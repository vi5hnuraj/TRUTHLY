import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { randomToken } from "./oidc";

/** Persistent OIDC attempt state. No process-local Map is authoritative. */
export type WorldPurpose =
  | "enroll"
  | "appeal"
  | "authorize_trade"
  | "correct_story"
  | "retract_story"
  | "change_payout"
  | "change_mandate"
  | "revoke_agent"
  | "resume_principal";

export type SessionStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "cancelled"
  | "mismatch";

export interface WorldIdClaims {
  sub: string;
  auth_time: number;
}

export interface SessionResult {
  reason?: string;
}

export interface WorldSession {
  id: string;
  purpose: WorldPurpose;
  address?: string;
  signalId?: string;
  principalId?: string;
  authorizationId?: string;
  action?: string;
  payloadHash?: string;
  returnTo: string;
  state: string;
  nonce: string;
  verifier: string;
  startedAt: number;
  expiresAt: number;
  stateConsumedAt?: string;
  status: SessionStatus;
  result: SessionResult;
}

const SESSION_TTL_SEC = 600;
const now = () => Math.floor(Date.now() / 1000);

type SessionInit = Pick<WorldSession, "purpose" | "returnTo" | "verifier"> &
  Partial<
    Pick<
      WorldSession,
      "address" | "signalId" | "principalId" | "authorizationId" | "action" | "payloadHash"
    >
  >;

function rowToSession(row: typeof schema.worldSessions.$inferSelect): WorldSession {
  return {
    id: row.id,
    purpose: row.purpose as WorldPurpose,
    address: row.address ?? undefined,
    signalId: row.signalId ?? undefined,
    principalId: row.principalId ?? undefined,
    authorizationId: row.authorizationId ?? undefined,
    action: row.action ?? undefined,
    payloadHash: row.payloadHash ?? undefined,
    returnTo: row.returnTo,
    state: row.state,
    nonce: row.nonce,
    verifier: row.verifier,
    startedAt: row.startedAt,
    expiresAt: row.expiresAt,
    stateConsumedAt: row.stateConsumedAt ?? undefined,
    status: row.status as SessionStatus,
    result: row.reason ? { reason: row.reason } : {},
  };
}

function boundNonce(init: SessionInit, salt: string): string {
  if (init.authorizationId && init.action && init.payloadHash) {
    // Airlock pattern: World's signed nonce commits to the exact operation.
    return createHash("sha256")
      .update(
        `truthly/oidc/v1|${init.authorizationId}|${init.action}|${init.payloadHash}|${salt}`,
      )
      .digest("hex");
  }
  return randomToken();
}

export async function createSession(init: SessionInit): Promise<WorldSession> {
  const db = await getDb();
  const startedAt = now();
  const state = randomToken();
  const session: WorldSession = {
    ...init,
    id: randomToken(16),
    state,
    nonce: boundNonce(init, randomToken(16)),
    startedAt,
    expiresAt: startedAt + SESSION_TTL_SEC,
    status: "pending",
    result: {},
  };
  await db
    .insert(schema.worldSessions)
    .values({
      id: session.id,
      purpose: session.purpose,
      address: session.address ?? null,
      signalId: session.signalId ?? null,
      principalId: session.principalId ?? null,
      authorizationId: session.authorizationId ?? null,
      action: session.action ?? null,
      payloadHash: session.payloadHash ?? null,
      returnTo: session.returnTo,
      state: session.state,
      nonce: session.nonce,
      verifier: session.verifier,
      startedAt: session.startedAt,
      expiresAt: session.expiresAt,
      status: session.status,
      updatedAt: new Date().toISOString(),
    })
    .run();
  return session;
}

export async function saveSession(session: WorldSession): Promise<void> {
  const db = await getDb();
  await db
    .update(schema.worldSessions)
    .set({
      status: session.status,
      reason: session.result.reason ?? null,
      stateConsumedAt: session.stateConsumedAt ?? null,
      // PKCE is needed only until token exchange. Erase it after every terminal
      // outcome so the durable audit row does not become a long-lived secret.
      verifier: session.status === "pending" ? session.verifier : "consumed",
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.worldSessions.id, session.id))
    .run();
}

export async function getSession(id: string): Promise<WorldSession | undefined> {
  const db = await getDb();
  const row = await db
    .select()
    .from(schema.worldSessions)
    .where(eq(schema.worldSessions.id, id))
    .get();
  if (!row) return undefined;
  const session = rowToSession(row);
  if (session.status === "pending" && now() >= session.expiresAt) {
    session.status = "expired";
    session.result = { reason: "login attempt expired" };
    await saveSession(session);
  }
  return session;
}

/** Atomic single-use state redemption works across concurrent serverless instances. */
export async function takeSessionByState(state: string): Promise<WorldSession | undefined> {
  const db = await getDb();
  const consumedAt = new Date().toISOString();
  const rows = await db
    .update(schema.worldSessions)
    .set({ stateConsumedAt: consumedAt, updatedAt: consumedAt })
    .where(
      and(
        eq(schema.worldSessions.state, state),
        isNull(schema.worldSessions.stateConsumedAt),
      ),
    )
    .returning();
  const row = rows[0];
  if (!row) return undefined;
  const session = rowToSession(row);
  session.stateConsumedAt = consumedAt;
  if (session.status === "pending" && now() >= session.expiresAt) {
    session.status = "expired";
    session.result = { reason: "login attempt expired" };
    await saveSession(session);
  }
  return session;
}

export async function expireSessionForTests(id: string) {
  const db = await getDb();
  await db
    .update(schema.worldSessions)
    .set({ expiresAt: now() - 1, updatedAt: new Date().toISOString() })
    .where(eq(schema.worldSessions.id, id))
    .run();
  return getSession(id);
}

export function publicView(session: WorldSession) {
  return {
    id: session.id,
    purpose: session.purpose,
    address: session.address,
    signalId: session.signalId,
    authorizationId: session.authorizationId,
    action: session.action,
    payloadHash: session.payloadHash,
    returnTo: session.returnTo,
    status: session.status,
    expiresAt: new Date(session.expiresAt * 1000).toISOString(),
    ...session.result,
  };
}
