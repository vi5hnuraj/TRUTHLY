import { NextRequest, NextResponse } from "next/server";
import * as z from "zod";
import { and, desc, eq } from "drizzle-orm";
import { isAddress } from "viem";
import { getDb, schema } from "@/lib/db";
import { withSecurityWriteLock } from "@/lib/db/write-lock";
import { checkRateLimit } from "@/lib/rate-limit";
import { currentSignal, publishedEdition } from "@/lib/era";
import { splitTags } from "@/lib/act-on";
import { readVerification } from "@/lib/herald/verification";
import {
  executeFlashTrade,
  flashDeskConfigured,
  FLASH_BASE,
  summarizeFlashError,
  USDC_BASE,
  WETH_BASE,
} from "@/lib/flash/trade";
import { parseUsdcAtomic } from "@/lib/usdc";
import { canonicalJson, hashPrivateText, type JsonValue } from "@/lib/world/actions";
import { verifySignalReceipt } from "@/lib/intel";
import {
  agentPassRequiredResponse,
  AuthorizationDenied,
  consumeWorldAuthorization,
  createWorldAuthorization,
} from "@/lib/world/authorizations";
import {
  checkTradeMandate,
  MandateDenied,
  mandateFromToken,
  recordMandateUsage,
} from "@/lib/world/mandates";
import {
  type MarketIntegritySnapshot,
  storedCouncilResultSchema,
  storedMarketIntegritySnapshotSchema,
} from "@/lib/council/types";
import {
  assertLimitNearMarket,
  assertMarketIntegrityExecutable,
  fetchMarketIntegritySnapshot,
  marketIntegrityMaxDeviationBps,
  marketQuoteMaxAgeMs,
  MarketIntegrityError,
  publicMarketIntegritySnapshot,
} from "@/lib/council/market";
import { uniswapApiConfigured } from "@/lib/uniswap/quote";
import {
  buildPublicDecisionBrief,
  decisionCouncilFromStoredRun,
} from "@/lib/flash/decision-brief";
import { publicLiveCouncilSummary } from "@/lib/council/store";
import { scoreSignalQuality } from "@/lib/council/signal-quality";

/**
 * A trade is never inferred from "latest news". The caller must identify an
 * eligible published story, present its paid receipt and an unexpired
 * executable LIVE Council BUY, choose a maximum spend and expiry, then
 * explicitly approve the exact request. Entry, stop and target must equal the
 * immutable Council plan. Application trades are qualifying Flash limit
 * orders; the route never turns paid news into a blind market buy.
 */
const positivePrice = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^\d+(?:\.\d{1,18})?$/, "must be a positive decimal string")
  .refine((value) => Number.isFinite(Number(value)) && Number(value) > 0, {
    message: "must be greater than zero",
  });

const orderExpiry = z.iso.datetime({ offset: true }).refine(
  (value) => {
    const expiry = Date.parse(value);
    const now = Date.now();
    return expiry >= now + 15 * 60_000 && expiry <= now + 7 * 24 * 60 * 60_000;
  },
  { message: "must be between 15 minutes and 7 days in the future" },
);

const tradeSchema = z.object({
  request_id: z.string().uuid().describe("client-generated idempotency key for this exact trade"),
  signal_id: z.string().uuid(),
  /**
   * The receipt from GET /api/intel/[signal_id]: proof this principal bought
   * this story's intelligence. Every request carries one — preview and
   * execution alike — so a trade can never run on story-less or unpaid news.
   */
  receipt: z
    .string()
    .trim()
    .min(8)
    .max(128)
    .describe("receipt_id from the paid /api/intel response for this signal"),
  token: z.string().trim().min(2).max(10).transform((token) => token.toUpperCase()),
  // Sell sizing needs token-decimal-aware limits. Keep the first safe version buy-only.
  side: z.literal("buy"),
  max_spend_usdc: z.string().regex(/^\d+(?:\.\d{1,6})?$/),
  order_type: z.literal("limit").default("limit"),
  limit_price_usd: positivePrice.describe(
    "maximum USD price per target token; a buy fills only at this price or lower",
  ),
  take_profit_price_usd: positivePrice.describe(
    "attached bracket upper exit price in USD per target token",
  ),
  stop_loss_price_usd: positivePrice.describe(
    "attached bracket lower exit price in USD per target token",
  ),
  expires_at: orderExpiry.describe("ISO-8601 good-til-time expiry"),
  rationale: z.string().trim().min(10).max(280),
  council_run_id: z
    .string()
    .uuid()
    .describe("unexpired executable LIVE Council BUY run for this signal and exact price plan"),
  approved: z.boolean().default(false),
  authorization_id: z.string().uuid().optional(),
}).superRefine((trade, ctx) => {
  const limit = Number(trade.limit_price_usd);
  const takeProfit = Number(trade.take_profit_price_usd);
  const stopLoss = Number(trade.stop_loss_price_usd);
  if (!(stopLoss < limit && limit < takeProfit)) {
    ctx.addIssue({
      code: "custom",
      path: ["take_profit_price_usd"],
      message: "prices must satisfy stop loss < limit entry < take profit",
    });
  }
});

type Db = Awaited<ReturnType<typeof getDb>>;

async function validateLiveCouncilRun(
  db: Db,
  input: {
    id: string;
    signalId: string;
    targetAsset: string;
    limitPrice: string;
    takeProfit: string;
    stopLoss: string;
    expiresAt: string;
  },
) {
  const run = await db
    .select()
    .from(schema.councilRuns)
    .where(eq(schema.councilRuns.id, input.id))
    .get();
  if (!run || run.mode !== "live" || run.status !== "completed") {
    throw new MandateDenied(
      "live_council_run_required",
      "The supplied council run is missing, incomplete or belongs to Demo Mode.",
      422,
    );
  }
  if (run.sourceSignalId !== input.signalId || !run.councilJson || !run.validUntil) {
    throw new MandateDenied("council_scope_mismatch", "Council run belongs to another signal.", 422);
  }
  if (Date.parse(run.validUntil) <= Date.now()) {
    throw new MandateDenied("council_run_expired", "Council market snapshot has expired.", 409);
  }
  if (Date.parse(input.expiresAt) > Date.parse(run.validUntil)) {
    throw new MandateDenied(
      "order_outlives_council",
      "The limit order cannot remain active after the Council decision expires.",
      422,
    );
  }
  let raw: unknown;
  let rawMarket: unknown;
  try {
    raw = JSON.parse(run.councilJson);
    rawMarket = JSON.parse(run.marketSnapshotJson ?? "null");
  } catch {
    raw = null;
    rawMarket = null;
  }
  const parsed = storedCouncilResultSchema.safeParse(raw);
  const parsedMarket = storedMarketIntegritySnapshotSchema.safeParse(rawMarket);
  if (
    !parsed.success ||
    !parsedMarket.success ||
    parsedMarket.data.integrity.status !== "verified" ||
    !parsedMarket.data.referenceQuote ||
    parsed.data.mode !== "live" ||
    parsed.data.action !== "BUY" ||
    !parsed.data.executionEligible
  ) {
    throw new MandateDenied(
      "council_not_executable",
      "Only an unexpired, executable LIVE BUY recommendation can inform this buy-only route.",
      422,
    );
  }
  const sameDecimal = (left: string | null, right: string) =>
    left !== null && Number.isFinite(Number(left)) && Number(left) === Number(right);
  if (
    parsed.data.assetAddress.toLowerCase() !== input.targetAsset.toLowerCase() ||
    !sameDecimal(parsed.data.entryPriceUsd, input.limitPrice) ||
    !sameDecimal(parsed.data.takeProfitPriceUsd, input.takeProfit) ||
    !sameDecimal(parsed.data.stopLossPriceUsd, input.stopLoss)
  ) {
    throw new MandateDenied(
      "council_levels_changed",
      "Asset or price levels differ from the referenced live council recommendation.",
      409,
    );
  }
  return run;
}

function parseJsonList(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function maxTradeUsd(): string {
  const configured = process.env.FLASH_MAX_TRADE_USD?.trim() || "5";
  return parseUsdcAtomic(configured) && parseUsdcAtomic(configured)! > BigInt(0) ? configured : "5";
}

function tokenAddresses(): Record<string, string> {
  const addresses: Record<string, string> = { ETH: WETH_BASE, WETH: WETH_BASE };
  const raw = process.env.FLASH_TOKEN_ADDRESSES?.trim();
  if (!raw) return addresses;
  try {
    const configured: unknown = JSON.parse(raw);
    if (!configured || typeof configured !== "object" || Array.isArray(configured)) {
      return addresses;
    }
    for (const [symbol, address] of Object.entries(configured)) {
      const normalized = symbol.toUpperCase();
      if (/^[A-Z0-9]{2,10}$/.test(normalized) && typeof address === "string" && isAddress(address)) {
        addresses[normalized] = address;
      }
    }
  } catch {
    console.error("FLASH_TOKEN_ADDRESSES is not valid JSON; using the built-in token map.");
  }
  return addresses;
}

function tokenDecimals(): Record<string, number> {
  const decimals: Record<string, number> = { ETH: 18, WETH: 18 };
  const raw = process.env.FLASH_TOKEN_DECIMALS?.trim();
  if (!raw) return decimals;
  try {
    const configured: unknown = JSON.parse(raw);
    if (!configured || typeof configured !== "object" || Array.isArray(configured)) {
      return decimals;
    }
    for (const [symbol, value] of Object.entries(configured)) {
      const normalized = symbol.toUpperCase();
      if (/^[A-Z0-9]{2,10}$/.test(normalized) && Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 36) {
        decimals[normalized] = Number(value);
      }
    }
  } catch {
    console.error("FLASH_TOKEN_DECIMALS is not valid JSON; using built-in decimals only.");
  }
  return decimals;
}

async function findEligibleSignal(db: Db, signalId: string) {
  const row = await db
    .select({
      id: schema.signals.id,
      headline: schema.signals.headline,
      tags: schema.signals.tags,
      verification: schema.signals.verification,
      stakeStatus: schema.signals.stakeStatus,
      status: schema.signals.status,
      editionId: schema.editions.id,
      editionNumber: schema.editions.number,
    })
    .from(schema.signals)
    .innerJoin(
      schema.editionSignals,
      eq(schema.editionSignals.signalId, schema.signals.id),
    )
    .innerJoin(
      schema.editions,
      eq(schema.editions.id, schema.editionSignals.editionId),
    )
    .where(
      and(
        eq(schema.signals.id, signalId),
        currentSignal,
        publishedEdition,
      ),
    )
    .orderBy(desc(schema.editions.number))
    .limit(1)
    .get();
  if (!row) return { ok: false as const, reason: "story_not_in_published_edition" };
  if (["retracted", "rejected"].includes(row.status)) {
    return { ok: false as const, reason: "story_retracted" };
  }

  const verification = readVerification(row.verification);
  if (!verification || !["supported", "partially_supported"].includes(verification.verdict)) {
    return { ok: false as const, reason: "story_not_supported" };
  }
  if (row.stakeStatus !== "refunded") {
    return { ok: false as const, reason: "stake_not_refunded" };
  }
  const { actOn } = splitTags(parseJsonList(row.tags));
  return {
    ok: true as const,
    row,
    verdict: verification.verdict,
    tokens: [...new Set(actOn.tokens.map((token) => token.toUpperCase()))],
  };
}

export async function POST(req: NextRequest) {
  const limited = checkRateLimit(req, 30);
  if (limited) return limited;
  const parsed = tradeSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        traded: false,
        reason: "invalid_request",
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      },
      { status: 400 },
    );
  }

  const trade = parsed.data;
  const amount = parseUsdcAtomic(trade.max_spend_usdc);
  const cap = parseUsdcAtomic(maxTradeUsd())!;
  if (!amount || amount <= BigInt(0) || amount > cap) {
    return NextResponse.json(
      {
        traded: false,
        reason: "unsafe_spend_limit",
        detail: `max_spend_usdc must be greater than 0 and no more than ${maxTradeUsd()} USDC`,
      },
      { status: 400 },
    );
  }

  const db = await getDb();
  const eligible = await findEligibleSignal(db, trade.signal_id);
  if (!eligible.ok) {
    return NextResponse.json(
      { traded: false, reason: eligible.reason },
      { status: 422 },
    );
  }
  if (!eligible.tokens.includes(trade.token)) {
    return NextResponse.json(
      {
        traded: false,
        reason: "token_not_identified_by_story",
        story_tokens: eligible.tokens,
      },
      { status: 422 },
    );
  }
  const targetAsset = tokenAddresses()[trade.token];
  if (!targetAsset || targetAsset.toLowerCase() === USDC_BASE.toLowerCase()) {
    return NextResponse.json(
      {
        traded: false,
        reason: "token_not_configured",
        detail:
          "Map this story token to a Base contract in FLASH_TOKEN_ADDRESSES before requesting a trade.",
      },
      { status: 422 },
    );
  }
  const targetDecimals = tokenDecimals()[trade.token];
  if (targetDecimals === undefined) {
    return NextResponse.json(
      {
        traded: false,
        reason: "token_decimals_not_configured",
        detail: "Set this symbol's exact ERC-20 decimals in FLASH_TOKEN_DECIMALS before signing an advanced order.",
      },
      { status: 422 },
    );
  }

  const mandateToken = req.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();

  try {
    const mandate = await checkTradeMandate(mandateToken, amount);
    const councilRun = await validateLiveCouncilRun(db, {
      id: trade.council_run_id,
      signalId: trade.signal_id,
      targetAsset,
      limitPrice: trade.limit_price_usd,
      takeProfit: trade.take_profit_price_usd,
      stopLoss: trade.stop_loss_price_usd,
      expiresAt: trade.expires_at,
    });

    // Receipt gate: the mandate says WHO may trade, the receipt says they
    // actually bought THIS story's intelligence. Both are required, on every
    // request, before any approval or execution step.
    const receipt = await verifySignalReceipt({
      receiptId: trade.receipt,
      signalId: trade.signal_id,
      allowedAccounts: [mandate.delegatedAgent.agentWallet, mandate.principal.ownerWallet],
    });
    if (!receipt.ok) {
      const status = receipt.reason === "receipt_wrong_account" ? 403 : 402;
      const reason =
        receipt.reason === "receipt_wrong_account"
          ? "receipt_owner_mismatch"
          : receipt.reason === "receipt_wrong_story"
            ? "receipt_for_another_signal"
            : "signal_intel_receipt_required";
      const detail =
        receipt.reason === "receipt_wrong_account"
          ? "This receipt belongs to another wallet. The wallet that paid for the story (or the controlling human's wallet) must trade on it."
          : receipt.reason === "receipt_wrong_story"
            ? "This receipt was issued for a different story. Buy this story's intelligence before trading it."
            : `Buy this story's intelligence first: GET /api/intel/${trade.signal_id} with an x402 payment, then resend this request with the returned receipt_id.`;
      return NextResponse.json(
        { traded: false, reason, detail, signal_id: trade.signal_id },
        { status },
      );
    }

    const maximumDeviationBps = marketIntegrityMaxDeviationBps();
    const maximumQuoteAgeMs = marketQuoteMaxAgeMs();

    const approval = {
      request_id: trade.request_id,
      signal_id: trade.signal_id,
      headline: eligible.row.headline,
      edition_id: eligible.row.editionId,
      edition: eligible.row.editionNumber,
      verdict: eligible.verdict,
      stake_status: eligible.row.stakeStatus,
      receipt_id: receipt.entitlement.id,
      intel_payer: receipt.entitlement.accountId,
      intel_transaction: receipt.payment.txHash,
      token: trade.token,
      target_asset: targetAsset,
      side: trade.side,
      maximum_spend_usdc: trade.max_spend_usdc,
      order_type: trade.order_type,
      limit_price_usd: trade.limit_price_usd,
      take_profit_price_usd: trade.take_profit_price_usd,
      stop_loss_price_usd: trade.stop_loss_price_usd,
      expires_at: trade.expires_at,
      maximum_price_impact: "0.05",
      rationale: trade.rationale,
      delegated_agent: mandate.delegatedAgent.agentWallet,
      human_principal: mandate.principal.id,
      council_run_id: councilRun.id,
      execution_mode: "live",
      market_integrity_policy: {
        status: "required_at_execution",
        execution_provider: "Definitive Flash",
        reference_provider: "Uniswap V2/V3/V4 on Base",
        maximum_deviation_bps: maximumDeviationBps,
        maximum_quote_age_seconds: Math.round(maximumQuoteAgeMs / 1_000),
        configured: uniswapApiConfigured(),
      },
    };
    const authorizationPayload = {
      request_id: trade.request_id,
      signal_id: trade.signal_id,
      edition_id: eligible.row.editionId,
      // Bind the paid-intel entitlement into the one-use World authorization.
      // A caller cannot swap even one same-owner receipt after the human
      // approved the exact trade request.
      receipt_id: receipt.entitlement.id,
      token_address: targetAsset.toLowerCase(),
      token_symbol: trade.token,
      side: trade.side,
      maximum_spend_atomic: amount.toString(),
      order_type: trade.order_type,
      // Flash requires pair-rate pricing for a bracketed limit entry. The
      // contra asset is USDC, so the approved USD/token value is the same
      // numeric limitCrossPrice sent to Flash.
      limit_cross_price: trade.limit_price_usd,
      take_profit_notional_price: trade.take_profit_price_usd,
      stop_loss_notional_price: trade.stop_loss_price_usd,
      expire_time: trade.expires_at,
      maximum_price_impact: "0.05",
      rationale_hash: hashPrivateText(trade.rationale),
      delegated_agent: mandate.delegatedAgent.agentWallet,
      council_run_id: councilRun.id,
      execution_mode: "live",
      market_integrity_required: true,
      uniswap_maximum_deviation_bps: maximumDeviationBps,
      market_quote_max_age_ms: maximumQuoteAgeMs,
    } as const;

    const makeAgentPassChallenge = async () => {
      const authorization = await createWorldAuthorization({
        principalId: mandate.principal.id,
        action: "execute_trade",
        payload: authorizationPayload,
        returnTo: "/trades",
      });
      return NextResponse.json(
        {
          traded: false,
          reason: "approval_required",
          approval,
          desk_armed: flashDeskConfigured(),
          ...agentPassRequiredResponse(
            authorization,
            "A fresh authorization from the controlling human is required for this exact trade.",
          ),
        },
        { status: 409 },
      );
    };

    if (!trade.approved) {
      if (mandate.requiresFreshAgentPass) return await makeAgentPassChallenge();
      return NextResponse.json(
        {
          traded: false,
          reason: "approval_required",
          approval,
          authorization_policy: "delegated_mandate",
          desk_armed: flashDeskConfigured(),
          detail:
            "This amount is inside the agent's autonomous mandate. Repeat the exact request with approved=true; any changed field is revalidated.",
        },
        { status: 409 },
      );
    }

    if (!flashDeskConfigured()) {
      return NextResponse.json({
        traded: false,
        reason: "desk_not_armed",
        approval,
        detail:
          "Set FLASH_FUNDER_PRIVATE_KEY to a limited burner wallet with USDC on Base before executing approved trades.",
      });
    }

    // An idempotent retry returns the durable result before spending provider
    // quote quota or consuming a one-use World authorization.
    const prior = await db
      .select({
        id: schema.trades.id,
        status: schema.trades.status,
        orderId: schema.trades.orderId,
        error: schema.trades.error,
      })
      .from(schema.trades)
      .where(eq(schema.trades.requestId, trade.request_id))
      .get();
    if (prior) {
      return NextResponse.json(
        {
          traded: prior.status === "submitted",
          reason: "request_already_recorded",
          trade_id: prior.id,
          status: prior.status,
          order_id: prior.orderId,
          detail: prior.error,
        },
        { status: 409 },
      );
    }

    // Fetch only after explicit approval and an armed limited burner. Preview
    // requests publish the policy without consuming provider quota. Execution
    // cannot reserve budget, consume a World authorization or reach Flash until
    // this same-notional Uniswap V2/V3/V4 comparison passes.
    let marketIntegrity: MarketIntegritySnapshot;
    try {
      marketIntegrity = await fetchMarketIntegritySnapshot({
        requireUniswap: true,
        notionalUsdc: trade.max_spend_usdc,
        decisionOrigin: "human_mediated",
      });
      assertMarketIntegrityExecutable(marketIntegrity, {
        maxAgeMs: maximumQuoteAgeMs,
      });
      assertLimitNearMarket(trade.limit_price_usd, marketIntegrity);
    } catch (error) {
      if (error instanceof MarketIntegrityError) {
        return NextResponse.json(
          {
            traded: false,
            reason: error.code,
            detail: error.message,
            market_integrity_required: true,
          },
          { status: error.status },
        );
      }
      console.error(
        "Cross-market execution guard failed:",
        error instanceof Error ? error.message : String(error),
      );
      return NextResponse.json(
        {
          traded: false,
          reason: "market_integrity_unavailable",
          detail:
            "Definitive and Uniswap could not produce a verified fresh market comparison. Nothing was submitted.",
          market_integrity_required: true,
        },
        { status: 502 },
      );
    }

    if (mandate.requiresFreshAgentPass) {
      if (!trade.authorization_id) return await makeAgentPassChallenge();
      await consumeWorldAuthorization({
        authorizationId: trade.authorization_id,
        principalId: mandate.principal.id,
        action: "execute_trade",
        payload: authorizationPayload,
      });
    } else if (trade.authorization_id) {
      // An authorization is never treated as an ignorable hint. If supplied,
      // it must be an approved, exact execute_trade grant and is consumed once.
      await consumeWorldAuthorization({
        authorizationId: trade.authorization_id,
        principalId: mandate.principal.id,
        action: "execute_trade",
        payload: authorizationPayload,
      });
    }

    const tradeId = crypto.randomUUID();
    // Revalidate the live token and reserve both the idempotency row and shared
    // budget under one write transaction. A second, immediate transaction below
    // moves reserved -> submitting only if the principal is still unpaused.
    await withSecurityWriteLock(() => db.transaction(async (tx) => {
      const liveMandate = await checkTradeMandate(mandateToken, amount, tx);
      if (
        liveMandate.principal.id !== mandate.principal.id ||
        liveMandate.delegatedAgent.id !== mandate.delegatedAgent.id ||
        liveMandate.mandate.id !== mandate.mandate.id
      ) {
        throw new MandateDenied(
          "mandate_changed",
          "The mandate changed while this order was being prepared. Start again.",
          409,
        );
      }

      const inserted = await tx
        .insert(schema.trades)
        .values({
          id: tradeId,
          requestId: trade.request_id,
          signalId: trade.signal_id,
          chain: FLASH_BASE,
          side: trade.side,
          qty: trade.max_spend_usdc,
          targetAsset,
          contraAsset: USDC_BASE,
          tokenSymbol: trade.token,
          maxSpendUsdc: trade.max_spend_usdc,
          orderType: trade.order_type,
          limitPriceUsd: trade.limit_price_usd,
          orderExpiresAt: trade.expires_at,
          takeProfitPriceUsd: trade.take_profit_price_usd,
          stopLossPriceUsd: trade.stop_loss_price_usd,
          rationale: trade.rationale,
          approvedAt: new Date().toISOString(),
          authorizationId: trade.authorization_id ?? null,
          councilRunId: councilRun.id,
          executionMode: "live",
          marketGuardStatus: marketIntegrity.integrity.status,
          marketGuardJson: canonicalJson(
            marketIntegrity as unknown as JsonValue,
          ),
          uniswapRequestId:
            marketIntegrity.referenceQuote?.providerRequestId ?? null,
          uniswapQuoteId:
            marketIntegrity.referenceQuote?.providerQuoteId ?? null,
          uniswapRouting: marketIntegrity.referenceQuote?.routing ?? null,
          uniswapPriceUsd:
            marketIntegrity.referenceQuote?.impliedPriceUsd ?? null,
          marketDeviationBps: marketIntegrity.integrity.deviationBps,
          receiptId: trade.receipt,
          principalId: mandate.principal.id,
          agentWallet: mandate.delegatedAgent.agentWallet,
          funder: "pending",
          status: "reserved",
          createdAt: new Date().toISOString(),
        })
        .onConflictDoNothing()
        .returning({ id: schema.trades.id });
      if (inserted.length !== 1) {
        throw new MandateDenied(
          "request_already_recorded",
          "This trade request id is already reserved.",
          409,
        );
      }

      await recordMandateUsage(
        {
          principalId: mandate.principal.id,
          delegatedAgentId: mandate.delegatedAgent.id,
          kind: "trade",
          amountAtomic: amount,
          refId: tradeId,
        },
        tx,
      );
    }));

    // This is the external-order linearization point relative to pausePrincipal.
    // If pause wins this write lock, the reservation is failed and released and
    // Flash is never called. If this transition wins, pause reports the durable
    // `submitting` row because the provider call may already be in flight.
    const submissionGate = await withSecurityWriteLock(() => db.transaction(async (tx) => {
      let gateError: MandateDenied | null = null;
      try {
        assertMarketIntegrityExecutable(marketIntegrity);
        assertLimitNearMarket(trade.limit_price_usd, marketIntegrity);
      } catch (error) {
        if (!(error instanceof MarketIntegrityError)) throw error;
        gateError = new MandateDenied(error.code, error.message, error.status);
      }
      try {
        if (!gateError) {
          const live = await mandateFromToken(mandateToken, tx);
          if (
            !live ||
            live.principal.id !== mandate.principal.id ||
            live.delegatedAgent.id !== mandate.delegatedAgent.id ||
            live.mandate.id !== mandate.mandate.id
          ) {
            gateError = new MandateDenied(
              "mandate_changed",
              "The mandate changed before provider submission. No order was sent.",
              409,
            );
          }
        }
      } catch (error) {
        if (!(error instanceof MandateDenied)) throw error;
        gateError = error;
      }

      if (!gateError) {
        const started = await tx
          .update(schema.trades)
          .set({ status: "submitting" })
          .where(
            and(
              eq(schema.trades.id, tradeId),
              eq(schema.trades.status, "reserved"),
            ),
          )
          .returning({ id: schema.trades.id });
        if (started.length === 1) return { ok: true as const };
        gateError = new MandateDenied(
          "submission_state_changed",
          "The reserved order changed before provider submission. No order was sent.",
          409,
        );
      }

      await tx
        .update(schema.trades)
        .set({ status: "failed", error: gateError.message })
        .where(
          and(
            eq(schema.trades.id, tradeId),
            eq(schema.trades.status, "reserved"),
          ),
        )
        .run();
      await tx
        .delete(schema.newsroomUsage)
        .where(
          and(
            eq(schema.newsroomUsage.refId, tradeId),
            eq(schema.newsroomUsage.kind, "trade"),
          ),
        )
        .run();
      return { ok: false as const, error: gateError };
    }));
    if (!submissionGate.ok) throw submissionGate.error;

    let outcome;
    try {
      outcome = await executeFlashTrade({
        targetChain: FLASH_BASE,
        contraChain: FLASH_BASE,
        targetAsset,
        contraAsset: USDC_BASE,
        side: trade.side,
        qty: trade.max_spend_usdc,
        orderType: trade.order_type,
        limitCrossPrice: trade.limit_price_usd,
        expireTime: trade.expires_at,
        maxPriceImpact: "0.05",
        evmUsePermit2: false,
        forceMinimalAllowance: true,
        attachedBracket: {
          takeProfit: { notionalPrice: trade.take_profit_price_usd },
          stopLoss: { notionalPrice: trade.stop_loss_price_usd },
          expireTime: trade.expires_at,
        },
        funderAddress: "", // filled from the configured limited burner key
      }, { targetDecimals });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const publicDetail = summarizeFlashError(error);
      console.error("Flash execution needs review:", detail);
      await db
        .update(schema.trades)
        .set({
          status: "needs_review",
          error: publicDetail,
        })
        .where(eq(schema.trades.id, tradeId))
        .run();
      return NextResponse.json(
        {
          traded: false,
          reason: "trade_needs_review",
          detail:
            "Flash execution did not return a complete acknowledgement. The request is blocked from retry; reconcile its provider status before any new order.",
          provider_error: publicDetail,
          trade_id: tradeId,
        },
        { status: 202 },
      );
    }

    await db
      .update(schema.trades)
      .set({
        quoteId: outcome.quoteId,
        orderId: outcome.orderId,
        spentNotional: outcome.spentNotional,
        receivedNotional: outcome.receivedNotional,
        bracketStatus: outcome.bracketStatus,
        funder: outcome.funderAddress,
        status: "submitted",
        error: null,
      })
      .where(eq(schema.trades.id, tradeId))
      .run();

    return NextResponse.json({
      traded: true,
      execution_mode: "live",
      label: "LIVE EXECUTION — REAL DEFINITIVE ORDER",
      trade_id: tradeId,
      approval,
      market_integrity: publicMarketIntegritySnapshot(marketIntegrity),
      ...outcome,
    });
  } catch (error) {
    if (error instanceof MandateDenied || error instanceof AuthorizationDenied) {
      return NextResponse.json(
        { traded: false, reason: error.code, detail: error.message },
        { status: error.status },
      );
    }
    throw error;
  }
}

export async function GET() {
  const db = await getDb();
  const [trades, rows, councilRows] = await Promise.all([
    db.select().from(schema.trades).orderBy(desc(schema.trades.createdAt)).limit(50),
    db
      .select({
        id: schema.signals.id,
        headline: schema.signals.headline,
        beat: schema.signals.beat,
        score: schema.signals.score,
        createdAt: schema.signals.createdAt,
        tags: schema.signals.tags,
        verification: schema.signals.verification,
        stakeStatus: schema.signals.stakeStatus,
        status: schema.signals.status,
        editionNumber: schema.editions.number,
        reporterName: schema.agents.name,
        reporterAddress: schema.agents.address,
      })
      .from(schema.signals)
      .innerJoin(
        schema.editionSignals,
        eq(schema.editionSignals.signalId, schema.signals.id),
      )
      .innerJoin(schema.editions, eq(schema.editions.id, schema.editionSignals.editionId))
      .leftJoin(schema.agents, eq(schema.agents.id, schema.signals.agentId))
      .where(and(currentSignal, publishedEdition))
      .orderBy(desc(schema.signals.createdAt), desc(schema.editions.number))
      .limit(50),
    db
      .select()
      .from(schema.councilRuns)
      .where(
        and(
          eq(schema.councilRuns.mode, "live"),
          eq(schema.councilRuns.status, "completed"),
        ),
      )
      .orderBy(desc(schema.councilRuns.createdAt))
      .limit(100),
  ]);

  const latestCouncilBySignal = new Map<string, (typeof councilRows)[number]>();
  for (const run of councilRows) {
    if (run.sourceSignalId && !latestCouncilBySignal.has(run.sourceSignalId)) {
      latestCouncilBySignal.set(run.sourceSignalId, run);
    }
  }

  const seen = new Set<string>();
  const briefs = rows.flatMap((row) => {
    if (seen.has(row.id)) return [];
    seen.add(row.id);
    const verification = readVerification(row.verification);
    const tokens = splitTags(parseJsonList(row.tags)).actOn.tokens.map((token) =>
      token.toUpperCase(),
    );
    if (tokens.length === 0) return [];
    const latestCouncil = latestCouncilBySignal.get(row.id) ?? null;
    const councilDecision = decisionCouncilFromStoredRun(latestCouncil);
    const councilSummary = publicLiveCouncilSummary(latestCouncil);
    const execution = buildPublicDecisionBrief({
      status: row.status,
      published: true,
      verdict: verification?.verdict ?? null,
      stakeStatus: row.stakeStatus,
      tokens,
      council: councilDecision,
    });
    const signalQuality = scoreSignalQuality({
      published: true,
      withdrawn: ["retracted", "rejected"].includes(row.status),
      verdict: verification?.verdict ?? null,
      heraldConfidence: verification?.confidence ?? null,
      sourceCount: verification?.source_evidence.length ?? 0,
      claimCheckCount: verification?.claim_checks.length ?? 0,
      stakeStatus: row.stakeStatus,
      assetSupported: tokens.some((token) => token === "ETH" || token === "WETH"),
      council: councilSummary
        ? {
            action: councilSummary.action,
            consensus: councilSummary.consensus,
            consensusConfidence: councilSummary.consensus_confidence,
            executionEligible: councilSummary.execution_eligible,
            validUntil: councilSummary.valid_until,
            entryPriceUsd: councilSummary.entry_price_usd,
            stopLossPriceUsd: councilSummary.stop_loss_price_usd,
            takeProfitPriceUsd: councilSummary.take_profit_price_usd,
            riskReward: councilSummary.risk_reward,
            opinions: councilSummary.agents,
          }
        : null,
      market: councilSummary
        ? {
            status: councilSummary.market.integrity_status,
            deviationBps: councilSummary.market.deviation_bps,
            maximumDeviationBps: councilSummary.market.maximum_deviation_bps,
          }
        : null,
      executionReady: execution.execution_eligible,
    });
    return [{
      id: row.id,
      headline: row.headline,
      beat: row.beat,
      score: row.score,
      created_at: row.createdAt,
      edition_number: row.editionNumber,
      verdict: verification?.verdict ?? null,
      stake_status: row.stakeStatus,
      tokens: [...new Set(tokens)],
      reporter: {
        name: row.reporterName ?? "Unknown",
        address: row.reporterAddress ?? "",
      },
      execution,
      signal_quality: signalQuality,
      council_summary: councilSummary,
      private_council_available: Boolean(councilDecision),
      private_council_valid_until: latestCouncil?.validUntil ?? null,
    }];
  });
  const eligibleSignals = briefs.flatMap((brief) =>
    brief.execution.story_eligible && brief.verdict
      ? [{
          id: brief.id,
          headline: brief.headline,
          verdict: brief.verdict as "supported" | "partially_supported",
          tokens: brief.tokens,
        }]
      : [],
  );
  return NextResponse.json({
    desk_armed: flashDeskConfigured(),
    uniswap_configured: uniswapApiConfigured(),
    market_integrity_required:
      "Every live order requires a fresh Uniswap V2/V3/V4 Base quote within the configured deviation from Definitive before provider submission.",
    maximum_trade_usdc: maxTradeUsd(),
    token_addresses: tokenAddresses(),
    token_decimals: tokenDecimals(),
    intel_receipt_required:
      "Every trade request carries receipt=<receipt_id> from GET /api/intel/{signal_id}; the receipt must be for that signal and paid for by this mandate's wallet or its human.",
    advanced_order_required:
      "Every application trade is an expiring Flash limit buy with an attached take-profit/stop-loss bracket; market-only orders are not accepted.",
    council_required:
      "Every trade must reference an unexpired executable LIVE Council BUY run for the same signal, asset and exact entry/stop/target levels. HOLD, SELL, Demo Mode and modified plans are refused.",
    execution_mode:
      "This route is LIVE execution only. Demo scenarios use separate paper-execution tables and can never be submitted here.",
    briefs,
    eligible_signals: eligibleSignals,
    trades,
  });
}
