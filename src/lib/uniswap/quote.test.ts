import assert from "node:assert/strict";
import test from "node:test";
import { USDC_BASE, WETH_BASE } from "../flash/trade";
import {
  fetchUniswapQuote,
  impliedUsdPrice,
  UniswapQuoteError,
  type UniswapFetch,
} from "./quote";

const SWAPPER = "0x1111111111111111111111111111111111111111";

function fixture(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "request-123",
    routing: "CLASSIC",
    quote: {
      chainId: 8453,
      input: { amount: "1000000", token: USDC_BASE },
      output: {
        amount: "250000000000000",
        token: WETH_BASE,
        recipient: SWAPPER,
      },
      swapper: SWAPPER,
      tradeType: "EXACT_INPUT",
      quoteId: "quote-123",
      route: [
        [
          {
            type: "v3-pool",
            address: "0x2222222222222222222222222222222222222222",
            tokenIn: { address: USDC_BASE },
            tokenOut: { address: WETH_BASE },
          },
        ],
      ],
      routeString: "[V3] USDC -> WETH",
      blockNumber: "53970000",
      gasFeeUSD: "0.002",
      priceImpact: 0.01,
      txFailureReasons: ["TRANSFER_FROM_FAILED"],
      // These fields are intentionally present in the provider fixture. The
      // production adapter must never return or persist them.
      encodedOrder: "secret-order-payload",
      swapTransaction: { to: "0x3333333333333333333333333333333333333333", data: "0xdeadbeef" },
      ...overrides,
    },
    permitData: { secret: "permit-payload" },
    swapTransaction: { data: "0xdeadbeef" },
  };
}

test("requires a server-side Uniswap API key before making a request", async () => {
  const previous = process.env.UNISWAP_API_KEY;
  delete process.env.UNISWAP_API_KEY;
  let called = false;
  const fetchImpl: UniswapFetch = async () => {
    called = true;
    return new Response();
  };
  try {
    await assert.rejects(
      fetchUniswapQuote(
        { notionalUsdc: "1", swapper: SWAPPER },
        { apiKey: "", fetchImpl },
      ),
      (error: unknown) =>
        error instanceof UniswapQuoteError && error.code === "not_configured",
    );
    assert.equal(called, false);
  } finally {
    if (previous === undefined) delete process.env.UNISWAP_API_KEY;
    else process.env.UNISWAP_API_KEY = previous;
  }
});

test("pins Base AMM protocols, attributes the agent and strips executable payloads", async () => {
  const captured: { headers: Headers; body: Record<string, unknown> } = {
    headers: new Headers(),
    body: {},
  };
  const fetchImpl: UniswapFetch = async (_url, init) => {
    captured.headers = new Headers(init?.headers);
    captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify(fixture()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const snapshot = await fetchUniswapQuote(
    {
      notionalUsdc: "1",
      swapper: SWAPPER,
      decisionOrigin: "human_mediated",
    },
    {
      apiKey: "test-key-never-logged",
      fetchImpl,
      now: () => new Date("2026-11-06T12:00:00.000Z"),
    },
  );

  assert.equal(captured.headers.get("x-api-key"), "test-key-never-logged");
  assert.equal(captured.headers.get("x-universal-router-version"), "2.1.2");
  assert.deepEqual(captured.body.protocols, ["V2", "V3", "V4"]);
  assert.equal(captured.body.routingPreference, "BEST_PRICE");
  assert.match(String(captured.headers.get("x-agent-info")), /truthly-market-integrity/);

  assert.equal(snapshot.impliedPriceUsd, "4000.00000000");
  assert.equal(snapshot.quotedReceiveAmount, "0.00025");
  assert.deepEqual(snapshot.protocols, ["V3"]);
  assert.equal(snapshot.providerRequestId, "request-123");
  assert.equal("permitData" in snapshot, false);
  assert.equal("swapTransaction" in snapshot, false);
  assert.equal("encodedOrder" in snapshot, false);
  assert.equal(JSON.stringify(snapshot).includes("test-key-never-logged"), false);
});

test("rejects token drift and non-benign simulation failures", async () => {
  const respond = (payload: unknown): UniswapFetch => async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  await assert.rejects(
    fetchUniswapQuote(
      { notionalUsdc: "1", swapper: SWAPPER },
      {
        apiKey: "test-key",
        fetchImpl: respond(
          fixture({ output: { amount: "250000000000000", token: USDC_BASE } }),
        ),
      },
    ),
    (error: unknown) =>
      error instanceof UniswapQuoteError && error.code === "quote_mismatch",
  );

  await assert.rejects(
    fetchUniswapQuote(
      { notionalUsdc: "1", swapper: SWAPPER },
      {
        apiKey: "test-key",
        fetchImpl: respond(fixture({ txFailureReasons: ["SIMULATION_ERROR"] })),
      },
    ),
    (error: unknown) =>
      error instanceof UniswapQuoteError && error.code === "simulation_failed",
  );
});

test("price arithmetic never crosses floating point", () => {
  assert.equal(
    impliedUsdPrice(BigInt(1_000_000), BigInt("250000000000000")),
    "4000.00000000",
  );
  assert.throws(() => impliedUsdPrice(BigInt(1), BigInt(0)));
});
