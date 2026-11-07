import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { retryRead } from "@/lib/db/retry";

function parseList(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

async function readOnlyGET(req: NextRequest) {
  const requested = Number.parseInt(req.nextUrl.searchParams.get("limit") || "25", 10);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 100) : 25;
  const status = req.nextUrl.searchParams.get("status") || "candidate";
  if (!/^(candidate|researched|filed|dismissed)$/.test(status)) {
    return NextResponse.json({ error: "Invalid candidate status" }, { status: 400 });
  }
  const db = await getDb();
  const rows = await db
    .select()
    .from(schema.scoutCandidates)
    .where(eq(schema.scoutCandidates.status, status))
    .orderBy(desc(schema.scoutCandidates.publishedAt), desc(schema.scoutCandidates.discoveredAt))
    .limit(limit)
    .all();

  return NextResponse.json({
    candidates: rows.map((row) => ({
      id: row.id,
      headline: row.headline,
      summary: row.summary,
      beat: row.beat,
      tags: parseList(row.tags),
      sources: parseList(row.sources),
      canonical_url: row.canonicalUrl,
      source_kind: row.sourceKind,
      published_at: row.publishedAt,
      discovered_at: row.discoveredAt,
      status: row.status,
    })),
    filing_note:
      "Candidates are not verified or filed. Gather independent evidence before using the paid filing route.",
  });
}

export async function GET(...args: Parameters<typeof readOnlyGET>) {
  return retryRead(() => readOnlyGET(...args));
}
