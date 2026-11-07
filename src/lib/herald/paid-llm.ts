import * as z from "zod";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import {
  decodePaymentResponseHeader,
  wrapFetchWithPayment,
  x402Client,
  type PaymentRequirements,
} from "@x402/fetch";

/**
 * Herald pays for its own inference: an x402 v2 "exact" USDC payment on Base,
 * signed by the newsroom treasury, capped per call by HERALD_MAX_ATOMIC.
 */
const ENDPOINT = "https://glim.sh/api/v1/inference/v1/chat/completions";
export const HERALD_NETWORK = "eip155:8453";
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TIMEOUT_MS = 25_000;
const DEFAULT_MODEL = "anthropic/claude-sonnet-4.6";
const DEFAULT_MAX_TOKENS = 500;
const DEFAULT_MAX_ATOMIC = BigInt(30_000); // $0.03 in USDC's 6-decimal atomic units
const HARD_CEILING_ATOMIC = BigInt(1_000_000); // $1.00: no env value can lift the cap past this

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface PaidChatOptions {
  maxTokens?: number;
  model?: string;
}

export interface PaidChatResult {
  text: string;
  model: string;
  costAtomic: string | null;
  paymentTx: string | null;
}

export type PaidLlmErrorCode =
  | "not_configured"
  | "payment_refused"
  | "payment_failed"
  | "http_error"
  | "bad_response"
  | "timeout"
  | "network";

export class PaidLlmError extends Error {
  readonly code: PaidLlmErrorCode;
  readonly status?: number;

  constructor(code: PaidLlmErrorCode, message: string, status?: number) {
    super(message);
    this.name = "PaidLlmError";
    this.code = code;
    this.status = status;
  }
}

/** One-line description of any thrown value, for logs (never includes key material). */
export function describeError(error: unknown): string {
  if (error instanceof PaidLlmError) return `${error.code}: ${error.message}`;
  if (error instanceof Error)
    return `${error.name}: ${error.message}`.slice(0, 300);
  return String(error).slice(0, 300);
}

export function maxAtomic(raw = process.env.HERALD_MAX_ATOMIC): bigint {
  const value = raw?.trim();
  if (!value) return DEFAULT_MAX_ATOMIC;
  if (!/^\d{1,18}$/.test(value)) {
    console.error(
      "HERALD_MAX_ATOMIC is not a whole number of atomic USDC units; using the default cap.",
    );
    return DEFAULT_MAX_ATOMIC;
  }
  const cap = BigInt(value);
  return cap > HARD_CEILING_ATOMIC ? HARD_CEILING_ATOMIC : cap;
}

let treasury: PrivateKeyAccount | null = null;

function treasurySigner(): PrivateKeyAccount {
  if (treasury) return treasury;
  const raw = process.env.TREASURY_PRIVATE_KEY?.trim() ?? "";
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) {
    throw new PaidLlmError(
      "not_configured",
      "TREASURY_PRIVATE_KEY is missing or malformed",
    );
  }
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
  try {
    treasury = privateKeyToAccount(key);
  } catch {
    // Deliberately drop the underlying error: its message could echo key material.
    throw new PaidLlmError(
      "not_configured",
      "TREASURY_PRIVATE_KEY is not a valid secp256k1 key",
    );
  }
  return treasury;
}

export function isBaseUsdc(req: PaymentRequirements): boolean {
  return (
    req.scheme === "exact" &&
    req.network === HERALD_NETWORK &&
    typeof req.asset === "string" &&
    req.asset.toLowerCase() === BASE_USDC.toLowerCase()
  );
}

export function withinCap(req: PaymentRequirements, cap: bigint): boolean {
  return /^\d{1,30}$/.test(req.amount) && BigInt(req.amount) <= cap;
}

/** What the payment policy saw during one call: a refused quote, or the amount it signed for. */
export interface PaymentTrace {
  overCap: string | null;
  signed: string | null;
}

/**
 * A fetch that answers x402 402s by paying, but only in Base USDC (exact scheme)
 * and only up to `cap` atomic units. Anything else is refused before signing.
 */
export function createPayingFetch(
  signer: ConstructorParameters<typeof ExactEvmScheme>[0],
  cap: bigint,
  baseFetch: typeof fetch = fetch,
) {
  const trace: PaymentTrace = { overCap: null, signed: null };
  const client = new x402Client()
    .register(HERALD_NETWORK, new ExactEvmScheme(signer))
    .registerPolicy((_version, reqs) => {
      const usdc = reqs.filter(isBaseUsdc);
      const affordable = usdc.filter((req) => withinCap(req, cap));
      if (affordable.length === 0 && usdc.length > 0)
        trace.overCap = usdc[0].amount;
      // The default selector takes the first option, so put the cheapest first.
      return affordable.sort((a, b) =>
        BigInt(a.amount) < BigInt(b.amount) ? -1 : 1,
      );
    })
    .onBeforePaymentCreation(async ({ selectedRequirements: req }) =>
      isBaseUsdc(req) && withinCap(req, cap)
        ? undefined
        : {
            abort: true as const,
            reason: "requirement is outside Herald's payment policy",
          },
    )
    .onAfterPaymentCreation(async ({ selectedRequirements }) => {
      trace.signed = selectedRequirements.amount;
    });
  return { fetch: wrapFetchWithPayment(baseFetch, client), trace };
}

function classifyFetchError(
  error: unknown,
  trace: PaymentTrace,
  cap: bigint,
): PaidLlmError {
  if (trace.overCap !== null) {
    return new PaidLlmError(
      "payment_refused",
      `quoted ${trace.overCap} atomic USDC, over Herald's cap of ${cap}`,
    );
  }
  const name = error instanceof Error ? error.name : "";
  const message = describeError(error);
  if (name === "TimeoutError" || name === "AbortError") {
    return new PaidLlmError(
      "timeout",
      `no response within ${TIMEOUT_MS / 1000}s`,
    );
  }
  if (
    /No network\/scheme registered|filtered out by policies|Payment creation aborted|No client registered/.test(
      message,
    )
  ) {
    return new PaidLlmError(
      "payment_refused",
      "no acceptable Base USDC payment option was offered",
    );
  }
  if (
    /Failed to (create payment payload|parse payment requirements)/.test(
      message,
    )
  ) {
    return new PaidLlmError("payment_failed", message.slice(0, 200));
  }
  return new PaidLlmError("network", message.slice(0, 200));
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new PaidLlmError(
        "timeout",
        `response body not received within ${TIMEOUT_MS / 1000}s`,
      );
    }
    throw new PaidLlmError(
      "network",
      `could not read response body (${describeError(error)})`,
    );
  }
}

function paymentRejectionReason(response: Response): string {
  const header = response.headers.get("PAYMENT-REQUIRED");
  if (!header) return "no reason given";
  try {
    return decodePaymentRequiredHeader(header).error ?? "no reason given";
  } catch (error) {
    console.error(
      "Herald could not decode a PAYMENT-REQUIRED header:",
      describeError(error),
    );
    return "unreadable PAYMENT-REQUIRED header";
  }
}

async function httpFailure(response: Response): Promise<PaidLlmError> {
  if (response.status === 402) {
    const reason = paymentRejectionReason(response).slice(0, 120);
    return new PaidLlmError(
      "payment_failed",
      `payment was not accepted (HTTP 402: ${reason})`,
      402,
    );
  }
  const body = (await readBody(response)).replace(/\s+/g, " ").slice(0, 160);
  return new PaidLlmError(
    "http_error",
    `inference returned HTTP ${response.status}: ${body}`,
    response.status,
  );
}

function settlement(response: Response): {
  tx: string | null;
  amount: string | null;
} {
  const header =
    response.headers.get("PAYMENT-RESPONSE") ??
    response.headers.get("X-PAYMENT-RESPONSE");
  if (!header) return { tx: null, amount: null };
  try {
    const settled = decodePaymentResponseHeader(header);
    return { tx: settled.transaction || null, amount: settled.amount ?? null };
  } catch (error) {
    console.error(
      "Herald could not decode the PAYMENT-RESPONSE header:",
      describeError(error),
    );
    return { tx: null, amount: null };
  }
}

const completionSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable().optional() }),
      }),
    )
    .min(1),
});

function completionText(raw: string): { text: string; model?: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new PaidLlmError("bad_response", "inference reply was not JSON");
  }
  const parsed = completionSchema.safeParse(json);
  const text = parsed.success
    ? parsed.data.choices[0].message.content?.trim()
    : undefined;
  if (!text)
    throw new PaidLlmError(
      "bad_response",
      "inference reply had no message content",
    );
  return { text, model: parsed.success ? parsed.data.model : undefined };
}

/** Calls the x402-paid chat endpoint once. Throws PaidLlmError on any failure. */
export async function paidChat(
  messages: ChatMessage[],
  opts: PaidChatOptions = {},
): Promise<PaidChatResult> {
  const model =
    opts.model ?? (process.env.HERALD_MODEL?.trim() || DEFAULT_MODEL);
  const cap = maxAtomic();
  const { fetch: payingFetch, trace } = createPayingFetch(
    treasurySigner(),
    cap,
  );

  let response: Response;
  try {
    response = await payingFetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw classifyFetchError(error, trace, cap);
  }
  if (!response.ok) throw await httpFailure(response);

  const reply = completionText(await readBody(response));
  const settled = settlement(response);
  return {
    text: reply.text,
    model: reply.model ?? model,
    costAtomic: settled.amount ?? trace.signed,
    paymentTx: settled.tx,
  };
}
