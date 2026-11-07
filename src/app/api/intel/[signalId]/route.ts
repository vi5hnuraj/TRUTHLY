import { NextRequest, NextResponse } from "next/server";
import { withSettledPayment } from "@/lib/x402";
import { SIGNAL_PRICE_CENTS } from "@/lib/constants";
import {
  buildSignalIntel,
  findSignalForSale,
  verifySignalReceipt,
  type SignalIntelRow,
} from "@/lib/intel";
import { recordSignalPayment } from "@/lib/payments";
import { rejectPausedPaymentPayer } from "@/lib/world/payment-guard";

/**
 * GET /api/intel/[signalId] — the individual intelligence purchase.
 *
 * No receipt: the x402 paywall settles first, then mints a signal-scoped
 * entitlement and returns the full story plus its receipt. With a receipt
 * (header `x-receipt` or `?receipt=`) the same story is re-readable without
 * paying again. Nobody can trade on a story they have not bought: the receipt
 * this returns is exactly what POST /api/flash/trade demands.
 */

const NOT_FOUND_STATUS: Record<string, number> = {
  invalid_signal_id: 400,
  signal_not_found: 404,
  not_in_published_edition: 404,
  story_unavailable: 410,
};

const NOT_FOUND_DETAIL: Record<string, string> = {
  invalid_signal_id: "signalId must be a UUID",
  signal_not_found: "No such story on the current wire",
  not_in_published_edition: "This story is not in a published edition yet, so it is not for sale",
  story_unavailable: "This story was retracted or rejected",
};

function signalIdFromPath(req: NextRequest): string {
  return req.nextUrl.pathname.split("/").filter(Boolean).at(-1) ?? "";
}

function notFound(reason: string): NextResponse {
  return NextResponse.json(
    { error: reason, detail: NOT_FOUND_DETAIL[reason] ?? "Not available" },
    { status: NOT_FOUND_STATUS[reason] ?? 404 },
  );
}

const paidIntel = withSettledPayment<SignalIntelRow>(
  {
    price: `$${(SIGNAL_PRICE_CENTS / 100).toFixed(2)}`,
    description:
      "One TRUTHLY signal's full intelligence: body, sources, claims, Herald's fact-check and source archive",
    guard: async (req) => {
      const lookup = await findSignalForSale(signalIdFromPath(req));
      return lookup.ok ? { data: lookup.row } : { reject: notFound(lookup.reason) };
    },
    verifiedGuard: async (_req, payment) => rejectPausedPaymentPayer(payment.payer),
  },
  async (_req, payment, row) => {
    let entitlementId: string | null = null;
    let grantedAt: string | null = null;
    try {
      const recorded = await recordSignalPayment({
        signalId: row.id,
        editionId: row.editionId,
        payerAddress: payment.payer,
        amountCents: SIGNAL_PRICE_CENTS,
        txHash: payment.transaction,
        network: payment.network,
      });
      entitlementId = recorded?.entitlementId ?? null;
      grantedAt = new Date().toISOString();
    } catch (error) {
      // Serve what was paid for either way; the receipt says plainly when the
      // entitlement write failed so the buyer never pays twice.
      console.error("recordSignalPayment failed:", error);
    }
    return NextResponse.json(await buildSignalIntel(row, { entitlementId, payment, grantedAt }));
  },
);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ signalId: string }> },
) {
  const { signalId } = await params;
  const receipt =
    req.headers.get("x-receipt") ?? new URL(req.url).searchParams.get("receipt") ?? "";

  if (receipt) {
    const check = await verifySignalReceipt({ receiptId: receipt, signalId });
    if (!check.ok) {
      return NextResponse.json(
        {
          error: "receipt_not_valid_for_this_story",
          reason: check.reason,
          detail:
            check.reason === "receipt_wrong_story"
              ? "This receipt was issued for a different story. Buy this story's intelligence first."
              : "Unknown receipt. Pay the x402 challenge on this endpoint to mint one.",
        },
        { status: 403 },
      );
    }
    const lookup = await findSignalForSale(signalId);
    if (!lookup.ok) return notFound(lookup.reason);
    return NextResponse.json(
      await buildSignalIntel(lookup.row, {
        entitlementId: check.entitlement.id,
        payment: {
          payer: check.payment.payerAddress,
          transaction: check.payment.txHash,
          network: check.payment.network,
        },
        grantedAt: check.entitlement.grantedAt,
      }),
    );
  }

  return paidIntel(req);
}
