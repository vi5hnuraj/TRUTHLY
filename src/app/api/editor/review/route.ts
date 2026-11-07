import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { currentSignal } from "@/lib/era";
import { scoreSignal } from "@/lib/scoring";
import { verifyEditorAuth } from "@/lib/editor-auth";
import { MAX_SIGNALS_PER_EDITION } from "@/lib/constants";
import { liveSources } from "@/lib/source-check";
import { factCheckAll, withHeraldActOn, withHeraldBonus } from "@/lib/herald/review";
import { refutesStory } from "@/lib/herald/verification";
import { settleStake, type StakeVerdict } from "@/lib/settle";
import { randomUUID } from "node:crypto";
import {
  sourceMetadataListSchema,
  storyClaimsSchema,
} from "@/lib/evidence";
import { recordSignalRevision } from "@/lib/revisions";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const auth = await verifyEditorAuth(req);
  if (!auth.authorized) {
    return NextResponse.json(
      { error: auth.error || "Unauthorized" },
      { status: 401 },
    );
  }

  const db = await getDb();

  // Get all submitted signals
  const submitted = await db
    .select({
      id: schema.signals.id,
      headline: schema.signals.headline,
      body: schema.signals.body,
      sources: schema.signals.sources,
      sourceMetadataRaw: schema.signals.sourceMetadata,
      claimsRaw: schema.signals.claims,
      tags: schema.signals.tags,
      beat: schema.signals.beat,
      agentId: schema.signals.agentId,
      stored: schema.signals.verification,
      agentStreak: schema.agents.currentStreak,
      agentIncluded: schema.agents.signalsIncluded,
    })
    .from(schema.signals)
    .leftJoin(schema.agents, eq(schema.signals.agentId, schema.agents.id))
    // Already-included stories are re-ranked with the wire so an edition never exceeds the cap.
    .where(and(inArray(schema.signals.status, ["submitted", "included"]), currentSignal))
    .orderBy(desc(schema.signals.createdAt))
    .limit(200)
    .all();

  if (submitted.length === 0) {
    return NextResponse.json({ message: "No signals to review", reviewed: 0 });
  }

  // Count signals per beat for diversity scoring
  const beatCounts: Record<string, number> = {};
  for (const s of submitted) {
    beatCounts[s.beat] = (beatCounts[s.beat] || 0) + 1;
  }

  // Verify sources: only URLs that resolve right now count toward the score,
  // and a signal with no live source is rejected outright.
  const now = new Date().toISOString();
  const checked = await Promise.all(
    submitted.map(async (s) => {
      const claims = parseEvidenceArray(s.claimsRaw, storyClaimsSchema);
      const sourceMetadata = parseEvidenceArray(
        s.sourceMetadataRaw,
        sourceMetadataListSchema,
      );
      return {
        ...s,
        claims,
        sourceMetadata,
        live: await liveSources(JSON.parse(s.sources) as string[]),
      };
    }),
  );
  const unverifiable = checked.filter((s) => s.live.length === 0);
  for (const s of unverifiable) {
    await db
      .update(schema.signals)
      .set({
        status: "rejected",
        score: 0,
        editorFeedback:
          "Rejected: none of the cited sources resolved when Herald checked them.",
        updatedAt: now,
      })
      .where(eq(schema.signals.id, s.id))
      .run();
    // TRUTHLY: a story whose sources don't exist has nothing backing it
    // — "unsupported" (nothing contradicts a source that never loaded), and
    // the 1¢ stake is slashed.
    await settleStake(db, s.id, "unsupported", "cited sources did not resolve");
    await recordSignalRevision(
      {
        ...s,
        sourceMetadata: s.sourceMetadataRaw,
        claims: s.claimsRaw,
      },
      "retracted",
      "Herald could not resolve any cited source",
      "Herald",
    );
  }
  const verified = checked.filter((s) => s.live.length > 0);
  if (verified.length === 0) {
    return NextResponse.json({
      message: "No verifiable signals",
      reviewed: checked.length,
      rejected: unverifiable.length,
      included: 0,
    });
  }

  // Herald fact-checks each story against its live sources (paid inference).
  // "contradicted" and "unsupported" are rejected outright; every other verdict
  // moves on to scoring.
  const factChecked = (await factCheckAll(verified)).map((s) => ({
    ...s,
    tagList: withHeraldActOn(JSON.parse(s.tags) as string[], s.verification),
  }));
  for (const signal of factChecked) {
    for (const evidence of signal.verification.source_evidence) {
      const submittedMeta = signal.sourceMetadata.find((source) => source.url === evidence.url);
      await db
        .insert(schema.sourceSnapshots)
        .values({
          id: randomUUID(),
          signalId: signal.id,
          url: evidence.url,
          contentHash: evidence.content_hash,
          title: evidence.title ?? submittedMeta?.title ?? null,
          publishedAt: evidence.published_at ?? submittedMeta?.published_at ?? null,
          fetchedAt: evidence.fetched_at,
        })
        .onConflictDoNothing()
        .run();
    }
  }
  const refuted = factChecked.filter((s) => refutesStory(s.verification.verdict));
  for (const s of refuted) {
    await db
      .update(schema.signals)
      .set({
        status: "rejected",
        score: 0,
        editorFeedback: `Rejected by Herald: ${s.verification.notes}`,
        verification: JSON.stringify(s.verification),
        tags: JSON.stringify(s.tagList),
        updatedAt: now,
      })
      .where(eq(schema.signals.id, s.id))
      .run();
    // TRUTHLY: Herald refuted the story — the stake is slashed. The
    // settlement row records which kind of refutation it was.
    await settleStake(
      db,
      s.id,
      s.verification.verdict as StakeVerdict,
      s.verification.notes.slice(0, 200),
    );
    await recordSignalRevision(
      {
        ...s,
        sourceMetadata: s.sourceMetadataRaw,
        claims: s.claimsRaw,
      },
      "retracted",
      `${s.verification.verdict === "contradicted" ? "Contradicted" : "Unsupported"}: ${s.verification.notes}`,
      "Herald",
    );
  }
  const accepted = factChecked.filter((s) => !refutesStory(s.verification.verdict));

  // Score each signal, plus Herald's verdict bonus
  const scored = accepted.map((s) => {
    const sources = s.live;
    const tags = s.tagList;
    const { score, breakdown } = scoreSignal(
      {
        headline: s.headline,
        body: s.body,
        sources,
        sourceMetadata: s.sourceMetadata,
        tags,
        beat: s.beat,
        agentStreak: s.agentStreak ?? 0,
        agentSignalsIncluded: s.agentIncluded ?? 0,
      },
      beatCounts,
    );
    return {
      ...s,
      score: withHeraldBonus(score, s.verification.verdict),
      breakdown,
    };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Only stories Herald actually checked can run. Unchecked ones (LLM down, sources unreadable,
  // run budget spent) wait on the wire and are checked again on the next run.
  const ranked = scored.filter((s) => s.verification.verdict !== "unchecked");
  const waiting = scored.filter((s) => s.verification.verdict === "unchecked");
  for (const s of waiting) {
    await db
      .update(schema.signals)
      .set({
        status: "submitted",
        score: s.score,
        editorFeedback: `Held: Herald has not fact-checked it yet (${s.verification.notes})`,
        verification: JSON.stringify(s.verification),
        tags: JSON.stringify(s.tagList),
        updatedAt: now,
      })
      .where(eq(schema.signals.id, s.id))
      .run();
    // TRUTHLY: an infra failure must never cost the reporter — refund.
    await settleStake(db, s.id, "unchecked", "Herald could not check this run");
  }

  // The top stories make this edition; the rest stay on the wire for the next one.
  const maxInclude = MAX_SIGNALS_PER_EDITION;

  for (let i = 0; i < ranked.length; i++) {
    const s = ranked[i];
    const status = i < maxInclude ? "included" : "submitted";
    const feedback =
      i < maxInclude
        ? `Included (rank #${i + 1}, score ${s.score.toFixed(1)})`
        : `Held for the next edition (rank #${i + 1}, score ${s.score.toFixed(1)})`;

    await db
      .update(schema.signals)
      .set({
        status,
        score: s.score,
        editorFeedback: feedback,
        verification: JSON.stringify(s.verification),
        tags: JSON.stringify(s.tagList),
        updatedAt: now,
      })
      .where(eq(schema.signals.id, s.id))
      .run();
    // TRUTHLY: Herald checked it and it is not a lie — the stake comes back.
    await settleStake(
      db,
      s.id,
      s.verification.verdict as StakeVerdict,
      "Herald verdict recorded",
    );
  }

  return NextResponse.json({
    message: `Reviewed ${checked.length} signals`,
    reviewed: checked.length,
    rejected: unverifiable.length + refuted.length,
    included: Math.min(maxInclude, ranked.length),
    held_unchecked: waiting.length,
    topSignals: ranked.slice(0, maxInclude).map((s) => ({
      id: s.id,
      headline: s.headline,
      score: s.score,
      beat: s.beat,
    })),
    verdicts: factChecked.map((s) => ({
      id: s.id,
      headline: s.headline,
      verdict: s.verification.verdict,
      confidence: s.verification.confidence,
      notes: s.verification.notes,
      cost_atomic: s.verification.cost_atomic,
      payment_tx: s.verification.payment_tx,
    })),
  });
}

function parseEvidenceArray<T>(
  raw: string | null,
  schema: { safeParse: (value: unknown) => { success: true; data: T[] } | { success: false } },
): T[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}
