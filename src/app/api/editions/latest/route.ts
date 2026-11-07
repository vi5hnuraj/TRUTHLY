import { NextResponse } from "next/server";
import { withSettledPayment } from "@/lib/x402";
import { EDITION_PRICE_CENTS } from "@/lib/constants";
import { findLatestEdition, loadPaidEdition, type EditionRow } from "@/lib/edition-content";
import { recordPayment } from "@/lib/payments";
import { rejectPausedPaymentPayer } from "@/lib/world/payment-guard";

export const GET = withSettledPayment<EditionRow>(
  {
    price: `$${(EDITION_PRICE_CENTS / 100).toFixed(2)}`,
    description: "Latest full TRUTHLY edition: every signal with body, sources and reporter",
    guard: async () => {
      const edition = await findLatestEdition();
      return edition
        ? { data: edition }
        : { reject: NextResponse.json({ error: "No editions yet" }, { status: 404 }) };
    },
    verifiedGuard: async (_req, payment) => rejectPausedPaymentPayer(payment.payer),
  },
  async (_req, payment, edition) => {
    await recordPayment({
      editionId: edition.id,
      payerAddress: payment.payer,
      amountCents: EDITION_PRICE_CENTS,
      txHash: payment.transaction,
      network: payment.network,
    }).catch((error: unknown) => console.error("recordPayment failed:", error));
    return NextResponse.json(await loadPaidEdition(edition, payment));
  },
);
