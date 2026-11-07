import { createPublicClient, createWalletClient, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { validateFlashQuote } from "./authorization";

/**
 * FLASH TRADE DESK — Definitive Flash API integration.
 *
 * Flow (all real, per https://flash.definitive.fi/docs/limit-order):
 *   1. POST /quote        — Flash prices the order and returns EIP-712 typed data
 *                           (+ an allowance tx when the spent token needs one).
 *   2. funder wallet signs — the EIP-712 FlashOrder payload (server-side key,
 *                           env FLASH_FUNDER_PRIVATE_KEY; a demo-only burner).
 *   3. POST /order        — Flash executes MEV-protected on-chain.
 *
 * NO MOCKS in production paths: every network call hits flash.definitive.fi and
 * every signature comes from a real key. Tests inject `fetchJson` and `signer`
 * through the documented parameters — production calls never do.
 *
 * Sizing discipline: this is the demonstrated "agent trades on paid, verified
 * intelligence" step, demo-scale by design. The application path submits an
 * expiring limit buy — a qualifying Flash advanced order — never a blind
 * market buy. The generic client type retains "market" only for legacy/tests.
 */

const FLASH_URL = "https://flash.definitive.fi/v1";

export const FLASH_BASE = "base" as const;

// Base mainnet canonical addresses.
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const; // USDC
export const WETH_BASE = "0x4200000000000000000000000000000000000006" as const; // WETH

/** Public integrator key — Definitive-documented, safe for development. */
const DEV_API_KEY = "dpka_513a2bd7_57a2_46d2_927b_2a3857fe271b";

export type FlashOrder = {
  targetChain: "base";
  contraChain: "base";
  targetAsset: string;
  contraAsset: string;
  side: "buy" | "sell";
  qty: string;
  orderType: "market" | "limit";
  maxSlippage?: string;
  maxPriceImpact?: string;
  limitNotionalPrice?: string;
  limitCrossPrice?: string;
  expireTime?: string;
  evmUsePermit2?: boolean;
  forceMinimalAllowance?: boolean;
  attachedBracket?: {
    takeProfit: { notionalPrice: string };
    stopLoss: { notionalPrice: string };
    expireTime?: string;
  };
  funderAddress: string;
};

export type FlashQuote = {
  quoteId: string;
  orderType: "market" | "limit";
  side: "buy" | "sell";
  targetAsset: string;
  contraAsset: string;
  from: { asset: "target" | "contra"; amount: string; notional: string };
  to: { asset: "target" | "contra"; amount: string; notional: string };
  recommendedSlippage?: string;
  evm?: {
    approveTx?: { to: string; data: string } | null;
    permitTypedData?: string | null;
    orderTypedData: string;
  };
  attachedBracket?: {
    evm?: {
      approveTx?: { to: string; data: string } | null;
      permitTypedData?: string | null;
      orderTypedData: string;
    } | null;
    salt: string | null;
    deadline: string;
    signedMaxFromAmount: string;
  } | null;
};

export type FlashSubmitResult = {
  orderId: string;
  attachedBracket?: { status?: string; bracketOrderId?: string } | null;
};

export type FlashTradeOutcome = {
  ok: true;
  orderId: string;
  quoteId: string;
  spentNotional: string;
  receivedNotional: string;
  funderAddress: string;
  bracketStatus: string | null;
}

export type FlashOrderDetail = {
  order: {
    orderId: string;
    orderType: string;
    side: string;
    status: string;
    closeReason: string | null;
    funderAddress: string;
    targetAsset: { address: string };
    contraAsset: { address: string };
    qty: string;
    limitCrossPrice: string | null;
    expiresAt: string | null;
    attachedBracket?: {
      status: string;
      bracketOrderId: string | null;
      takeProfit: { notionalPrice?: string | null } | null;
      stopLoss: { notionalPrice?: string | null } | null;
    } | null;
  };
  fills: Array<{
    status: string;
    notional: string;
    venues: string[];
    transactionId: string;
    targetAmount: string;
    contraAmount: string;
    fillPrice: string;
    filledAt: string;
  }>;
};

/** JSON POST against Flash's API. Injectable for tests (documented hook). */
export type FetchJson = (path: string, body: unknown, apiKey: string) => Promise<unknown>;
async function callFlash(
  path: string,
  body: unknown,
  apiKey: string,
  attempt = 0,
): Promise<unknown> {
  const quoteOnly = path === "/quote";
  let res: Response;
  try {
    res = await fetch(`${FLASH_URL}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-definitive-api-key": apiKey,
        // Flash's edge rejects some default programmatic user agents. Identify
        // this integration consistently without exposing credentials.
        "user-agent": "TRUTHLY/1.0",
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(25_000),
    });
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    if (quoteOnly && timedOut && attempt === 0) {
      return callFlash(path, body, apiKey, 1);
    }
    throw new Error(
      timedOut
        ? `flash ${path} timed out; ${quoteOnly ? "nothing was submitted" : "submission status is unknown"}`
        : `flash ${path} could not be reached`,
    );
  }

  if (res.status === 429 && quoteOnly && attempt === 0) {
    return callFlash(path, body, apiKey, 1);
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const detail =
      (json as { error?: { code?: string; message?: string } } | null)?.error?.message ??
      res.statusText;
    throw new Error(`flash ${path} failed (${res.status}): ${detail}`);
  }
  return json;
}

export const defaultFetchJson: FetchJson = (path, body, apiKey) =>
  callFlash(path, body, apiKey);

async function getFlashOrder(
  orderId: string,
  funderAddress: string,
  apiKey: string,
  attempt = 0,
): Promise<FlashOrderDetail> {
  const url = new URL(`${FLASH_URL}/orders/${encodeURIComponent(orderId)}`);
  url.searchParams.set("funderAddress", funderAddress);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        accept: "application/json",
        "x-definitive-api-key": apiKey,
        "user-agent": "TRUTHLY/1.0",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    if (timedOut && attempt === 0) {
      return getFlashOrder(orderId, funderAddress, apiKey, 1);
    }
    throw new Error(timedOut ? "flash order read timed out" : "flash order could not be reached");
  }
  if (response.status === 429 && attempt === 0) {
    return getFlashOrder(orderId, funderAddress, apiKey, 1);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      (payload as { error?: { message?: string } } | null)?.error?.message ??
      response.statusText;
    throw new Error(`flash order read failed (${response.status}): ${detail}`);
  }
  const result = payload as Partial<FlashOrderDetail>;
  if (!result.order || !Array.isArray(result.fills)) {
    throw new Error("flash order read returned an unexpected shape");
  }
  return result as FlashOrderDetail;
}

/** Safe, idempotent provider readback for ledger reconciliation. */
export function readFlashOrder(
  orderId: string,
  funderAddress: string,
  apiKey = flashApiKey(),
): Promise<FlashOrderDetail> {
  return getFlashOrder(orderId, funderAddress, apiKey);
}

/** Browser-safe Flash error summary; full details remain in the private server log/audit row. */
export function summarizeFlashError(error: unknown, maxLength = 180): string {
  const raw = error instanceof Error ? error.message : "Flash request failed";
  const withoutEnvelope = raw.replace(/\s*[{[]\s*["'][\s\S]*$/, "").trim() || raw;
  if (withoutEnvelope.length <= maxLength) return withoutEnvelope;
  const slice = withoutEnvelope.slice(0, maxLength);
  const boundary = slice.lastIndexOf(" ");
  return `${(boundary > maxLength / 2 ? slice.slice(0, boundary) : slice).trimEnd()}…`;
}

/** Signs the quote's EIP-712 order payload. Injectable for tests. */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type OrderSigner = (
  orderTypedData: string,
  funder: { account?: unknown; signTypedData: (args: any) => Promise<Hex> },
) => Promise<Hex>;
/* eslint-enable @typescript-eslint/no-explicit-any */
export const defaultOrderSigner: OrderSigner = async (orderTypedData, funder) => {
  const { domain, types, primaryType, message } = JSON.parse(orderTypedData);
  return funder.signTypedData({ domain, types, primaryType, message, account: funder.account });
};

export function flashApiKey(): string {
  return process.env.FLASH_API_KEY || DEV_API_KEY;
}

/** Is the desk armed? Quote-only mode needs no key; execution needs the funder. */
export function flashDeskConfigured(): boolean {
  return !!process.env.FLASH_FUNDER_PRIVATE_KEY;
}

function walletFor(pk: string, rpcUrl?: string) {
  const account = privateKeyToAccount(pk.startsWith("0x") ? (pk as `0x${string}`) : (`0x${pk}` as `0x${string}`));
  return {
    signer: createWalletClient({ account, chain: base, transport: http(rpcUrl || process.env.FLASH_RPC_URL) }),
    publicClient: createPublicClient({ chain: base, transport: http(rpcUrl || process.env.FLASH_RPC_URL) }),
    address: account.address,
  };
}

/**
 * Quote-only read: real pricing from Flash, no wallet/side effects.
 * Safe to call from UI/status routes any time.
 */
export async function flashQuote(
  order: FlashOrder,
  opts: { fetchJson?: FetchJson; apiKey?: string } = {},
): Promise<FlashQuote> {
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  return (await fetchJson("/quote", order, opts.apiKey ?? flashApiKey())) as FlashQuote;
}

/**
 * The full on-chain trade: quote → allowance (if needed) → sign → submit.
 * Throws on any real failure; the caller records the outcome.
 */
export type DeskWallet = {
  /** Test-only injected funder identity. Production derives this from the key. */
  address?: string;
  sendTransaction: (tx: { to: Hex; data: Hex; value: bigint }) => Promise<Hex>;
  waitForTransactionReceipt: (args: { hash: Hex }) => Promise<unknown>;
};

export async function executeFlashTrade(
  order: FlashOrder,
  opts: {
    fetchJson?: FetchJson;
    signer?: OrderSigner;
    privateKey?: string;
    rpcUrl?: string;
    targetDecimals?: number;
    /** Test-only injection: a stand-in wallet. Production paths never pass it. */
    wallet?: DeskWallet;
  } = {},
): Promise<FlashTradeOutcome> {
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const sign = opts.signer ?? defaultOrderSigner;
  const privateKey = opts.privateKey ?? process.env.FLASH_FUNDER_PRIVATE_KEY;
  if (!privateKey && !opts.wallet) {
    throw new Error("flash desk not armed: FLASH_FUNDER_PRIVATE_KEY missing");
  }

  const walletCtx = privateKey ? walletFor(privateKey, opts.rpcUrl) : null;
  // Injected wallet path: no network ownership, no real key involved.
  const deskWallet: DeskWallet = opts.wallet
    ? opts.wallet
    : {
        sendTransaction: (tx) => walletCtx!.signer.sendTransaction(tx),
        waitForTransactionReceipt: (args) => walletCtx!.publicClient.waitForTransactionReceipt(args as never),
      };
  const funderAddress = walletCtx ? walletCtx.address : opts.wallet?.address ?? "0xinjected";
  const orderWithFunder = { ...order, funderAddress };

  const quote = (await fetchJson("/quote", orderWithFunder, flashApiKey())) as FlashQuote;
  if (!quote?.evm?.orderTypedData) {
    throw new Error("flash quote returned no EVM order typed data");
  }
  validateFlashQuote(quote, orderWithFunder, {
    targetDecimals: opts.targetDecimals ?? 18,
  });

  const signer = (walletCtx
    ? walletCtx.signer
    : { account: undefined, signTypedData: async () => "0x00" as Hex }) as never;

  // Attached brackets use separate bounded funding approval and signature
  // checks for the entry and protective exit. An exit may need a second token
  // approval for the asset it will sell.
  const approvals = [quote.evm.approveTx, quote.attachedBracket?.evm?.approveTx]
    .filter((tx): tx is { to: string; data: string } => Boolean(tx));
  for (const approval of approvals) {
    const hash = await deskWallet.sendTransaction({
      to: approval.to as Hex,
      data: approval.data as Hex,
      value: BigInt(0),
    });
    await deskWallet.waitForTransactionReceipt({ hash });
  }

  const userSignature = await sign(quote.evm.orderTypedData, signer);
  const entryPermit = quote.evm.permitTypedData
    ? {
        evmPermitTypedData: quote.evm.permitTypedData,
        evmPermitSignature: await sign(quote.evm.permitTypedData, signer),
      }
    : {};

  let attachedBracket: Record<string, unknown> | undefined;
  if (orderWithFunder.attachedBracket) {
    const bracket = quote.attachedBracket;
    if (!bracket?.evm?.orderTypedData) {
      throw new Error("flash quote returned no attached-bracket EVM order typed data");
    }
    attachedBracket = {
      ...orderWithFunder.attachedBracket,
      userSignature: await sign(bracket.evm.orderTypedData, signer),
      salt: bracket.salt,
      deadline: bracket.deadline,
      signedMaxFromAmount: bracket.signedMaxFromAmount,
      ...(bracket.evm.permitTypedData
        ? {
            evmPermitTypedData: bracket.evm.permitTypedData,
            evmPermitSignature: await sign(bracket.evm.permitTypedData, signer),
          }
        : {}),
    };
  }

  const submitted = (await fetchJson(
    "/order",
    {
      ...orderWithFunder,
      quoteId: quote.quoteId,
      userSignature,
      evmOrderTypedData: quote.evm.orderTypedData,
      ...entryPermit,
      ...(attachedBracket ? { attachedBracket } : {}),
    },
    flashApiKey(),
  )) as FlashSubmitResult;

  return {
    ok: true,
    orderId: submitted.orderId,
    quoteId: quote.quoteId,
    spentNotional: orderWithFunder.side === "buy" ? orderWithFunder.qty : quote.from.notional,
    receivedNotional: quote.to.notional,
    funderAddress,
    bracketStatus: submitted.attachedBracket?.status ?? null,
  };
}
