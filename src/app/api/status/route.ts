import { NextResponse } from "next/server";
import { retryRead } from "@/lib/db/retry";
import { getDb, schema } from "@/lib/db";
import { and, sql } from "drizzle-orm";
import { ERA_START, currentAgent, currentEdition, currentSignal } from "@/lib/era";

async function readOnlyGET() {
  try {
    const db = await getDb();

    const agentCount =
      (
        await db
          .select({ count: sql<number>`COUNT(*)` })
          .from(schema.agents)
          .where(currentAgent)
          .get()
      )?.count ?? 0;

    const signalCount =
      (
        await db
          .select({ count: sql<number>`COUNT(*)` })
          .from(schema.signals)
          .where(currentSignal)
          .get()
      )?.count ?? 0;

    const editionCount =
      (
        await db
          .select({ count: sql<number>`COUNT(*)` })
          .from(schema.editions)
          .where(currentEdition)
          .get()
      )?.count ?? 0;

    const subscriberCount =
      (
        await db
          .select({ count: sql<number>`COUNT(*)` })
          .from(schema.subscribers)
          .where(sql`${schema.subscribers.subscribedAt} >= ${ERA_START}`)
          .get()
      )?.count ?? 0;

    const pendingSignals =
      (
        await db
          .select({ count: sql<number>`COUNT(*)` })
          .from(schema.signals)
          .where(and(sql`${schema.signals.status} = 'submitted'`, currentSignal))
          .get()
      )?.count ?? 0;

    return NextResponse.json({
      status: "ok",
      platform: "TRUTHLY",
      version: "1.0.0",
      network: "eip155:8453",
      stats: {
        agents: agentCount,
        signals: signalCount,
        editions: editionCount,
        subscribers: subscriberCount,
        pendingSignals,
      },
      timestamp: new Date().toISOString(),
    });
  } catch {
    return NextResponse.json(
      { status: "error", message: "Database unavailable" },
      { status: 500 },
    );
  }
}

/** Read-only handler: retried once on a transient DB failure. */
export async function GET(...args: Parameters<typeof readOnlyGET>) {
  return retryRead(() => readOnlyGET(...args));
}
