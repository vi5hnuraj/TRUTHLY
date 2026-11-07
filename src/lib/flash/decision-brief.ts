import { WETH_BASE } from "./trade";

export type DecisionBlockCode =
  | "story_withdrawn"
  | "not_published"
  | "herald_support_required"
  | "stake_refund_pending"
  | "stake_not_refunded"
  | "asset_not_identified"
  | "asset_not_supported"
  | "council_required"
  | "council_expired"
  | "council_hold"
  | "council_sell"
  | "council_not_executable"
  | "decision_ready";

export type CouncilAction = "BUY" | "SELL" | "HOLD";

export interface DecisionCouncilInput {
  id: string;
  status: string;
  validUntil: string | null;
  action: CouncilAction | null;
  executionEligible: boolean;
  entryPriceUsd: string | null;
  stopLossPriceUsd: string | null;
  takeProfitPriceUsd: string | null;
  riskReward: string | null;
  consensus: string | null;
  consensusConfidence: number | null;
}

export interface PublicDecisionBrief {
  story_eligible: boolean;
  execution_eligible: boolean;
  status: DecisionBlockCode;
  label: string;
  detail: string;
  asset: {
    symbol: "ETH";
    execution_symbol: "WETH";
    network: "Base mainnet";
    pair: "WETH / USDC";
    venue: "Definitive Flash";
    reference: "Uniswap V2/V3/V4";
    address: string;
  } | null;
  direction: {
    action: CouncilAction | null;
    label: string;
    detail: string;
  };
  plan: {
    council_run_id: string;
    entry_price_usd: string;
    stop_loss_price_usd: string;
    take_profit_price_usd: string;
    risk_reward: string | null;
    valid_until: string;
  } | null;
  gates: Array<{
    key: "published" | "herald" | "stake" | "asset" | "council";
    label: string;
    passed: boolean;
    state: string;
  }>;
}

export function buildPublicDecisionBrief(input: {
  status: string;
  published: boolean;
  verdict: string | null;
    stakeStatus: string;
    tokens: string[];
    council?: DecisionCouncilInput | null;
    nowMs?: number;
  }): PublicDecisionBrief {
  const withdrawn = ["retracted", "rejected"].includes(input.status);
  const heraldSupported = ["supported", "partially_supported"].includes(
    input.verdict ?? "",
  );
  const tokens = [...new Set(input.tokens.map((token) => token.trim().toUpperCase()).filter(Boolean))];
  const hasToken = tokens.length > 0;
  const hasSupportedAsset = tokens.some((token) => token === "ETH" || token === "WETH");
  const stakeRefunded = input.stakeStatus === "refunded";
  const storyEligible =
    !withdrawn && input.published && heraldSupported && stakeRefunded && hasSupportedAsset;

  let status: DecisionBlockCode = "council_required";
  let label = "Live Council decision required";
  let detail =
    "Every story gate passed. Convene the five-agent live Council against fresh Definitive and Uniswap market data; no order appears unless it returns an unexpired executable BUY plan.";

  if (withdrawn) {
    status = "story_withdrawn";
    label = "Execution unavailable — story withdrawn";
    detail = "Retracted or rejected stories can never become trading inputs.";
  } else if (!input.published) {
    status = "not_published";
    label = "Execution unavailable — publication required";
    detail = "The story must appear in a published edition before it can enter the decision workflow.";
  } else if (!heraldSupported) {
    status = "herald_support_required";
    label = "Execution unavailable — Herald support required";
    detail = "Only supported or partially supported evidence can become a decision brief.";
  } else if (!stakeRefunded) {
    status = input.stakeStatus === "refund_pending" ? "stake_refund_pending" : "stake_not_refunded";
    label =
      input.stakeStatus === "refund_pending"
        ? "Execution blocked — stake refund pending"
        : "Execution blocked — stake is not refunded";
    detail =
      input.stakeStatus === "refund_pending"
        ? "Herald supports the story, but the reporter's filing stake has not been returned on-chain. TRUTHLY will not present an order until settlement succeeds."
        : `The filing stake is ${input.stakeStatus.replace(/_/g, " ")}. Only a completed on-chain refund unlocks the decision workflow.`;
  } else if (!hasToken) {
    status = "asset_not_identified";
    label = "Execution unavailable — no crypto asset identified";
    detail = "The evidence did not identify a token. TRUTHLY will not guess one from the headline.";
  } else if (!hasSupportedAsset) {
    status = "asset_not_supported";
    label = "Execution unavailable — asset route unsupported";
    detail = `The story identifies ${tokens.join(", ")}, but the current protected Definitive route supports ETH/WETH on Base only.`;
  }

  const council = input.council ?? null;
  const nowMs = input.nowMs ?? Date.now();
  const councilExpiry = council?.validUntil ? Date.parse(council.validUntil) : Number.NaN;
  const councilExpired = Boolean(council) &&
    (!Number.isFinite(councilExpiry) || councilExpiry <= nowMs);
  const entry = council?.entryPriceUsd ? Number(council.entryPriceUsd) : Number.NaN;
  const stop = council?.stopLossPriceUsd ? Number(council.stopLossPriceUsd) : Number.NaN;
  const target = council?.takeProfitPriceUsd ? Number(council.takeProfitPriceUsd) : Number.NaN;
  const validBuyLevels =
    Number.isFinite(entry) &&
    Number.isFinite(stop) &&
    Number.isFinite(target) &&
    stop > 0 &&
    stop < entry &&
    entry < target;
  const executionEligible = Boolean(
    storyEligible &&
      council &&
      council.status === "completed" &&
      !councilExpired &&
      council.action === "BUY" &&
      council.executionEligible &&
      validBuyLevels,
  );

  if (storyEligible && council) {
    if (councilExpired) {
      status = "council_expired";
      label = "Council decision expired";
      detail = "The stored market snapshot is no longer fresh. Convene the live Council again before preparing an order.";
    } else if (council.action === "HOLD") {
      status = "council_hold";
      label = "Council decision — HOLD";
      detail = "The live Council found no executable trade. The thesis remains visible, but the execution ticket stays closed.";
    } else if (council.action === "SELL") {
      status = "council_sell";
      label = "Council decision — SELL";
      detail = "The live Council rejected a long entry. This release is buy-only, so no order ticket is available.";
    } else if (!executionEligible) {
      status = "council_not_executable";
      label = "Council plan is not executable";
      detail = "The Council result is missing a valid BUY level, verified market-integrity state, or execution eligibility. Nothing can be submitted.";
    } else {
      status = "decision_ready";
      label = "Executable Council BUY plan";
      detail = "Every evidence, market-integrity and Council gate passed. The execution ticket is locked to this run's asset and entry, stop and target levels.";
    }
  }

  const direction = !council
    ? {
        action: null,
        label: "Council required",
        detail:
          "No BUY, SELL or HOLD direction is inferred from a headline. Five live Council agents must analyze the paid evidence and fresh markets.",
      }
    : {
        action: council.action,
        label: council.action ? `Council ${council.action}` : "Council incomplete",
        detail: council.consensus
          ? `${council.consensus.replace(/_/g, " ")} consensus${council.consensusConfidence === null ? "" : ` at ${council.consensusConfidence}% confidence`}.`
          : "The Council run did not produce a complete direction.",
      };

  return {
    story_eligible: storyEligible,
    execution_eligible: executionEligible,
    status,
    label,
    detail,
    asset: hasSupportedAsset
      ? {
          symbol: "ETH",
          execution_symbol: "WETH",
          network: "Base mainnet",
          pair: "WETH / USDC",
          venue: "Definitive Flash",
          reference: "Uniswap V2/V3/V4",
          address: WETH_BASE.toLowerCase(),
        }
      : null,
    direction,
    plan: executionEligible && council?.validUntil && council.entryPriceUsd &&
        council.stopLossPriceUsd && council.takeProfitPriceUsd
      ? {
          council_run_id: council.id,
          entry_price_usd: council.entryPriceUsd,
          stop_loss_price_usd: council.stopLossPriceUsd,
          take_profit_price_usd: council.takeProfitPriceUsd,
          risk_reward: council.riskReward,
          valid_until: council.validUntil,
        }
      : null,
    gates: [
      {
        key: "published",
        label: "Published edition",
        passed: input.published && !withdrawn,
        state: withdrawn ? input.status : input.published ? "passed" : "missing",
      },
      {
        key: "herald",
        label: "Herald evidence",
        passed: heraldSupported,
        state: input.verdict ?? "unchecked",
      },
      {
        key: "stake",
        label: "On-chain stake refund",
        passed: stakeRefunded,
        state: input.stakeStatus,
      },
      {
        key: "asset",
        label: "Executable crypto route",
        passed: hasSupportedAsset,
        state: hasSupportedAsset ? "ETH → WETH/USDC on Base" : hasToken ? tokens.join(", ") : "missing",
      },
      {
        key: "council",
        label: "Live Council direction",
        passed: executionEligible,
        state: !council
          ? "not run"
          : councilExpired
            ? "expired"
            : council.action
              ? `${council.action}${council.consensus ? ` · ${council.consensus.replace(/_/g, " ")}` : ""}`
              : council.status,
      },
    ],
  };
}

/** Convert the persisted Council JSON into the small decision-gate shape. */
export function decisionCouncilFromStoredRun(
  row: {
    id: string;
    status: string;
    validUntil: string | null;
    councilJson: string | null;
  } | null | undefined,
): DecisionCouncilInput | null {
  if (!row?.councilJson) return null;
  try {
    const value = JSON.parse(row.councilJson) as Record<string, unknown>;
    const action = ["BUY", "SELL", "HOLD"].includes(String(value.action))
      ? (String(value.action) as CouncilAction)
      : null;
    const nullableText = (key: string) =>
      typeof value[key] === "string" && value[key] ? String(value[key]) : null;
    return {
      id: row.id,
      status: row.status,
      validUntil: row.validUntil,
      action,
      executionEligible: value.executionEligible === true,
      entryPriceUsd: nullableText("entryPriceUsd"),
      stopLossPriceUsd: nullableText("stopLossPriceUsd"),
      takeProfitPriceUsd: nullableText("takeProfitPriceUsd"),
      riskReward: nullableText("riskReward"),
      consensus: nullableText("consensus"),
      consensusConfidence:
        typeof value.consensusConfidence === "number" &&
        Number.isFinite(value.consensusConfidence)
          ? value.consensusConfidence
          : null,
    };
  } catch {
    return null;
  }
}
