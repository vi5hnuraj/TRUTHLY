import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFunctionData, erc20Abi, parseUnits } from "viem";
import {
  FLASH_ALLOWANCE_BASE,
  validateFlashQuote,
} from "./authorization";
import type { FlashOrder, FlashQuote } from "./trade";

const FUNDER = "0x1111111111111111111111111111111111111111";
const VAULT = "0x2222222222222222222222222222222222222222";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";

function fields() {
  return [
    { name: "swapper", type: "address" },
    { name: "vault", type: "address" },
    { name: "recipient", type: "address" },
    { name: "fromToken", type: "address" },
    { name: "toToken", type: "address" },
    { name: "fromAmount", type: "uint256" },
    { name: "salt", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ];
}

function fixture() {
  const expireTime = new Date(Date.now() + 60 * 60_000).toISOString();
  const deadline = String(Math.floor(Date.parse(expireTime) / 1000));
  const entry = {
    primaryType: "FlashOrder",
    domain: {
      name: "DefinitiveFlashAllowance",
      version: "1",
      chainId: "8453",
      verifyingContract: FLASH_ALLOWANCE_BASE,
    },
    types: { FlashOrder: fields() },
    message: {
      swapper: FUNDER,
      vault: VAULT,
      recipient: FUNDER,
      fromToken: USDC,
      toToken: WETH,
      fromAmount: parseUnits("1", 6).toString(),
      salt: "1",
      deadline,
    },
  };
  const exit = structuredClone(entry);
  Object.assign(exit.message, {
    fromToken: WETH,
    toToken: USDC,
    fromAmount: parseUnits("0.0006", 18).toString(),
    salt: "2",
  });
  const order: FlashOrder = {
    targetChain: "base",
    contraChain: "base",
    targetAsset: WETH,
    contraAsset: USDC,
    side: "buy",
    qty: "1",
    orderType: "limit",
    limitCrossPrice: "3500",
    expireTime,
    evmUsePermit2: false,
    forceMinimalAllowance: true,
    attachedBracket: {
      takeProfit: { notionalPrice: "4000" },
      stopLoss: { notionalPrice: "3000" },
      expireTime,
    },
    funderAddress: FUNDER,
  };
  const quote: FlashQuote = {
    quoteId: "q-test",
    orderType: "limit",
    side: "buy",
    targetAsset: WETH,
    contraAsset: USDC,
    from: { asset: "contra", amount: "1", notional: "1" },
    to: { asset: "target", amount: "0.0003", notional: "0.9" },
    evm: {
      approveTx: null,
      permitTypedData: null,
      orderTypedData: JSON.stringify(entry),
    },
    attachedBracket: {
      evm: {
        approveTx: null,
        permitTypedData: null,
        orderTypedData: JSON.stringify(exit),
      },
      salt: "2",
      deadline,
      signedMaxFromAmount: "0.0006",
    },
  };
  return { order, quote };
}

type MutableTypedOrder = {
  primaryType: string;
  domain: Record<string, string>;
  types: { FlashOrder: Array<{ name: string; type: string }> };
  message: Record<string, string>;
};

function mutateTyped(
  quote: FlashQuote,
  side: "entry" | "exit",
  change: (payload: MutableTypedOrder) => void,
) {
  const container = side === "entry" ? quote.evm! : quote.attachedBracket!.evm!;
  const payload = JSON.parse(container.orderTypedData) as MutableTypedOrder;
  change(payload);
  container.orderTypedData = JSON.stringify(payload);
}

test("accepts an exact limit entry and bounded attached bracket", () => {
  const { order, quote } = fixture();
  const result = validateFlashQuote(quote, order, { targetDecimals: 18 });
  assert.equal(result.entry.primaryType, "FlashOrder");
  assert.equal(result.exit.primaryType, "FlashOrder");
});

const mutations: Array<[
  string,
  "entry" | "exit",
  (data: MutableTypedOrder) => void,
]> = [
  ["redirected recipient", "entry", (data) => { data.message.recipient = "0x3333333333333333333333333333333333333333"; }],
  ["wrong chain", "entry", (data) => { data.domain.chainId = "1"; }],
  ["larger spend", "entry", (data) => { data.message.fromAmount = "2000000"; }],
  ["unrelated exit token", "exit", (data) => { data.message.fromToken = USDC; }],
  ["expired payload", "entry", (data) => { data.message.deadline = "1"; }],
  ["changed schema", "entry", (data) => { data.types.FlashOrder[0].type = "bytes32"; }],
  ["different vault", "exit", (data) => { data.message.vault = "0x3333333333333333333333333333333333333333"; }],
];

for (const [name, side, change] of mutations) {
  test(`rejects ${name} before signing`, () => {
    const { order, quote } = fixture();
    mutateTyped(quote, side, change);
    assert.throws(() => validateFlashQuote(quote, order, { targetDecimals: 18 }));
  });
}

test("rejects oversized bracket exposure even when payload and metadata agree", () => {
  const { order, quote } = fixture();
  quote.attachedBracket!.signedMaxFromAmount = "0.0007";
  mutateTyped(quote, "exit", (data) => {
    data.message.fromAmount = parseUnits("0.0007", 18).toString();
  });
  assert.throws(() => validateFlashQuote(quote, order, { targetDecimals: 18 }));
});

test("rejects Permit2 and quote/order identity drift", () => {
  const permit = fixture();
  permit.quote.evm!.permitTypedData = "{}";
  assert.throws(() => validateFlashQuote(permit.quote, permit.order, { targetDecimals: 18 }));

  const drift = fixture();
  drift.quote.targetAsset = "0x3333333333333333333333333333333333333333";
  assert.throws(() => validateFlashQuote(drift.quote, drift.order, { targetDecimals: 18 }));
});

test("accepts bounded ERC-20 approvals and rejects changed spender or unlimited amount", () => {
  const valid = fixture();
  valid.quote.evm!.approveTx = {
    to: USDC,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [FLASH_ALLOWANCE_BASE, parseUnits("1", 6)],
    }),
  };
  assert.doesNotThrow(() =>
    validateFlashQuote(valid.quote, valid.order, { targetDecimals: 18 }),
  );

  const wrongSpender = fixture();
  wrongSpender.quote.evm!.approveTx = {
    to: USDC,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: ["0x3333333333333333333333333333333333333333", parseUnits("1", 6)],
    }),
  };
  assert.throws(() =>
    validateFlashQuote(wrongSpender.quote, wrongSpender.order, { targetDecimals: 18 }),
  );

  const unlimited = fixture();
  unlimited.quote.attachedBracket!.evm!.approveTx = {
    to: WETH,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [FLASH_ALLOWANCE_BASE, BigInt(2) ** BigInt(256) - BigInt(1)],
    }),
  };
  assert.throws(() =>
    validateFlashQuote(unlimited.quote, unlimited.order, { targetDecimals: 18 }),
  );
});
