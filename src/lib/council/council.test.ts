import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import path from "node:path";
import { DEMO_SCENARIOS } from "./scenarios";
import { verifyDemoScenario } from "./demo-herald";
import {
  assertMarketIntegrityExecutable,
  createMarketIntegritySnapshot,
  fetchFlashMarketSnapshot,
  fetchMarketIntegritySnapshot,
} from "./market";
import {
  determineCouncilAction,
  runCouncil,
  validateRecommendationLevels,
  type CouncilModel,
} from "./orchestrator";
import { hypotheticalPnlPercent } from "./paper";
import type {
  CouncilNewsInput,
  CouncilOpinion,
  FlashMarketSnapshot,
  MarketIntegritySnapshot,
} from "./types";
import type { UniswapQuoteSnapshot } from "../uniswap/quote";
import { clerkRecommendationSchema, councilOpinionSchema } from "./types";

const dbFile = path.join(process.cwd(), `.truthly-council-test-${process.pid}.db`);
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
delete process.env.TURSO_AUTH_TOKEN;

after(async () => {
  await rm(dbFile, { force: true });
  await rm(`${dbFile}-shm`, { force: true });
  await rm(`${dbFile}-wal`, { force: true });
});

const FLASH_MARKET: FlashMarketSnapshot = {
  source: "definitive_flash_quote",
  network: "base-mainnet",
  assetSymbol: "ETH",
  assetAddress: "0x4200000000000000000000000000000000000006",
  contraSymbol: "USDC",
  contraAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  side: "buy",
  quotedSpendUsdc: "1",
  quotedReceiveAmount: "0.0002857142857",
  impliedPriceUsd: "3500.00000000",
  priceImpactLimit: "0.05",
  providerQuoteId: "real-provider-quote-fixture",
  fetchedAt: "2026-11-06T12:00:00.000Z",
  snapshotHash: "0xfixture",
};

const UNISWAP_MARKET: UniswapQuoteSnapshot = {
  source: "uniswap_trading_api",
  network: "base-mainnet",
  chainId: 8453,
  assetSymbol: "ETH",
  assetAddress: FLASH_MARKET.assetAddress,
  contraSymbol: "USDC",
  contraAddress: FLASH_MARKET.contraAddress,
  side: "buy",
  exactInputAtomic: "1000000",
  quotedSpendUsdc: "1",
  quotedReceiveAmount: "0.0002853067047",
  impliedPriceUsd: "3505.00000000",
  routing: "CLASSIC",
  protocols: ["V3", "V4"],
  routeString: "[V3/V4] USDC -> WETH",
  priceImpactPercent: "0.010000",
  gasFeeUsd: "0.002",
  providerRequestId: "uniswap-request-fixture",
  providerQuoteId: "uniswap-quote-fixture",
  blockNumber: "53970000",
  universalRouterVersion: "2.1.2",
  decisionOrigin: "human_mediated",
  fetchedAt: "2026-11-06T12:00:00.000Z",
  quoteHash: "0xuniswapfixture",
};

const MARKET: MarketIntegritySnapshot = createMarketIntegritySnapshot({
  executionQuote: FLASH_MARKET,
  referenceQuote: UNISWAP_MARKET,
  checkedAt: "2026-11-06T12:00:00.000Z",
  maximumDeviationBps: 100,
});

test("predefined news and demo Herald output are unmistakably simulated", () => {
  assert.equal(DEMO_SCENARIOS.length, 6);
  assert.deepEqual(new Set(DEMO_SCENARIOS.map((scenario) => scenario.tone)), new Set(["bullish", "bearish", "neutral"]));
  assert(DEMO_SCENARIOS.some((scenario) => /wallet funding/i.test(scenario.headline)));
  for (const scenario of DEMO_SCENARIOS) {
    assert.match(scenario.label, /DEMO NEWS/);
    assert.match(scenario.headline, /^DEMO NEWS:/);
    const verification = verifyDemoScenario(scenario);
    assert.equal(verification.simulated, true);
    assert.match(verification.label, /SIMULATED, NOT A REAL-WORLD FACT CHECK/);
  }
});

test("Definitive quote snapshots retain real provider identity but strip signing data", async () => {
  const snapshot = await fetchFlashMarketSnapshot(async () => ({
    quoteId: "quote-123",
    orderType: "market",
    side: "buy",
    targetAsset: FLASH_MARKET.assetAddress,
    contraAsset: FLASH_MARKET.contraAddress,
    from: { asset: "contra", amount: "1", notional: "1" },
    to: { asset: "target", amount: "0.00025", notional: "1" },
    evm: { orderTypedData: "secret-signing-payload" },
  }));
  assert.equal(snapshot.impliedPriceUsd, "4000.00000000");
  assert.equal(snapshot.providerQuoteId, "quote-123");
  assert.equal("evm" in snapshot, false);
  assert.equal("orderTypedData" in snapshot, false);
});

test("Uniswap reference is a deterministic execution gate, not decorative metadata", () => {
  assert.equal(MARKET.integrity.status, "verified");
  assert.equal(MARKET.integrity.deviationBps, "14.27");
  assert.doesNotThrow(() =>
    assertMarketIntegrityExecutable(MARKET, {
      nowMs: Date.parse("2026-11-06T12:00:20.000Z"),
      maxAgeMs: 30_000,
    }),
  );

  const divergent = createMarketIntegritySnapshot({
    executionQuote: FLASH_MARKET,
    referenceQuote: { ...UNISWAP_MARKET, impliedPriceUsd: "3000.00000000" },
    maximumDeviationBps: 100,
    checkedAt: "2026-11-06T12:00:00.000Z",
  });
  assert.equal(divergent.integrity.status, "deviation_exceeded");
  assert.throws(
    () => assertMarketIntegrityExecutable(divergent),
    /above the 100 bps policy/,
  );

  const unavailable = createMarketIntegritySnapshot({
    executionQuote: FLASH_MARKET,
    referenceQuote: null,
    referenceFailure: "not_configured",
  });
  assert.equal(unavailable.integrity.status, "unavailable");
  assert.throws(() => assertMarketIntegrityExecutable(unavailable), /Uniswap/);
  assert.throws(
    () =>
      createMarketIntegritySnapshot({
        executionQuote: FLASH_MARKET,
        referenceQuote: { ...UNISWAP_MARKET, quotedSpendUsdc: "2" },
      }),
    /same market and notional/,
  );
});

test("cross-market fetch sends the same notional and retains both real provider identities", async () => {
  let flashNotional = "";
  let uniswapNotional = "";
  const snapshot = await fetchMarketIntegritySnapshot({
    notionalUsdc: "2",
    funderAddress: "0x1111111111111111111111111111111111111111",
    now: () => new Date("2026-11-06T12:00:00.000Z"),
    flashQuoteReader: async (order) => {
      flashNotional = order.qty;
      return {
        quoteId: "definitive-same-notional",
        orderType: "market",
        side: "buy",
        targetAsset: FLASH_MARKET.assetAddress,
        contraAsset: FLASH_MARKET.contraAddress,
        from: { asset: "contra", amount: "2", notional: "2" },
        to: { asset: "target", amount: "0.0005714285714", notional: "2" },
      };
    },
    uniswapQuoteReader: async (input) => {
      uniswapNotional = input.notionalUsdc;
      return {
        ...UNISWAP_MARKET,
        quotedSpendUsdc: "2",
        exactInputAtomic: "2000000",
        quotedReceiveAmount: "0.0005706134094",
        providerRequestId: "uniswap-same-notional-request",
        providerQuoteId: "uniswap-same-notional-quote",
      };
    },
  });
  assert.equal(flashNotional, "2");
  assert.equal(uniswapNotional, "2");
  assert.equal(snapshot.executionQuote.providerQuoteId, "definitive-same-notional");
  assert.equal(snapshot.referenceQuote?.providerRequestId, "uniswap-same-notional-request");
  assert.equal(snapshot.integrity.status, "verified");
});

test("council agents vote independently and demo output is never execution eligible", async () => {
  const tokenBudgets: number[] = [];
  const prompts: string[] = [];
  const votes: Record<string, "BUY" | "SELL" | "HOLD"> = {
    "ROLE: Alpha Hunter": "BUY",
    "ROLE: Market Analyst": "BUY",
    "ROLE: Macro Analyst": "BUY",
    "ROLE: Risk Sentinel": "HOLD",
    "ROLE: Devil's Advocate": "SELL",
  };
  const model: CouncilModel = {
    name: "test-council-model",
    async complete(_system, user, maxTokens) {
      tokenBudgets.push(maxTokens);
      prompts.push(user);
      if (user.includes("server-computed action")) {
        return {
          action: "BUY",
          entry_price_usd: "3500",
          stop_loss_price_usd: "3400",
          take_profit_price_usd: "3750",
          confidence: 78,
          reasoning: "Three independent agents support the simulated catalyst while the dissent is retained.",
          disagreements: ["Risk Sentinel preferred HOLD", "Devil's Advocate voted SELL"],
        };
      }
      const match = Object.entries(votes).find(([prefix]) => user.includes(prefix));
      assert(match);
      return {
        vote: match[1],
        confidence: 75,
        reasoning:
          match[0] === "ROLE: Alpha Hunter"
            ? "A".repeat(1_000)
            : `Independent ${match[0]} assessment using only the supplied input and quote.`,
        risk_flags: [],
        veto: false,
      };
    },
  };
  const news: CouncilNewsInput = {
    mode: "demo",
    sourceId: "scenario",
    headline: "DEMO NEWS: scenario",
    body: "Fictional scenario for a deterministic orchestration test.",
    assetSymbol: "ETH",
    assetAddress: MARKET.assetAddress,
    simulated: true,
    verificationKind: "demo_simulation",
    verificationSummary: "Simulated verification only.",
    claims: ["A fictional claim"],
    evidenceRefs: ["demo-assumption:1"],
  };
  const result = await runCouncil(news, MARKET, model);
  assert.equal(result.action, "BUY");
  assert.equal(result.consensus, "majority");
  assert.equal(result.executionEligible, false);
  assert.equal(result.opinions.length, 5);
  assert.equal(result.opinions[0].reasoning.length, 800);
  assert.match(result.label, /DEMO AI COUNCIL/);
  assert.equal(tokenBudgets.length, 6);
  assert(tokenBudgets.every((budget) => budget === 1_200));
  assert.equal(prompts.some((prompt) => prompt.includes("uniswap-request-fixture")), false);
  assert.equal(prompts.some((prompt) => prompt.includes("0xuniswapfixture")), false);
  assert(prompts.some((prompt) => prompt.includes('"protocols":["V3","V4"]')));
});

test("object-shaped model text is normalized to bounded strings, not dropped", () => {
  const clerk = clerkRecommendationSchema.parse({
    action: "HOLD",
    entry_price_usd: null,
    stop_loss_price_usd: null,
    take_profit_price_usd: null,
    confidence: 60,
    reasoning: "The clerk summarizes the deterministic HOLD vote with sufficient detail.",
    disagreements: [
      { issue: "Risk Sentinel required a fresh verified catalyst" },
      { note: "Devil's Advocate argued the scenario alone is not tradeable" },
      "Alpha Hunter and Market Analyst both leaned BUY.",
      { role: "macro_analyst", detail: "No ETH supply or demand change in the scenario." },
    ],
  });
  assert.deepEqual(clerk.disagreements, [
    "Risk Sentinel required a fresh verified catalyst",
    "Devil's Advocate argued the scenario alone is not tradeable",
    "Alpha Hunter and Market Analyst both leaned BUY.",
    "No ETH supply or demand change in the scenario.",
  ]);
  const opinion = councilOpinionSchema.parse({
    role: "risk_sentinel",
    vote: "HOLD",
    confidence: 80,
    reasoning: "The risk sentinel rejects the trade because the catalyst is unverified.",
    risk_flags: [{ flag: "simulated catalyst" }, "single snapshot, no trend data"],
    veto: true,
  });
  assert.deepEqual(opinion.risk_flags, ["simulated catalyst", "single snapshot, no trend data"]);
  assert.throws(() =>
    clerkRecommendationSchema.parse({
      ...clerk,
      disagreements: [null],
    }),
  );
});

test("structured risk veto and contested votes deterministically produce HOLD", () => {
  const base = (role: CouncilOpinion["role"], vote: CouncilOpinion["vote"]): CouncilOpinion => ({
    role,
    vote,
    confidence: 70,
    reasoning: "Sufficiently detailed deterministic council test reasoning.",
    risk_flags: [],
    veto: false,
  });
  const vetoed = [
    base("alpha_hunter", "BUY"),
    base("market_analyst", "BUY"),
    base("macro_analyst", "BUY"),
    { ...base("risk_sentinel", "HOLD"), veto: true },
    base("devils_advocate", "SELL"),
  ];
  assert.deepEqual(determineCouncilAction(vetoed), {
    action: "HOLD",
    consensus: "vetoed",
    agreement: 1,
  });
});

test("price levels and paper P&L use deterministic arithmetic", () => {
  assert.deepEqual(
    validateRecommendationLevels(
      "BUY",
      { entry_price_usd: "3500", stop_loss_price_usd: "3400", take_profit_price_usd: "3750" },
      3500,
    ),
    { entry: "3500", stop: "3400", takeProfit: "3750", riskReward: "2.50" },
  );
  assert.equal(hypotheticalPnlPercent("BUY", 3500, 3570), 2);
  assert.equal(hypotheticalPnlPercent("SELL", 3500, 3430), 2);
  assert.equal(hypotheticalPnlPercent("HOLD", 3500, 9999), 0);
  assert.throws(() =>
    validateRecommendationLevels(
      "BUY",
      { entry_price_usd: "3500", stop_loss_price_usd: "3600", take_profit_price_usd: "3750" },
      3500,
    ),
  );
});

test("demo and council modules have no live execution import or order submission path", async () => {
  const files = [
    "src/lib/council/market.ts",
    "src/lib/council/orchestrator.ts",
    "src/lib/council/paper.ts",
    "src/app/api/demo/run/route.ts",
    "src/app/api/demo/mark/route.ts",
  ];
  for (const file of files) {
    const source = await readFile(path.join(process.cwd(), file), "utf8");
    assert.equal(source.includes("executeFlashTrade"), false, `${file} must not import live execution`);
    assert.equal(source.includes('fetch("https://flash.definitive.fi/v1/order"'), false);
  }
});

test("paper persistence is separate from live trades and marks against a later quote", async () => {
  const [{ getDb, schema }, store, paper] = await Promise.all([
    import("../db"),
    import("./store"),
    import("./paper"),
  ]);
  const news: CouncilNewsInput = {
    mode: "demo",
    sourceId: "paper-test",
    headline: "DEMO NEWS: paper persistence test",
    body: "A fictional scenario used only to test separate paper persistence.",
    assetSymbol: "ETH",
    assetAddress: MARKET.assetAddress,
    simulated: true,
    verificationKind: "demo_simulation",
    verificationSummary: "Simulated verification.",
    claims: ["Fictional"],
    evidenceRefs: ["demo-assumption:1"],
  };
  const run = await store.beginCouncilRun({
    mode: "demo",
    demoScenarioId: "paper-test",
    news,
    verification: { simulated: true },
  });
  const council = {
    label: "DEMO AI COUNCIL — SIMULATED NEWS" as const,
    mode: "demo" as const,
    model: "test",
    action: "BUY" as const,
    assetSymbol: "ETH",
    assetAddress: MARKET.assetAddress,
    entryPriceUsd: "3500",
    stopLossPriceUsd: "3400",
    takeProfitPriceUsd: "3750",
    riskReward: "2.50",
    modelConfidence: 75,
    consensusConfidence: 60,
    consensus: "majority" as const,
    reasoning: "A deterministic paper persistence fixture with no live execution.",
    disagreements: [],
    opinions: [],
    executionEligible: false,
    validUntil: "2026-11-06T13:00:00.000Z",
    generatedAt: "2026-11-06T12:00:00.000Z",
  };
  await store.completeCouncilRun(run.id, MARKET, council);
  const execution = await paper.createPaperExecution({
    councilRunId: run.id,
    demoScenarioId: "paper-test",
    council,
    market: MARKET,
    notionalUsdc: "100",
  });
  assert(execution);
  const later = { ...MARKET, impliedPriceUsd: "3570.00000000", providerQuoteId: "later-quote" };
  const mark = await paper.markPaperExecution(execution.id, later);
  assert.equal(mark?.hypotheticalPnlPercent, "2.000000");
  const db = await getDb();
  assert.equal((await db.select().from(schema.trades)).length, 0);
  assert.equal((await db.select().from(schema.paperExecutions)).length, 1);
  assert.equal((await db.select().from(schema.paperMarks)).length, 1);
});
