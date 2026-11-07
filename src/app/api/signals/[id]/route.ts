import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { retryRead } from "@/lib/db/retry";
import { readVerification } from "@/lib/herald/verification";
import { buildSignalTeaser, findPublicSignal } from "@/lib/intel";

/**
 * GET /api/signals/[id] — the free decision layer for one story: headline,
 * excerpt, evidence summary and the DIY-vs-buy comparison. The body, sources,
 * claims and Herald's notes are only ever returned by the paid /api/intel
 * endpoint (or a valid receipt for it).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const lookup = await findPublicSignal(id);
  if (!lookup.ok) {
    return NextResponse.json(
      { error: lookup.reason, detail: "No such story on the current wire" },
      { status: lookup.reason === "invalid_signal_id" ? 400 : 404 },
    );
  }

  const db = await getDb();
  const snapshots = await retryRead(() =>
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(schema.sourceSnapshots)
      .where(eq(schema.sourceSnapshots.signalId, lookup.row.id))
      .get(),
  );

  return NextResponse.json(
    buildSignalTeaser(lookup.row, {
      snapshotCount: Number(snapshots?.count ?? 0),
      verification: readVerification(lookup.row.verification),
    }),
  );
}
