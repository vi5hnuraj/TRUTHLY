import { signRequest } from "@worldcoin/idkit-core/signing";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import type { IDKitResult } from "@worldcoin/idkit-core";
import { getAddress } from "viem";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { principalForAgentWallet, registerPrincipal } from "@/lib/world/principals";
import { idkitConfig } from "./config";

/**
 * IDKit proof of unique human at byline enrollment.
 * The newsroom's read-payout pool flows to reporters, so one
 * person must not farm it from many wallets. Before a byline can enroll for the
 * appeal right, the human proves with World ID that they are unique; the proof's
 * signal is their wallet address, so it can't be reused for another wallet. The
 * backend verifies with the Developer Portal and records the action-scoped
 * nullifier — one human, one root principal, with explicitly delegated wallets.
 *
 * The durable uniqueness store is the `world_nullifier_hash` column. Only a
 * hash of the nullifier is stored.
 */

export const idkitEnabled = () => !!(idkitConfig.appId && idkitConfig.rpId && idkitConfig.signingKey);

/** The signal every proof must be bound to: the lowercase byline address. */
export const signalFor = (wallet: string) => getAddress(wallet).toLowerCase();

// Nonces are durable and one-use. The proof callback may hit a different
// serverless instance than the RP-signature request.
export async function issueRpSignature() {
  const { sig, nonce, createdAt, expiresAt } = signRequest({
    signingKeyHex: idkitConfig.signingKey,
    action: idkitConfig.action,
  });
  const db = await getDb();
  await db
    .insert(schema.idkitNonces)
    .values({ nonce, createdAt, expiresAt })
    .onConflictDoNothing()
    .run();
  return { sig, nonce, created_at: createdAt, expires_at: expiresAt };
}

/** Test hook (same as the protocol's rememberNonceForTests). */
export async function rememberNonceForTests(nonce: string, expiresAt: number) {
  const db = await getDb();
  await db
    .insert(schema.idkitNonces)
    .values({ nonce, createdAt: Math.floor(Date.now() / 1000), expiresAt })
    .onConflictDoUpdate({
      target: schema.idkitNonces.nonce,
      set: { expiresAt, consumedAt: null },
    })
    .run();
}

export class ProofRejected extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 = 400,
  ) {
    super(message);
  }
}

/**
 * Local checks before we spend a Portal call. The Portal proves the proof is
 * cryptographically valid; *we* must make sure it is for our action, our
 * request, an environment we serve, and this wallet.
 *
 * Environments we serve: the configured one (IDKIT_ENVIRONMENT) always; the
 * staging Simulator additionally when IDKIT_ALLOW_SIMULATOR=1. A production
 * deployment therefore never silently accepts simulator proofs.
 */
export function allowedEnvironments(): string[] {
  return idkitConfig.allowSimulator && idkitConfig.environment !== "staging"
    ? [idkitConfig.environment, "staging"]
    : [idkitConfig.environment];
}

export async function checkResult(
  result: IDKitResult,
  wallet: string,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  if (!result || !Array.isArray(result.responses) || result.responses.length === 0) {
    throw new ProofRejected("empty IDKit result");
  }
  if ("session_id" in result) throw new ProofRejected("session proofs are not accepted here");
  if (result.action !== idkitConfig.action) throw new ProofRejected("proof is for a different action");
  if (!allowedEnvironments().includes(result.environment)) {
    throw new ProofRejected(
      `proof environment is ${result.environment}, expected ${allowedEnvironments().join(" or ")}`,
    );
  }

  const db = await getDb();
  const nonce = await db
    .select()
    .from(schema.idkitNonces)
    .where(eq(schema.idkitNonces.nonce, result.nonce))
    .get();
  if (!nonce || nonce.consumedAt) throw new ProofRejected("unknown or already-used request nonce");
  if (now > nonce.expiresAt) throw new ProofRejected("request expired — start again");

  const expected = hashSignal(signalFor(wallet)).toLowerCase();
  for (const r of result.responses) {
    if (r.signal_hash?.toLowerCase() !== expected) throw new ProofRejected("proof is not bound to this wallet");
  }
}

interface PortalVerifyResponse {
  success?: boolean;
  nullifier?: string;
  environment?: string;
  action?: string;
  detail?: string;
  code?: string;
}

/** Forwards the IDKit result as-is to the Developer Portal. Returns the verified nullifier. */
export async function verifyWithPortal(result: IDKitResult): Promise<string> {
  const res = await fetch(`${idkitConfig.verifyBaseUrl}/${idkitConfig.rpId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Simulator staging proofs need the portal's staging token; phone proofs don't.
      ...(result.environment === "staging" && idkitConfig.stagingToken
        ? { "x-staging-verification-token": idkitConfig.stagingToken }
        : {}),
    },
    body: JSON.stringify(result),
  });
  const body = (await res.json().catch(() => ({}))) as PortalVerifyResponse;
  if (!res.ok || body.success !== true) {
    throw new ProofRejected(`World ID verification failed: ${body.detail ?? body.code ?? `HTTP ${res.status}`}`);
  }
  if (body.environment && body.environment !== result.environment) {
    throw new ProofRejected(`verified in ${body.environment}, expected ${result.environment}`);
  }
  const first = result.responses[0];
  const nullifier = body.nullifier ?? (first && "nullifier" in first ? first.nullifier : undefined);
  if (!nullifier) throw new ProofRejected("no nullifier in verification result");
  return nullifier as string;
}

export async function humanStatus(wallet: string) {
  const bound = await principalForAgentWallet(wallet);
  if (bound) return { verified: true, principalId: bound.principal.id };
  const db = await getDb();
  const agent = await db
    .select({ worldNullifierHash: schema.agents.worldNullifierHash })
    .from(schema.agents)
    .where(sql`lower(${schema.agents.address}) = ${getAddress(wallet).toLowerCase()}`)
    .get();
  return { verified: !!agent?.worldNullifierHash, principalId: null };
}

/**
 * Records the verified nullifier against the wallet — the uniqueness store
 * (the protocol's contract; ours the DB). Idempotent for the same wallet + human.
 * One human, one root principal; additional wallets require an audited mandate.
 */
export async function registerHuman(
  wallet: string,
  nullifier: string,
): Promise<{ already: boolean; principalId: string }> {
  try {
    const result = await registerPrincipal(wallet, nullifier);
    return { already: result.already, principalId: result.principalId };
  } catch (error) {
    const message = error instanceof Error ? error.message : "principal registration failed";
    const status =
      error && typeof error === "object" && "status" in error && error.status === 409
        ? 409
        : 400;
    throw new ProofRejected(message, status);
  }
}

/** Consumes the nonce once the proof is accepted, so the same proof can't be replayed. */
export async function consumeNonce(nonce: string) {
  const db = await getDb();
  const consumedAt = new Date().toISOString();
  const rows = await db
    .update(schema.idkitNonces)
    .set({ consumedAt })
    .where(
      and(
        eq(schema.idkitNonces.nonce, nonce),
        isNull(schema.idkitNonces.consumedAt),
        gt(schema.idkitNonces.expiresAt, Math.floor(Date.now() / 1000)),
      ),
    )
    .returning({ nonce: schema.idkitNonces.nonce });
  if (rows.length !== 1) throw new ProofRejected("unknown, expired, or already-used request nonce");
}
