import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb, schema, type DatabaseExecutor } from "@/lib/db";
import { withSecurityWriteLock } from "@/lib/db/write-lock";
import {
  canonicalJson,
  hashAuthorizationPayload,
  isWorldAction,
  pauseAllows,
  type JsonValue,
  type WorldAction,
} from "./actions";
import { hashSub, isFreshForAttempt } from "./freshness";
import { principalById } from "./principals";
import type { WorldSession } from "./sessions";

export class AuthorizationDenied extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

export type AuthorizationPayload = Record<string, JsonValue>;

export function authorizationUrl(id: string, returnTo = "/"): string {
  const base = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
  const query = new URLSearchParams({ returnTo: returnTo.startsWith("/") ? returnTo : "/" });
  return `${base}/authorizations/${encodeURIComponent(id)}?${query.toString()}`;
}

export async function createWorldAuthorization(input: {
  principalId: string;
  action: WorldAction;
  payload: AuthorizationPayload;
  returnTo?: string;
  ttlSeconds?: number;
}) {
  if ("expires_at" in input.payload || "nonce" in input.payload) {
    throw new AuthorizationDenied(
      "reserved_payload_field",
      "Authorization payloads may not supply the reserved expires_at or nonce fields.",
      400,
    );
  }
  const db = await getDb();
  // A write transaction serializes this check+insert with pausePrincipal. An
  // authorization therefore linearizes wholly before the pause or is refused;
  // it cannot be minted from a stale pre-pause read.
  return withSecurityWriteLock(() => db.transaction(async (tx) => {
    const principal = await assertWorldActionAllowed(input.principalId, input.action, tx);
    if (!principal.worldSubHash) {
      throw new AuthorizationDenied(
        "agent_pass_not_bound",
        "This principal must first bind World Agent Pass at /bind.",
        428,
      );
    }

    const id = randomUUID();
    const nonce = randomBytes(24).toString("base64url");
    const createdAt = new Date().toISOString();
    const expiresAt = nowSeconds() + Math.min(Math.max(input.ttlSeconds ?? 600, 60), 900);
    const payload: AuthorizationPayload = {
      ...input.payload,
      expires_at: expiresAt,
      nonce,
    };
    const payloadHash = hashAuthorizationPayload(input.action, payload);
    await tx
      .insert(schema.worldAuthorizations)
      .values({
        id,
        principalId: input.principalId,
        action: input.action,
        payloadHash,
        payloadJson: canonicalJson(payload),
        nonce,
        status: "pending",
        createdAt,
        expiresAt,
      })
      .run();
    return {
      id,
      action: input.action,
      payloadHash,
      payload,
      expiresAt,
      authorizationUrl: authorizationUrl(id, input.returnTo),
    };
  }));
}

export async function getWorldAuthorization(id: string, database?: DatabaseExecutor) {
  const db = database ?? (await getDb());
  const authorization = await db
    .select()
    .from(schema.worldAuthorizations)
    .where(eq(schema.worldAuthorizations.id, id))
    .get();
  if (
    authorization &&
    ["pending", "approved"].includes(authorization.status) &&
    authorization.expiresAt <= nowSeconds()
  ) {
    await db
      .update(schema.worldAuthorizations)
      .set({ status: "expired", reason: "authorization expired" })
      .where(
        and(
          eq(schema.worldAuthorizations.id, id),
          eq(schema.worldAuthorizations.status, authorization.status),
        ),
      )
      .run();
    return { ...authorization, status: "expired", reason: "authorization expired" };
  }
  return authorization;
}

export async function assertWorldActionAllowed(
  principalId: string,
  action: WorldAction,
  database?: DatabaseExecutor,
) {
  const principal = await principalById(principalId, database);
  if (!principal || principal.status !== "active") {
    throw new AuthorizationDenied(
      "principal_inactive",
      "The controlling human principal is not active.",
      403,
    );
  }
  if (principal.pausedAt && !pauseAllows(action)) {
    throw new AuthorizationDenied(
      "principal_paused",
      "This human principal is paused. Resume before authorizing anything else.",
      423,
    );
  }
  return principal;
}

/** Verify that the bytes shown to the human are the bytes committed by the digest. */
export function authorizationPayloadIntegrity(authorization: {
  action: string;
  payloadJson: string;
  payloadHash: string;
}): {
  valid: boolean;
  payload: AuthorizationPayload | null;
  actualHash: string | null;
} {
  if (!isWorldAction(authorization.action)) {
    return { valid: false, payload: null, actualHash: null };
  }
  try {
    const parsed: unknown = JSON.parse(authorization.payloadJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { valid: false, payload: null, actualHash: null };
    }
    const payload = parsed as AuthorizationPayload;
    const actualHash = hashAuthorizationPayload(authorization.action, payload);
    return {
      valid: actualHash === authorization.payloadHash,
      payload,
      actualHash,
    };
  } catch {
    return { valid: false, payload: null, actualHash: null };
  }
}

export function publicAuthorizationView(
  authorization: NonNullable<Awaited<ReturnType<typeof getWorldAuthorization>>>,
) {
  return {
    authorization_id: authorization.id,
    action: authorization.action,
    payload_hash: authorization.payloadHash,
    payload: JSON.parse(authorization.payloadJson) as JsonValue,
    status: authorization.status,
    reason: authorization.reason,
    expires_at: new Date(authorization.expiresAt * 1000).toISOString(),
    approved_at: authorization.approvedAt,
    consumed_at: authorization.consumedAt,
  };
}

export function recomputeAuthorizationHash(
  action: WorldAction,
  corePayload: AuthorizationPayload,
  authorization: { nonce: string; expiresAt: number },
): string {
  return hashAuthorizationPayload(action, {
    ...corePayload,
    expires_at: authorization.expiresAt,
    nonce: authorization.nonce,
  });
}

async function recordAttempt(input: {
  authorizationId: string;
  status: string;
  reason?: string;
  subHash?: string | null;
  authTime?: number | null;
}, database?: DatabaseExecutor) {
  const db = database ?? (await getDb());
  await db
    .insert(schema.authorizationAttempts)
    .values({
      id: randomUUID(),
      authorizationId: input.authorizationId,
      status: input.status,
      reason: input.reason ?? null,
      subHash: input.subHash ?? null,
      authTime: input.authTime ?? null,
      createdAt: new Date().toISOString(),
    })
    .run();
}

/** Fresh same-human Agent Pass result -> one approved exact authorization. */
export async function completeWorldAuthorization(
  session: WorldSession,
  claims: { sub: string; auth_time: number },
): Promise<void> {
  if (!session.authorizationId || !session.principalId || !session.action || !session.payloadHash) {
    session.status = "denied";
    session.result = { reason: "authorization session is incomplete" };
    return;
  }
  const db = await getDb();
  const outcome = await withSecurityWriteLock(() => db.transaction(async (tx) => {
    const authorization = await getWorldAuthorization(session.authorizationId!, tx);
    const principal = await principalById(session.principalId!, tx);
    const subHash = hashSub(claims.sub);
    let status: "approved" | "denied" | "expired" | "mismatch" = "denied";
    let reason: string | undefined;

    if (!authorization || authorization.principalId !== session.principalId) {
      reason = "authorization does not belong to this principal";
    } else if (
      authorization.action !== session.action ||
      authorization.payloadHash !== session.payloadHash
    ) {
      reason = "authorization session payload binding changed";
    } else if (!authorizationPayloadIntegrity(authorization).valid) {
      reason = "stored authorization payload failed its canonical hash check";
    } else if (authorization.status === "expired" || authorization.expiresAt <= nowSeconds()) {
      status = "expired";
      reason = "authorization expired";
    } else if (authorization.status !== "pending") {
      reason = `authorization is ${authorization.status}`;
    } else if (!isFreshForAttempt(claims.auth_time, session.startedAt)) {
      status = "expired";
      reason = "World authentication was not fresh for this attempt";
    } else if (
      !isWorldAction(session.action) ||
      (principal?.pausedAt && !pauseAllows(session.action))
    ) {
      status = "denied";
      reason = "The principal was paused while this approval was pending.";
    } else if (
      principal?.status !== "active" ||
      !principal.worldSubHash ||
      principal.worldSubHash !== subHash
    ) {
      status = "mismatch";
      reason = "A different human authenticated. Only the controlling principal may approve.";
    } else {
      status = "approved";
    }

    const now = new Date().toISOString();
    if (authorization) {
      const updated = await tx
        .update(schema.worldAuthorizations)
        .set({
          status,
          approvedAt: status === "approved" ? now : null,
          reason: reason ?? null,
        })
        .where(
          and(
            eq(schema.worldAuthorizations.id, authorization.id),
            eq(schema.worldAuthorizations.status, "pending"),
          ),
        )
        .returning({ id: schema.worldAuthorizations.id });
      if (updated.length === 0 && status === "approved") {
        status = "denied";
        reason = "authorization was already decided";
      }
      await recordAttempt(
        {
          authorizationId: authorization.id,
          status,
          reason,
          subHash,
          authTime: claims.auth_time,
        },
        tx,
      );
    }
    return { status, reason };
  }));
  session.status = outcome.status;
  session.result = { reason: outcome.reason };
}

export async function failWorldAuthorization(
  authorizationId: string,
  status: "denied" | "expired" | "cancelled" | "mismatch",
  reason: string,
) {
  const db = await getDb();
  await withSecurityWriteLock(() => db.transaction(async (tx) => {
    await tx
      .update(schema.worldAuthorizations)
      .set({ status, reason })
      .where(
        and(
          eq(schema.worldAuthorizations.id, authorizationId),
          eq(schema.worldAuthorizations.status, "pending"),
        ),
      )
      .run();
    await recordAttempt({ authorizationId, status, reason }, tx);
  }));
}

/**
 * Re-check the exact payload immediately before side effects, then atomically
 * consume the grant. Consumption happens first: an upstream failure can be
 * retried by creating a new approval, never by replaying the old one.
 */
export async function consumeWorldAuthorization(input: {
  authorizationId: string;
  principalId: string;
  action: WorldAction;
  payload: AuthorizationPayload;
}) {
  const db = await getDb();
  // Consumption, expiry, replay and pause are decided under one write
  // transaction. A pause cannot land between a stale principal read and the
  // approved -> consumed transition.
  const decision = await withSecurityWriteLock(() => db.transaction(async (tx) => {
    const authorization = await getWorldAuthorization(input.authorizationId, tx);
    if (!authorization) {
      return {
        ok: false as const,
        error: new AuthorizationDenied("authorization_not_found", "Authorization not found.", 404),
      };
    }
    if (authorization.principalId !== input.principalId || authorization.action !== input.action) {
      await recordAttempt(
        {
          authorizationId: authorization.id,
          status: "denied",
          reason: "authorization principal or action mismatch",
        },
        tx,
      );
      return {
        ok: false as const,
        error: new AuthorizationDenied(
          "authorization_scope_mismatch",
          "Authorization belongs to another action or principal.",
          403,
        ),
      };
    }
    const actualHash = recomputeAuthorizationHash(input.action, input.payload, authorization);
    if (actualHash !== authorization.payloadHash) {
      await recordAttempt(
        {
          authorizationId: authorization.id,
          status: "denied",
          reason: "modified_payload",
        },
        tx,
      );
      return {
        ok: false as const,
        error: new AuthorizationDenied(
          "modified_payload",
          "The action differs from what the human approved. Start a new Agent Pass request.",
          409,
        ),
      };
    }
    if (authorization.status === "consumed" || authorization.consumedAt) {
      await recordAttempt(
        {
          authorizationId: authorization.id,
          status: "denied",
          reason: "replay",
        },
        tx,
      );
      return {
        ok: false as const,
        error: new AuthorizationDenied(
          "authorization_replayed",
          "This one-use authorization was already consumed.",
          409,
        ),
      };
    }
    if (authorization.status !== "approved") {
      return {
        ok: false as const,
        error: new AuthorizationDenied(
          `authorization_${authorization.status}`,
          `Authorization is ${authorization.status}, not approved.`,
          409,
        ),
      };
    }

    try {
      await assertWorldActionAllowed(input.principalId, input.action, tx);
    } catch (error) {
      if (!(error instanceof AuthorizationDenied)) throw error;
      await recordAttempt(
        {
          authorizationId: authorization.id,
          status: "denied",
          reason: error.code,
        },
        tx,
      );
      return { ok: false as const, error };
    }

    const consumedAt = new Date().toISOString();
    const consumed = await tx
      .update(schema.worldAuthorizations)
      .set({ status: "consumed", consumedAt })
      .where(
        and(
          eq(schema.worldAuthorizations.id, authorization.id),
          eq(schema.worldAuthorizations.status, "approved"),
          isNull(schema.worldAuthorizations.consumedAt),
          gt(schema.worldAuthorizations.expiresAt, nowSeconds()),
        ),
      )
      .returning({ id: schema.worldAuthorizations.id });
    if (consumed.length !== 1) {
      await recordAttempt(
        {
          authorizationId: authorization.id,
          status: "denied",
          reason: "replay_or_expired",
        },
        tx,
      );
      return {
        ok: false as const,
        error: new AuthorizationDenied(
          "authorization_replayed",
          "Authorization was already used or expired.",
          409,
        ),
      };
    }
    await recordAttempt({ authorizationId: authorization.id, status: "consumed" }, tx);
    return {
      ok: true as const,
      value: { ...authorization, status: "consumed", consumedAt },
    };
  }));
  if (!decision.ok) throw decision.error;
  return decision.value;
}

export function agentPassRequiredResponse(
  authorization: Awaited<ReturnType<typeof createWorldAuthorization>>,
  message: string,
) {
  return {
    action_required: "world_agent_pass",
    authorization_id: authorization.id,
    authorization_url: authorization.authorizationUrl,
    action: authorization.action,
    payload_hash: authorization.payloadHash,
    expires_at: new Date(authorization.expiresAt * 1000).toISOString(),
    message,
  };
}
