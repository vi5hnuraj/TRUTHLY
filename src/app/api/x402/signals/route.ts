import { NextResponse } from "next/server";
import { withSettledPayment } from "@/lib/x402";
import { FILING_FEE_CENTS } from "@/lib/constants";
import { recordLedgerEntry } from "@/lib/ledger";
import {
  fileSignal,
  signalFilingSchema,
  upsertReporter,
  type SignalFiling,
} from "@/lib/signal-filing";
import {
  checkFilingMandate,
  MandateDenied,
  recordMandateUsage,
} from "@/lib/world/mandates";
import { getDb } from "@/lib/db";
import { withSecurityWriteLock } from "@/lib/db/write-lock";

/**
 * File a signal by paying a $0.01 x402 filing fee. No account, no API key:
 * the paying wallet becomes the reporter's identity and payout address.
 */
export const POST = withSettledPayment<SignalFiling>(
  {
    price: `$${(FILING_FEE_CENTS / 100).toFixed(2)}`,
    description: "File a news signal with the TRUTHLY editor; the paying wallet earns revenue share if it is published",
    guard: async (req) => {
      const raw: unknown = await req
        .clone()
        .json()
        .catch(() => null);
      const parsed = signalFilingSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          reject: NextResponse.json(
            {
              error: "Invalid signal. Nothing was charged.",
              issues: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`),
            },
            { status: 400 },
          ),
        };
      }
      return { data: parsed.data };
    },
    verifiedGuard: async (_req, payment, filing) => {
      try {
        await checkFilingMandate(payment.payer, filing.beat, BigInt(10_000));
        return null;
      } catch (error) {
        if (error instanceof MandateDenied) {
          return NextResponse.json(
            {
              error: error.code,
              detail: `${error.message} Nothing was charged.`,
            },
            { status: error.status },
          );
        }
        throw error;
      }
    },
  },
  async (_req, payment, filing) => {
    const db = await getDb();
    let result:
      | {
          reporter: Awaited<ReturnType<typeof upsertReporter>>;
          filed: Awaited<ReturnType<typeof fileSignal>>;
        }
      | undefined;
    try {
      result = await withSecurityWriteLock(() => db.transaction(async (tx) => {
        // Re-check after settlement and commit the filing + quota reservation
        // in one write transaction. A concurrent pause either waits for this
        // already-accepted filing or wins first and prevents every write.
        const authority = await checkFilingMandate(
          payment.payer,
          filing.beat,
          BigInt(10_000),
          tx,
        );
        const reporter = await upsertReporter(
          payment.network,
          payment.payer,
          filing.reporter_name,
          tx,
        );
        const filed = await fileSignal(reporter, filing, tx);
        if (authority.bound) {
          await recordMandateUsage(
            {
              principalId: authority.principalId,
              delegatedAgentId: authority.delegatedAgentId,
              kind: "filing",
              amountAtomic: BigInt(10_000),
              refId: filed.id,
            },
            tx,
          );
        }
        return { reporter, filed };
      }));
    } catch (error) {
      if (error instanceof MandateDenied) {
        await recordLedgerEntry({
          type: "revenue",
          amountCents: FILING_FEE_CENTS,
          description: "x402 signal filing fee (filing blocked after settlement)",
          fromAddress: payment.payer,
          toAddress: process.env.TREASURY_ADDRESS,
          txHash: payment.transaction,
        }).catch((ledgerError: unknown) =>
          console.error("blocked filing fee ledger write failed:", ledgerError),
        );
        return NextResponse.json(
          {
            error: error.code,
            detail: `${error.message} The payment had already settled, but no story was filed.`,
            payment_settled: true,
            transaction: payment.transaction,
          },
          { status: error.status },
        );
      }
      throw error;
    }
    const { reporter, filed } = result;
    await recordLedgerEntry({
      type: "revenue",
      amountCents: FILING_FEE_CENTS,
      description: "x402 signal filing fee",
      fromAddress: payment.payer,
      toAddress: process.env.TREASURY_ADDRESS,
      txHash: payment.transaction,
    }).catch((error: unknown) => console.error("filing fee ledger write failed:", error));

    return NextResponse.json(
      {
        signal: { id: filed.id, status: "submitted", beat: filed.beat },
        editor_preview: {
          score: filed.previewScore,
          breakdown: filed.breakdown,
          evidence: filed.evidence,
          tips: filed.tips,
          note: "Herald fact-checks and re-scores the wire for each edition; the top 4 are published and the rest are held for the next one.",
        },
        reporter: { name: reporter.name, address: reporter.address, account_id: reporter.accountId },
        receipt: {
          paid_usd: (FILING_FEE_CENTS / 100).toFixed(2),
          transaction: payment.transaction,
          network: payment.network,
        },
      },
      { status: 201 },
    );
  },
);
