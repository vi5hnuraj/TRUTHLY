import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import { withSecurityWriteLock } from "./db/write-lock";
import { hashSub, isFreshForAttempt } from "./world/freshness";
import { principalForSignal } from "./world/principals";

type Db = Awaited<ReturnType<typeof getDb>>;

export type AppealInput = {
  signalId: string;
  /** World `sub` — in the trial it arrives in the request body; from Nov 6 it is
   *  extracted from a server-validated Agent Pass id_token instead. The rules below
   *  never change. */
  sub: string;
  /** World `auth_time` — when the human actually authenticated. */
  authTime: number;
  /** When this appeal attempt began (server clock). */
  startedAt: number;
};

export type AppealOutcome = {
  status: "approved" | "denied";
  reason: string;
};

/**
 * The appeal gate: a slashed stake comes back ONLY for a fresh, matching human.
 * Rules adapted from the protocol's verifyFreshCheck (MIT) — deny-by-default, every
 * attempt recorded. The denied path is not an error case — it is the demo.
 */
export async function requestAppeal(db: Db, input: AppealInput): Promise<AppealOutcome> {
  return withSecurityWriteLock(() => db.transaction(async (tx) => {
    const nowIso = new Date().toISOString();
    let outcome: AppealOutcome;

    const signal = await tx
      .select({
        id: schema.signals.id,
        agentId: schema.signals.agentId,
        stakeStatus: schema.signals.stakeStatus,
      })
      .from(schema.signals)
      .where(eq(schema.signals.id, input.signalId))
      .get();
    const ownership = signal ? await principalForSignal(input.signalId, tx) : undefined;

    if (!signal) {
      outcome = { status: "denied", reason: "signal_not_found" };
    } else if (ownership?.principal.pausedAt) {
      // Appeal restores a story and stake, so unlike revocation it is not a
      // safe-direction exception to the principal-wide emergency stop.
      outcome = { status: "denied", reason: "principal_paused" };
    } else if (signal.stakeStatus !== "slashed") {
      // Nothing at stake -> nothing to appeal.
      outcome = { status: "denied", reason: "not_slashed" };
    } else {
      const agent = await tx
        .select({
          worldSubHash: schema.agents.worldSubHash,
        })
        .from(schema.agents)
        .where(eq(schema.agents.id, signal.agentId))
        .get();

      if (!agent?.worldSubHash) {
        // The byline was never born from a human check -> no appeal rights.
        outcome = { status: "denied", reason: "no_human_bound" };
      } else if (hashSub(input.sub) !== agent.worldSubHash) {
        // Same rule as the protocol: the face must belong to this byline's human.
        outcome = { status: "denied", reason: "mismatch" };
      } else if (!isFreshForAttempt(input.authTime, input.startedAt)) {
        // The check must belong to THIS attempt — an old login is worthless.
        outcome = { status: "denied", reason: "expired" };
      } else {
        outcome = { status: "approved", reason: "fresh_human_verified" };
      }
    }

    // Approved -> the stake re-locks and the story returns to Herald's queue for re-review.
    if (outcome.status === "approved") {
      await tx
        .update(schema.signals)
        .set({ stakeStatus: "locked", status: "submitted", updatedAt: nowIso })
        .where(eq(schema.signals.id, input.signalId))
        .run();
    }

    // Every attempt is recorded — denied rows are what the demo shows.
    await tx
      .insert(schema.appeals)
      .values({
        id: randomUUID(),
        signalId: input.signalId,
        agentId: signal?.agentId ?? "unknown",
        status: outcome.status,
        reason: outcome.reason,
        subHash: hashSub(input.sub),
        authTime: input.authTime,
        createdAt: nowIso,
        decidedAt: nowIso,
      })
      .run();

    return outcome;
  }));
}
