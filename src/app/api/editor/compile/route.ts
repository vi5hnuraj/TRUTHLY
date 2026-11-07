import { NextRequest, NextResponse } from "next/server";
import { v4 as uuid } from "uuid";
import { getDb, schema } from "@/lib/db";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { currentAgent, currentSignal } from "@/lib/era";
import { compileEdition } from "@/lib/compiler";
import { EDITION_PRICE_CENTS, MAX_SIGNALS_PER_EDITION } from "@/lib/constants";
import { verifyEditorAuth } from "@/lib/editor-auth";
import { editorsBrief } from "@/lib/herald/brief";

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

  // Get all "included" signals
  const included = await db
    .select({
      id: schema.signals.id,
      headline: schema.signals.headline,
      body: schema.signals.body,
      sources: schema.signals.sources,
      sourceMetadata: schema.signals.sourceMetadata,
      claims: schema.signals.claims,
      tags: schema.signals.tags,
      beat: schema.signals.beat,
      score: schema.signals.score,
      agentId: schema.signals.agentId,
      agentName: schema.agents.name,
      agentAddress: schema.agents.address,
      agentStreak: schema.agents.currentStreak,
    })
    .from(schema.signals)
    .leftJoin(schema.agents, eq(schema.signals.agentId, schema.agents.id))
    .where(and(eq(schema.signals.status, "included"), currentSignal))
    .orderBy(sql`${schema.signals.score} DESC`)
    .limit(MAX_SIGNALS_PER_EDITION)
    .all();

  if (included.length === 0) {
    return NextResponse.json(
      { error: "No included signals. Run /api/editor/review first." },
      { status: 400 },
    );
  }

  // Get next edition number
  const lastEdition = await db
    .select({ number: schema.editions.number })
    .from(schema.editions)
    .orderBy(sql`${schema.editions.number} DESC`)
    .limit(1)
    .get();
  const editionNumber = (lastEdition?.number ?? 0) + 1;

  // Compile the edition (payouts happen at payment time via recordPayment)
  const compiled = await compileEdition({
    editionNumber,
    signals: included.map((s) => ({
      headline: s.headline,
      body: s.body,
      sources: JSON.parse(s.sources),
      sourceMetadata: s.sourceMetadata ? JSON.parse(s.sourceMetadata) : [],
      claims: s.claims ? JSON.parse(s.claims) : [],
      tags: JSON.parse(s.tags),
      beat: s.beat,
      score: s.score ?? 0,
      agentName: s.agentName ?? "Unknown",
      agentAddress: s.agentAddress ?? "",
      agentStreak: s.agentStreak ?? 0,
    })),
  });

  // Herald's paid editor's brief replaces the template summary; on failure the template stays.
  const { brief, costAtomic: briefCostAtomic } = await editorsBrief(
    included.map((s) => ({ headline: s.headline, body: s.body, beat: s.beat })),
  );

  const now = new Date().toISOString();
  const editionId = uuid();

  // Insert edition — revenue starts at 0; actual x402 payments update it
  await db
    .insert(schema.editions)
    .values({
      id: editionId,
      number: editionNumber,
      title: compiled.title,
      summary: brief ?? compiled.summary,
      contentHtml: compiled.contentHtml,
      contentText: compiled.contentText,
      signalCount: included.length,
      priceCents: EDITION_PRICE_CENTS,
      costCents: 0,
      heraldCostAtomic: briefCostAtomic,
      revenueCents: 0,
      publishedAt: now,
      createdAt: now,
      status: "compiled",
    })
    .run();

  // Insert edition_signals and update agent inclusion stats
  for (let i = 0; i < included.length; i++) {
    const s = included[i];

    await db
      .insert(schema.editionSignals)
      .values({
        editionId,
        signalId: s.id,
        position: i + 1,
        payoutCents: 0,
      })
      .run();

    // Mark signal as compiled
    await db
      .update(schema.signals)
      .set({ status: "compiled", updatedAt: now })
      .where(eq(schema.signals.id, s.id))
      .run();

    // Update agent inclusion count (earnings come from actual x402 payments)
    await db
      .update(schema.agents)
      .set({
        signalsIncluded: sql`${schema.agents.signalsIncluded} + 1`,
      })
      .where(eq(schema.agents.id, s.agentId))
      .run();
  }

  // Streaks: reporters with a story in this edition extend theirs; everyone else resets.
  const editionAgents = [...new Set(included.map((s) => s.agentId))];
  await db
    .update(schema.agents)
    .set({
      currentStreak: sql`${schema.agents.currentStreak} + 1`,
      longestStreak: sql`MAX(${schema.agents.longestStreak}, ${schema.agents.currentStreak} + 1)`,
    })
    .where(inArray(schema.agents.id, editionAgents))
    .run();
  await db
    .update(schema.agents)
    .set({ currentStreak: 0 })
    .where(and(notInArray(schema.agents.id, editionAgents), currentAgent))
    .run();

  return NextResponse.json({
    message: `Edition #${editionNumber} compiled`,
    edition: {
      id: editionId,
      number: editionNumber,
      title: compiled.title,
      signalCount: included.length,
    },
  });
}
