import { v4 as uuid } from "uuid";
import { getDb, schema } from "./db";
import { and, eq, sql } from "drizzle-orm";
import { currentLedger } from "./era";

type LedgerType = "revenue" | "expense" | "payout" | "refund";

export async function recordLedgerEntry(entry: {
  type: LedgerType;
  amountCents: number;
  description: string;
  fromAddress?: string;
  toAddress?: string;
  txHash?: string;
  editionId?: string;
}): Promise<string> {
  const db = await getDb();
  const id = uuid();
  await db.insert(schema.ledger)
    .values({
      id,
      type: entry.type,
      amountCents: entry.amountCents,
      description: entry.description,
      fromAddress: entry.fromAddress ?? null,
      toAddress: entry.toAddress ?? null,
      txHash: entry.txHash ?? null,
      editionId: entry.editionId ?? null,
      createdAt: new Date().toISOString(),
    })
    .run();
  return id;
}

/** Marks a credited payout as settled on-chain. */
export async function setLedgerTx(id: string, txHash: string) {
  const db = await getDb();
  await db.update(schema.ledger).set({ txHash }).where(eq(schema.ledger.id, id)).run();
}

export async function getFinancials() {
  const db = await getDb();

  const totals = await db
    .select({
      type: schema.ledger.type,
      total: sql<number>`SUM(${schema.ledger.amountCents})`,
      count: sql<number>`COUNT(*)`,
    })
    .from(schema.ledger)
    .where(currentLedger)
    .groupBy(schema.ledger.type)
    .all();

  const recentEntries = await db
    .select()
    .from(schema.ledger)
    .where(currentLedger)
    .orderBy(sql`${schema.ledger.createdAt} DESC`)
    .limit(50)
    .all();

  // Revenue that reached today's newsroom wallet (an early filing paid the previous treasury).
  const treasury = (process.env.TREASURY_ADDRESS ?? "").toLowerCase();
  const received = await db
    .select({ total: sql<number>`COALESCE(SUM(${schema.ledger.amountCents}), 0)` })
    .from(schema.ledger)
    .where(and(currentLedger, eq(schema.ledger.type, "revenue"), sql`lower(${schema.ledger.toAddress}) = ${treasury}`))
    .get();

  const revenue = totals.find((t) => t.type === "revenue")?.total ?? 0;
  const expenses = totals.find((t) => t.type === "expense")?.total ?? 0;
  const payouts = totals.find((t) => t.type === "payout")?.total ?? 0;
  const refunds = totals.find((t) => t.type === "refund")?.total ?? 0;

  return {
    revenueCents: revenue,
    receivedCents: received?.total ?? 0,
    expenseCents: expenses,
    payoutCents: payouts,
    refundCents: refunds,
    profitCents: revenue - expenses - payouts - refunds,
    entries: recentEntries,
  };
}

export async function getEditionFinancials(editionId: string) {
  const db = await getDb();
  return await db
    .select()
    .from(schema.ledger)
    .where(eq(schema.ledger.editionId, editionId))
    .all();
}
