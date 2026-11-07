import { NextRequest, NextResponse } from "next/server";
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
  type RouteConfig,
} from "@x402/core/server";
import type { Network, PaymentPayload } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { NextAdapter } from "@x402/next";

const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS || "";
const NETWORK = (process.env.X402_NETWORK || "eip155:8453") as Network; // Base mainnet
const FACILITATOR_URL =
  process.env.X402_FACILITATOR_URL || "https://facilitator.payai.network";

export { TREASURY_ADDRESS, NETWORK, FACILITATOR_URL };

export interface SettledPayment {
  payer: string;
  transaction: string;
  network: string;
}

/** A pre-payment check: reject the request, or hand parsed data to the paid handler. */
export type PaymentGuard<T> = (
  req: NextRequest,
) => Promise<{ reject: NextResponse } | { data: T }>;

export type PaidHandler<T> = (
  req: NextRequest,
  payment: SettledPayment,
  data: T,
) => Promise<NextResponse>;

/** Runs after the x402 signature is verified (so payer is trustworthy) but before settlement. */
export type VerifiedPaymentGuard<T> = (
  req: NextRequest,
  payment: Pick<SettledPayment, "payer" | "network">,
  data: T,
) => Promise<NextResponse | null>;

let resourceServer: x402ResourceServer | null = null;

function getResourceServer(): x402ResourceServer {
  if (!resourceServer) {
    const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
    resourceServer = new x402ResourceServer(facilitator).register(
      NETWORK,
      new ExactEvmScheme(),
    );
  }
  return resourceServer;
}

function routeConfig(price: string, description: string): RouteConfig {
  return {
    accepts: {
      scheme: "exact",
      price,
      network: NETWORK,
      payTo: TREASURY_ADDRESS,
    },
    description,
    mimeType: "application/json",
  };
}

function toNextResponse(instructions: {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
}): NextResponse {
  const headers = new Headers(instructions.headers);
  if (typeof instructions.body === "string") {
    if (!headers.has("Content-Type")) headers.set("Content-Type", "text/html; charset=utf-8");
    return new NextResponse(instructions.body, { status: instructions.status, headers });
  }
  headers.set("Content-Type", "application/json");
  return new NextResponse(JSON.stringify(instructions.body ?? {}), {
    status: instructions.status,
    headers,
  });
}

function payerFromPayload(payload: PaymentPayload): string {
  const authorization = (
    payload.payload as { authorization?: { from?: unknown } }
  ).authorization;
  return typeof authorization?.from === "string" ? authorization.from : "";
}

/**
 * x402 paywall that settles BEFORE serving: the guard validates the request
 * (so nobody pays for a 404 or a malformed body), the facilitator verifies and
 * settles on-chain, and only then does the handler run and write state.
 */
export function withSettledPayment<T>(
  options: {
    price: string;
    description: string;
    guard: PaymentGuard<T>;
    verifiedGuard?: VerifiedPaymentGuard<T>;
  },
  handler: PaidHandler<T>,
) {
  let httpServer: x402HTTPResourceServer | null = null;
  let ready: Promise<void> | null = null;

  return async (req: NextRequest): Promise<NextResponse> => {
    if (!TREASURY_ADDRESS) {
      return NextResponse.json(
        { error: "Payments are not configured" },
        { status: 503 },
      );
    }

    const checked = await options.guard(req);
    if ("reject" in checked) return checked.reject;

    httpServer ??= new x402HTTPResourceServer(getResourceServer(), {
      "*": routeConfig(options.price, options.description),
    });
    const server = httpServer;
    ready ??= server.initialize().catch((error: unknown) => {
      ready = null;
      throw error;
    });

    let payment: SettledPayment;
    let receiptHeaders: Record<string, string>;
    try {
      await ready;
      const adapter = new NextAdapter(req);
      const context = {
        adapter,
        path: req.nextUrl.pathname,
        method: req.method,
        paymentHeader:
          adapter.getHeader("payment-signature") ||
          adapter.getHeader("x-payment"),
      };

      const result = await server.processHTTPRequest(context);
      if (result.type === "payment-error")
        return toNextResponse(result.response);
      if (result.type !== "payment-verified") {
        return NextResponse.json(
          { error: "Payment route misconfigured" },
          { status: 500 },
        );
      }

      const verifiedPayer = payerFromPayload(result.paymentPayload).toLowerCase();
      if (options.verifiedGuard) {
        const rejected = await options.verifiedGuard(
          req,
          { payer: verifiedPayer, network: result.paymentRequirements.network },
          checked.data,
        );
        if (rejected) return rejected;
      }

      const settled = await server.processSettlement(
        result.paymentPayload,
        result.paymentRequirements,
        result.declaredExtensions,
        { request: context },
      );
      if (!settled.success) return toNextResponse(settled.response);

      payment = {
        payer: (settled.payer || payerFromPayload(result.paymentPayload)).toLowerCase(),
        transaction: settled.transaction,
        network: settled.network,
      };
      receiptHeaders = settled.headers;
    } catch (error) {
      console.error("x402 payment processing failed:", error);
      const attempted = Boolean(req.headers.get("payment-signature") || req.headers.get("x-payment"));
      return NextResponse.json(
        attempted
          ? { error: "Payment could not be verified or settled, so nothing was served. Check your wallet before retrying." }
          : { error: "Payments are temporarily unavailable. Nothing was charged; try again shortly." },
        { status: attempted ? 502 : 503 },
      );
    }

    try {
      const response = await handler(req, payment, checked.data);
      for (const [key, value] of Object.entries(receiptHeaders)) {
        response.headers.set(key, value);
      }
      return response;
    } catch (error) {
      console.error("Paid handler failed after settlement:", error);
      return NextResponse.json(
        {
          error:
            "Payment settled but the response failed. Do not pay again; contact TRUTHLY with this transaction.",
          transaction: payment.transaction,
        },
        { status: 500 },
      );
    }
  };
}
