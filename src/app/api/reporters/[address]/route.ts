import { NextRequest, NextResponse } from "next/server";
import { retryRead } from "@/lib/db/retry";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { currentAgent, currentLedger, currentSignal } from "@/lib/era";

const usd = (cents: number) => (cents / 100).toFixed(2);

/** A reporter wallet's public record: stories, credited earnings and on-chain payouts. */
async function readOnlyGET(_req: NextRequest, { params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "address must be a 0x EVM address" }, { status: 400 });
  }
  const wallet = address.toLowerCase();
  const db = await getDb();

  let agents = await db
    .select()
    .from(schema.agents)
    .where(and(sql`LOWER(${schema.agents.address}) = ${wallet}`, currentAgent))
    .all();
  const delegation = await db
    .select({ principalId: schema.delegatedAgents.principalId })
    .from(schema.delegatedAgents)
    .where(sql`lower(${schema.delegatedAgents.agentWallet}) = ${wallet}`)
    .get();
  let principalWallets = [wallet];
  if (delegation) {
    const delegated = await db
      .select({ wallet: schema.delegatedAgents.agentWallet })
      .from(schema.delegatedAgents)
      .where(eq(schema.delegatedAgents.principalId, delegation.principalId));
    principalWallets = [...new Set(delegated.map((row) => row.wallet.toLowerCase()))];
    const allAgents = await db.select().from(schema.agents).where(currentAgent).all();
    agents = allAgents.filter((agent) => principalWallets.includes(agent.address.toLowerCase()));
  }
  const agentIds = agents.map((a) => a.id);

  const signals = agentIds.length
    ? await db
        .select({
          id: schema.signals.id,
          headline: schema.signals.headline,
          beat: schema.signals.beat,
          status: schema.signals.status,
          score: schema.signals.score,
          feedback: schema.signals.editorFeedback,
          stakeStatus: schema.signals.stakeStatus,
          createdAt: schema.signals.createdAt,
        })
        .from(schema.signals)
        .where(and(inArray(schema.signals.agentId, agentIds), currentSignal))
        .orderBy(desc(schema.signals.createdAt))
        .limit(10)
        .all()
    : [];

  const payouts = await db
    .select()
    .from(schema.ledger)
    .where(and(eq(schema.ledger.type, "payout"), sql`LOWER(${schema.ledger.toAddress}) = ${wallet}`, currentLedger))
    .orderBy(desc(schema.ledger.createdAt))
    .limit(10)
    .all();

  const refunds = await db
    .select()
    .from(schema.ledger)
    .where(and(eq(schema.ledger.type, "refund"), sql`LOWER(${schema.ledger.toAddress}) = ${wallet}`, currentLedger))
    .orderBy(desc(schema.ledger.createdAt))
    .limit(10)
    .all();

  const totals = await db
    .select({
      credited: sql<number>`COALESCE(SUM(${schema.ledger.amountCents}), 0)`,
      paid: sql<number>`COALESCE(SUM(CASE WHEN ${schema.ledger.txHash} IS NOT NULL THEN ${schema.ledger.amountCents} ELSE 0 END), 0)`,
    })
    .from(schema.ledger)
    .where(and(eq(schema.ledger.type, "payout"), sql`LOWER(${schema.ledger.toAddress}) = ${wallet}`, currentLedger))
    .get();
  const credited = Number(totals?.credited ?? 0);
  const paid = Number(totals?.paid ?? 0);

  return NextResponse.json({
    address: wallet,
    principal_id: delegation?.principalId ?? null,
    independence_group: delegation?.principalId ?? `unbound:${wallet}`,
    delegated_wallets: principalWallets,
    reputation_scope: delegation ? "human_principal" : "wallet",
    found: agents.length > 0,
    name: agents[0]?.name ?? null,
    payout_address:
      agents.find((agent) => agent.address.toLowerCase() === wallet)?.payoutAddress ?? wallet,
    signals_filed: agents.reduce((n, a) => n + a.totalSignals, 0),
    signals_published: agents.reduce((n, a) => n + a.signalsIncluded, 0),
    streak: Math.max(0, ...agents.map((a) => a.currentStreak)),
    credited_usd: usd(credited),
    paid_on_chain_usd: usd(paid),
    payouts: payouts.slice(0, 10).map((p) => ({
      amount_usd: usd(p.amountCents),
      transaction: p.txHash,
      explorer: p.txHash ? `https://basescan.org/tx/${p.txHash}` : null,
      at: p.createdAt,
    })),
    stake_refunds: refunds.map((refund) => ({
      amount_usd: usd(refund.amountCents),
      status: refund.txHash ? "settled" : "pending",
      transaction: refund.txHash,
      explorer: refund.txHash ? `https://basescan.org/tx/${refund.txHash}` : null,
      at: refund.createdAt,
    })),
    recent_signals: signals,
  });
}

/** Read-only handler: retried once on a transient DB failure. */
export async function GET(...args: Parameters<typeof readOnlyGET>) {
  return retryRead(() => readOnlyGET(...args));
}
