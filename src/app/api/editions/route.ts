import { NextResponse } from "next/server";
import { retryRead } from "@/lib/db/retry";
import { getDb, schema } from "@/lib/db";
import { sql } from "drizzle-orm";
import { publishedEdition } from "@/lib/era";

async function readOnlyGET() {
  const db = await getDb();
  const editions = await db
    .select({
      id: schema.editions.id,
      number: schema.editions.number,
      title: schema.editions.title,
      summary: schema.editions.summary,
      signalCount: schema.editions.signalCount,
      priceCents: schema.editions.priceCents,
      publishedAt: schema.editions.publishedAt,
    })
    .from(schema.editions)
    .where(publishedEdition)
    .orderBy(sql`${schema.editions.number} DESC`)
    .all();

  return NextResponse.json({ editions });
}

/** Read-only handler: retried once on a transient DB failure. */
export async function GET(...args: Parameters<typeof readOnlyGET>) {
  return retryRead(() => readOnlyGET(...args));
}
