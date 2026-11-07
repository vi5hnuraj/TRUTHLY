import { sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { hashSub, isFreshForAttempt } from "./freshness";
import { bindPrincipalSubject, principalByOwnerWallet } from "./principals";
import type { WorldIdClaims } from "./oidc";
import type { WorldSession } from "./sessions";

/**
 * Enrollment at byline birth — ported from the protocol (MIT),
 * `backend/src/worldid/verifyProofOfHuman.ts` (`completeEnrollment`).
 * The id_token has already been fully validated by the caller. We enforce what
 * the protocol enforces: this proof was made during THIS attempt, not a reused session.
 *
 * Adaptation: the protocol signs an EIP-712 Enrollment attestation for its contract.
 * We have no contracts — the binding is the `world_sub_hash` column on the
 * agent row (only the hash is ever stored, never the raw World sub).
 */
export async function completeEnrollment(
  session: WorldSession,
  claims: WorldIdClaims,
): Promise<void> {
  // the protocol: "if (!session.address) throw …" — the wallet must exist before binding.
  if (!session.address) {
    session.status = "denied";
    session.result = { reason: "enroll session has no byline address" };
    return;
  }
  // Enforce what we asked World for: a fresh proof for this attempt.
  if (!isFreshForAttempt(claims.auth_time, session.startedAt)) {
    session.status = "expired";
    session.result = { reason: "World ID authentication was not fresh for this enrollment" };
    return;
  }

  const db = await getDb();
  const subHash = hashSub(claims.sub);
  const nowIso = new Date().toISOString();
  const principal = await principalByOwnerWallet(session.address);

  if (!principal) {
    session.status = "denied";
    session.result = { reason: "IDKit must create a unique human principal before Agent Pass enrollment" };
    return;
  }

  const agent = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(sql`lower(${schema.agents.address}) = ${session.address.toLowerCase()}`)
    .get();

  if (!agent) {
    // No byline registered at this wallet yet — deny rather than bind a ghost.
    session.status = "denied";
    session.result = { reason: "no byline registered at this address" };
    return;
  }

  try {
    await bindPrincipalSubject(principal.id, subHash);
    await db
      .update(schema.agents)
      .set({ worldSubHash: subHash, worldVerifiedAt: nowIso })
      .where(sql`lower(${schema.agents.address}) = ${session.address.toLowerCase()}`)
      .run();
  } catch (error) {
    session.status = "mismatch";
    session.result = {
      reason: error instanceof Error ? error.message : "World subject binding failed",
    };
    return;
  }

  session.status = "approved";
  session.result = {};
}

/** Read helper: how the frontend learns whether a wallet's byline is World-bound. */
export async function enrollmentStatus(address: string) {
  const db = await getDb();
  const agent = await db
    .select({
      id: schema.agents.id,
      worldSubHash: schema.agents.worldSubHash,
      worldVerifiedAt: schema.agents.worldVerifiedAt,
    })
    .from(schema.agents)
    .where(sql`lower(${schema.agents.address}) = ${address.toLowerCase()}`)
    .get();
  return {
    bound: !!agent?.worldSubHash,
    verifiedAt: agent?.worldVerifiedAt ?? null,
  };
}
