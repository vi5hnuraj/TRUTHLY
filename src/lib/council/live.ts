import { and, desc, eq } from "drizzle-orm";
import { splitTags } from "@/lib/act-on";
import { getDb, schema } from "@/lib/db";
import { currentSignal, publishedEdition } from "@/lib/era";
import { WETH_BASE } from "@/lib/flash/trade";
import { readVerification } from "@/lib/herald/verification";
import { uniswapApiConfigured } from "@/lib/uniswap/quote";
import type { JsonValue } from "@/lib/world/actions";
import { fetchMarketIntegritySnapshot, type UniswapQuoteReader, type QuoteReader } from "./market";
import { runCouncil, type CouncilModel } from "./orchestrator";
import {
  beginCouncilRun,
  completeCouncilRun,
  councilRunById,
  failCouncilRun,
  latestCouncilRunForSignal,
  latestLiveCouncilRun,
} from "./store";
import {
  CouncilUnavailable,
  publicCouncilFailure,
  type CouncilNewsInput,
  type CouncilResult,
  type MarketIntegritySnapshot,
} from "./types";

export class LiveCouncilDenied extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422,
  ) {
    super(message);
    this.name = "LiveCouncilDenied";
  }
}

export class LiveCouncilRunFailed extends Error {
  constructor(
    readonly councilRunId: string,
    readonly causeValue: unknown,
  ) {
    super(publicCouncilFailure(causeValue));
    this.name = "LiveCouncilRunFailed";
  }
}

export interface LiveCouncilDependencies {
  marketReader?: () => Promise<MarketIntegritySnapshot>;
  councilRunner?: (news: CouncilNewsInput, market: MarketIntegritySnapshot) => Promise<CouncilResult>;
  flashQuoteReader?: QuoteReader;
  uniswapQuoteReader?: UniswapQuoteReader;
  model?: CouncilModel;
}

function stringList(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function claimList(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(value)
      ? value.flatMap((item) =>
          item && typeof item === "object" && typeof (item as { claim?: unknown }).claim === "string"
            ? [(item as { claim: string }).claim]
            : [],
        )
      : [];
  } catch {
    return [];
  }
}

async function liveCouncilNews(signalId: string): Promise<{
  news: CouncilNewsInput;
  verification: NonNullable<ReturnType<typeof readVerification>>;
}> {
  const db = await getDb();
  const signal = await db
    .select()
    .from(schema.signals)
    .where(and(eq(schema.signals.id, signalId), currentSignal))
    .get();
  if (!signal) throw new LiveCouncilDenied("signal_not_found", "No current signal has that id.", 404);
  if (["retracted", "rejected"].includes(signal.status)) {
    throw new LiveCouncilDenied("signal_not_eligible", "Withdrawn stories cannot enter the live Council.");
  }
  const published = await db
    .select({ id: schema.editions.id })
    .from(schema.editionSignals)
    .innerJoin(schema.editions, eq(schema.editions.id, schema.editionSignals.editionId))
    .where(
      and(
        eq(schema.editionSignals.signalId, signal.id),
        publishedEdition,
      ),
    )
    .orderBy(desc(schema.editions.number))
    .limit(1)
    .get();
  if (!published) {
    throw new LiveCouncilDenied(
      "published_edition_required",
      "Only a story in a published current edition can enter the live Council.",
    );
  }
  const verification = readVerification(signal.verification);
  if (!verification || !["supported", "partially_supported"].includes(verification.verdict)) {
    throw new LiveCouncilDenied(
      "herald_verification_required",
      "Only genuinely Herald-verified news can enter the live Council.",
    );
  }
  if (signal.stakeStatus !== "refunded") {
    throw new LiveCouncilDenied(
      "stake_refund_required",
      signal.stakeStatus === "refund_pending"
        ? "The supported story's filing stake refund is still pending on-chain. Council planning remains closed."
        : `The filing stake is ${signal.stakeStatus.replace(/_/g, " ")}; a completed refund is required.`,
    );
  }
  const actOn = splitTags(stringList(signal.tags)).actOn;
  if (!actOn.tokens.some((token) => ["ETH", "WETH"].includes(token.toUpperCase()))) {
    throw new LiveCouncilDenied(
      "unsupported_live_market",
      "The first live Council release supports ETH/WETH on Base only.",
    );
  }
  const snapshots = await db
    .select({ contentHash: schema.sourceSnapshots.contentHash })
    .from(schema.sourceSnapshots)
    .where(eq(schema.sourceSnapshots.signalId, signal.id));
  return {
    news: {
      mode: "live",
      sourceId: signal.id,
      headline: signal.headline,
      body: signal.body,
      assetSymbol: "ETH",
      assetAddress: WETH_BASE,
      simulated: false,
      verificationKind: "herald_live",
      verificationSummary: `${verification.verdict}: ${verification.notes}`,
      claims: claimList(signal.claims),
      evidenceRefs: snapshots.map((snapshot) => `source-hash:${snapshot.contentHash}`),
    },
    verification,
  };
}

export async function runLiveCouncilForSignal(
  signalId: string,
  options: {
    reuseCompleted?: boolean;
    decisionOrigin?: "autonomous" | "human_mediated";
    dependencies?: LiveCouncilDependencies;
  } = {},
) {
  const prepared = await liveCouncilNews(signalId);
  if (options.reuseCompleted) {
    const existing = await latestLiveCouncilRun(signalId);
    if (existing) return { row: existing, reused: true };
  }
  const latest = await latestCouncilRunForSignal(signalId);
  if (
    latest?.status === "pending" &&
    Date.now() - Date.parse(latest.createdAt) < 5 * 60_000
  ) {
    throw new LiveCouncilDenied(
      "council_in_progress",
      "A live Council is already analyzing this signal.",
      409,
    );
  }
  const run = await beginCouncilRun({
    mode: "live",
    sourceSignalId: signalId,
    news: prepared.news,
    verification: prepared.verification as unknown as JsonValue,
  });
  try {
    const dependencies = options.dependencies ?? {};
    const notionalUsdc = process.env.LIVE_COUNCIL_NOTIONAL_USDC?.trim() ||
      process.env.FLASH_MAX_TRADE_USD?.trim() ||
      "5";
    const market = dependencies.marketReader
      ? await dependencies.marketReader()
      : await fetchMarketIntegritySnapshot({
          requireUniswap: true,
          notionalUsdc,
          decisionOrigin: options.decisionOrigin ?? "human_mediated",
          flashQuoteReader: dependencies.flashQuoteReader,
          uniswapQuoteReader: dependencies.uniswapQuoteReader,
        });
    const council = dependencies.councilRunner
      ? await dependencies.councilRunner(prepared.news, market)
      : await runCouncil(prepared.news, market, dependencies.model);
    await completeCouncilRun(run.id, market, council);
    const row = await councilRunById(run.id);
    if (!row) throw new Error("Completed Council run could not be reloaded.");
    return { row, reused: false };
  } catch (error) {
    await failCouncilRun(run.id, error);
    throw new LiveCouncilRunFailed(run.id, error);
  }
}

export const liveCouncilAutoEnabled = () => process.env.LIVE_COUNCIL_AUTO_RUN === "1";

export async function runMissingLiveCouncils(limit = 3) {
  if (!liveCouncilAutoEnabled()) {
    return { enabled: false, attempted: 0, completed: 0, reused: 0, failed: 0, results: [] };
  }
  if (!process.env.COUNCIL_GROQ_API_KEY?.trim() && !process.env.GROQ_API_KEY?.trim()) {
    throw new CouncilUnavailable("Automatic live Council is enabled but no Council model key is configured.");
  }
  if (!uniswapApiConfigured()) {
    throw new CouncilUnavailable("Automatic live Council is enabled but the Uniswap market reference is not configured.");
  }
  const db = await getDb();
  const rows = await db
    .select({
      id: schema.signals.id,
      tags: schema.signals.tags,
      verification: schema.signals.verification,
      stakeStatus: schema.signals.stakeStatus,
      status: schema.signals.status,
    })
    .from(schema.signals)
    .innerJoin(schema.editionSignals, eq(schema.editionSignals.signalId, schema.signals.id))
    .innerJoin(schema.editions, eq(schema.editions.id, schema.editionSignals.editionId))
    .where(and(currentSignal, publishedEdition))
    .orderBy(desc(schema.signals.createdAt))
    .limit(100);
  const seen = new Set<string>();
  const candidates = rows.flatMap((row) => {
    if (seen.has(row.id)) return [];
    seen.add(row.id);
    const verification = readVerification(row.verification);
    const tokens = splitTags(stringList(row.tags)).actOn.tokens;
    return !["retracted", "rejected"].includes(row.status) &&
      row.stakeStatus === "refunded" &&
      Boolean(verification && ["supported", "partially_supported"].includes(verification.verdict)) &&
      tokens.some((token) => ["ETH", "WETH"].includes(token.toUpperCase()))
      ? [row.id]
      : [];
  }).slice(0, Math.min(Math.max(limit, 1), 10));

  const results: Array<Record<string, unknown>> = [];
  for (const signalId of candidates) {
    try {
      const result = await runLiveCouncilForSignal(signalId, {
        reuseCompleted: true,
        decisionOrigin: "autonomous",
      });
      let action: string | null = null;
      try {
        action = result.row.councilJson
          ? String((JSON.parse(result.row.councilJson) as { action?: unknown }).action ?? "") || null
          : null;
      } catch {
        action = null;
      }
      results.push({
        signal_id: signalId,
        council_run_id: result.row.id,
        status: result.reused ? "reused" : "completed",
        action,
      });
    } catch (error) {
      results.push({
        signal_id: signalId,
        status: "failed",
        detail: error instanceof LiveCouncilDenied ? error.message : publicCouncilFailure(error),
        council_run_id: error instanceof LiveCouncilRunFailed ? error.councilRunId : null,
      });
    }
  }
  return {
    enabled: true,
    attempted: candidates.length,
    completed: results.filter((result) => result.status === "completed").length,
    reused: results.filter((result) => result.status === "reused").length,
    failed: results.filter((result) => result.status === "failed").length,
    results,
  };
}
