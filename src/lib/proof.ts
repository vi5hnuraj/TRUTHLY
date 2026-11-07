import { and, eq, isNotNull, sql } from "drizzle-orm";
import { getDb, schema } from "./db";
import { currentAgent, currentEdition, currentLedger, currentPayment, currentSignal } from "./era";

export interface ProofStats {
  distinct_payer_wallets: number;
  reporter_wallets: number;
  herald_checks: number;
  herald_briefs: number;
  herald_ai_spend_usd: string;
  paid_onchain_usd: string;
  newsroom_wallet: string;
  newsroom_explorer: string;
}

async function distinctPayers(): Promise<number> {
  const db = await getDb();
  const readers = await db
    .select({ address: schema.payments.payerAddress })
    .from(schema.payments)
    .where(currentPayment)
    .all();
  const filers = await db
    .select({ address: schema.ledger.fromAddress })
    .from(schema.ledger)
    .where(and(eq(schema.ledger.type, "revenue"), isNotNull(schema.ledger.fromAddress), currentLedger))
    .all();
  const wallets = new Set(
    [...readers, ...filers].map((r) => (r.address ?? "").toLowerCase()).filter((a) => a.startsWith("0x")),
  );
  return wallets.size;
}

/** Herald's paid AI calls: fact-check receipts on each verification plus each edition's brief. */
async function heraldSpend(): Promise<{ checks: number; briefs: number; atomic: bigint }> {
  const db = await getDb();
  const rows = await db
    .select({ verification: schema.signals.verification })
    .from(schema.signals)
    .where(and(isNotNull(schema.signals.verification), currentSignal))
    .all();
  let checks = 0;
  let atomic = BigInt(0);
  for (const row of rows) {
    try {
      const v = JSON.parse(row.verification ?? "{}") as { verdict?: string; cost_atomic?: string | null };
      if (v.verdict && v.verdict !== "unchecked") checks += 1;
      if (v.cost_atomic && /^\d+$/.test(v.cost_atomic)) atomic += BigInt(v.cost_atomic);
    } catch {
      // A malformed verification is simply not counted.
    }
  }
  const editions = await db
    .select({ cost: schema.editions.heraldCostAtomic })
    .from(schema.editions)
    .where(and(isNotNull(schema.editions.heraldCostAtomic), currentEdition))
    .all();
  let briefs = 0;
  for (const edition of editions) {
    if (!edition.cost || !/^\d+$/.test(edition.cost)) continue;
    briefs += 1;
    atomic += BigInt(edition.cost);
  }
  return { checks, briefs, atomic };
}

export async function getProofStats(): Promise<ProofStats> {
  const db = await getDb();
  const [payers, reporters, herald, paid] = await Promise.all([
    distinctPayers(),
    db.select({ n: sql<number>`COUNT(*)` }).from(schema.agents).where(currentAgent).get(),
    heraldSpend(),
    db
      .select({ cents: sql<number>`COALESCE(SUM(${schema.ledger.amountCents}), 0)` })
      .from(schema.ledger)
      .where(and(eq(schema.ledger.type, "payout"), isNotNull(schema.ledger.txHash), currentLedger))
      .get(),
  ]);
  const wallet = process.env.TREASURY_ADDRESS ?? "";
  return {
    distinct_payer_wallets: payers,
    reporter_wallets: Number(reporters?.n ?? 0),
    herald_checks: herald.checks,
    herald_briefs: herald.briefs,
    herald_ai_spend_usd: (Number(herald.atomic) / 1_000_000).toFixed(4),
    paid_onchain_usd: (Number(paid?.cents ?? 0) / 100).toFixed(2),
    newsroom_wallet: wallet,
    newsroom_explorer: wallet ? `https://basescan.org/address/${wallet}#tokentxns` : "",
  };
}
