import assert from "node:assert/strict";
import test from "node:test";
import { buildPublicDecisionBrief } from "./decision-brief";

const base = {
  status: "compiled",
  published: true,
  verdict: "supported",
  stakeStatus: "refunded",
  tokens: ["ETH"],
};

test("an ETH story needs a live Council decision after every evidence gate", () => {
  const result = buildPublicDecisionBrief(base);
  assert.equal(result.story_eligible, true);
  assert.equal(result.execution_eligible, false);
  assert.equal(result.status, "council_required");
  assert.equal(result.asset?.pair, "WETH / USDC");
  assert.equal(result.direction.action, null);
  assert.equal(result.gates.find((gate) => gate.key === "council")?.passed, false);
});

test("an unexpired executable Council BUY unlocks its exact plan", () => {
  const result = buildPublicDecisionBrief({
    ...base,
    nowMs: Date.parse("2026-11-07T12:00:00.000Z"),
    council: {
      id: "run-1",
      status: "completed",
      validUntil: "2026-11-07T12:30:00.000Z",
      action: "BUY",
      executionEligible: true,
      entryPriceUsd: "2200",
      stopLossPriceUsd: "2100",
      takeProfitPriceUsd: "2400",
      riskReward: "2.00",
      consensus: "majority",
      consensusConfidence: 76,
    },
  });
  assert.equal(result.status, "decision_ready");
  assert.equal(result.execution_eligible, true);
  assert.equal(result.plan?.council_run_id, "run-1");
  assert.equal(result.direction.action, "BUY");
});

test("HOLD and expired Council results never expose an order plan", () => {
  const hold = buildPublicDecisionBrief({
    ...base,
    nowMs: Date.parse("2026-11-07T12:00:00.000Z"),
    council: {
      id: "run-hold",
      status: "completed",
      validUntil: "2026-11-07T12:30:00.000Z",
      action: "HOLD",
      executionEligible: false,
      entryPriceUsd: null,
      stopLossPriceUsd: null,
      takeProfitPriceUsd: null,
      riskReward: null,
      consensus: "unanimous",
      consensusConfidence: 82,
    },
  });
  assert.equal(hold.status, "council_hold");
  assert.equal(hold.plan, null);

  const expired = buildPublicDecisionBrief({
    ...base,
    nowMs: Date.parse("2026-11-07T13:00:00.000Z"),
    council: {
      id: "run-old",
      status: "completed",
      validUntil: "2026-11-07T12:30:00.000Z",
      action: "BUY",
      executionEligible: true,
      entryPriceUsd: "2200",
      stopLossPriceUsd: "2100",
      takeProfitPriceUsd: "2400",
      riskReward: "2.00",
      consensus: "majority",
      consensusConfidence: 70,
    },
  });
  assert.equal(expired.status, "council_expired");
  assert.equal(expired.execution_eligible, false);
});

test("a pending stake refund blocks the order without hiding the ETH route", () => {
  const result = buildPublicDecisionBrief({ ...base, stakeStatus: "refund_pending" });
  assert.equal(result.story_eligible, false);
  assert.equal(result.status, "stake_refund_pending");
  assert.equal(result.asset?.symbol, "ETH");
  assert.match(result.detail, /not been returned on-chain/i);
});

test("the decision brief never guesses an asset", () => {
  const result = buildPublicDecisionBrief({ ...base, tokens: [] });
  assert.equal(result.story_eligible, false);
  assert.equal(result.status, "asset_not_identified");
  assert.equal(result.asset, null);
});
