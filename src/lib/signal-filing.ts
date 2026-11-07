import { v4 as uuid } from "uuid";
import { eq, sql } from "drizzle-orm";
import * as z from "zod";
import { getDb, schema, type DatabaseExecutor } from "./db";
import { BEATS, BEAT_LABELS, SIGNAL_LIMITS, type Beat } from "./constants";
import { scoreSignal } from "./scoring";
import { encodeActOn, isActOnTag } from "./act-on";
import {
  evidenceIssues,
  evidenceUrlSchema,
  independentOwnerGroups,
  isLikelyPrimarySource,
  sourceMetadataListSchema,
  storyClaimsSchema,
} from "./evidence";

export const signalFilingSchema = z
  .object({
    headline: z.string().trim().min(10).max(SIGNAL_LIMITS.headlineMaxLen),
    body: z.string().trim().min(40).max(SIGNAL_LIMITS.bodyMaxLen),
    beat: z.enum(BEATS),
    sources: z
      .array(evidenceUrlSchema)
      .min(SIGNAL_LIMITS.minSources)
      .max(SIGNAL_LIMITS.maxSources),
    source_metadata: sourceMetadataListSchema,
    claims: storyClaimsSchema,
    tags: z
      .array(z.string().trim().min(1).max(40).refine((tag) => !isActOnTag(tag), "Use world_query/tokens instead of prefixed tags"))
      .min(SIGNAL_LIMITS.minTags)
      .max(SIGNAL_LIMITS.maxTags),
    // Act-on hints are cleaned rather than rejected: the published spec describes them
    // loosely ("symbols or mints"), and a hint is never worth failing a paid filing over.
    world_query: z
      .string()
      .max(200)
      .optional()
      .transform((query) => {
        const clean = query?.replace(/[^\p{L}\p{N} .,'%$-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80);
        return clean && clean.length >= 2 ? clean : undefined;
      }),
    tokens: z
      .array(z.string().trim().max(64))
      .max(10)
      .optional()
      .transform((tokens) => {
        const tickers = tokens?.map((token) => token.toUpperCase()).filter((token) => /^[A-Z0-9]{2,10}$/.test(token)).slice(0, 3);
        return tickers && tickers.length > 0 ? tickers : undefined;
      }),
    reporter_name: z.string().trim().min(2).max(60).optional(),
  })
  .strict()
  .superRefine((filing, ctx) => {
    for (const issue of evidenceIssues(
      filing.sources,
      filing.source_metadata,
      filing.claims,
    )) {
      ctx.addIssue({
        code: "custom",
        path: issue.path,
        message: issue.message,
      });
    }
  });

export type SignalFiling = z.infer<typeof signalFilingSchema>;
type AgentRow = typeof schema.agents.$inferSelect;

function defaultName(address: string): string {
  return `Reporter ${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** The paying wallet is the reporter's identity and payout address. */
export async function upsertReporter(
  network: string,
  address: string,
  name?: string,
  database?: DatabaseExecutor,
): Promise<AgentRow> {
  const db = database ?? (await getDb());
  const accountId = `${network}:${address}`;
  const existing = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.accountId, accountId))
    .get();

  if (existing) {
    if (name && existing.name === defaultName(address)) {
      await db.update(schema.agents).set({ name }).where(eq(schema.agents.id, existing.id)).run();
      return { ...existing, name };
    }
    return existing;
  }

  const agent = {
    id: uuid(),
    accountId,
    chainId: network,
    address,
    name: name ?? defaultName(address),
    bio: "Files signals through x402 with a 1¢ stake behind every story.",
    registeredAt: new Date().toISOString(),
  };
  await db.insert(schema.agents).values(agent).onConflictDoNothing().run();
  const created = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.accountId, accountId))
    .get();
  if (!created) throw new Error("reporter row missing after insert");
  return created;
}

async function pendingBeatCounts(database?: DatabaseExecutor): Promise<Record<string, number>> {
  const db = database ?? (await getDb());
  const rows = await db
    .select({ beat: schema.signals.beat, count: sql<number>`COUNT(*)` })
    .from(schema.signals)
    .where(eq(schema.signals.status, "submitted"))
    .groupBy(schema.signals.beat)
    .all();
  const counts: Record<string, number> = Object.fromEntries(BEATS.map((b) => [b, 0]));
  for (const row of rows) counts[row.beat] = Number(row.count);
  return counts;
}

function tipsFor(breakdown: Record<string, number>, counts: Record<string, number>): string[] {
  const tips: string[] = [];
  if ((breakdown.sourceCount ?? 0) < 20) tips.push("Cite at least 3 sources for full source credit.");
  if ((breakdown.sourceQuality ?? 0) < 10) tips.push("Reputable independent outlets add source-quality points.");
  if ((breakdown.primarySources ?? 0) < 5) tips.push("Cite an official release, filing, governance proposal or security advisory for a primary-source bonus.");
  if ((breakdown.headline ?? 0) < 10) tips.push("Keep the headline at 140 characters or fewer.");
  if ((breakdown.bodyDepth ?? 0) < 10) tips.push("Write a body of 50+ words.");
  if ((breakdown.tags ?? 0) < 10) tips.push("Use 3–7 tags.");
  if ((breakdown.diversity ?? 0) === 0) {
    const quietest = [...BEATS].sort((a, b) => (counts[a] ?? 0) - (counts[b] ?? 0))[0];
    tips.push(`This beat is crowded; ${BEAT_LABELS[quietest]} has the fewest pending signals.`);
  }
  return tips;
}

/** Inserts a paid signal and returns the editor's preview score for it. */
export async function fileSignal(
  reporter: AgentRow,
  filing: SignalFiling,
  database?: DatabaseExecutor,
) {
  const db = database ?? (await getDb());
  const counts = await pendingBeatCounts(db);
  const now = new Date().toISOString();
  const id = uuid();

  await db
    .insert(schema.signals)
    .values({
      id,
      agentId: reporter.id,
      headline: filing.headline,
      body: filing.body,
      sources: JSON.stringify(filing.sources),
      sourceMetadata: JSON.stringify(filing.source_metadata),
      claims: JSON.stringify(filing.claims),
      tags: JSON.stringify(encodeActOn(filing.tags, filing.world_query, filing.tokens)),
      beat: filing.beat,
      status: "submitted",
      score: null,
      editorFeedback: null,
      // TRUTHLY: the paid 1¢ filing fee is the stake — locked until Herald settles it.
      stakeAtomic: "10000", // 1¢ in atomic USDC
      stakeStatus: "locked",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  await db
    .insert(schema.signalRevisions)
    .values({
      id: uuid(),
      signalId: id,
      action: "filed",
      headline: filing.headline,
      body: filing.body,
      sources: JSON.stringify(filing.sources),
      sourceMetadata: JSON.stringify(filing.source_metadata),
      claims: JSON.stringify(filing.claims),
      reason: "Initial paid filing",
      actor: reporter.address,
      createdAt: now,
    })
    .run();
  await db
    .update(schema.agents)
    .set({ totalSignals: sql`${schema.agents.totalSignals} + 1` })
    .where(eq(schema.agents.id, reporter.id))
    .run();

  const withThis = { ...counts, [filing.beat]: (counts[filing.beat] ?? 0) + 1 };
  const { score, breakdown } = scoreSignal(
    {
      headline: filing.headline,
      body: filing.body,
      sources: filing.sources,
      sourceMetadata: filing.source_metadata,
      tags: filing.tags,
      beat: filing.beat,
      agentStreak: reporter.currentStreak,
      agentSignalsIncluded: reporter.signalsIncluded,
    },
    withThis,
  );

  return {
    id,
    beat: filing.beat as Beat,
    previewScore: score,
    breakdown,
    tips: tipsFor(breakdown, withThis),
    evidence: {
      independent_source_groups: independentOwnerGroups(
        filing.sources,
        filing.source_metadata,
      ).length,
      primary_sources: filing.source_metadata.filter(isLikelyPrimarySource).length,
      claims: filing.claims.length,
    },
  };
}
