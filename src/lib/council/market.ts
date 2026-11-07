import { privateKeyToAccount } from "viem/accounts";
import { isAddress } from "viem";
import * as z from "zod";
import {
  flashQuote,
  USDC_BASE,
  WETH_BASE,
  type FlashOrder,
  type FlashQuote,
} from "@/lib/flash/trade";
import { parseUsdcAtomic } from "@/lib/usdc";
import {
  fetchUniswapQuote,
  UniswapQuoteError,
  type UniswapQuoteInput,
  type UniswapQuoteSnapshot,
} from "@/lib/uniswap/quote";
import { canonicalJson, sha256, type JsonValue } from "@/lib/world/actions";
import type {
  FlashMarketSnapshot,
  MarketIntegritySnapshot,
  MarketIntegrityStatus,
} from "./types";

const safeQuoteSchema = z.object({
  quoteId: z.string().min(1),
  orderType: z.string(),
  side: z.string(),
  targetAsset: z.string(),
  contraAsset: z.string(),
  from: z.object({
    asset: z.string(),
    amount: z.string(),
    notional: z.string(),
  }),
  to: z.object({
    asset: z.string(),
    amount: z.string(),
    notional: z.string(),
  }),
});

export type QuoteReader = (order: FlashOrder) => Promise<FlashQuote>;
export type UniswapQuoteReader = (
  input: UniswapQuoteInput,
) => Promise<UniswapQuoteSnapshot>;

export function marketQuoteAddress(): string {
  const configured = process.env.DEMO_QUOTE_FUNDER_ADDRESS?.trim();
  if (configured && isAddress(configured, { strict: false })) return configured;

  const privateKey = process.env.FLASH_FUNDER_PRIVATE_KEY?.trim();
  if (privateKey && /^(0x)?[0-9a-fA-F]{64}$/.test(privateKey)) {
    return privateKeyToAccount(
      (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as `0x${string}`,
    ).address;
  }

  // Quote-only identity. No key exists for this address and no signing or
  // submission method is available in this module.
  return "0x0000000000000000000000000000000000000001";
}

/** Real Base-mainnet market snapshot from Definitive's read-only /quote API. */
export async function fetchFlashMarketSnapshot(
  quoteReader: QuoteReader = (order) => flashQuote(order),
  options: {
    notionalUsdc?: string;
    funderAddress?: string;
    now?: () => Date;
  } = {},
): Promise<FlashMarketSnapshot> {
  const notionalUsdc = options.notionalUsdc ?? "1";
  const notionalAtomic = parseUsdcAtomic(notionalUsdc);
  if (!notionalAtomic || notionalAtomic <= BigInt(0)) {
    throw new Error("Definitive market snapshot requires a positive USDC notional.");
  }
  const order: FlashOrder = {
    targetChain: "base",
    contraChain: "base",
    targetAsset: WETH_BASE,
    contraAsset: USDC_BASE,
    side: "buy",
    qty: notionalUsdc,
    orderType: "market",
    maxSlippage: "0.01",
    maxPriceImpact: "0.05",
    evmUsePermit2: false,
    forceMinimalAllowance: true,
    funderAddress: options.funderAddress ?? marketQuoteAddress(),
  };
  const raw = await quoteReader(order);
  const parsed = safeQuoteSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Definitive quote returned an unexpected market-data shape.");
  const quote = parsed.data;
  if (
    quote.side !== "buy" ||
    quote.from.asset !== "contra" ||
    quote.to.asset !== "target" ||
    quote.targetAsset.toLowerCase() !== WETH_BASE.toLowerCase() ||
    quote.contraAsset.toLowerCase() !== USDC_BASE.toLowerCase()
  ) {
    throw new Error("Definitive quote does not match the requested Base WETH/USDC market.");
  }

  const spend = Number(quote.from.amount);
  const receive = Number(quote.to.amount);
  const implied = spend / receive;
  if (!(spend > 0) || !(receive > 0) || !Number.isFinite(implied) || implied <= 0) {
    throw new Error("Definitive quote could not produce a valid implied market price.");
  }

  const fetchedAt = (options.now?.() ?? new Date()).toISOString();
  const core = {
    source: "definitive_flash_quote" as const,
    network: "base-mainnet" as const,
    assetSymbol: "ETH",
    assetAddress: WETH_BASE.toLowerCase(),
    contraSymbol: "USDC" as const,
    contraAddress: USDC_BASE.toLowerCase(),
    side: "buy" as const,
    quotedSpendUsdc: quote.from.amount,
    quotedReceiveAmount: quote.to.amount,
    impliedPriceUsd: implied.toFixed(8),
    priceImpactLimit: "0.05",
    providerQuoteId: quote.quoteId,
    fetchedAt,
  };
  return {
    ...core,
    snapshotHash: sha256(canonicalJson(core as unknown as JsonValue)),
  };
}

/** Browser/API-safe snapshot: no EIP-712 data, allowance calldata or signatures. */
export function publicMarketSnapshot(snapshot: FlashMarketSnapshot) {
  return snapshot;
}

export type MarketIntegrityErrorCode =
  | "uniswap_reference_required"
  | "market_deviation_exceeded"
  | "market_snapshot_stale"
  | "limit_price_outside_market";

export class MarketIntegrityError extends Error {
  readonly code: MarketIntegrityErrorCode;
  readonly status: number;

  constructor(code: MarketIntegrityErrorCode, message: string, status = 422) {
    super(message);
    this.name = "MarketIntegrityError";
    this.code = code;
    this.status = status;
  }
}

export function marketIntegrityMaxDeviationBps(
  raw = process.env.UNISWAP_MAX_DEVIATION_BPS,
): number {
  const parsed = Number(raw ?? "100");
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 2_000 ? parsed : 100;
}

export function marketQuoteMaxAgeMs(
  raw = process.env.UNISWAP_QUOTE_MAX_AGE_MS,
): number {
  const parsed = Number(raw ?? "30000");
  return Number.isInteger(parsed) && parsed >= 5_000 && parsed <= 120_000
    ? parsed
    : 30_000;
}

function deviationBps(executionPrice: string, referencePrice: string): number {
  const execution = Number(executionPrice);
  const reference = Number(referencePrice);
  if (!(execution > 0) || !(reference > 0)) {
    throw new Error("Cross-market comparison requires positive prices.");
  }
  return (Math.abs(execution - reference) / reference) * 10_000;
}

export function createMarketIntegritySnapshot(input: {
  executionQuote: FlashMarketSnapshot;
  referenceQuote: UniswapQuoteSnapshot | null;
  referenceFailure?: string | null;
  maximumDeviationBps?: number;
  checkedAt?: string;
}): MarketIntegritySnapshot {
  const maximumDeviationBps =
    input.maximumDeviationBps ?? marketIntegrityMaxDeviationBps();
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  if (input.referenceQuote) {
    const executionAtomic = parseUsdcAtomic(
      input.executionQuote.quotedSpendUsdc,
    );
    const referenceAtomic = parseUsdcAtomic(
      input.referenceQuote.quotedSpendUsdc,
    );
    if (
      !executionAtomic ||
      executionAtomic !== referenceAtomic ||
      input.referenceQuote.network !== input.executionQuote.network ||
      input.referenceQuote.assetAddress.toLowerCase() !==
        input.executionQuote.assetAddress.toLowerCase() ||
      input.referenceQuote.contraAddress.toLowerCase() !==
        input.executionQuote.contraAddress.toLowerCase() ||
      input.referenceQuote.side !== input.executionQuote.side
    ) {
      throw new Error(
        "Definitive and Uniswap snapshots do not describe the same market and notional.",
      );
    }
  }
  const divergence = input.referenceQuote
    ? deviationBps(
        input.executionQuote.impliedPriceUsd,
        input.referenceQuote.impliedPriceUsd,
      )
    : null;
  const status: MarketIntegrityStatus = !input.referenceQuote
    ? "unavailable"
    : divergence !== null && divergence > maximumDeviationBps
      ? "deviation_exceeded"
      : "verified";
  const reason =
    status === "unavailable"
      ? input.referenceFailure ?? "uniswap_reference_unavailable"
      : status === "deviation_exceeded"
        ? "definitive_uniswap_price_deviation_exceeded"
        : null;
  const core = {
    source: "truthly_cross_market_guard" as const,
    network: "base-mainnet" as const,
    assetSymbol: input.executionQuote.assetSymbol,
    assetAddress: input.executionQuote.assetAddress,
    contraSymbol: "USDC" as const,
    contraAddress: input.executionQuote.contraAddress,
    side: "buy" as const,
    notionalUsdc: input.executionQuote.quotedSpendUsdc,
    executionQuote: input.executionQuote,
    referenceQuote: input.referenceQuote,
    integrity: {
      status,
      deviationBps: divergence === null ? null : divergence.toFixed(2),
      maximumDeviationBps,
      policy: "fresh_uniswap_reference_required_for_live_execution" as const,
      reason,
      checkedAt,
    },
    impliedPriceUsd: input.executionQuote.impliedPriceUsd,
    providerQuoteId: input.executionQuote.providerQuoteId,
    fetchedAt: input.executionQuote.fetchedAt,
  };
  return {
    ...core,
    snapshotHash: sha256(canonicalJson(core as unknown as JsonValue)),
  };
}

/**
 * Fetches the same exact-input Base WETH/USDC market from Definitive and
 * Uniswap. A missing Uniswap key may be retained as explicit evidence in Demo
 * Mode, but `requireUniswap` makes live council generation fail closed.
 */
export async function fetchMarketIntegritySnapshot(
  options: {
    flashQuoteReader?: QuoteReader;
    uniswapQuoteReader?: UniswapQuoteReader;
    requireUniswap?: boolean;
    notionalUsdc?: string;
    funderAddress?: string;
    decisionOrigin?: "autonomous" | "human_mediated";
    now?: () => Date;
  } = {},
): Promise<MarketIntegritySnapshot> {
  const funderAddress = options.funderAddress ?? marketQuoteAddress();
  const notionalUsdc = options.notionalUsdc ?? "1";
  const now = options.now ?? (() => new Date());
  const executionPromise = fetchFlashMarketSnapshot(
    options.flashQuoteReader ?? ((order) => flashQuote(order)),
    { notionalUsdc, funderAddress, now },
  );
  const referencePromise = (
    options.uniswapQuoteReader ?? ((quoteInput) => fetchUniswapQuote(quoteInput))
  )({
    notionalUsdc,
    swapper: funderAddress,
    assetSymbol: "ETH",
    assetAddress: WETH_BASE,
    assetDecimals: 18,
    decisionOrigin: options.decisionOrigin ?? "human_mediated",
  });
  const [executionResult, referenceResult] = await Promise.allSettled([
    executionPromise,
    referencePromise,
  ]);
  if (executionResult.status === "rejected") throw executionResult.reason;

  if (referenceResult.status === "rejected" && options.requireUniswap) {
    const detail =
      referenceResult.reason instanceof UniswapQuoteError
        ? referenceResult.reason.message
        : "Uniswap reference quote failed";
    throw new MarketIntegrityError(
      "uniswap_reference_required",
      detail,
      503,
    );
  }
  const referenceQuote =
    referenceResult.status === "fulfilled" ? referenceResult.value : null;
  const referenceFailure =
    referenceResult.status === "rejected"
      ? referenceResult.reason instanceof UniswapQuoteError
        ? referenceResult.reason.code
        : "uniswap_reference_error"
      : null;
  return createMarketIntegritySnapshot({
    executionQuote: executionResult.value,
    referenceQuote,
    referenceFailure,
    checkedAt: now().toISOString(),
  });
}

export function assertMarketIntegrityExecutable(
  snapshot: MarketIntegritySnapshot,
  options: { nowMs?: number; maxAgeMs?: number } = {},
): void {
  if (snapshot.integrity.status === "deviation_exceeded") {
    throw new MarketIntegrityError(
      "market_deviation_exceeded",
      `Definitive and Uniswap differ by ${snapshot.integrity.deviationBps} bps, above the ${snapshot.integrity.maximumDeviationBps} bps policy.`,
      409,
    );
  }
  if (snapshot.integrity.status !== "verified" || !snapshot.referenceQuote) {
    throw new MarketIntegrityError(
      "uniswap_reference_required",
      "A verified Uniswap Base AMM reference quote is required before live execution.",
      503,
    );
  }
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? marketQuoteMaxAgeMs();
  const oldest = Math.min(
    Date.parse(snapshot.executionQuote.fetchedAt),
    Date.parse(snapshot.referenceQuote.fetchedAt),
  );
  if (!Number.isFinite(oldest) || nowMs - oldest > maxAgeMs || oldest > nowMs + 5_000) {
    throw new MarketIntegrityError(
      "market_snapshot_stale",
      `Cross-market quotes must be no more than ${Math.round(maxAgeMs / 1_000)} seconds old.`,
      409,
    );
  }
}

export function assertLimitNearMarket(
  limitPriceUsd: string,
  snapshot: MarketIntegritySnapshot,
  maximumBps = 1_500,
): void {
  const difference = deviationBps(limitPriceUsd, snapshot.impliedPriceUsd);
  if (difference > maximumBps) {
    throw new MarketIntegrityError(
      "limit_price_outside_market",
      `Limit entry differs from the fresh market by ${difference.toFixed(2)} bps; maximum is ${maximumBps} bps.`,
      422,
    );
  }
}

/** Browser/API-safe snapshot: provider keys and executable payloads never enter this type. */
export function publicMarketIntegritySnapshot(snapshot: MarketIntegritySnapshot) {
  return snapshot;
}
