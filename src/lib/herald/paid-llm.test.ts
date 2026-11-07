/**
 * Offline: a local stand-in for the x402 inference server and a throwaway key.
 * Nothing here touches a real network or a funded wallet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { BASE_USDC, createPayingFetch, HERALD_NETWORK, maxAtomic } from "./paid-llm";

const CAP = BigInt(30_000);
const signer = privateKeyToAccount(generatePrivateKey());

function requirement(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: HERALD_NETWORK,
    amount: "20000",
    asset: BASE_USDC,
    payTo: "0x1111111111111111111111111111111111111111",
    maxTimeoutSeconds: 60,
    extra: { name: "USD Coin", version: "2" },
    ...overrides,
  };
}

/** Answers unpaid requests with 402 + `accepts`; paid ones with a chat completion. */
async function withX402Server(accepts: PaymentRequirements[], run: (url: string, paid: string[]) => Promise<void>) {
  const paid: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    const signature = req.headers["payment-signature"];
    if (typeof signature !== "string") {
      const header = encodePaymentRequiredHeader({ x402Version: 2, resource: { url: "http://local/chat", description: "", mimeType: "application/json" }, accepts });
      res.writeHead(402, { "PAYMENT-REQUIRED": header, "Content-Type": "application/json" }).end("{}");
      return;
    }
    paid.push(signature);
    const receipt = encodePaymentResponseHeader({ success: true, transaction: "0xfeed", network: HERALD_NETWORK });
    res.writeHead(200, { "PAYMENT-RESPONSE": receipt, "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: "test-model", choices: [{ message: { content: "ok" } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/chat`, paid);
  } finally {
    server.close();
  }
}

test("pays a Base USDC quote within the cap and reports the settlement", async () => {
  const solana = requirement({ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" });
  await withX402Server([solana, requirement()], async (url, paid) => {
    const { fetch: payingFetch, trace } = createPayingFetch(signer, CAP);
    const response = await payingFetch(url, { method: "POST", body: "{}" });
    assert.equal(response.status, 200);
    assert.equal(paid.length, 1);
    const payload = decodePaymentSignatureHeader(paid[0]);
    assert.equal(payload.accepted.network, HERALD_NETWORK);
    assert.equal(payload.accepted.amount, "20000");
    assert.equal(trace.signed, "20000");
    assert.equal(decodePaymentResponseHeader(response.headers.get("PAYMENT-RESPONSE") ?? "").transaction, "0xfeed");
  });
});

test("refuses, without signing, a quote above the cap", async () => {
  await withX402Server([requirement({ amount: "30001" })], async (url, paid) => {
    const { fetch: payingFetch, trace } = createPayingFetch(signer, CAP);
    await assert.rejects(payingFetch(url, { method: "POST", body: "{}" }));
    assert.equal(paid.length, 0);
    assert.equal(trace.overCap, "30001");
    assert.equal(trace.signed, null);
  });
});

test("refuses other assets and other networks", async () => {
  const otherAsset = requirement({ asset: "0x2222222222222222222222222222222222222222" });
  const otherChain = requirement({ network: "eip155:1" });
  await withX402Server([otherAsset, otherChain], async (url, paid) => {
    const { fetch: payingFetch, trace } = createPayingFetch(signer, CAP);
    await assert.rejects(payingFetch(url, { method: "POST", body: "{}" }));
    assert.equal(paid.length, 0);
    assert.equal(trace.signed, null);
  });
});

test("HERALD_MAX_ATOMIC parsing: default, invalid, and hard ceiling", () => {
  assert.equal(maxAtomic(undefined), BigInt(30_000));
  assert.equal(maxAtomic("12345"), BigInt(12_345));
  assert.equal(maxAtomic("-5"), BigInt(30_000));
  assert.equal(maxAtomic("0.05"), BigInt(30_000));
  assert.equal(maxAtomic("999999999999"), BigInt(1_000_000));
});
