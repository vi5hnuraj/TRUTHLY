import assert from "node:assert/strict";
import { after, test } from "node:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import { WETH_BASE, USDC_BASE } from "../flash/trade";
import {
  LiveCouncilDenied,
  runLiveCouncilForSignal,
} from "./live";
import { publicLiveCouncilSummary } from "./store";
import type { CouncilResult, MarketIntegritySnapshot } from "./types";

const dbFile = path.join(process.cwd(), `.truthly-live-council-test-${process.pid}.db`);
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
delete process.env.TURSO_AUTH_TOKEN;

after(async () => {
  await rm(dbFile, { force: true });
  await rm(`${dbFile}-shm`, { force: true });
  await rm(`${dbFile}-wal`, { force: true });
});

const now = "2026-11-07T12:00:00.000Z";
const validUntil = "2099-11-07T12:30:00.000Z";
const signalId = "10000000-0000-4000-8000-000000000001";

const market: MarketIntegritySnapshot = {
  source: "truthly_cross_market_guard",
  network: "base-mainnet",
  assetSymbol: "ETH",
  assetAddress: WETH_BASE.toLowerCase(),
  contraSymbol: "USDC",
  contraAddress: USDC_BASE.toLowerCase(),
  side: "buy",
  notionalUsdc: "5",
  executionQuote: {
    source: "definitive_flash_quote",
    network: "base-mainnet",
    assetSymbol: "ETH",
    assetAddress: WETH_BASE.toLowerCase(),
    contraSymbol: "USDC",
    contraAddress: USDC_BASE.toLowerCase(),
    side: "buy",
    quotedSpendUsdc: "5",
    quotedReceiveAmount: "0.0022727272727",
    impliedPriceUsd: "2200.00000000",
    priceImpactLimit: "0.05",
    providerQuoteId: "live-test-definitive",
    fetchedAt: now,
    snapshotHash: "live-test-definitive-hash",
  },
  referenceQuote: {
    source: "uniswap_trading_api",
    network: "base-mainnet",
    chainId: 8453,
    assetSymbol: "ETH",
    assetAddress: WETH_BASE.toLowerCase(),
    contraSymbol: "USDC",
    contraAddress: USDC_BASE.toLowerCase(),
    side: "buy",
    exactInputAtomic: "5000000",
    quotedSpendUsdc: "5",
    quotedReceiveAmount: "0.0022675736961",
    impliedPriceUsd: "2205.00000000",
    routing: "CLASSIC",
    protocols: ["V3"],
    routeString: "[V3] USDC -> WETH",
    priceImpactPercent: "0.01",
    gasFeeUsd: "0.01",
    providerRequestId: "live-test-uniswap-request",
    providerQuoteId: "live-test-uniswap-quote",
    blockNumber: "1",
    universalRouterVersion: "2.1.2",
    decisionOrigin: "autonomous",
    fetchedAt: now,
    quoteHash: "live-test-uniswap-hash",
  },
  integrity: {
    status: "verified",
    deviationBps: "22.68",
    maximumDeviationBps: 100,
    policy: "fresh_uniswap_reference_required_for_live_execution",
    reason: null,
    checkedAt: now,
  },
  impliedPriceUsd: "2200.00000000",
  providerQuoteId: "live-test-definitive",
  fetchedAt: now,
  snapshotHash: "live-test-market-hash",
};

const council: CouncilResult = {
  label: "LIVE AI COUNCIL — HERALD VERIFIED",
  mode: "live",
  model: "test-live-council",
  action: "BUY",
  assetSymbol: "ETH",
  assetAddress: WETH_BASE.toLowerCase(),
  entryPriceUsd: "2200",
  stopLossPriceUsd: "2100",
  takeProfitPriceUsd: "2450",
  riskReward: "2.50",
  modelConfidence: 82,
  consensusConfidence: 78,
  consensus: "majority",
  reasoning: "Verified catalyst and cross-market evidence support a bounded test plan.",
  disagreements: [],
  opinions: [
    { role: "alpha_hunter", vote: "BUY", confidence: 84, reasoning: "Evidence-backed opportunity.", risk_flags: [], veto: false },
    { role: "market_analyst", vote: "BUY", confidence: 80, reasoning: "Providers agree inside policy.", risk_flags: [], veto: false },
    { role: "macro_analyst", vote: "BUY", confidence: 76, reasoning: "Catalyst has relevant implications.", risk_flags: [], veto: false },
    { role: "risk_sentinel", vote: "HOLD", confidence: 60, reasoning: "Downside remains bounded by the stop.", risk_flags: [], veto: false },
    { role: "devils_advocate", vote: "SELL", confidence: 55, reasoning: "Alternative interpretation remains possible.", risk_flags: [], veto: false },
  ],
  executionEligible: true,
  validUntil,
  generatedAt: now,
};

async function seedEligibleSignal() {
  const db = await getDb();
  await db.insert(schema.agents).values({
    id: "live-council-agent",
    accountId: "live-council-account",
    chainId: "8453",
    address: `0x${"1".repeat(40)}`,
    name: "Live Council Reporter",
    registeredAt: now,
  }).run();
  await db.insert(schema.signals).values({
    id: signalId,
    agentId: "live-council-agent",
    headline: "Verified Ethereum catalyst enters the live Council",
    body: "The evidence-backed catalyst changes the expected Ethereum market state.",
    sources: JSON.stringify(["https://example.com/a", "https://example.org/b"]),
    claims: JSON.stringify([{ claim: "The catalyst occurred." }]),
    tags: JSON.stringify(["ethereum", "token:ETH"]),
    beat: "infrastructure",
    status: "compiled",
    verification: JSON.stringify({
      verdict: "supported",
      confidence: 0.95,
      notes: "Independent sources support the structured claim.",
      model: "test-herald",
      checked_at: now,
      claim_checks: [],
      source_evidence: [],
    }),
    stakeAtomic: "10000",
    stakeStatus: "refunded",
    createdAt: now,
    updatedAt: now,
  }).run();
  await db.insert(schema.editions).values({
    id: "10000000-0000-4000-8000-000000000002",
    number: 1,
    title: "Live Council Test Edition",
    contentHtml: "<p>test</p>",
    contentText: "test",
    signalCount: 1,
    publishedAt: now,
    createdAt: now,
    status: "published",
  }).run();
  await db.insert(schema.editionSignals).values({
    editionId: "10000000-0000-4000-8000-000000000002",
    signalId,
    position: 1,
  }).run();
}

test("real published news runs through the five-agent live Council and persists a public summary", async () => {
  await seedEligibleSignal();
  let calls = 0;
  const first = await runLiveCouncilForSignal(signalId, {
    dependencies: {
      marketReader: async () => market,
      councilRunner: async (news, receivedMarket) => {
        calls += 1;
        assert.equal(news.mode, "live");
        assert.equal(news.simulated, false);
        assert.equal(news.sourceId, signalId);
        assert.equal(receivedMarket.integrity.status, "verified");
        return council;
      },
    },
  });
  assert.equal(first.reused, false);
  assert.equal(first.row.mode, "live");
  const summary = publicLiveCouncilSummary(first.row);
  assert.equal(summary?.action, "BUY");
  assert.equal(summary?.agents.length, 5);
  assert.equal(summary?.market.integrity_status, "verified");
  assert.equal("reasoning" in (summary?.agents[0] ?? {}), false);

  const reused = await runLiveCouncilForSignal(signalId, {
    reuseCompleted: true,
    dependencies: {
      marketReader: async () => market,
      councilRunner: async () => {
        calls += 1;
        return council;
      },
    },
  });
  assert.equal(reused.reused, true);
  assert.equal(calls, 1);
});

test("live Council never bypasses a pending reporter refund", async () => {
  const db = await getDb();
  await db
    .update(schema.signals)
    .set({ stakeStatus: "refund_pending" })
    .where(eq(schema.signals.id, signalId))
    .run();
  await assert.rejects(
    () => runLiveCouncilForSignal(signalId),
    (error: unknown) => error instanceof LiveCouncilDenied && error.code === "stake_refund_required",
  );
});
