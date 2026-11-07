import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { canonicalJson, sha256, type JsonValue } from "@/lib/world/actions";
import type {
  CouncilMode,
  CouncilNewsInput,
  CouncilResult,
  MarketIntegritySnapshot,
} from "./types";
import {
  publicCouncilFailure,
  storedCouncilResultSchema,
  storedMarketIntegritySnapshotSchema,
} from "./types";

export async function beginCouncilRun(input: {
  mode: CouncilMode;
  sourceSignalId?: string | null;
  demoScenarioId?: string | null;
  news: CouncilNewsInput;
  verification: JsonValue;
}) {
  const db = await getDb();
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const inputHash = sha256(
    canonicalJson({ news: input.news, verification: input.verification } as unknown as JsonValue),
  );
  await db
    .insert(schema.councilRuns)
    .values({
      id,
      mode: input.mode,
      sourceSignalId: input.sourceSignalId ?? null,
      demoScenarioId: input.demoScenarioId ?? null,
      inputHash,
      newsJson: canonicalJson(input.news as unknown as JsonValue),
      verificationJson: canonicalJson(input.verification),
      status: "pending",
      createdAt,
    })
    .run();
  return { id, inputHash, createdAt };
}

export async function completeCouncilRun(
  id: string,
  market: MarketIntegritySnapshot,
  council: CouncilResult,
) {
  const db = await getDb();
  const completedAt = new Date().toISOString();
  await db
    .update(schema.councilRuns)
    .set({
      marketSnapshotJson: canonicalJson(market as unknown as JsonValue),
      councilJson: canonicalJson(council as unknown as JsonValue),
      status: "completed",
      error: null,
      validUntil: council.validUntil,
      completedAt,
    })
    .where(eq(schema.councilRuns.id, id))
    .run();
}

export async function failCouncilRun(id: string, error: unknown) {
  const db = await getDb();
  const detail = publicCouncilFailure(error);
  await db
    .update(schema.councilRuns)
    .set({
      status: "failed",
      error: detail.slice(0, 500),
      completedAt: new Date().toISOString(),
    })
    .where(eq(schema.councilRuns.id, id))
    .run();
}

export async function councilRunById(id: string) {
  const db = await getDb();
  return db.select().from(schema.councilRuns).where(eq(schema.councilRuns.id, id)).get();
}

export async function recentCouncilRuns(mode: CouncilMode, limit = 20) {
  const db = await getDb();
  return db
    .select()
    .from(schema.councilRuns)
    .where(eq(schema.councilRuns.mode, mode))
    .orderBy(desc(schema.councilRuns.createdAt))
    .limit(Math.min(Math.max(limit, 1), 50));
}

export async function latestLiveCouncilRun(signalId: string) {
  const db = await getDb();
  return db
    .select()
    .from(schema.councilRuns)
    .where(
      and(
        eq(schema.councilRuns.mode, "live"),
        eq(schema.councilRuns.sourceSignalId, signalId),
        eq(schema.councilRuns.status, "completed"),
      ),
    )
    .orderBy(desc(schema.councilRuns.createdAt))
    .limit(1)
    .get();
}

export async function latestCouncilRunForSignal(signalId: string) {
  const db = await getDb();
  return db
    .select()
    .from(schema.councilRuns)
    .where(
      and(
        eq(schema.councilRuns.mode, "live"),
        eq(schema.councilRuns.sourceSignalId, signalId),
      ),
    )
    .orderBy(desc(schema.councilRuns.createdAt))
    .limit(1)
    .get();
}

export function publicCouncilRun(row: typeof schema.councilRuns.$inferSelect) {
  const parse = (raw: string | null) => {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  };
  return {
    id: row.id,
    mode: row.mode,
    source_signal_id: row.sourceSignalId,
    demo_scenario_id: row.demoScenarioId,
    input_hash: row.inputHash,
    news: parse(row.newsJson),
    verification: parse(row.verificationJson),
    market_snapshot: parse(row.marketSnapshotJson),
    council: parse(row.councilJson),
    status: row.status,
    error: row.error,
    valid_until: row.validUntil,
    created_at: row.createdAt,
    completed_at: row.completedAt,
  };
}

/**
 * Public live-decision summary for the trade desk. It deliberately omits the
 * paid story body, Herald notes, detailed agent reasoning and executable
 * provider payloads. Full reasoning remains in the receipt-gated intel result.
 */
export function publicLiveCouncilSummary(
  row: typeof schema.councilRuns.$inferSelect | null | undefined,
) {
  if (!row?.councilJson || row.mode !== "live" || row.status !== "completed") return null;
  let rawCouncil: unknown;
  let rawMarket: unknown;
  try {
    rawCouncil = JSON.parse(row.councilJson);
    rawMarket = JSON.parse(row.marketSnapshotJson ?? "null");
  } catch {
    return null;
  }
  const council = storedCouncilResultSchema.safeParse(rawCouncil);
  const market = storedMarketIntegritySnapshotSchema.safeParse(rawMarket);
  if (!council.success || !market.success) return null;
  return {
    id: row.id,
    status: row.status,
    valid_until: row.validUntil,
    generated_at: council.data.generatedAt,
    action: council.data.action,
    consensus: council.data.consensus,
    consensus_confidence: council.data.consensusConfidence,
    execution_eligible: council.data.executionEligible,
    entry_price_usd: council.data.entryPriceUsd,
    stop_loss_price_usd: council.data.stopLossPriceUsd,
    take_profit_price_usd: council.data.takeProfitPriceUsd,
    risk_reward: council.data.riskReward,
    agents: council.data.opinions.map((opinion) => ({
      role: opinion.role,
      vote: opinion.vote,
      confidence: opinion.confidence,
      veto: opinion.veto,
    })),
    market: {
      definitive_price_usd: market.data.executionQuote.impliedPriceUsd,
      definitive_quote_id: market.data.executionQuote.providerQuoteId,
      uniswap_price_usd: market.data.referenceQuote?.impliedPriceUsd ?? null,
      uniswap_request_id: market.data.referenceQuote?.providerRequestId ?? null,
      uniswap_quote_id: market.data.referenceQuote?.providerQuoteId ?? null,
      uniswap_routing: market.data.referenceQuote?.routing ?? null,
      uniswap_protocols: market.data.referenceQuote?.protocols ?? [],
      integrity_status: market.data.integrity.status,
      deviation_bps: market.data.integrity.deviationBps,
      maximum_deviation_bps: market.data.integrity.maximumDeviationBps,
      checked_at: market.data.integrity.checkedAt,
    },
  };
}
