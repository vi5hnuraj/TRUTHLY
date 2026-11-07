import assert from "node:assert/strict";
import test from "node:test";
import { scoreSignalQuality, type SignalQualityInput } from "./signal-quality";

const base: SignalQualityInput = {
  published: true,
  withdrawn: false,
  verdict: "supported",
  heraldConfidence: 0.95,
  sourceCount: 4,
  claimCheckCount: 4,
  stakeStatus: "refunded",
  assetSupported: true,
  council: null,
  market: null,
  executionReady: false,
  nowMs: Date.parse("2026-11-07T12:00:00.000Z"),
};

test("verified news without a live Council is explicitly incomplete", () => {
  const quality = scoreSignalQuality(base);
  assert.equal(quality.state, "incomplete");
  assert.equal(quality.final_score, null);
  assert.equal(quality.assessed_maximum, 55);
  assert.equal(quality.components.council.score, 0);
  assert.equal(quality.components.council.state, "pending");
  assert(quality.missing.includes("live five-agent Council"));
  assert.equal(quality.execution_ready, false);
});

test("a fresh verified majority BUY receives a transparent component score", () => {
  const quality = scoreSignalQuality({
    ...base,
    council: {
      action: "BUY",
      consensus: "majority",
      consensusConfidence: 80,
      executionEligible: true,
      validUntil: "2026-11-07T12:30:00.000Z",
      entryPriceUsd: "2200",
      stopLossPriceUsd: "2100",
      takeProfitPriceUsd: "2450",
      riskReward: "2.50",
      opinions: [
        { role: "alpha_hunter", vote: "BUY", confidence: 82, veto: false },
        { role: "risk_sentinel", vote: "HOLD", confidence: 65, veto: false },
      ],
    },
    market: { status: "verified", deviationBps: "20", maximumDeviationBps: 100 },
    executionReady: true,
  });
  assert.equal(quality.state, "complete");
  assert.equal(quality.final_score, quality.score);
  assert.equal(quality.execution_ready, true);
  assert(quality.score >= 85);
  assert.equal(quality.final_score, quality.score);
  assert.equal(quality.components.risk_plan.score, 5);
});

test("a high-confidence HOLD remains a quality decision but never execution ready", () => {
  const quality = scoreSignalQuality({
    ...base,
    council: {
      action: "HOLD",
      consensus: "unanimous",
      consensusConfidence: 90,
      executionEligible: false,
      validUntil: "2026-11-07T12:30:00.000Z",
      entryPriceUsd: null,
      stopLossPriceUsd: null,
      takeProfitPriceUsd: null,
      riskReward: null,
      opinions: [
        { role: "risk_sentinel", vote: "HOLD", confidence: 90, veto: false },
      ],
    },
    market: { status: "verified", deviationBps: "10", maximumDeviationBps: 100 },
    executionReady: false,
  });
  assert(quality.score >= 85);
  assert.equal(quality.execution_ready, false);
  assert(quality.hard_blocks.includes("Council action is HOLD"));
});

test("pending stake and divergent providers remain hard blocks", () => {
  const quality = scoreSignalQuality({
    ...base,
    stakeStatus: "refund_pending",
    market: { status: "deviation_exceeded", deviationBps: "140", maximumDeviationBps: 100 },
  });
  assert(quality.hard_blocks.includes("stake refund incomplete"));
  assert(quality.hard_blocks.includes("Definitive/Uniswap deviation exceeded"));
  assert.equal(quality.final_score, null);
  assert.equal(quality.execution_ready, false);
});
