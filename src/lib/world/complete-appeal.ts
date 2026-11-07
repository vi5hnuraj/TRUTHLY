import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb, schema } from "@/lib/db";
import { requestAppeal, type AppealOutcome } from "../appeal";
import { hashSub, isFreshForAttempt } from "./freshness";
import type { WorldIdClaims } from "./oidc";
import type { WorldSession } from "./sessions";
import { saveSession } from "./sessions";
import { failWorldAuthorization } from "./authorizations";

/**
 * Appeal step-up — ported from the protocol (MIT), `backend/src/worldid/verifyFreshCheck.ts`
 * (`completeClaimCheck` + `fail`). The id_token has already been fully validated
 * (issuer, RS256 via JWKS, audience, expiry, nonce) by the caller. Here we enforce
 * what makes it a *fresh check by the same human*:
 *   - the authentication belongs to THIS attempt (prompt=login / max_age=0 semantics)
 *   - hash(sub) equals the subHash bound to the byline at birth
 * the protocol holds a dishonest claim on-chain; we have no contracts, so every failure
 * is recorded as an audit row in the `appeals` table — the denied path is the demo.
 */

export async function completeAppealCheck(
  session: WorldSession,
  claims: WorldIdClaims,
): Promise<AppealOutcome> {
  const database = await getDb();
  const signalId = session.signalId!;

  const outcome = await requestAppeal(database, {
    signalId,
    sub: claims.sub,
    authTime: claims.auth_time,
    startedAt: session.startedAt,
  });

  session.status = outcome.status === "approved" ? "approved" : mapReason(outcome.reason);
  session.result = { reason: outcome.reason };
  return outcome;
}

type FailStatus = "denied" | "expired" | "mismatch";

function mapReason(reason: string): FailStatus {
  switch (reason) {
    case "expired":
      return "expired";
    case "mismatch":
      return "mismatch";
    default:
      return "denied";
  }
}

/**
 * Marks a session failed and records it. Used for callback errors
 * (cancelled/denied) as well as validation failures — the protocol holds the claim
 * on-chain here; our audit row in `appeals` is the equivalent.
 */
export async function fail(
  session: WorldSession,
  status: "denied" | "expired" | "cancelled" | "mismatch",
  reason: string,
): Promise<void> {
  session.status = status;
  session.result = { reason };
  if (session.authorizationId) {
    await failWorldAuthorization(session.authorizationId, status, reason);
  }
  await saveSession(session);
  if (!session.signalId) return;

  const db = await getDb();
  const nowIso = new Date().toISOString();

  // Attribute the attempt to the filing byline when the story still exists —
  // an "unknown" row in the public ledger would hide who was denied.
  const signal = await db
    .select({ agentId: schema.signals.agentId })
    .from(schema.signals)
    .where(eq(schema.signals.id, session.signalId))
    .get();

  await db
    .insert(schema.appeals)
    .values({
      id: randomUUID(),
      signalId: session.signalId,
      agentId: signal?.agentId ?? "unknown",
      status: "denied",
      reason: `${status}: ${reason}`,
      subHash: null,
      authTime: null,
      createdAt: nowIso,
      decidedAt: nowIso,
    })
    .run();
}

/** Re-exported so the callback route imports one module — parity with the protocol's server.ts. */
export { hashSub, isFreshForAttempt };
