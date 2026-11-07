import { NextResponse } from "next/server";
import { retryRead } from "@/lib/db/retry";
import { getFinancials } from "@/lib/ledger";
import { getPaymentRevenue } from "@/lib/payments";
import { getProofStats } from "@/lib/proof";

async function readOnlyGET() {
  const [financials, payments, proof] = await Promise.all([
    getFinancials(),
    getPaymentRevenue(),
    getProofStats(),
  ]);

  return NextResponse.json({
    ...financials,
    paymentRevenueCents: payments.totalCents,
    paymentCount: payments.count,
    proof,
  });
}

/** Read-only handler: retried once on a transient DB failure. */
export async function GET(...args: Parameters<typeof readOnlyGET>) {
  return retryRead(() => readOnlyGET(...args));
}
