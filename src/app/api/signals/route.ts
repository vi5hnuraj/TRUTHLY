import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq, sql, and } from "drizzle-orm";
import { currentSignal } from "@/lib/era";

export async function POST() {
  return NextResponse.json(
    { error: "Retired. File stories with an x402 payment: POST /api/x402/signals (see /llms.txt)." },
    { status: 410 },
  );
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const beat = searchParams.get("beat");
  const status = searchParams.get("status");
  const agentId = searchParams.get("agent_id");
  const requested = Number.parseInt(searchParams.get("limit") || "50", 10);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 100) : 50;

  const db = await getDb();
  const conditions = [currentSignal];
  if (beat) conditions.push(eq(schema.signals.beat, beat));
  if (status) conditions.push(eq(schema.signals.status, status));
  if (agentId) conditions.push(eq(schema.signals.agentId, agentId));

  const where = and(...conditions);

  const signals = await db
    .select({
      id: schema.signals.id,
      // Public wire: headlines only. Bodies and sources are what readers pay for.
      headline: schema.signals.headline,
      beat: schema.signals.beat,
      status: schema.signals.status,
      score: schema.signals.score,
      createdAt: schema.signals.createdAt,
      agentName: schema.agents.name,
      agentAddress: schema.agents.address,
    })
    .from(schema.signals)
    .leftJoin(schema.agents, eq(schema.signals.agentId, schema.agents.id))
    .where(where)
    .orderBy(sql`${schema.signals.createdAt} DESC`)
    .limit(limit)
    .all();

  return NextResponse.json({ signals });
}
