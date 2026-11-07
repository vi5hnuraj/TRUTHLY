import { NextRequest, NextResponse } from "next/server";
import { retryRead } from "@/lib/db/retry";
import { getDb, schema } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { publishedEdition } from "@/lib/era";
import { splitTags } from "@/lib/act-on";
import { readVerification } from "@/lib/herald/verification";

async function readOnlyGET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  void req;
  const { id } = await params;
  const db = await getDb();

  const edition = await db
    .select()
    .from(schema.editions)
    .where(and(eq(schema.editions.id, id), publishedEdition))
    .get();

  if (!edition) {
    return NextResponse.json({ error: "Edition not found" }, { status: 404 });
  }

  const includedSignals = await db
    .select({
      position: schema.editionSignals.position,
      payoutCents: schema.editionSignals.payoutCents,
      headline: schema.signals.headline,
      beat: schema.signals.beat,
      score: schema.signals.score,
      tags: schema.signals.tags,
      verification: schema.signals.verification,
      status: schema.signals.status,
      agentName: schema.agents.name,
      agentAddress: schema.agents.address,
    })
    .from(schema.editionSignals)
    .leftJoin(
      schema.signals,
      eq(schema.editionSignals.signalId, schema.signals.id),
    )
    .leftJoin(schema.agents, eq(schema.signals.agentId, schema.agents.id))
    .where(eq(schema.editionSignals.editionId, id))
    .orderBy(schema.editionSignals.position)
    .all();

  // Strip full content from API response — full content is gated by x402 on /api/editions/latest
  const editionPreview: Partial<typeof edition> = { ...edition };
  delete editionPreview.contentHtml;
  delete editionPreview.contentText;
  return NextResponse.json({
    edition: editionPreview,
    signals: includedSignals.map(({ tags, verification, ...signal }) => {
      let parsed: string[] = [];
      try {
        const value: unknown = JSON.parse(tags ?? "[]");
        if (Array.isArray(value))
          parsed = value.filter((t): t is string => typeof t === "string");
      } catch {
        parsed = [];
      }
      const { tags: plain, actOn } = splitTags(parsed);
      // Only the verdict is public; Herald's notes are part of the paid edition.
      const verdict = readVerification(verification)?.verdict ?? null;
      return {
        ...signal,
        tags: plain,
        act_on: signal.status === "retracted" ? { world_market_search: null, tokens: [] } : actOn,
        verdict,
      };
    }),
  });
}

/** Read-only handler: retried once on a transient DB failure. */
export async function GET(...args: Parameters<typeof readOnlyGET>) {
  return retryRead(() => readOnlyGET(...args));
}
