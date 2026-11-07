import { after } from "next/server";
import { v4 as uuid } from "uuid";
import { getDb, schema } from "./db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { recordLedgerEntry, setLedgerTx } from "./ledger";
import { currentPayment } from "./era";
import { REVENUE_SPLIT } from "./constants";
import { executePayouts, type PayoutTarget } from "./payouts";
import { allocatePayoutByOrigin } from "./payout-allocation";

export async function recordPayment(opts: {
  editionId: string;
  payerAddress: string;
  amountCents: number;
  txHash?: string;
  network: string;
}) {
  const db = await getDb();
  const now = new Date().toISOString();
  const paymentId = uuid();

  const inserted = await db
    .insert(schema.payments)
    .values({
      id: paymentId,
      editionId: opts.editionId,
      payerAddress: opts.payerAddress.toLowerCase(),
      amountCents: opts.amountCents,
      txHash: opts.txHash ?? null,
      network: opts.network,
      paidAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.payments.id });
  if (inserted.length === 0) return null; // this transaction was already credited

  // Create entitlement
  await db
    .insert(schema.entitlements)
    .values({
      id: uuid(),
      paymentId,
      editionId: opts.editionId,
      accountId: opts.payerAddress,
      grantedAt: now,
    })
    .run();

  // Record in ledger as actual revenue
  await recordLedgerEntry({
    type: "revenue",
    amountCents: opts.amountCents,
    description: `x402 payment for edition`,
    fromAddress: opts.payerAddress,
    toAddress: process.env.TREASURY_ADDRESS,
    txHash: opts.txHash,
    editionId: opts.editionId,
  });

  // Update edition-level revenue with actual cumulative payments
  const { totalCents } = await getPaymentRevenue(opts.editionId);
  await db
    .update(schema.editions)
    .set({ revenueCents: totalCents })
    .where(eq(schema.editions.id, opts.editionId))
    .run();

  // Distribute contributor payouts for this payment
  await distributePayouts(opts.editionId, opts.amountCents);

  return paymentId;
}

async function distributePayouts(
  editionId: string,
  paymentAmountCents: number,
) {
  const db = await getDb();

  const contributors = await db
    .select({
      signalId: schema.editionSignals.signalId,
      position: schema.editionSignals.position,
      agentId: schema.signals.agentId,
      agentAddress: schema.agents.address,
      payoutAddress: schema.agents.payoutAddress,
    })
    .from(schema.editionSignals)
    .innerJoin(
      schema.signals,
      eq(schema.editionSignals.signalId, schema.signals.id),
    )
    .innerJoin(schema.agents, eq(schema.signals.agentId, schema.agents.id))
    .where(eq(schema.editionSignals.editionId, editionId))
    .orderBy(schema.editionSignals.position)
    .all();

  if (contributors.length === 0) return;

  const contributorPool = Math.floor(
    paymentAmountCents * REVENUE_SPLIT.contributors,
  );
  if (contributorPool <= 0) return;

  // A payout share follows a human origin, not a wallet or byline count. All
  // unknown origins collapse into one conservative pool, so creating fresh
  // unbound wallets cannot multiply the edition payout either.
  const contributorWallets = [...new Set(contributors.map((c) => c.agentAddress.toLowerCase()))];
  const delegations = contributorWallets.length
    ? await db
        .select({
          wallet: schema.delegatedAgents.agentWallet,
          principalId: schema.delegatedAgents.principalId,
        })
        .from(schema.delegatedAgents)
        .where(inArray(schema.delegatedAgents.agentWallet, contributorWallets))
    : [];
  const principalByWallet = new Map(
    delegations.map((row) => [row.wallet.toLowerCase(), row.principalId]),
  );
  const groupFor = (wallet: string) =>
    principalByWallet.get(wallet.toLowerCase()) ?? "unbound_unknown_origin";
  const allocation = allocatePayoutByOrigin(
    contributorPool,
    contributors.map((contributor) => ({
      key: contributor.signalId,
      groupId: groupFor(contributor.agentAddress),
      position: contributor.position,
    })),
  );

  const payoutTargets: PayoutTarget[] = [];

  for (const c of contributors) {
    const payout = allocation.get(c.signalId) ?? 0;
    if (payout <= 0) continue;
    const groupId = groupFor(c.agentAddress);

    await db
      .update(schema.editionSignals)
      .set({
        payoutCents: sql`${schema.editionSignals.payoutCents} + ${payout}`,
      })
      .where(
        and(
          eq(schema.editionSignals.editionId, editionId),
          eq(schema.editionSignals.signalId, c.signalId),
        ),
      )
      .run();

    await db
      .update(schema.agents)
      .set({
        totalEarnedCents: sql`${schema.agents.totalEarnedCents} + ${payout}`,
      })
      .where(eq(schema.agents.id, c.agentId))
      .run();

    const payoutAddress = c.payoutAddress || c.agentAddress;
    const ledgerId = await recordLedgerEntry({
      type: "payout",
      amountCents: payout,
      description: `Contributor payout from x402 payment (origin ${groupId.slice(0, 18)})`,
      toAddress: payoutAddress,
      editionId,
    });

    if (payoutAddress) {
      payoutTargets.push({ ledgerId, address: payoutAddress, amountCents: payout });
    }
  }

  // On-chain payouts run after the response is sent (best-effort); the ledger
  // entries above are the source of truth for what each reporter is owed.
  if (payoutTargets.length > 0) {
    after(() =>
      executePayouts(payoutTargets)
        .then(async (results) => {
          for (const result of results) {
            if (result.txHash) await setLedgerTx(result.ledgerId, result.txHash);
            else console.error("payout not settled:", result.address, result.error);
          }
        })
        .catch((error: unknown) => console.error("on-chain payouts failed:", error)),
    );
  }
}

export async function getPaymentRevenue(editionId?: string) {
  const db = await getDb();

  if (editionId) {
    const result = await db
      .select({
        total: sql<number>`COALESCE(SUM(${schema.payments.amountCents}), 0)`,
        count: sql<number>`COUNT(*)`,
      })
      .from(schema.payments)
      .where(eq(schema.payments.editionId, editionId))
      .get();
    return { totalCents: result?.total ?? 0, count: result?.count ?? 0 };
  }

  const result = await db
    .select({
      total: sql<number>`COALESCE(SUM(${schema.payments.amountCents}), 0)`,
      count: sql<number>`COUNT(*)`,
    })
    .from(schema.payments)
    .where(currentPayment)
    .get();
  return { totalCents: result?.total ?? 0, count: result?.count ?? 0 };
}

export async function hasEntitlement(
  accountId: string,
  editionId: string,
): Promise<boolean> {
  const db = await getDb();
  const row = await db
    .select({ id: schema.entitlements.id })
    .from(schema.entitlements)
    .where(
      and(
        eq(schema.entitlements.accountId, accountId),
        eq(schema.entitlements.editionId, editionId),
      ),
    )
    .get();
  return !!row;
}

/**
 * A signal-scoped sale: one x402 payment buys one story's intelligence and
 * mints the entitlement (receipt) that a trade on that story must present.
 * The payment still books against the edition that published the story.
 */
export async function recordSignalPayment(opts: {
  signalId: string;
  editionId: string;
  payerAddress: string;
  amountCents: number;
  txHash?: string;
  network: string;
}): Promise<{ paymentId: string; entitlementId: string } | null> {
  const db = await getDb();
  const now = new Date().toISOString();
  const paymentId = uuid();

  const inserted = await db
    .insert(schema.payments)
    .values({
      id: paymentId,
      editionId: opts.editionId,
      signalId: opts.signalId,
      payerAddress: opts.payerAddress.toLowerCase(),
      amountCents: opts.amountCents,
      txHash: opts.txHash ?? null,
      network: opts.network,
      paidAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.payments.id });
  if (inserted.length === 0) return null; // this transaction was already credited

  const entitlementId = uuid();
  await db
    .insert(schema.entitlements)
    .values({
      id: entitlementId,
      paymentId,
      editionId: opts.editionId,
      signalId: opts.signalId,
      accountId: opts.payerAddress,
      grantedAt: now,
    })
    .run();

  await recordLedgerEntry({
    type: "revenue",
    amountCents: opts.amountCents,
    description: "x402 payment for one signal's intelligence",
    fromAddress: opts.payerAddress,
    toAddress: process.env.TREASURY_ADDRESS,
    txHash: opts.txHash,
    editionId: opts.editionId,
  });

  const { totalCents } = await getPaymentRevenue(opts.editionId);
  await db
    .update(schema.editions)
    .set({ revenueCents: totalCents })
    .where(eq(schema.editions.id, opts.editionId))
    .run();

  // The buyer bought ONE story, so the contributor share goes to that story's
  // reporter alone — not split across the edition that happens to carry it.
  await distributeSignalPayout(opts.signalId, opts.editionId, opts.amountCents);

  return { paymentId, entitlementId };
}

/**
 * Contributor share of a single-story sale. The ledger is integer cents, so
 * 80% of a $0.02 sale rounds down to 1¢ for the reporter; the remainder stays
 * with the platform. A 5¢ edition sale still splits exactly 80/20.
 */
async function distributeSignalPayout(
  signalId: string,
  editionId: string,
  paymentAmountCents: number,
) {
  const db = await getDb();
  const contributor = await db
    .select({
      agentId: schema.signals.agentId,
      agentAddress: schema.agents.address,
      payoutAddress: schema.agents.payoutAddress,
    })
    .from(schema.signals)
    .innerJoin(schema.agents, eq(schema.signals.agentId, schema.agents.id))
    .where(eq(schema.signals.id, signalId))
    .get();
  if (!contributor) return;

  const payout = Math.floor(paymentAmountCents * REVENUE_SPLIT.contributors);
  if (payout <= 0) return;

  await db
    .update(schema.editionSignals)
    .set({ payoutCents: sql`${schema.editionSignals.payoutCents} + ${payout}` })
    .where(
      and(
        eq(schema.editionSignals.editionId, editionId),
        eq(schema.editionSignals.signalId, signalId),
      ),
    )
    .run();

  await db
    .update(schema.agents)
    .set({ totalEarnedCents: sql`${schema.agents.totalEarnedCents} + ${payout}` })
    .where(eq(schema.agents.id, contributor.agentId))
    .run();

  const payoutAddress = contributor.payoutAddress || contributor.agentAddress;
  const ledgerId = await recordLedgerEntry({
    type: "payout",
    amountCents: payout,
    description: "Contributor share of an x402 signal-intelligence sale",
    toAddress: payoutAddress,
    editionId,
  });

  if (payoutAddress) {
    const targets: PayoutTarget[] = [{ ledgerId, address: payoutAddress, amountCents: payout }];
    afterResponse(() =>
      executePayouts(targets)
        .then(async (results) => {
          for (const result of results) {
            if (result.txHash) await setLedgerTx(result.ledgerId, result.txHash);
            else console.error("signal payout not settled:", result.address, result.error);
          }
        })
        .catch((error: unknown) => console.error("on-chain signal payout failed:", error)),
    );
  }
}

/**
 * On-chain payouts are best-effort and belong after the response. Outside a
 * request scope (cron, script, test) `after` refuses to schedule anything, so
 * run the same best-effort work immediately rather than failing a sale the
 * facilitator has already settled.
 */
function afterResponse(work: () => Promise<void>): void {
  try {
    after(work);
  } catch {
    work().catch((error: unknown) =>
      console.error("post-response signal payout failed:", error),
    );
  }
}
