import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import * as z from "zod";
import { getDb, schema } from "@/lib/db";
import { verifyEditorAuth } from "@/lib/editor-auth";
import { recordSignalRevision } from "@/lib/revisions";

const rejection = z.object({ signal_id: z.uuid(), reason: z.string().trim().min(3).max(300) }).strict();

/** Editor takedown: pulls a filed signal off the wire and out of future editions. */
export async function POST(req: NextRequest) {
  const auth = await verifyEditorAuth(req);
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: 401 });
  }
  const parsed = rejection.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Body must be {signal_id, reason}" }, { status: 400 });
  }
  const db = await getDb();
  const signal = await db
    .select()
    .from(schema.signals)
    .where(eq(schema.signals.id, parsed.data.signal_id))
    .get();
  if (!signal) return NextResponse.json({ error: "Signal not found" }, { status: 404 });
  const publishedRecord = await db
    .select({ signalId: schema.editionSignals.signalId })
    .from(schema.editionSignals)
    .where(eq(schema.editionSignals.signalId, signal.id))
    .limit(1)
    .get();
  if (publishedRecord || signal.status === "compiled") {
    return NextResponse.json(
      {
        error:
          "This story has entered the public edition record. Use /api/editor/retract with fresh Agent Pass authorization.",
      },
      { status: 409 },
    );
  }
  await db
    .update(schema.signals)
    .set({ status: "rejected", editorFeedback: `Rejected by editor: ${parsed.data.reason}`, updatedAt: new Date().toISOString() })
    .where(eq(schema.signals.id, parsed.data.signal_id))
    .run();
  await recordSignalRevision(
    signal,
    "retracted",
    parsed.data.reason,
    "TRUTHLY editor",
  );
  return NextResponse.json({ signal_id: parsed.data.signal_id, status: "rejected" });
}
