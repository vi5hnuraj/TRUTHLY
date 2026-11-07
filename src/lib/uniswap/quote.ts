import * as z from "zod";
import { isAddress } from "viem";
import { USDC_BASE, WETH_BASE } from "@/lib/flash/trade";
import { parseUsdcAtomic } from "@/lib/usdc";
import { canonicalJson, sha256, type JsonValue } from "@/lib/world/actions";

const UNISWAP_QUOTE_URL = "https://trade-api.gateway.uniswap.org/v1/quote";
const BASE_CHAIN_ID = 8453;
const UNIVERSAL_ROUTER_VERSION = "2.1.2";
const WETH_DECIMALS = 18;
const USDC_DECIMALS = 6;
const PRICE_DECIMALS = 8;
const QUOTE_TIMEOUT_MS = 20_000;

const failureReasonSchema = z.enum([
  "SIMULATION_ERROR",
  "UNSUPPORTED_SIMULATION",
  "SIMULATION_UNAVAILABLE",
  "SLIPPAGE_TOO_LOW",
  "TRANSFER_FROM_FAILED",
]);

const poolSchema = z
  .object({
    type: z.string().min(1),
  })
  .passthrough();

const quoteResponseSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    routing: z.string().min(1).max(40),
    quote: z
      .object({
        chainId: z.number().int(),
        input: z.object({
          amount: z.string().regex(/^\d+$/),
          token: z.string(),
        }),
        output: z.object({
          amount: z.string().regex(/^\d+$/),
          token: z.string(),
          recipient: z.string().optional(),
        }),
        swapper: z.string(),
        tradeType: z.literal("EXACT_INPUT"),
        quoteId: z.string().min(1).max(200),
        route: z.array(z.array(poolSchema)).min(1),
        routeString: z.string().max(4_000).optional(),
        blockNumber: z.string().regex(/^\d+$/).optional(),
        gasFeeUSD: z.string().max(80).optional(),
        priceImpact: z.number().finite().optional(),
        txFailureReasons: z.array(failureReasonSchema).default([]),
      })
      .passthrough(),
  })
  .passthrough();

const errorResponseSchema = z
  .object({
    errorCode: z.string().max(120).optional(),
    detail: z.string().max(500).optional(),
    message: z.string().max(500).optional(),
    requestId: z.string().max(200).optional(),
  })
  .passthrough();

export type UniswapQuoteErrorCode =
  | "not_configured"
  | "timeout"
  | "network"
  | "http_error"
  | "bad_response"
  | "quote_mismatch"
  | "simulation_failed";

export class UniswapQuoteError extends Error {
  readonly code: UniswapQuoteErrorCode;
  readonly status?: number;
  readonly requestId?: string;

  constructor(
    code: UniswapQuoteErrorCode,
    message: string,
    options: { status?: number; requestId?: string } = {},
  ) {
    super(message);
    this.name = "UniswapQuoteError";
    this.code = code;
    this.status = options.status;
    this.requestId = options.requestId;
  }
}

export interface UniswapQuoteSnapshot {
  source: "uniswap_trading_api";
  network: "base-mainnet";
  chainId: 8453;
  assetSymbol: string;
  assetAddress: string;
  contraSymbol: "USDC";
  contraAddress: string;
  side: "buy";
  exactInputAtomic: string;
  quotedSpendUsdc: string;
  quotedReceiveAmount: string;
  impliedPriceUsd: string;
  routing: "CLASSIC";
  protocols: Array<"V2" | "V3" | "V4">;
  routeString: string | null;
  priceImpactPercent: string | null;
  gasFeeUsd: string | null;
  providerRequestId: string;
  providerQuoteId: string;
  blockNumber: string | null;
  universalRouterVersion: "2.1.2";
  decisionOrigin: "autonomous" | "human_mediated";
  fetchedAt: string;
  quoteHash: string;
}

export interface UniswapQuoteInput {
  notionalUsdc: string;
  swapper: string;
  assetSymbol?: string;
  assetAddress?: string;
  assetDecimals?: number;
  decisionOrigin?: "autonomous" | "human_mediated";
}

export type UniswapFetch = typeof fetch;

export interface UniswapQuoteOptions {
  apiKey?: string;
  fetchImpl?: UniswapFetch;
  now?: () => Date;
}

export function uniswapApiConfigured(): boolean {
  return Boolean(process.env.UNISWAP_API_KEY?.trim());
}

/** Plain, bounded provider failure for API responses and durable audit rows. */
export function describeUniswapError(error: unknown): string {
  if (error instanceof UniswapQuoteError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 240);
  return String(error).slice(0, 240);
}

function fixed(value: bigint, decimals: number): string {
  const scale = BigInt(10) ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0");
  return `${whole}.${fraction}`;
}

/** USDC atomic input divided by target-token atomic output, rendered as USD/token. */
export function impliedUsdPrice(
  usdcAtomic: bigint,
  targetAtomic: bigint,
  targetDecimals = WETH_DECIMALS,
): string {
  if (usdcAtomic <= BigInt(0) || targetAtomic <= BigInt(0)) {
    throw new UniswapQuoteError("bad_response", "Uniswap quote amounts must be positive");
  }
  const priceScale = BigInt(10) ** BigInt(PRICE_DECIMALS);
  const targetScale = BigInt(10) ** BigInt(targetDecimals);
  const usdcScale = BigInt(10) ** BigInt(USDC_DECIMALS);
  const scaledPrice =
    (usdcAtomic * targetScale * priceScale) / (targetAtomic * usdcScale);
  if (scaledPrice <= BigInt(0)) {
    throw new UniswapQuoteError("bad_response", "Uniswap quote produced an invalid price");
  }
  return fixed(scaledPrice, PRICE_DECIMALS);
}

function humanTokenAmount(atomic: bigint, decimals: number): string {
  const scale = BigInt(10) ** BigInt(decimals);
  const whole = atomic / scale;
  const fraction = (atomic % scale)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function routeProtocols(route: Array<Array<{ type: string }>>): Array<"V2" | "V3" | "V4"> {
  const protocols = new Set<"V2" | "V3" | "V4">();
  for (const split of route) {
    for (const pool of split) {
      if (pool.type === "v2-pool") protocols.add("V2");
      if (pool.type === "v3-pool") protocols.add("V3");
      if (pool.type === "v4-pool") protocols.add("V4");
    }
  }
  return [...protocols];
}

function safeProviderDetail(payload: unknown, status: number): {
  message: string;
  requestId?: string;
} {
  const parsed = errorResponseSchema.safeParse(payload);
  if (!parsed.success) return { message: `Uniswap quote request failed with HTTP ${status}` };
  const code = parsed.data.errorCode?.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
  return {
    message: code
      ? `Uniswap quote request failed with HTTP ${status} (${code})`
      : `Uniswap quote request failed with HTTP ${status}`,
    requestId: parsed.data.requestId,
  };
}

/**
 * Server-only Uniswap Base AMM reference quote.
 *
 * The request is deliberately pinned to V2/V3/V4 liquidity and exact-input
 * routing. The response is reduced to a non-executable market snapshot: permit
 * data, calldata, approvals and transaction objects are never returned or stored.
 */
export async function fetchUniswapQuote(
  input: UniswapQuoteInput,
  options: UniswapQuoteOptions = {},
): Promise<UniswapQuoteSnapshot> {
  const apiKey = options.apiKey?.trim() || process.env.UNISWAP_API_KEY?.trim() || "";
  if (!apiKey) {
    throw new UniswapQuoteError(
      "not_configured",
      "UNISWAP_API_KEY is required for cross-market verification",
    );
  }
  const swapper = input.swapper.trim();
  const assetAddress = (input.assetAddress ?? WETH_BASE).trim();
  const assetDecimals = input.assetDecimals ?? WETH_DECIMALS;
  if (!isAddress(swapper, { strict: false }) || !isAddress(assetAddress, { strict: false })) {
    throw new UniswapQuoteError("quote_mismatch", "Uniswap quote requires valid EVM addresses");
  }
  if (!Number.isInteger(assetDecimals) || assetDecimals < 0 || assetDecimals > 36) {
    throw new UniswapQuoteError("quote_mismatch", "Uniswap target decimals are invalid");
  }
  const inputAtomic = parseUsdcAtomic(input.notionalUsdc);
  if (!inputAtomic || inputAtomic <= BigInt(0)) {
    throw new UniswapQuoteError("quote_mismatch", "Uniswap quote notional must be positive USDC");
  }

  const decisionOrigin = input.decisionOrigin ?? "human_mediated";
  const agentInfo = JSON.stringify({
    decision_origin: decisionOrigin,
    integration_name: "truthly-market-integrity",
    version: "1.0.0",
  });
  const body = {
    type: "EXACT_INPUT",
    amount: inputAtomic.toString(),
    tokenInChainId: BASE_CHAIN_ID,
    tokenOutChainId: BASE_CHAIN_ID,
    tokenIn: USDC_BASE,
    tokenOut: assetAddress,
    swapper,
    slippageTolerance: 0.5,
    routingPreference: "BEST_PRICE",
    protocols: ["V2", "V3", "V4"],
    hooksOptions: "V4_HOOKS_INCLUSIVE",
    permitAmount: "EXACT",
  } as const;

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(UNISWAP_QUOTE_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "content-type": "application/json",
        accept: "application/json",
        "x-universal-router-version": UNIVERSAL_ROUTER_VERSION,
        "x-agent-info": agentInfo,
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    throw new UniswapQuoteError(
      timedOut ? "timeout" : "network",
      timedOut ? "Uniswap quote timed out" : "Uniswap quote endpoint could not be reached",
    );
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = safeProviderDetail(payload, response.status);
    throw new UniswapQuoteError("http_error", detail.message, {
      status: response.status,
      requestId: detail.requestId,
    });
  }
  if (response.headers.get("x-agent-info-status") === "malformed") {
    throw new UniswapQuoteError(
      "bad_response",
      "Uniswap rejected the TRUTHLY agent-attribution header",
    );
  }

  const parsed = quoteResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new UniswapQuoteError("bad_response", "Uniswap quote returned an unexpected shape");
  }
  const { requestId, routing, quote } = parsed.data;
  const protocols = routeProtocols(quote.route);
  const seriousFailures = quote.txFailureReasons.filter(
    (reason) => reason !== "TRANSFER_FROM_FAILED",
  );
  if (seriousFailures.length > 0) {
    throw new UniswapQuoteError(
      "simulation_failed",
      `Uniswap route simulation was not clean (${seriousFailures.join(",")})`,
      { requestId },
    );
  }
  if (
    routing !== "CLASSIC" ||
    quote.chainId !== BASE_CHAIN_ID ||
    quote.input.token.toLowerCase() !== USDC_BASE.toLowerCase() ||
    quote.output.token.toLowerCase() !== assetAddress.toLowerCase() ||
    quote.input.amount !== inputAtomic.toString() ||
    quote.swapper.toLowerCase() !== swapper.toLowerCase() ||
    protocols.length === 0
  ) {
    throw new UniswapQuoteError(
      "quote_mismatch",
      "Uniswap quote did not match the requested Base AMM market",
      { requestId },
    );
  }

  const outputAtomic = BigInt(quote.output.amount);
  const fetchedAt = (options.now?.() ?? new Date()).toISOString();
  const core = {
    source: "uniswap_trading_api" as const,
    network: "base-mainnet" as const,
    chainId: BASE_CHAIN_ID as 8453,
    assetSymbol: input.assetSymbol ?? "ETH",
    assetAddress: assetAddress.toLowerCase(),
    contraSymbol: "USDC" as const,
    contraAddress: USDC_BASE.toLowerCase(),
    side: "buy" as const,
    exactInputAtomic: inputAtomic.toString(),
    quotedSpendUsdc: input.notionalUsdc,
    quotedReceiveAmount: humanTokenAmount(outputAtomic, assetDecimals),
    impliedPriceUsd: impliedUsdPrice(inputAtomic, outputAtomic, assetDecimals),
    routing: "CLASSIC" as const,
    protocols,
    routeString: quote.routeString ?? null,
    priceImpactPercent:
      quote.priceImpact === undefined ? null : quote.priceImpact.toFixed(6),
    gasFeeUsd: quote.gasFeeUSD ?? null,
    providerRequestId: requestId,
    providerQuoteId: quote.quoteId,
    blockNumber: quote.blockNumber ?? null,
    universalRouterVersion: UNIVERSAL_ROUTER_VERSION as "2.1.2",
    decisionOrigin,
    fetchedAt,
  };
  return {
    ...core,
    quoteHash: sha256(canonicalJson(core as unknown as JsonValue)),
  };
}
