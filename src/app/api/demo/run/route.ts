import { NextRequest, NextResponse } from "next/server";
import * as z from "zod";
import { checkRateLimit } from "@/lib/rate-limit";
import { demoScenario } from "@/lib/council/scenarios";
import { verifyDemoScenario } from "@/lib/council/demo-herald";
import {
  fetchMarketIntegritySnapshot,
  publicMarketIntegritySnapshot,
} from "@/lib/council/market";
import { runCouncil } from "@/lib/council/orchestrator";
import {
  CouncilUnavailable,
  publicCouncilFailure,
  type CouncilNewsInput,
} from "@/lib/council/types";
import { beginCouncilRun, completeCouncilRun, failCouncilRun, councilRunById, publicCouncilRun } from "@/lib/council/store";
import { createPaperExecution, publicPaperExecution } from "@/lib/council/paper";
import { demoDisabledResponse, demoModeEnabled } from "@/lib/council/mode";
import { WETH_BASE } from "@/lib/flash/trade";
import type { JsonValue } from "@/lib/world/actions";

const schema = z.object({ scenario_id: z.string().min(1).max(80) }).strict();

export async function POST(req: NextRequest) {
  if (!demoModeEnabled()) return demoDisabledResponse();
  const limited = checkRateLimit(req, 10);
  if (limited) return limited;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_demo_request" }, { status: 400 });
  }
  const scenario = demoScenario(parsed.data.scenario_id);
  if (!scenario) return NextResponse.json({ error: "demo_scenario_not_found" }, { status: 404 });

  const verification = verifyDemoScenario(scenario);
  const news: CouncilNewsInput = {
    mode: "demo",
    sourceId: scenario.id,
    headline: scenario.headline,
    body: scenario.body,
    assetSymbol: scenario.assetSymbol,
    assetAddress: WETH_BASE,
    simulated: true,
    verificationKind: "demo_simulation",
    verificationSummary: verification.notes,
    claims: [...scenario.claims],
    evidenceRefs: scenario.claims.map((_, index) => `demo-assumption:${index + 1}`),
  };
  const run = await beginCouncilRun({
    mode: "demo",
    demoScenarioId: scenario.id,
    news,
    verification: verification as unknown as JsonValue,
  });

  try {
    const paperNotionalUsdc = process.env.DEMO_PAPER_NOTIONAL_USDC ?? "100";
    const market = await fetchMarketIntegritySnapshot({
      requireUniswap: false,
      notionalUsdc: paperNotionalUsdc,
      decisionOrigin: "human_mediated",
    });
    const council = await runCouncil(news, market);
    await completeCouncilRun(run.id, market, council);
    const paper = await createPaperExecution({
      councilRunId: run.id,
      demoScenarioId: scenario.id,
      council,
      market,
      notionalUsdc: paperNotionalUsdc,
    });
    const stored = await councilRunById(run.id);
    return NextResponse.json({
      mode: "demo",
      warning:
        "DEMO NEWS + DEMO HERALD VERIFICATION + PAPER EXECUTION. Definitive and Uniswap market reads are real when configured; no transaction was signed or submitted.",
      run: stored ? publicCouncilRun(stored) : null,
      market_snapshot: publicMarketIntegritySnapshot(market),
      paper_execution: paper ? publicPaperExecution(paper) : null,
    });
  } catch (error) {
    await failCouncilRun(run.id, error);
    return NextResponse.json(
      {
        error: error instanceof CouncilUnavailable ? "council_not_configured" : "demo_run_failed",
        detail: publicCouncilFailure(error),
        council_run_id: run.id,
        paper_execution_created: false,
      },
      { status: error instanceof CouncilUnavailable ? 503 : 502 },
    );
  }
}
