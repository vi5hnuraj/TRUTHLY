import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { currentSignal } from "@/lib/era";
import { POST as review } from "../../editor/review/route";
import { POST as compile } from "../../editor/compile/route";
import { POST as publish } from "../../editor/publish/route";
import { retryPendingStakeRefunds } from "@/lib/settle";
import { runMissingLiveCouncils } from "@/lib/council/live";
import { publicCouncilFailure } from "@/lib/council/types";

export const maxDuration = 300;

// Every story that passes Herald makes the next daily edition, so a new reporter never waits on others.
const MIN_STORIES = 1;

const digest = (value: string) => createHash("sha256").update(value).digest();

interface EditorResult {
  ok: boolean;
  status: number;
  body: unknown;
}

/** Herald's daily run: review → compile → publish/email, with safe publish retries. */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get("authorization") ?? "";
  if (!secret || !timingSafeEqual(digest(given), digest(`Bearer ${secret}`))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const editorRequest = (path: string) =>
    new NextRequest(new URL(path, req.url), {
      method: "POST",
      headers: { "x-editor-key": process.env.EDITOR_API_KEY ?? "" },
    });

  const invoke = async (
    handler: (request: NextRequest) => Promise<Response>,
    path: string,
  ): Promise<EditorResult> => {
    const response = await handler(editorRequest(path));
    return {
      ok: response.ok,
      status: response.status,
      body: await response.json().catch(() => null),
    };
  };

  const runCouncilStage = async () => {
    const configured = Number.parseInt(process.env.LIVE_COUNCIL_CRON_LIMIT ?? "3", 10);
    const limit = Number.isFinite(configured) ? Math.min(Math.max(configured, 1), 10) : 3;
    try {
      return await runMissingLiveCouncils(limit);
    } catch (error) {
      return {
        enabled: process.env.LIVE_COUNCIL_AUTO_RUN === "1",
        attempted: 0,
        completed: 0,
        reused: 0,
        failed: 1,
        error: publicCouncilFailure(error),
        results: [],
      };
    }
  };

  // Retry prior durable refund intents once per cron run. New refunds created by
  // this review get their first attempt inside settleStake and wait until the
  // next run after a failure, avoiding two authorizations in one invocation.
  const stakeRefunds = await retryPendingStakeRefunds();
  const reviewed = await invoke(review, "/api/editor/review");
  if (!reviewed.ok) {
    return NextResponse.json(
      {
        error: "Editor review failed; compile and publish were not run.",
        stake_refunds: stakeRefunds,
        reviewed,
      },
      { status: 502 },
    );
  }
  const db = await getDb();
  const ready =
    (
      await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(schema.signals)
        .where(and(eq(schema.signals.status, "included"), currentSignal))
        .get()
    )?.count ?? 0;

  if (Number(ready) < MIN_STORIES) {
    // A previous email attempt may have failed after compilation. Retrying publish is
    // safe because /publish is idempotent and accepts delivery_failed editions.
    const pendingEdition = await db
      .select({ status: schema.editions.status })
      .from(schema.editions)
      .orderBy(sql`${schema.editions.number} DESC`)
      .limit(1)
      .get();
    if (pendingEdition?.status === "compiled" || pendingEdition?.status === "delivery_failed") {
      const published = await invoke(publish, "/api/editor/publish");
      const liveCouncil = await runCouncilStage();
      return NextResponse.json(
        {
          reviewed: reviewed.body,
          stake_refunds: stakeRefunds,
          compiled: null,
          published: published.body,
          live_council: liveCouncil,
          note: "No new edition was compiled; retried the pending publish/email step.",
        },
        { status: published.ok ? 200 : 502 },
      );
    }
    const liveCouncil = await runCouncilStage();
    return NextResponse.json({
      reviewed: reviewed.body,
      stake_refunds: stakeRefunds,
      compiled: null,
      published: null,
      live_council: liveCouncil,
      note: `Waiting for ${MIN_STORIES} verified stories (have ${ready}).`,
    });
  }
  const compiled = await invoke(compile, "/api/editor/compile");
  if (!compiled.ok) {
    return NextResponse.json(
      {
        error: "Editor compile failed; publish was not run.",
        reviewed: reviewed.body,
        stake_refunds: stakeRefunds,
        compiled,
      },
      { status: 502 },
    );
  }

  const published = await invoke(publish, "/api/editor/publish");
  const liveCouncil = await runCouncilStage();
  return NextResponse.json(
    {
      reviewed: reviewed.body,
      stake_refunds: stakeRefunds,
      compiled: compiled.body,
      published: published.body,
      live_council: liveCouncil,
    },
    { status: published.ok ? 200 : 502 },
  );
}
