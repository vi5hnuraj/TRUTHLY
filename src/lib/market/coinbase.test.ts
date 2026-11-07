import assert from "node:assert/strict";
import test from "node:test";
import { ethHistoricalBars, ethPriceAt } from "./coinbase";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("falls back to real Binance candles when Coinbase returns no history", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("coinbase.com")) return Response.json([]);
    return Response.json([
      [1794000000000, "2200", "2250", "2180", "2230", "1000"],
      [1794003600000, "2230", "2260", "2210", "2240", "1200"],
    ]);
  }) as typeof fetch;

  const result = await ethHistoricalBars("1h", new Date("2026-11-07T00:00:00.000Z"));
  assert.equal(result.source, "Binance");
  assert.equal(result.data.length, 2);
  assert.equal(result.data[0].open, 2200);
  assert(calls[0].includes("coinbase.com"));
  assert(calls[1].includes("binance.com"));
});

test("posted-price lookup uses the same real-venue fallback", async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).includes("coinbase.com")) {
      return new Response("temporarily unavailable", { status: 503 });
    }
    return Response.json([
      [1794000000000, "2200", "2250", "2180", "2230", "1000"],
      [1794003600000, "2230", "2260", "2210", "2240", "1200"],
    ]);
  }) as typeof fetch;

  assert.equal(await ethPriceAt(new Date(1794003500000)), 2240);
});
