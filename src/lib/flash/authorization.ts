import { decodeFunctionData, erc20Abi, isAddress, parseUnits } from "viem";
import type { FlashOrder, FlashQuote } from "./trade";

/** DefinitiveFlashAllowance on Base, verified from Flash's EIP-712 payload. */
export const FLASH_ALLOWANCE_BASE =
  "0x5d00000873b6bf41539e6f5365b0ff7d3c368f78";

const BASE_CHAIN_ID = 8453;
const ORDER_FIELDS = [
  ["swapper", "address"],
  ["vault", "address"],
  ["recipient", "address"],
  ["fromToken", "address"],
  ["toToken", "address"],
  ["fromAmount", "uint256"],
  ["salt", "uint256"],
  ["deadline", "uint256"],
] as const;

type TypedField = { name: string; type: string };
type TypedOrder = {
  primaryType?: unknown;
  domain?: {
    name?: unknown;
    version?: unknown;
    chainId?: unknown;
    verifyingContract?: unknown;
  };
  types?: { FlashOrder?: TypedField[] };
  message?: Record<string, unknown>;
};

const sameAddress = (left: unknown, right: unknown): boolean =>
  typeof left === "string" &&
  typeof right === "string" &&
  left.toLowerCase() === right.toLowerCase();

function parseTypedOrder(raw: string, label: string): TypedOrder {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as TypedOrder;
  } catch {
    throw new Error(`Flash ${label} signing payload is not valid JSON.`);
  }
}

function integer(value: unknown, label: string): bigint {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text)) throw new Error(`Flash ${label} is not an unsigned integer.`);
  return BigInt(text);
}

function validateTypedEnvelope(
  data: TypedOrder,
  funderAddress: string,
  label: string,
): Record<string, unknown> {
  if (!isAddress(funderAddress)) {
    throw new Error(`Flash ${label} funder is not a valid EVM address.`);
  }
  const fields = data.types?.FlashOrder?.map((field) => [field.name, field.type]);
  if (JSON.stringify(fields) !== JSON.stringify(ORDER_FIELDS)) {
    throw new Error(`Flash ${label} signing schema is not the expected FlashOrder schema.`);
  }
  if (
    data.primaryType !== "FlashOrder" ||
    data.domain?.name !== "DefinitiveFlashAllowance" ||
    data.domain?.version !== "1" ||
    Number(data.domain?.chainId) !== BASE_CHAIN_ID ||
    !sameAddress(data.domain?.verifyingContract, FLASH_ALLOWANCE_BASE)
  ) {
    throw new Error(`Flash ${label} signing domain is not the approved Base allowance contract.`);
  }

  const message = data.message;
  if (!message) throw new Error(`Flash ${label} signing message is missing.`);
  if (
    !sameAddress(message.swapper, funderAddress) ||
    !sameAddress(message.recipient, funderAddress)
  ) {
    throw new Error(`Flash ${label} redirects the trade away from the approved funder.`);
  }
  if (
    typeof message.vault !== "string" ||
    !isAddress(message.vault) ||
    /^0x0{40}$/i.test(message.vault)
  ) {
    throw new Error(`Flash ${label} uses an invalid execution vault.`);
  }
  integer(message.salt, `${label} salt`);
  return message;
}

function validateDeadline(value: unknown, expectedIso: string, label: string): bigint {
  const actual = integer(value, `${label} deadline`);
  const expected = BigInt(Math.floor(Date.parse(expectedIso) / 1000));
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (actual <= now + BigInt(15)) {
    throw new Error(`Flash ${label} signing payload expires too soon.`);
  }
  // Flash derives the EIP-712 deadline from expireTime. One second of
  // serialization tolerance is harmless; anything else is a changed order.
  const delta = actual > expected ? actual - expected : expected - actual;
  if (delta > BigInt(1)) {
    throw new Error(`Flash ${label} deadline does not match the approved expiry.`);
  }
  return actual;
}

function validateApproval(
  tx: { to: string; data: string } | null | undefined,
  token: string,
  maximum: bigint,
  label: string,
): void {
  if (!tx) return;
  if (!sameAddress(tx.to, token)) {
    throw new Error(`Flash ${label} approval targets an unexpected token.`);
  }
  let decoded: ReturnType<typeof decodeFunctionData>;
  try {
    decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data as `0x${string}` });
  } catch {
    throw new Error(`Flash ${label} approval calldata is not ERC-20 approve.`);
  }
  const args = decoded.args as readonly unknown[] | undefined;
  const spender = args?.[0];
  const amount = args?.[1];
  if (
    decoded.functionName !== "approve" ||
    !sameAddress(spender, FLASH_ALLOWANCE_BASE) ||
    typeof amount !== "bigint" ||
    amount <= BigInt(0) ||
    amount > maximum
  ) {
    throw new Error(`Flash ${label} approval exceeds the bounded allowance policy.`);
  }
}

export type ValidatedFlashQuote = {
  entry: TypedOrder;
  exit: TypedOrder;
};

/**
 * Fail-closed validation before the limited burner signs a provider payload.
 *
 * The caller approved a TRUTHLY order, not arbitrary EIP-712 bytes. This
 * reconstructs the security boundary from that order and rejects recipient,
 * token, amount, chain, contract, expiry, vault and bracket-cap substitutions.
 * Every provider payload is treated as untrusted and checked against the exact
 * user-approved order before any signature is produced.
 */
export function validateFlashQuote(
  quote: FlashQuote,
  order: FlashOrder,
  opts: { targetDecimals: number; contraDecimals?: number },
): ValidatedFlashQuote {
  const contraDecimals = opts.contraDecimals ?? 6;
  if (
    quote.orderType !== order.orderType ||
    quote.side !== order.side ||
    !sameAddress(quote.targetAsset, order.targetAsset) ||
    !sameAddress(quote.contraAsset, order.contraAsset) ||
    quote.from?.asset !== "contra" ||
    parseUnits(quote.from.amount, contraDecimals) !== parseUnits(order.qty, contraDecimals) ||
    !(Number(quote.to?.amount) > 0)
  ) {
    throw new Error("Flash quote does not match the approved advanced order.");
  }
  if (!order.expireTime || !order.attachedBracket) {
    throw new Error("Flash advanced order requires an expiry and attached bracket.");
  }
  if (!quote.evm?.orderTypedData || quote.evm.permitTypedData) {
    throw new Error("Flash returned an unsupported entry signing path.");
  }
  if (!quote.attachedBracket?.evm?.orderTypedData || quote.attachedBracket.evm.permitTypedData) {
    throw new Error("Flash returned an unsupported bracket signing path.");
  }

  const entry = parseTypedOrder(quote.evm.orderTypedData, "entry");
  const exit = parseTypedOrder(quote.attachedBracket.evm.orderTypedData, "bracket");
  const entryMessage = validateTypedEnvelope(entry, order.funderAddress, "entry");
  const exitMessage = validateTypedEnvelope(exit, order.funderAddress, "bracket");

  if (
    !sameAddress(entryMessage.fromToken, order.contraAsset) ||
    !sameAddress(entryMessage.toToken, order.targetAsset) ||
    integer(entryMessage.fromAmount, "entry amount") !== parseUnits(order.qty, contraDecimals)
  ) {
    throw new Error("Flash entry signs an unexpected token transfer or amount.");
  }

  const signedMax = parseUnits(
    quote.attachedBracket.signedMaxFromAmount,
    opts.targetDecimals,
  );
  const received = parseUnits(quote.to.amount, opts.targetDecimals);
  if (
    !sameAddress(exitMessage.fromToken, order.targetAsset) ||
    !sameAddress(exitMessage.toToken, order.contraAsset) ||
    integer(exitMessage.fromAmount, "bracket amount") !== signedMax ||
    signedMax <= BigInt(0) ||
    signedMax * BigInt(10) > received * BigInt(21)
  ) {
    throw new Error("Flash bracket signs an unexpected or oversized exit authorization.");
  }

  // forceMinimalAllowance can include existing open orders. Permit a bounded
  // cumulative allowance (ten current-size orders), but never an unrelated
  // token, spender, malformed call or unlimited approval.
  validateApproval(
    quote.evm.approveTx,
    order.contraAsset,
    parseUnits(order.qty, contraDecimals) * BigInt(10),
    "entry",
  );
  validateApproval(
    quote.attachedBracket.evm.approveTx,
    order.targetAsset,
    signedMax * BigInt(10),
    "bracket",
  );

  const entryDeadline = validateDeadline(entryMessage.deadline, order.expireTime, "entry");
  const exitDeadline = validateDeadline(exitMessage.deadline, order.expireTime, "bracket");
  if (
    String(exitMessage.salt) !== quote.attachedBracket.salt ||
    String(exitDeadline) !== quote.attachedBracket.deadline ||
    !sameAddress(entryMessage.vault, exitMessage.vault) ||
    entryDeadline <= BigInt(0)
  ) {
    throw new Error("Flash bracket identity does not match the approved entry.");
  }

  return { entry, exit };
}
