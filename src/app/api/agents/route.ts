import { NextResponse } from "next/server";
import { retryRead } from "@/lib/db/retry";
import { getDb, schema } from "@/lib/db";
import { sql } from "drizzle-orm";
import { currentAgent } from "@/lib/era";

async function readOnlyGET() {
  const db = await getDb();
  const agents = await db
    .select()
    .from(schema.agents)
    .where(currentAgent)
    .orderBy(sql`${schema.agents.signalsIncluded} DESC`)
    .all();

  return NextResponse.json({ agents });
}

/** Read-only handler: retried once on a transient DB failure. */
export async function GET(...args: Parameters<typeof readOnlyGET>) {
  return retryRead(() => readOnlyGET(...args));
}
