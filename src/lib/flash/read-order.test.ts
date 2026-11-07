import assert from "node:assert/strict";
import { test } from "node:test";
import { readFlashOrder, summarizeFlashError } from "./trade";

test("reads one exact Flash order by provider id and funder", async () => {
  const original = globalThis.fetch;
  let requested = "";
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested = String(input);
    return Response.json({
      order: {
        orderId: "order-1",
        orderType: "limit",
        side: "buy",
        status: "ORDER_STATUS_ACCEPTED",
        closeReason: null,
        funderAddress: "0x1111111111111111111111111111111111111111",
        targetAsset: { address: "0x4200000000000000000000000000000000000006" },
        contraAsset: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
        qty: "1",
        limitCrossPrice: "3500",
        expiresAt: "2026-11-07T12:00:00.000Z",
        attachedBracket: {
          status: "pending_activation",
          bracketOrderId: null,
          takeProfit: { notionalPrice: "4000" },
          stopLoss: { notionalPrice: "3000" },
        },
      },
      fills: [],
    });
  }) as typeof fetch;
  try {
    const result = await readFlashOrder(
      "order-1",
      "0x1111111111111111111111111111111111111111",
      "test-key",
    );
    assert.equal(result.order.orderId, "order-1");
    assert.match(requested, /\/orders\/order-1\?/);
    assert.match(requested, /funderAddress=0x1111/);
  } finally {
    globalThis.fetch = original;
  }
});

test("fails closed on an unexpected provider read shape", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ orderId: "flat-shape" })) as typeof fetch;
  try {
    await assert.rejects(
      readFlashOrder(
        "order-1",
        "0x1111111111111111111111111111111111111111",
        "test-key",
      ),
      /unexpected shape/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("keeps raw provider envelopes out of the browser-safe error", () => {
  const summary = summarizeFlashError(
    new Error('flash /order failed (422): rejected {"private":"provider envelope"}'),
  );
  assert.equal(summary, "flash /order failed (422): rejected");
  assert.doesNotMatch(summary, /private|provider envelope/);
});
