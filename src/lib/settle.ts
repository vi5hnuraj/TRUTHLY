import { and, asc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb, schema } from "./db";
import { executePayouts } from "./payouts";
import { recordLedgerEntry, setLedgerTx } from "./ledger";
import { refutesStory } from "./herald/verification";

type Db = Awaited<ReturnType<typeof getDb>>;

export type StakeVerdict =
  | "supported"
  | "partially_supported"
  | "contradicted"
  | "unsupported"
  | "unchecked";

export type SettlementResult = {
  action: "refund" | "slash" | "none";
  detail: string;
  transaction?: string | null;
};

/** 10000 atomic USDC = 1¢. */
export const CENT_ATOMIC = "10000";

type RefundRow = {
  id: string;
  signalId: string;
  payoutAtomic: string;
  refundLedgerId: string | null;
  reporterAddress: string;
  headline: string;
};

function atomicToCents(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const atomic = BigInt(value);
  if (atomic % BigInt(10_000) !== BigInt(0)) return null;
  const cents = atomic / BigInt(10_000);
  return cents > BigInt(0) && cents <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(cents)
    : null;
}

async function refundRow(db: Db, settlementId: string): Promise<RefundRow | null> {
  const row = await db
    .select({
      id: schema.settlements.id,
      signalId: schema.settlements.signalId,
      payoutAtomic: schema.settlements.payoutAtomic,
      refundLedgerId: schema.settlements.refundLedgerId,
      reporterAddress: sql<string>`COALESCE(${schema.agents.payoutAddress}, ${schema.agents.address})`,
      headline: schema.signals.headline,
    })
    .from(schema.settlements)
    .innerJoin(schema.signals, eq(schema.signals.id, schema.settlements.signalId))
    .innerJoin(schema.agents, eq(schema.agents.id, schema.signals.agentId))
    .where(eq(schema.settlements.id, settlementId))
    .get();
  return row ?? null;
}

async function executeRefund(db: Db, settlementId: string): Promise<SettlementResult> {
  let row = await refundRow(db, settlementId);
  if (!row) return { action: "none", detail: "settlement_not_found" };
  const amountCents = atomicToCents(row.payoutAtomic);
  if (!amountCents) {
    const now = new Date().toISOString();
    await db
      .update(schema.settlements)
      .set({
        payoutStatus: "not_applicable",
        payoutError: "Stake amount is not a positive whole-cent USDC value",
        updatedAt: now,
      })
      .where(eq(schema.settlements.id, row.id))
      .run();
    // A zero legacy stake needs no transfer and may safely be considered refunded.
    if (row.payoutAtomic === "0") {
      await db
        .update(schema.signals)
        .set({ stakeStatus: "refunded" })
        .where(eq(schema.signals.id, row.signalId))
        .run();
      return { action: "refund", detail: "zero_stake_refunded", transaction: null };
    }
    return { action: "refund", detail: "refund_amount_invalid", transaction: null };
  }

  if (!row.refundLedgerId) {
    const ledgerId = await recordLedgerEntry({
      type: "refund",
      amountCents,
      description: `On-chain filing stake refund: ${row.headline.slice(0, 80)}`,
      toAddress: row.reporterAddress,
    });
    await db
      .update(schema.settlements)
      .set({ refundLedgerId: ledgerId, updatedAt: new Date().toISOString() })
      .where(eq(schema.settlements.id, row.id))
      .run();
    row = { ...row, refundLedgerId: ledgerId };
  }
  const refundLedgerId = row.refundLedgerId;
  if (!refundLedgerId) {
    return { action: "refund", detail: "refund_ledger_missing", transaction: null };
  }

  const [result] = await executePayouts([
    {
      ledgerId: refundLedgerId,
      address: row.reporterAddress,
      amountCents,
      description:
        "TRUTHLY filing stake refund: Herald did not refute the story",
      resourceUrl: `${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/stake-refunds/${row.id}`,
    },
  ]);
  const now = new Date().toISOString();
  if (!result?.txHash) {
    await db
      .update(schema.settlements)
      .set({
        payoutStatus: "pending",
        payoutError: result?.error ?? "refund settlement failed",
        updatedAt: now,
      })
      .where(eq(schema.settlements.id, row.id))
      .run();
    return { action: "refund", detail: "refund_pending", transaction: null };
  }

  await setLedgerTx(refundLedgerId, result.txHash);
  await db
    .update(schema.settlements)
    .set({
      payoutStatus: "settled",
      payoutTxHash: result.txHash,
      payoutError: null,
      updatedAt: now,
    })
    .where(eq(schema.settlements.id, row.id))
    .run();
  await db
    .update(schema.signals)
    .set({ stakeStatus: "refunded", updatedAt: now })
    .where(eq(schema.signals.id, row.signalId))
    .run();
  return { action: "refund", detail: "stake_refunded_on_chain", transaction: result.txHash };
}

/**
 * The stake prices one promise: claim only what your sources back. Herald's
 * verdict split records WHICH way that promise broke — "contradicted" (the
 * sources directly deny the story: a lie) vs "unsupported" (the sources fail
 * to establish it: an over-claim) — and both break it, so both slash. Every
 * other verdict (supported, partially_supported, unchecked) sends the stake
 * back on-chain. A failed refund remains pending and appeal-ineligible;
 * infrastructure failure never becomes a slash.
 */
export async function settleStake(
  db: Db,
  signalId: string,
  verdict: StakeVerdict,
  reason?: string,
): Promise<SettlementResult> {
  const signal = await db
    .select({
      id: schema.signals.id,
      stakeAtomic: schema.signals.stakeAtomic,
      stakeStatus: schema.signals.stakeStatus,
    })
    .from(schema.signals)
    .where(eq(schema.signals.id, signalId))
    .get();

  if (!signal) return { action: "none", detail: "signal_not_found" };
  if (signal.stakeStatus === "refunded" || signal.stakeStatus === "slashed") {
    return { action: "none", detail: `already_${signal.stakeStatus}` };
  }

  const existing = await db
    .select({ id: schema.settlements.id, action: schema.settlements.action })
    .from(schema.settlements)
    .where(eq(schema.settlements.signalId, signalId))
    .orderBy(asc(schema.settlements.createdAt))
    .limit(1)
    .get();

  if (refutesStory(verdict)) {
    if (existing) return { action: "none", detail: `already_${existing.action}` };
    const now = new Date().toISOString();
    await db
      .update(schema.signals)
      .set({ stakeStatus: "slashed", updatedAt: now })
      .where(eq(schema.signals.id, signalId))
      .run();
    await db
      .insert(schema.settlements)
      .values({
        id: randomUUID(),
        signalId,
        verdict,
        stakeAtomic: signal.stakeAtomic || "0",
        payoutAtomic: "0",
        action: "slash",
        reason: reason ?? null,
        payoutStatus: "not_applicable",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    // The filing payment was recorded as revenue when it arrived. Keeping it is
    // the slash; adding another revenue row here would count the same cent twice.
    return { action: "slash", detail: "stake_slashed" };
  }

  let settlementId = existing?.action === "refund" ? existing.id : null;
  if (!settlementId) {
    if (existing) return { action: "none", detail: `already_${existing.action}` };
    settlementId = randomUUID();
    const now = new Date().toISOString();
    await db
      .insert(schema.settlements)
      .values({
        id: settlementId,
        signalId,
        verdict,
        stakeAtomic: signal.stakeAtomic || "0",
        payoutAtomic: signal.stakeAtomic || "0",
        action: "refund",
        reason: reason ?? null,
        payoutStatus: "pending",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
  await db
    .update(schema.signals)
    .set({ stakeStatus: "refund_pending", updatedAt: new Date().toISOString() })
    .where(eq(schema.signals.id, signalId))
    .run();
  return executeRefund(db, settlementId);
}

/** Retries durable pending refunds (including pre-v13 database-only refunds). */
export async function retryPendingStakeRefunds(limit = 50) {
  const db = await getDb();
  const pending = await db
    .select({ id: schema.settlements.id })
    .from(schema.settlements)
    .where(
      and(
        eq(schema.settlements.action, "refund"),
        eq(schema.settlements.payoutStatus, "pending"),
      ),
    )
    .orderBy(asc(schema.settlements.createdAt))
    .limit(limit)
    .all();
  const results = [];
  for (const row of pending) results.push(await executeRefund(db, row.id));
  return {
    attempted: results.length,
    settled: results.filter((result) => result.detail === "stake_refunded_on_chain").length,
    pending: results.filter((result) => result.detail === "refund_pending").length,
  };
}
