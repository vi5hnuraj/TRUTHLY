import * as z from "zod";
import type { UniswapQuoteSnapshot } from "@/lib/uniswap/quote";

export const COUNCIL_ACTIONS = ["BUY", "SELL", "HOLD"] as const;
export const COUNCIL_ROLES = [
  "alpha_hunter",
  "market_analyst",
  "macro_analyst",
  "risk_sentinel",
  "devils_advocate",
] as const;

export type CouncilMode = "demo" | "live";
export type CouncilAction = (typeof COUNCIL_ACTIONS)[number];
export type CouncilRole = (typeof COUNCIL_ROLES)[number];

export interface CouncilNewsInput {
  mode: CouncilMode;
  sourceId: string;
  headline: string;
  body: string;
  assetSymbol: string;
  assetAddress: string;
  simulated: boolean;
  verificationKind: "demo_simulation" | "herald_live";
  verificationSummary: string;
  claims: string[];
  evidenceRefs: string[];
}

export interface FlashMarketSnapshot {
  source: "definitive_flash_quote";
  network: "base-mainnet";
  assetSymbol: string;
  assetAddress: string;
  contraSymbol: "USDC";
  contraAddress: string;
  side: "buy";
  quotedSpendUsdc: string;
  quotedReceiveAmount: string;
  impliedPriceUsd: string;
  priceImpactLimit: string;
  providerQuoteId: string;
  fetchedAt: string;
  snapshotHash: string;
}

export type MarketIntegrityStatus =
  | "verified"
  | "unavailable"
  | "deviation_exceeded";

/**
 * Definitive remains the execution venue; Uniswap is an independent Base AMM
 * reference. Live execution requires a fresh `verified` comparison. Demo Mode
 * may retain `unavailable` evidence, but it can never become execution eligible.
 */
export interface MarketIntegritySnapshot {
  source: "truthly_cross_market_guard";
  network: "base-mainnet";
  assetSymbol: string;
  assetAddress: string;
  contraSymbol: "USDC";
  contraAddress: string;
  side: "buy";
  notionalUsdc: string;
  executionQuote: FlashMarketSnapshot;
  referenceQuote: UniswapQuoteSnapshot | null;
  integrity: {
    status: MarketIntegrityStatus;
    deviationBps: string | null;
    maximumDeviationBps: number;
    policy: "fresh_uniswap_reference_required_for_live_execution";
    reason: string | null;
    checkedAt: string;
  };
  /** Canonical execution-price aliases retained for paper accounting. */
  impliedPriceUsd: string;
  providerQuoteId: string;
  fetchedAt: string;
  snapshotHash: string;
}

const decimalText = z.string().regex(/^\d+(?:\.\d+)?$/);

export const storedMarketIntegritySnapshotSchema = z.object({
  source: z.literal("truthly_cross_market_guard"),
  network: z.literal("base-mainnet"),
  assetSymbol: z.string(),
  assetAddress: z.string(),
  contraSymbol: z.literal("USDC"),
  contraAddress: z.string(),
  side: z.literal("buy"),
  notionalUsdc: decimalText,
  executionQuote: z.object({
    source: z.literal("definitive_flash_quote"),
    network: z.literal("base-mainnet"),
    assetSymbol: z.string(),
    assetAddress: z.string(),
    contraSymbol: z.literal("USDC"),
    contraAddress: z.string(),
    side: z.literal("buy"),
    quotedSpendUsdc: decimalText,
    quotedReceiveAmount: decimalText,
    impliedPriceUsd: decimalText,
    priceImpactLimit: decimalText,
    providerQuoteId: z.string(),
    fetchedAt: z.string(),
    snapshotHash: z.string(),
  }),
  referenceQuote: z
    .object({
      source: z.literal("uniswap_trading_api"),
      network: z.literal("base-mainnet"),
      chainId: z.literal(8453),
      assetSymbol: z.string(),
      assetAddress: z.string(),
      contraSymbol: z.literal("USDC"),
      contraAddress: z.string(),
      side: z.literal("buy"),
      exactInputAtomic: z.string().regex(/^\d+$/),
      quotedSpendUsdc: decimalText,
      quotedReceiveAmount: decimalText,
      impliedPriceUsd: decimalText,
      routing: z.literal("CLASSIC"),
      protocols: z.array(z.enum(["V2", "V3", "V4"])).min(1),
      routeString: z.string().nullable(),
      priceImpactPercent: decimalText.nullable(),
      gasFeeUsd: decimalText.nullable(),
      providerRequestId: z.string(),
      providerQuoteId: z.string(),
      blockNumber: z.string().regex(/^\d+$/).nullable(),
      universalRouterVersion: z.literal("2.1.2"),
      decisionOrigin: z.enum(["autonomous", "human_mediated"]),
      fetchedAt: z.string(),
      quoteHash: z.string(),
    })
    .nullable(),
  integrity: z.object({
    status: z.enum(["verified", "unavailable", "deviation_exceeded"]),
    deviationBps: decimalText.nullable(),
    maximumDeviationBps: z.number().int().positive(),
    policy: z.literal("fresh_uniswap_reference_required_for_live_execution"),
    reason: z.string().nullable(),
    checkedAt: z.string(),
  }),
  impliedPriceUsd: decimalText,
  providerQuoteId: z.string(),
  fetchedAt: z.string(),
  snapshotHash: z.string(),
});

/**
 * Model output is untrusted. gpt-oss sometimes returns objects where the schema
 * asks for a short string (for example `disagreements: [{ "issue": "…" }]`).
 * Normalize those into a single bounded sentence instead of failing the whole
 * run or silently dropping the model's content. Non-string shapes without any
 * readable text are still rejected.
 */
const textFromModelValue = (max: number) =>
  z.preprocess((value) => {
    if (typeof value === "string") return value.trim().slice(0, max);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const candidate = ["text", "issue", "reason", "detail", "disagreement", "point", "flag", "note"]
        .map((key) => record[key])
        .find((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
      if (candidate) return candidate.trim().slice(0, max);
      try {
        return JSON.stringify(value).slice(0, max);
      } catch {
        return null;
      }
    }
    return value;
  }, z.string().trim().min(2).max(max));

const textArrayFromModelValue = (max: number, items: number) =>
  z.preprocess((value) => {
    if (!Array.isArray(value)) return value;
    return value.slice(0, items);
  }, z.array(textFromModelValue(max)).max(items));

const actionText = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
  z.enum(COUNCIL_ACTIONS),
);

/** gpt-oss emits bare numbers for price fields the schema wants as decimal strings. */
const priceText = z.preprocess((value) => {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return value.trim();
  return value;
}, z.string());

const boundedConfidence = z.preprocess((value) => {
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return value;
}, z.number().min(0).max(100));

export const councilOpinionSchema = z.object({
  role: z.enum(COUNCIL_ROLES),
  vote: actionText,
  confidence: boundedConfidence,
  reasoning: textFromModelValue(800),
  risk_flags: textArrayFromModelValue(120, 8).default([]),
  veto: z.boolean().default(false),
});

export type CouncilOpinion = z.infer<typeof councilOpinionSchema>;

export const clerkRecommendationSchema = z.object({
  action: actionText,
  entry_price_usd: priceText.nullable(),
  stop_loss_price_usd: priceText.nullable(),
  take_profit_price_usd: priceText.nullable(),
  confidence: boundedConfidence,
  reasoning: textFromModelValue(1_200),
  disagreements: textArrayFromModelValue(180, 8).default([]),
});

export type ClerkRecommendation = z.infer<typeof clerkRecommendationSchema>;

export interface CouncilResult {
  label: "DEMO AI COUNCIL — SIMULATED NEWS" | "LIVE AI COUNCIL — HERALD VERIFIED";
  mode: CouncilMode;
  model: string;
  action: CouncilAction;
  assetSymbol: string;
  assetAddress: string;
  entryPriceUsd: string | null;
  stopLossPriceUsd: string | null;
  takeProfitPriceUsd: string | null;
  riskReward: string | null;
  modelConfidence: number;
  consensusConfidence: number;
  consensus: "unanimous" | "majority" | "contested" | "vetoed";
  reasoning: string;
  disagreements: string[];
  opinions: CouncilOpinion[];
  executionEligible: boolean;
  validUntil: string;
  generatedAt: string;
}

export const storedCouncilResultSchema = z.object({
  label: z.enum(["DEMO AI COUNCIL — SIMULATED NEWS", "LIVE AI COUNCIL — HERALD VERIFIED"]),
  mode: z.enum(["demo", "live"]),
  model: z.string(),
  action: z.enum(COUNCIL_ACTIONS),
  assetSymbol: z.string(),
  assetAddress: z.string(),
  entryPriceUsd: z.string().nullable(),
  stopLossPriceUsd: z.string().nullable(),
  takeProfitPriceUsd: z.string().nullable(),
  riskReward: z.string().nullable(),
  modelConfidence: z.number(),
  consensusConfidence: z.number(),
  consensus: z.enum(["unanimous", "majority", "contested", "vetoed"]),
  reasoning: z.string(),
  disagreements: z.array(z.string()),
  opinions: z.array(councilOpinionSchema),
  executionEligible: z.boolean(),
  validUntil: z.string(),
  generatedAt: z.string(),
});

export class CouncilUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CouncilUnavailable";
  }
}

/** Browser-safe failure text. Full provider/schema details stay in server logs. */
export function publicCouncilFailure(error: unknown): string {
  if (error instanceof CouncilUnavailable) return error.message;
  if (error instanceof z.ZodError) {
    return "A council model returned an invalid structured response. The run stopped safely and no paper execution was created.";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/429|rate.?limit/i.test(message)) {
    return "The council model provider is temporarily rate-limited. Wait one minute before trying once more.";
  }
  if (/timed out|timeout/i.test(message)) {
    return "A council dependency timed out. The run stopped safely and nothing was executed.";
  }
  if (/UNISWAP_API_KEY|Uniswap reference/i.test(message)) {
    return "The Uniswap market reference is unavailable. Live execution remains blocked.";
  }
  return "The council run failed safely. No paper execution or transaction was created.";
}
