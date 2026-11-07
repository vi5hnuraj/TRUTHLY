import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Public correction/retraction audit without leaking paywalled story bodies. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!zUuid(id)) {
    return NextResponse.json({ error: "Invalid signal id" }, { status: 400 });
  }
  const db = await getDb();
  const signal = await db
    .select({ id: schema.signals.id, headline: schema.signals.headline })
    .from(schema.signals)
    .where(eq(schema.signals.id, id))
    .get();
  if (!signal) return NextResponse.json({ error: "Signal not found" }, { status: 404 });
  const revisions = await db
    .select()
    .from(schema.signalRevisions)
    .where(eq(schema.signalRevisions.signalId, id))
    .orderBy(asc(schema.signalRevisions.createdAt))
    .all();
  return NextResponse.json({
    signal_id: id,
    headline: signal.headline,
    history: revisions.map((revision) => ({
      action: revision.action,
      reason: revision.reason,
      actor: revision.actor,
      at: revision.createdAt,
      revision_hash: hash(
        [revision.headline, revision.body, revision.sources, revision.sourceMetadata, revision.claims]
          .filter((value): value is string => value !== null)
          .join("\n"),
      ),
    })),
  });
}

function zUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
