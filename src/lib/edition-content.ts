import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "./db";
import { EDITION_PRICE_CENTS } from "./constants";
import { publishedEdition } from "./era";
import type { SettledPayment } from "./x402";
import { splitTags } from "./act-on";
import { retryRead } from "./db/retry";
import { readVerification } from "./herald/verification";
import {
  independentOwnerGroups,
  sourceMetadataListSchema,
  type SourceMetadata,
} from "./evidence";

export type EditionRow = typeof schema.editions.$inferSelect;

export async function findEditionById(id: string): Promise<EditionRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const db = await getDb();
  const edition = await retryRead(() => db
    .select()
    .from(schema.editions)
    .where(and(eq(schema.editions.id, id), publishedEdition))
    .get());
  return edition ?? null;
}

export async function findLatestEdition(): Promise<EditionRow | null> {
  const db = await getDb();
  const edition = await retryRead(() => db
    .select()
    .from(schema.editions)
    .where(publishedEdition)
    .orderBy(sql`${schema.editions.number} DESC`)
    .limit(1)
    .get());
  return edition ?? null;
}

function parseList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

/** The paid edition payload: compact, agent-readable, with the on-chain receipt. */
export async function loadPaidEdition(
  edition: EditionRow,
  payment: SettledPayment,
) {
  const db = await getDb();
  const rows = await retryRead(() => db
    .select({
      position: schema.editionSignals.position,
      signalId: schema.signals.id,
      headline: schema.signals.headline,
      body: schema.signals.body,
      beat: schema.signals.beat,
      score: schema.signals.score,
      sources: schema.signals.sources,
      sourceMetadata: schema.signals.sourceMetadata,
      claims: schema.signals.claims,
      tags: schema.signals.tags,
      verification: schema.signals.verification,
      status: schema.signals.status,
      reporterName: schema.agents.name,
      reporterAddress: schema.agents.address,
    })
    .from(schema.editionSignals)
    .leftJoin(
      schema.signals,
      eq(schema.editionSignals.signalId, schema.signals.id),
    )
    .leftJoin(schema.agents, eq(schema.signals.agentId, schema.agents.id))
    .where(eq(schema.editionSignals.editionId, edition.id))
    .orderBy(schema.editionSignals.position)
    .all());
  const signalIds = rows
    .map((row) => row.signalId)
    .filter((id): id is string => Boolean(id));
  const [snapshots, revisions] = signalIds.length
    ? await Promise.all([
        retryRead(() => db
          .select()
          .from(schema.sourceSnapshots)
          .where(inArray(schema.sourceSnapshots.signalId, signalIds))
          .all()),
        retryRead(() => db
          .select()
          .from(schema.signalRevisions)
          .where(inArray(schema.signalRevisions.signalId, signalIds))
          .orderBy(schema.signalRevisions.createdAt)
          .all()),
      ])
    : [[], []];

  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
  return {
    edition: {
      id: edition.id,
      number: edition.number,
      title: edition.title,
      summary: edition.summary,
      signal_count: edition.signalCount,
      published_at: edition.publishedAt,
      web_url: `${baseUrl}/editions/${edition.id}`,
    },
    signals: rows.map((row) => {
      const { tags, actOn } = splitTags(parseList(row.tags));
      const sources = parseList(row.sources);
      const sourceMetadata = parseSourceMetadata(row.sourceMetadata);
      return {
        position: row.position,
        headline: row.headline ?? "",
        body: row.status === "retracted" ? "" : row.body ?? "",
        beat: row.beat ?? "",
        score: row.score ?? 0,
        status: row.status ?? "unknown",
        retraction_notice:
          row.status === "retracted"
            ? revisions
                .filter((revision) => revision.signalId === row.signalId && revision.action === "retracted")
                .at(-1)?.reason ?? "This story was retracted."
            : null,
        sources: row.status === "retracted" ? [] : sources,
        source_metadata: row.status === "retracted" ? [] : sourceMetadata,
        source_ownership_groups:
          row.status === "retracted" ? [] : independentOwnerGroups(sources, sourceMetadata),
        claims: row.status === "retracted" ? [] : parseObjects(row.claims),
        source_archive: snapshots
          .filter((snapshot) => snapshot.signalId === row.signalId)
          .map((snapshot) => ({
            url: snapshot.url,
            content_hash: snapshot.contentHash,
            title: snapshot.title,
            published_at: snapshot.publishedAt,
            fetched_at: snapshot.fetchedAt,
          })),
        correction_history: revisions
          .filter((revision) => revision.signalId === row.signalId)
          .map((revision) => ({
            action: revision.action,
            reason: revision.reason,
            actor: revision.actor,
            at: revision.createdAt,
          })),
        tags,
        act_on: actOn,
        verification: readVerification(row.verification),
        reporter: {
          name: row.reporterName ?? "Unknown",
          address: row.reporterAddress ?? "",
        },
      };
    }),
    act_on_guide:
      "act_on.world_market_search is a query for World's world_search to see live prediction-market odds on the story; act_on.tokens are symbols or mints to look up with discover_tokens. Read-only checks first; any trade still needs the user's approval.",
    receipt: {
      paid_usd: (EDITION_PRICE_CENTS / 100).toFixed(2),
      payer: payment.payer,
      transaction: payment.transaction,
      network: payment.network,
      split:
        "80% is split by independent human-origin group first, then across that group's stories; extra delegated or unbound wallets cannot multiply a top-level share",
    },
  };
}

function parseObjects(value: string | null): Record<string, unknown>[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === "object" && !Array.isArray(item),
        )
      : [];
  } catch {
    return [];
  }
}

function parseSourceMetadata(value: string | null): SourceMetadata[] {
  const parsed = sourceMetadataListSchema.safeParse(parseObjects(value));
  return parsed.success ? parsed.data : [];
}
