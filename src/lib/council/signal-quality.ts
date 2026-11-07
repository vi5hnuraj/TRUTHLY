export interface SignalQualityCouncil {
  action: "BUY" | "SELL" | "HOLD" | null;
  consensus: string | null;
  consensusConfidence: number | null;
  executionEligible: boolean;
  validUntil: string | null;
  entryPriceUsd: string | null;
  stopLossPriceUsd: string | null;
  takeProfitPriceUsd: string | null;
  riskReward: string | null;
  opinions: Array<{ role: string; vote: string; confidence: number; veto: boolean }>;
}

export interface SignalQualityMarket {
  status: "verified" | "unavailable" | "deviation_exceeded" | null;
  deviationBps: string | null;
  maximumDeviationBps: number | null;
}

export interface SignalQualityInput {
  published: boolean;
  withdrawn: boolean;
  verdict: string | null;
  heraldConfidence: number | null;
  sourceCount: number;
  claimCheckCount: number;
  stakeStatus: string;
  assetSupported: boolean;
  council: SignalQualityCouncil | null;
  market: SignalQualityMarket | null;
  executionReady: boolean;
  nowMs?: number;
}

export interface SignalQualityResult {
  score: number;
  final_score: number | null;
  assessed_score: number;
  assessed_maximum: number;
  coverage_percent: number;
  grade: "A" | "B" | "C" | "D" | null;
  state: "complete" | "incomplete" | "blocked";
  execution_ready: boolean;
  label: string;
  note: string;
  components: {
    evidence: { score: number; maximum: 40; state: "assessed" };
    accountability: { score: number; maximum: 15; state: "assessed" };
    council: { score: number; maximum: 25; state: "assessed" | "pending" };
    market_integrity: { score: number; maximum: 15; state: "assessed" | "pending" };
    risk_plan: { score: number; maximum: 5; state: "assessed" | "pending" };
  };
  hard_blocks: string[];
  missing: string[];
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), maximum);

function confidenceFraction(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return 0;
  return clamp(value > 1 ? value / 100 : value, 0, 1);
}

function positiveDecimal(value: string | null): number | null {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function planIsValid(council: SignalQualityCouncil): boolean {
  if (council.action === "HOLD") {
    return council.entryPriceUsd === null &&
      council.stopLossPriceUsd === null &&
      council.takeProfitPriceUsd === null;
  }
  const entry = positiveDecimal(council.entryPriceUsd);
  const stop = positiveDecimal(council.stopLossPriceUsd);
  const target = positiveDecimal(council.takeProfitPriceUsd);
  if (!entry || !stop || !target) return false;
  return council.action === "BUY"
    ? stop < entry && entry < target
    : council.action === "SELL"
      ? target < entry && entry < stop
      : false;
}

export function scoreSignalQuality(input: SignalQualityInput): SignalQualityResult {
  const verdictPoints = input.verdict === "supported"
    ? 10
    : input.verdict === "partially_supported"
      ? 7
      : 0;
  const confidencePoints = Math.round(confidenceFraction(input.heraldConfidence) * 15);
  const sourcePoints = Math.round(clamp(input.sourceCount, 0, 4) / 4 * 8);
  const claimPoints = Math.round(clamp(input.claimCheckCount, 0, 4) / 4 * 7);
  const evidence = verdictPoints + confidencePoints + sourcePoints + claimPoints;

  const accountability =
    (input.published && !input.withdrawn ? 5 : 0) +
    (input.stakeStatus === "refunded" ? 5 : 0) +
    (input.assetSupported ? 5 : 0);

  const council = input.council;
  const councilExpired = Boolean(
    council?.validUntil && Date.parse(council.validUntil) <= (input.nowMs ?? Date.now()),
  );
  const consensusPoints = council
    ? council.consensus === "unanimous"
      ? 5
      : council.consensus === "majority"
        ? 4
        : council.consensus === "contested"
          ? 1
          : 0
    : 0;
  const councilConfidence = council?.consensusConfidence ?? 0;
  const confidenceCouncilPoints = council
    ? Math.round(clamp(councilConfidence, 0, 100) / 100 * 12)
    : 0;
  const riskVeto = council?.opinions.some(
    (opinion) => opinion.role === "risk_sentinel" && opinion.veto,
  ) ?? false;
  const councilScore = council
    ? 3 + consensusPoints + confidenceCouncilPoints + (riskVeto ? 0 : 5)
    : 0;

  const market = input.market;
  let marketIntegrity = 0;
  if (market?.status === "verified") {
    marketIntegrity = 10;
    const deviation = Number(market.deviationBps);
    const maximum = Number(market.maximumDeviationBps);
    if (Number.isFinite(deviation) && Number.isFinite(maximum) && maximum > 0) {
      marketIntegrity += Math.round((1 - clamp(deviation / maximum, 0, 1)) * 5);
    }
  }

  let riskPlan = 0;
  if (council && planIsValid(council)) {
    if (council.action === "HOLD") {
      riskPlan = 5;
    } else {
      riskPlan = 3;
      const ratio = positiveDecimal(council.riskReward);
      if (ratio !== null && ratio >= 1) riskPlan += 2;
    }
  }

  const score = clamp(
    evidence + accountability + councilScore + marketIntegrity + riskPlan,
    0,
    100,
  );
  const finalScore = council && market ? score : null;
  const assessedMaximum = 55 + (council ? 30 : 0) + (market ? 15 : 0);
  const assessedScore = evidence + accountability +
    (council ? councilScore + riskPlan : 0) +
    (market ? marketIntegrity : 0);
  const coveragePercent = Math.round(assessedMaximum / 100 * 100);
  const grade = finalScore === null
    ? null
    : finalScore >= 85
      ? "A"
      : finalScore >= 70
        ? "B"
        : finalScore >= 55
          ? "C"
          : "D";
  const hardBlocks: string[] = [];
  const missing: string[] = [];
  if (input.withdrawn) hardBlocks.push("story withdrawn");
  if (!input.published) hardBlocks.push("publication required");
  if (!["supported", "partially_supported"].includes(input.verdict ?? "")) {
    hardBlocks.push("Herald support required");
  }
  if (input.stakeStatus !== "refunded") hardBlocks.push("stake refund incomplete");
  if (!input.assetSupported) hardBlocks.push("executable asset route missing");
  if (!council) missing.push("live five-agent Council");
  if (!market) missing.push("cross-market snapshot");
  if (councilExpired) hardBlocks.push("Council decision expired");
  if (market && market.status !== "verified") {
    hardBlocks.push(
      market.status === "deviation_exceeded"
        ? "Definitive/Uniswap deviation exceeded"
        : "market integrity unavailable",
    );
  }
  if (council?.action === "HOLD") hardBlocks.push("Council action is HOLD");
  if (council?.action === "SELL") hardBlocks.push("buy-only executor cannot express SELL");
  if (riskVeto) hardBlocks.push("Risk Sentinel veto");

  const state = hardBlocks.length > 0
    ? "blocked"
    : missing.length > 0
      ? "incomplete"
      : "complete";
  const label = finalScore === null
    ? hardBlocks.length > 0
      ? "Decision blocked before full analysis"
      : "Decision analysis pending"
    : finalScore >= 85
      ? "High-quality decision"
      : finalScore >= 70
        ? "Moderate-quality decision"
        : finalScore >= 55
          ? "Limited decision quality"
          : "Low decision quality";
  const note = finalScore === null
    ? `${assessedScore} of ${assessedMaximum} currently assessable points earned. Pending layers are not scored as failures.`
    : input.executionReady
      ? "Every execution gate passed; this score measures decision completeness, not expected profit."
      : "The analysis remains visible, but at least one hard gate prevents execution.";

  return {
    score,
    final_score: finalScore,
    assessed_score: assessedScore,
    assessed_maximum: assessedMaximum,
    coverage_percent: coveragePercent,
    grade,
    state,
    execution_ready: input.executionReady,
    label,
    note,
    components: {
      evidence: { score: evidence, maximum: 40, state: "assessed" },
      accountability: { score: accountability, maximum: 15, state: "assessed" },
      council: { score: councilScore, maximum: 25, state: council ? "assessed" : "pending" },
      market_integrity: { score: marketIntegrity, maximum: 15, state: market ? "assessed" : "pending" },
      risk_plan: { score: riskPlan, maximum: 5, state: council ? "assessed" : "pending" },
    },
    hard_blocks: hardBlocks,
    missing,
  };
}
