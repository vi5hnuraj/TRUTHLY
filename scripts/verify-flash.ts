/**
 * Flash boundary verification: guards, exact approval, ledger honesty,
 * and the live quote path.
 *
 * Safety:
 *   - Uses an isolated temporary SQLite database; never touches production.
 *   - Refuses to run when FLASH_FUNDER_PRIVATE_KEY is present, so this rehearsal
 *     cannot accidentally submit an on-chain order.
 *   - The final Flash call is quote-only (real network pricing, no signature or
 *     side effect). Submit-path checks use the library's documented injection
 *     points; production never supplies those injections.
 *
 * Checks:
 *   C1  desk is unarmed; abort if a live funder key is present
 *   C2  route rejects a signal trade with no intel receipt (no bypass)
 *   C3  route rejects a valid story receipt paid by another wallet
 *   C4  paid, owner-bound receipt reaches an exact World Agent Pass hold
 *   C5  World payload hash input includes the exact receipt id
 *   C6  below-threshold approved request reaches honest desk_not_armed guard;
 *       an order that outlives its Council run is refused
 *   C7  GET lists the eligible story and publishes the receipt requirement
 *   C8  executeFlashTrade throws a clear error without a key (library guard)
 *   C9  quote → approve → sign → submit threads quote typed data correctly
 *   C10 injected submit returns order/quote/notional fields
 *   C11 ledger stores and returns receipt id plus a deliberately losing demo row
 *   C12 REAL Flash quote returns quote id + EVM typed data (no execution)
 *
 * RESULT: 13/13 expected.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { encodeFunctionData, erc20Abi, parseUnits } from "viem";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function requestBody(signalId: string, councilRunId: string, receipt: string | undefined, input?: {
  spend?: string;
  approved?: boolean;
  requestId?: string;
  expiresAt?: string;
}) {
  return {
    request_id: input?.requestId ?? randomUUID(),
    signal_id: signalId,
    ...(receipt ? { receipt } : {}),
    token: "ETH",
    side: "buy",
    max_spend_usdc: input?.spend ?? "0.25",
    order_type: "limit",
    limit_price_usd: "3500",
    take_profit_price_usd: "4000",
    stop_loss_price_usd: "3000",
    expires_at: input?.expiresAt ?? new Date(Date.now() + 20 * 60_000).toISOString(),
    rationale: "The supported upgrade changes expected protocol usage.",
    council_run_id: councilRunId,
    approved: input?.approved ?? false,
  };
}

async function main() {
  const dbFile = path.join(process.cwd(), `.truthly-verify-flash-${process.pid}.db`);
  process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
  delete process.env.TURSO_AUTH_TOKEN;

  const flash = await import("../src/lib/flash/trade");
  const flashAuthorization = await import("../src/lib/flash/authorization");
  const route = await import("../src/app/api/flash/trade/route");
  const dbModule = await import("../src/lib/db");
  const mandates = await import("../src/lib/world/mandates");
  const { getDb, schema } = dbModule;
  const db = await getDb();

  try {
    console.log("— C1: execution safety —");
    const unarmed = !flash.flashDeskConfigured();
    check("C1 desk is unarmed for the no-side-effect rehearsal", unarmed);
    if (!unarmed) {
      throw new Error(
        "Refusing to run verify-flash with FLASH_FUNDER_PRIVATE_KEY present. Unset it; this trial must never execute a live order.",
      );
    }

    // Isolated fixture: one eligible published story, two signal receipts (one
    // owned by this principal and one by a different wallet), and one bounded
    // trading mandate. Inserting the settled payment rows directly avoids a
    // payout attempt; the route exercises the same entitlement verifier used in
    // production.
    const now = new Date().toISOString();
    const agentId = `verify-flash-agent-${process.pid}`;
    const principalId = randomUUID();
    const signalId = randomUUID();
    const councilRunId = randomUUID();
    const editionId = randomUUID();
    const paymentId = randomUUID();
    const receiptId = randomUUID();
    const otherPaymentId = randomUUID();
    const wrongOwnerReceiptId = randomUUID();
    const agentWallet = `0x${"8".repeat(40)}`;
    const otherWallet = `0x${"7".repeat(40)}`;

    await db.insert(schema.agents).values({
      id: agentId,
      accountId: `verify-flash-account-${process.pid}`,
      chainId: "8453",
      address: agentWallet,
      name: "Flash verification reporter",
      registeredAt: now,
    }).run();
    await db.insert(schema.editions).values({
      id: editionId,
      number: 8_000_000 + process.pid,
      title: "Flash verification receipt edition",
      summary: "isolated route fixture",
      contentHtml: "<p>trial</p>",
      contentText: "trial",
      signalCount: 1,
      publishedAt: now,
      createdAt: now,
      status: "published",
    }).run();
    await db.insert(schema.signals).values({
      id: signalId,
      agentId,
      headline: "Flash verification supported protocol upgrade",
      body: "A supported test-only story used to prove the paid receipt gate.",
      sources: JSON.stringify(["https://example.com/verify-flash-a", "https://example.org/verify-flash-b"]),
      tags: JSON.stringify(["infrastructure", "token:ETH"]),
      beat: "infrastructure",
      status: "included",
      score: 90,
      verification: JSON.stringify({
        verdict: "supported",
        confidence: 0.95,
        notes: "Fixture sources support the claim.",
        world_query: null,
        tokens: ["ETH"],
        model: "trial-fixture",
        checked_at: now,
        cost_atomic: null,
        payment_tx: null,
        claim_checks: [],
        source_evidence: [],
      }),
      createdAt: now,
      updatedAt: now,
      stakeAtomic: "10000",
      stakeStatus: "refunded",
    }).run();
    await db.insert(schema.editionSignals).values({
      editionId,
      signalId,
      position: 1,
      payoutCents: 0,
    }).run();

    const councilValidUntil = new Date(Date.now() + 30 * 60_000).toISOString();
    const executionQuote = {
      source: "definitive_flash_quote",
      network: "base-mainnet",
      assetSymbol: "ETH",
      assetAddress: flash.WETH_BASE.toLowerCase(),
      contraSymbol: "USDC",
      contraAddress: flash.USDC_BASE.toLowerCase(),
      side: "buy",
      quotedSpendUsdc: "1",
      quotedReceiveAmount: "0.0002857142857",
      impliedPriceUsd: "3500.00000000",
      priceImpactLimit: "0.05",
      providerQuoteId: "verify-flash-definitive-quote",
      fetchedAt: now,
      snapshotHash: "verify-flash-definitive-hash",
    };
    const referenceQuote = {
      source: "uniswap_trading_api",
      network: "base-mainnet",
      chainId: 8453,
      assetSymbol: "ETH",
      assetAddress: flash.WETH_BASE.toLowerCase(),
      contraSymbol: "USDC",
      contraAddress: flash.USDC_BASE.toLowerCase(),
      side: "buy",
      exactInputAtomic: "1000000",
      quotedSpendUsdc: "1",
      quotedReceiveAmount: "0.0002853067047",
      impliedPriceUsd: "3505.00000000",
      routing: "CLASSIC",
      protocols: ["V3"],
      routeString: "[V3] USDC -> WETH",
      priceImpactPercent: "0.01",
      gasFeeUsd: "0.01",
      providerRequestId: "verify-flash-uniswap-request",
      providerQuoteId: "verify-flash-uniswap-quote",
      blockNumber: "1",
      universalRouterVersion: "2.1.2",
      decisionOrigin: "human_mediated",
      fetchedAt: now,
      quoteHash: "verify-flash-uniswap-hash",
    };
    const marketSnapshot = {
      source: "truthly_cross_market_guard",
      network: "base-mainnet",
      assetSymbol: "ETH",
      assetAddress: flash.WETH_BASE.toLowerCase(),
      contraSymbol: "USDC",
      contraAddress: flash.USDC_BASE.toLowerCase(),
      side: "buy",
      notionalUsdc: "1",
      executionQuote,
      referenceQuote,
      integrity: {
        status: "verified",
        deviationBps: "14.27",
        maximumDeviationBps: 100,
        policy: "fresh_uniswap_reference_required_for_live_execution",
        reason: null,
        checkedAt: now,
      },
      impliedPriceUsd: executionQuote.impliedPriceUsd,
      providerQuoteId: executionQuote.providerQuoteId,
      fetchedAt: now,
      snapshotHash: "verify-flash-market-hash",
    };
    await db.insert(schema.councilRuns).values({
      id: councilRunId,
      mode: "live",
      sourceSignalId: signalId,
      inputHash: "verify-flash-council-input-hash",
      newsJson: JSON.stringify({ sourceId: signalId }),
      verificationJson: JSON.stringify({ verdict: "supported" }),
      marketSnapshotJson: JSON.stringify(marketSnapshot),
      councilJson: JSON.stringify({
        label: "LIVE AI COUNCIL — HERALD VERIFIED",
        mode: "live",
        model: "verify-flash-fixture",
        action: "BUY",
        assetSymbol: "ETH",
        assetAddress: flash.WETH_BASE.toLowerCase(),
        entryPriceUsd: "3500",
        stopLossPriceUsd: "3000",
        takeProfitPriceUsd: "4000",
        riskReward: "1.00",
        modelConfidence: 80,
        consensusConfidence: 75,
        consensus: "majority",
        reasoning: "Fixture Council result for the isolated no-side-effect route rehearsal.",
        disagreements: [],
        opinions: [],
        executionEligible: true,
        validUntil: councilValidUntil,
        generatedAt: now,
      }),
      status: "completed",
      validUntil: councilValidUntil,
      createdAt: now,
      completedAt: now,
    }).run();

    for (const payment of [
      { id: paymentId, receipt: receiptId, payer: agentWallet, tx: "0xverify-flashowned" },
      { id: otherPaymentId, receipt: wrongOwnerReceiptId, payer: otherWallet, tx: "0xverify-flashother" },
    ]) {
      await db.insert(schema.payments).values({
        id: payment.id,
        editionId,
        signalId,
        payerAddress: payment.payer,
        amountCents: 2,
        txHash: payment.tx,
        network: "eip155:8453",
        paidAt: now,
      }).run();
      await db.insert(schema.entitlements).values({
        id: payment.receipt,
        paymentId: payment.id,
        editionId,
        signalId,
        accountId: payment.payer,
        grantedAt: now,
      }).run();
    }

    await db.insert(schema.humanPrincipals).values({
      id: principalId,
      nullifierHash: `verify-flash-nullifier-${process.pid}`,
      ownerWallet: agentWallet,
      // A high-risk trade can only mint an authorization after Agent Pass was
      // enrolled for this principal. A deterministic hash-shaped fixture is
      // sufficient here; no World token is accepted or fabricated.
      worldSubHash: `verify-flash-world-sub-hash-${process.pid}`,
      status: "active",
      createdAt: now,
      updatedAt: now,
    }).run();
    const { credential: mandateToken } = await mandates.upsertMandate(principalId, {
      agentWallet,
      label: "Flash verification bounded trader",
      roles: ["trade_preview", "trade_execute"],
      allowedBeats: ["infrastructure"],
      dailyFilings: 0,
      dailyStakeAtomic: "0",
      maxTradeAtomic: "2000000", // $2/order
      freshPassAboveAtomic: "500000", // fresh World approval above $0.50
    });

    const post = async (body: unknown) => {
      const response = await route.POST(
        new NextRequest("http://localhost:3000/api/flash/trade", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${mandateToken}`,
          },
          body: JSON.stringify(body),
        }),
      );
      return { response, body: await response.json() };
    };

    console.log("— C2..C6: signal receipt + exact approval gate —");
    const missing = await post(requestBody(signalId, councilRunId, undefined));
    check(
      "C2 no receipt is a schema error; there is no signal-less/unpaid bypass",
      missing.response.status === 400 && missing.body.reason === "invalid_request" &&
        (missing.body.issues as string[] | undefined)?.some((issue) => issue.startsWith("receipt:")) === true,
    );

    const wrongOwner = await post(requestBody(signalId, councilRunId, wrongOwnerReceiptId));
    check(
      "C3 another wallet's valid story receipt is refused",
      wrongOwner.response.status === 403 && wrongOwner.body.reason === "receipt_owner_mismatch",
    );

    const heldRequest = requestBody(signalId, councilRunId, receiptId, { spend: "1.00" });
    const held = await post(heldRequest);
    check(
      "C4 owner-bound receipt reaches a payload-bound World hold above threshold",
      held.response.status === 409 && held.body.action_required === "world_agent_pass" &&
        held.body.approval?.receipt_id === receiptId,
    );

    const authorization = held.body.authorization_id
      ? await db.select().from(schema.worldAuthorizations)
          .where(eq(schema.worldAuthorizations.id, held.body.authorization_id)).get()
      : null;
    const authorizedPayload = authorization
      ? JSON.parse(authorization.payloadJson) as Record<string, unknown>
      : null;
    check(
      "C5 exact World authorization binds receipt + limit + bracket + idempotency key",
      authorizedPayload?.receipt_id === receiptId &&
        authorizedPayload.request_id === heldRequest.request_id &&
        authorizedPayload.order_type === "limit" &&
        authorizedPayload.limit_cross_price === "3500" &&
        authorizedPayload.take_profit_notional_price === "4000" &&
        authorizedPayload.stop_loss_notional_price === "3000",
    );

    const belowThreshold = await post(
      requestBody(signalId, councilRunId, receiptId, { spend: "0.25", approved: true }),
    );
    check(
      "C6 paid approved request reaches the honest unarmed-desk guard",
      belowThreshold.response.status === 200 && belowThreshold.body.reason === "desk_not_armed" &&
        belowThreshold.body.approval?.receipt_id === receiptId,
    );
    const outlivesCouncil = await post(
      requestBody(signalId, councilRunId, receiptId, {
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      }),
    );
    check(
      "C6 an order cannot remain live after its Council decision expires",
      outlivesCouncil.response.status === 422 &&
        outlivesCouncil.body.reason === "order_outlives_council",
    );

    console.log("— C7: the public desk contract —");
    const ledger = await (await route.GET()).json();
    check(
      "C7 GET lists eligible story and publishes the receipt requirement",
      ledger.desk_armed === false &&
        typeof ledger.intel_receipt_required === "string" &&
        typeof ledger.advanced_order_required === "string" &&
        ledger.eligible_signals?.some((signal: { id?: string }) => signal.id === signalId),
    );

    const advancedExpiry = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const base = {
      targetChain: flash.FLASH_BASE,
      contraChain: flash.FLASH_BASE,
      targetAsset: flash.WETH_BASE,
      contraAsset: flash.USDC_BASE,
      side: "buy" as const,
      orderType: "limit" as const,
      limitCrossPrice: "3500",
      expireTime: advancedExpiry,
      maxPriceImpact: "0.05",
      evmUsePermit2: false,
      forceMinimalAllowance: true,
      attachedBracket: {
        takeProfit: { notionalPrice: "4000" },
        stopLoss: { notionalPrice: "3000" },
        expireTime: advancedExpiry,
      },
    };

    console.log("— C8: library guard without a funder key —");
    try {
      await flash.executeFlashTrade({ ...base, qty: "1", funderAddress: "" });
      check("C8 library throws a clear error without a key", false, "did not throw");
    } catch (error) {
      check(
        "C8 library throws a clear error without a key",
        error instanceof Error && error.message.includes("not armed"),
      );
    }

    console.log("— C9..C10: injected submit flow (documented test hooks) —");
    let submitted: unknown = null;
    const threadedKeys: string[] = [];
    const fakeFetch = async (requestPath: string, body: unknown, apiKey: string): Promise<unknown> => {
      threadedKeys.push(apiKey);
      if (!apiKey) throw new Error("API key not threaded");
      if (requestPath === "/quote") {
        const order = body as typeof base & { qty: string; funderAddress: string };
        const deadline = String(Math.floor(Date.parse(order.expireTime) / 1000));
        const orderFields = [
          { name: "swapper", type: "address" },
          { name: "vault", type: "address" },
          { name: "recipient", type: "address" },
          { name: "fromToken", type: "address" },
          { name: "toToken", type: "address" },
          { name: "fromAmount", type: "uint256" },
          { name: "salt", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ];
        const entry = {
          domain: {
            name: "DefinitiveFlashAllowance",
            version: "1",
            chainId: "8453",
            verifyingContract: "0x5d00000873b6bf41539e6f5365b0ff7d3c368f78",
          },
          types: { FlashOrder: orderFields },
          primaryType: "FlashOrder",
          message: {
            swapper: order.funderAddress,
            vault: "0x2222222222222222222222222222222222222222",
            recipient: order.funderAddress,
            fromToken: flash.USDC_BASE,
            toToken: flash.WETH_BASE,
            fromAmount: "1000000",
            salt: "1",
            deadline,
          },
        };
        const exit = structuredClone(entry);
        Object.assign(exit.message, {
          fromToken: flash.WETH_BASE,
          toToken: flash.USDC_BASE,
          fromAmount: "760000000000000",
          salt: "2",
        });
        return {
          quoteId: "q-1",
          orderType: "limit",
          side: "buy",
          targetAsset: flash.WETH_BASE,
          contraAsset: flash.USDC_BASE,
          from: { asset: "contra", amount: "1", notional: "1" },
          // Deliberately adverse fixture: $1.00 spent, $0.90 received. This is
          // the required losing demo case, not a claim about live performance.
          to: { asset: "target", amount: "0.00038", notional: "0.9" },
          evm: {
            approveTx: {
              to: flash.USDC_BASE,
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: "approve",
                args: [
                  "0x5d00000873b6bf41539e6f5365b0ff7d3c368f78",
                  parseUnits("1", 6),
                ],
              }),
            },
            permitTypedData: null,
            orderTypedData: JSON.stringify(entry),
          },
          attachedBracket: {
            evm: {
              approveTx: {
                to: flash.WETH_BASE,
                data: encodeFunctionData({
                  abi: erc20Abi,
                  functionName: "approve",
                  args: [
                    "0x5d00000873b6bf41539e6f5365b0ff7d3c368f78",
                    parseUnits("0.00076", 18),
                  ],
                }),
              },
              permitTypedData: null,
              orderTypedData: JSON.stringify(exit),
            },
            salt: "2",
            deadline,
            signedMaxFromAmount: "0.00076",
          },
        };
      }
      if (requestPath === "/order") {
        submitted = body;
        return { orderId: "ord_test_1", attachedBracket: { status: "pending_activation" } };
      }
      throw new Error(`unexpected path ${requestPath}`);
    };
    const signatures: string[] = [];
    let approvals = 0;
    const fakeSigner = async (typed: string) => {
      signatures.push(typed);
      return "0x01" as `0x${string}`;
    };
    const outcome = await flash.executeFlashTrade(
      { ...base, qty: "1", funderAddress: "" },
      {
        fetchJson: fakeFetch,
        signer: fakeSigner,
        wallet: {
          address: "0x1111111111111111111111111111111111111111",
          sendTransaction: async () => {
            approvals++;
            return `0xapprove${approvals}` as `0x${string}`;
          },
          waitForTransactionReceipt: async () => ({}),
        },
      },
    );
    const submittedOrder = submitted as {
      userSignature?: string;
      quoteId?: string;
      evmOrderTypedData?: string;
      attachedBracket?: { userSignature?: string };
    } | null;
    check(
      "C9 submit carries two validated signatures and both token approvals",
      submittedOrder?.quoteId === "q-1" && submittedOrder.userSignature === "0x01" &&
        submittedOrder.attachedBracket?.userSignature === "0x01" &&
        Boolean(submittedOrder.evmOrderTypedData) && signatures.length === 2 &&
        approvals === 2 && threadedKeys.length >= 2,
    );
    check(
      "C10 outcome carries order/quote and adverse notional fields honestly",
      outcome.orderId === "ord_test_1" && outcome.quoteId === "q-1" &&
        outcome.spentNotional === "1" && outcome.receivedNotional === "0.9",
    );

    console.log("— C11: receipt-bearing ledger + losing demo row —");
    const tradeId = randomUUID();
    const ledgerRequestId = randomUUID();
    await db.insert(schema.trades).values({
      id: tradeId,
      requestId: ledgerRequestId,
      signalId,
      chain: flash.FLASH_BASE,
      side: "buy",
      qty: "1",
      targetAsset: flash.WETH_BASE,
      contraAsset: flash.USDC_BASE,
      tokenSymbol: "ETH",
      maxSpendUsdc: "1",
      orderType: "limit",
      limitPriceUsd: "3500",
      orderExpiresAt: advancedExpiry,
      takeProfitPriceUsd: "4000",
      stopLossPriceUsd: "3000",
      bracketStatus: outcome.bracketStatus,
      rationale: "Trial-only adverse outcome; no profitability claim.",
      councilRunId,
      receiptId,
      principalId,
      agentWallet,
      quoteId: outcome.quoteId,
      orderId: outcome.orderId,
      spentNotional: outcome.spentNotional,
      receivedNotional: outcome.receivedNotional,
      funder: outcome.funderAddress,
      status: "submitted",
      createdAt: now,
    }).run();
    const duplicate = await db.insert(schema.trades).values({
      id: randomUUID(),
      requestId: ledgerRequestId,
      signalId,
      chain: flash.FLASH_BASE,
      side: "buy",
      qty: "1",
      targetAsset: flash.WETH_BASE,
      contraAsset: flash.USDC_BASE,
      funder: "0x1111111111111111111111111111111111111111",
      status: "submitting",
      createdAt: now,
    }).onConflictDoNothing().returning({ id: schema.trades.id });
    const afterInsert = await (await route.GET()).json();
    const ledgerRow = afterInsert.trades?.find((trade: { id?: string }) => trade.id === tradeId);
    check(
      "C11 ledger returns the exact receipt and a losing ($1.00 → $0.90) demo outcome",
      ledgerRow?.receiptId === receiptId && ledgerRow.spentNotional === "1" &&
        ledgerRow.receivedNotional === "0.9" && duplicate.length === 0,
    );

    console.log("— C12: LIVE sponsor quote (no wallet, no execution) —");
    try {
      const liveOrder = {
        ...base,
        qty: "1",
        funderAddress: "0xa40c40db8dc44e1a05e382a4a01832777659d2b9",
      };
      const live = await flash.flashQuote(liveOrder);
      flashAuthorization.validateFlashQuote(live, liveOrder, { targetDecimals: 18 });
      check(
        "C12 live Flash quote returns entry + bracket EVM order data",
        Boolean(
          live.quoteId &&
            live.evm?.orderTypedData &&
            live.attachedBracket?.evm?.orderTypedData,
        ),
      );
    } catch (error) {
      check(
        "C12 live Flash quote returns entry + bracket EVM order data",
        false,
        error instanceof Error ? error.message : String(error),
      );
    }
  } finally {
    await rm(dbFile, { force: true });
    await rm(`${dbFile}-shm`, { force: true });
    await rm(`${dbFile}-wal`, { force: true });
  }

  console.log(`\nRESULT: ${passed}/${passed + failed} passed`);
  if (failures.length) for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  console.log(`RESULT: ${passed}/${passed + failed} passed (threw)`);
  process.exitCode = 1;
});
