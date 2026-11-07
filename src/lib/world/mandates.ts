import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema, type DatabaseExecutor } from "@/lib/db";
import { withSecurityWriteLock } from "@/lib/db/write-lock";
import { formatUsdcAtomic } from "@/lib/usdc";
import { normalizeWallet, principalById, principalByOwnerWallet } from "./principals";

export const MANDATE_ROLES = [
  "scout",
  "file",
  "trade_preview",
  "trade_execute",
] as const;

export type MandateRole = (typeof MANDATE_ROLES)[number];

export interface MandateInput {
  agentWallet: string;
  label: string;
  roles: MandateRole[];
  allowedBeats: string[];
  dailyFilings: number;
  dailyStakeAtomic: string;
  maxTradeAtomic: string;
  freshPassAboveAtomic: string;
  expiresAt?: string | null;
}

export interface MandateStateExpectation {
  agentStatus: string | null;
  mandateId: string | null;
  mandateVersion: number | null;
}

export class MandateDenied extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 403,
  ) {
    super(message);
  }
}

const tokenHash = (token: string) =>
  createHash("sha256").update(`truthly/mandate-token/v1|${token}`).digest("hex");

const list = (raw: string): string[] => {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
};

const today = () => new Date().toISOString().slice(0, 10);

function isExpired(expiresAt: string | null): boolean {
  return !!expiresAt && Date.parse(expiresAt) <= Date.now();
}

export async function mandateForAgentWallet(wallet: string, database?: DatabaseExecutor) {
  const db = database ?? (await getDb());
  const normalized = normalizeWallet(wallet);
  return db
    .select({
      principal: schema.humanPrincipals,
      delegatedAgent: schema.delegatedAgents,
      mandate: schema.newsroomMandates,
    })
    .from(schema.delegatedAgents)
    .innerJoin(
      schema.humanPrincipals,
      eq(schema.humanPrincipals.id, schema.delegatedAgents.principalId),
    )
    .innerJoin(
      schema.newsroomMandates,
      and(
        eq(schema.newsroomMandates.delegatedAgentId, schema.delegatedAgents.id),
        eq(schema.newsroomMandates.status, "active"),
      ),
    )
    .where(sql`lower(${schema.delegatedAgents.agentWallet}) = ${normalized}`)
    .get();
}

export async function mandateFromToken(
  token: string | null | undefined,
  database?: DatabaseExecutor,
) {
  if (!token || !token.startsWith("apm_")) return null;
  const db = database ?? (await getDb());
  const row = await db
    .select({
      principal: schema.humanPrincipals,
      delegatedAgent: schema.delegatedAgents,
      mandate: schema.newsroomMandates,
    })
    .from(schema.delegatedAgents)
    .innerJoin(
      schema.humanPrincipals,
      eq(schema.humanPrincipals.id, schema.delegatedAgents.principalId),
    )
    .innerJoin(
      schema.newsroomMandates,
      and(
        eq(schema.newsroomMandates.delegatedAgentId, schema.delegatedAgents.id),
        eq(schema.newsroomMandates.status, "active"),
      ),
    )
    .where(eq(schema.delegatedAgents.credentialHash, tokenHash(token)))
    .get();
  if (
    !row ||
    row.principal.status !== "active" ||
    row.delegatedAgent.status !== "active" ||
    isExpired(row.mandate.expiresAt)
  ) {
    return null;
  }
  assertPrincipalNotPaused(row.principal);
  return row;
}

/**
 * The emergency stop is checked server-side on every authority-bearing call,
 * so no existing mandate, token or autonomous threshold can route around it.
 */
export function assertPrincipalNotPaused(principal: { pausedAt?: string | null }) {
  if (principal.pausedAt) {
    throw new MandateDenied(
      "principal_paused",
      "The controlling human paused all agents. Nothing executes until the principal resumes.",
      423,
    );
  }
}

async function issueCredentialWithDb(
  db: DatabaseExecutor,
  delegatedAgentId: string,
): Promise<string> {
  const authority = await db
    .select({
      agentStatus: schema.delegatedAgents.status,
      principal: schema.humanPrincipals,
    })
    .from(schema.delegatedAgents)
    .innerJoin(
      schema.humanPrincipals,
      eq(schema.humanPrincipals.id, schema.delegatedAgents.principalId),
    )
    .where(eq(schema.delegatedAgents.id, delegatedAgentId))
    .get();
  if (!authority || authority.agentStatus !== "active") {
    throw new MandateDenied("agent_inactive", "The delegated agent is not active.");
  }
  assertPrincipalNotPaused(authority.principal);
  const token = `apm_${randomBytes(32).toString("base64url")}`;
  const updated = await db
    .update(schema.delegatedAgents)
    .set({ credentialHash: tokenHash(token), updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(schema.delegatedAgents.id, delegatedAgentId),
        eq(schema.delegatedAgents.status, "active"),
      ),
    )
    .returning({ id: schema.delegatedAgents.id });
  if (updated.length !== 1) throw new MandateDenied("agent_inactive", "The delegated agent is not active.");
  return token;
}

export async function issueCredential(delegatedAgentId: string): Promise<string> {
  const db = await getDb();
  return withSecurityWriteLock(() =>
    db.transaction((tx) => issueCredentialWithDb(tx, delegatedAgentId)),
  );
}

export async function upsertMandate(
  principalId: string,
  input: MandateInput,
  expected?: MandateStateExpectation,
): Promise<{ delegatedAgentId: string; mandateId: string; credential: string }> {
  const db = await getDb();
  return withSecurityWriteLock(() =>
    db.transaction(async (tx) => {
      // The write transaction serializes the pause check with every mandate and
      // credential write. A pause cannot land halfway through this multi-row
      // update, and a request based on an older mandate version is rejected.
      const principal = await principalById(principalId, tx);
      if (!principal) {
        throw new MandateDenied("principal_not_found", "Human principal not found.", 404);
      }
      assertPrincipalNotPaused(principal);
      const agentWallet = normalizeWallet(input.agentWallet);
      const now = new Date().toISOString();
      let delegated = await tx
        .select()
        .from(schema.delegatedAgents)
        .where(sql`lower(${schema.delegatedAgents.agentWallet}) = ${agentWallet}`)
        .get();

      if (delegated && delegated.principalId !== principalId) {
        throw new MandateDenied(
          "wallet_already_delegated",
          "That wallet is controlled by a different human principal.",
          409,
        );
      }

      const activeMandate = delegated
        ? await tx
            .select()
            .from(schema.newsroomMandates)
            .where(
              and(
                eq(schema.newsroomMandates.delegatedAgentId, delegated.id),
                eq(schema.newsroomMandates.status, "active"),
              ),
            )
            .get()
        : undefined;
      if (
        expected &&
        (expected.agentStatus !== (delegated?.status ?? null) ||
          expected.mandateId !== (activeMandate?.id ?? null) ||
          expected.mandateVersion !== (activeMandate?.version ?? null))
      ) {
        throw new MandateDenied(
          "stale_mandate_state",
          "The delegated agent or mandate changed after approval. Start a new Agent Pass request.",
          409,
        );
      }

      if (!delegated) {
        const delegatedAgentId = randomUUID();
        await tx
          .insert(schema.delegatedAgents)
          .values({
            id: delegatedAgentId,
            principalId,
            agentWallet,
            label: input.label,
            status: "active",
            createdAt: now,
            updatedAt: now,
          })
          .run();
        delegated = await tx
          .select()
          .from(schema.delegatedAgents)
          .where(eq(schema.delegatedAgents.id, delegatedAgentId))
          .get();
      } else {
        await tx
          .update(schema.delegatedAgents)
          .set({ label: input.label, status: "active", revokedAt: null, updatedAt: now })
          .where(eq(schema.delegatedAgents.id, delegated.id))
          .run();
      }
      if (!delegated) throw new Error("delegated agent insert failed");

      const previous = await tx
        .select({ version: schema.newsroomMandates.version })
        .from(schema.newsroomMandates)
        .where(eq(schema.newsroomMandates.delegatedAgentId, delegated.id))
        .orderBy(desc(schema.newsroomMandates.version))
        .limit(1)
        .get();

      await tx
        .update(schema.newsroomMandates)
        .set({ status: "superseded", revokedAt: now })
        .where(
          and(
            eq(schema.newsroomMandates.delegatedAgentId, delegated.id),
            eq(schema.newsroomMandates.status, "active"),
          ),
        )
        .run();

      const mandateId = randomUUID();
      await tx
        .insert(schema.newsroomMandates)
        .values({
          id: mandateId,
          principalId,
          delegatedAgentId: delegated.id,
          version: (previous?.version ?? 0) + 1,
          roles: JSON.stringify([...new Set(input.roles)]),
          allowedBeats: JSON.stringify([...new Set(input.allowedBeats)]),
          dailyFilings: input.dailyFilings,
          dailyStakeAtomic: input.dailyStakeAtomic,
          maxTradeAtomic: input.maxTradeAtomic,
          freshPassAboveAtomic: input.freshPassAboveAtomic,
          status: "active",
          createdAt: now,
          expiresAt: input.expiresAt ?? null,
        })
        .run();

      return {
        delegatedAgentId: delegated.id,
        mandateId,
        credential: await issueCredentialWithDb(tx, delegated.id),
      };
    }),
  );
}

export async function revokeDelegatedAgent(
  principalId: string,
  wallet: string,
  expected?: MandateStateExpectation,
): Promise<void> {
  const db = await getDb();
  await withSecurityWriteLock(() => db.transaction(async (tx) => {
    const normalized = normalizeWallet(wallet);
    const delegated = await tx
      .select()
      .from(schema.delegatedAgents)
      .where(sql`lower(${schema.delegatedAgents.agentWallet}) = ${normalized}`)
      .get();
    if (!delegated || delegated.principalId !== principalId) {
      throw new MandateDenied("agent_not_found", "No delegated agent belongs to this principal.", 404);
    }
    const activeMandate = await tx
      .select()
      .from(schema.newsroomMandates)
      .where(
        and(
          eq(schema.newsroomMandates.delegatedAgentId, delegated.id),
          eq(schema.newsroomMandates.status, "active"),
        ),
      )
      .get();
    if (
      expected &&
      (expected.agentStatus !== delegated.status ||
        expected.mandateId !== (activeMandate?.id ?? null) ||
        expected.mandateVersion !== (activeMandate?.version ?? null))
    ) {
      throw new MandateDenied(
        "stale_mandate_state",
        "The delegated agent or mandate changed after approval. Start a new Agent Pass request.",
        409,
      );
    }
    const now = new Date().toISOString();
    await tx
      .update(schema.delegatedAgents)
      .set({ status: "revoked", credentialHash: null, revokedAt: now, updatedAt: now })
      .where(eq(schema.delegatedAgents.id, delegated.id))
      .run();
    await tx
      .update(schema.newsroomMandates)
      .set({ status: "revoked", revokedAt: now })
      .where(
        and(
          eq(schema.newsroomMandates.delegatedAgentId, delegated.id),
          eq(schema.newsroomMandates.status, "active"),
        ),
      )
      .run();
  }));
}

async function usageForDay(
  principalId: string,
  delegatedAgentId: string,
  kind: string,
  database?: DatabaseExecutor,
) {
  const db = database ?? (await getDb());
  const rows = await db
    .select({
      delegatedAgentId: schema.newsroomUsage.delegatedAgentId,
      amountAtomic: schema.newsroomUsage.amountAtomic,
    })
    .from(schema.newsroomUsage)
    .where(
      and(
        eq(schema.newsroomUsage.principalId, principalId),
        eq(schema.newsroomUsage.day, today()),
        eq(schema.newsroomUsage.kind, kind),
      ),
    );
  let principalCount = 0;
  let agentCount = 0;
  let principalAmount = BigInt(0);
  let agentAmount = BigInt(0);
  for (const row of rows) {
    principalCount += 1;
    principalAmount += BigInt(row.amountAtomic);
    if (row.delegatedAgentId === delegatedAgentId) {
      agentCount += 1;
      agentAmount += BigInt(row.amountAtomic);
    }
  }
  return { principalCount, agentCount, principalAmount, agentAmount };
}

export async function checkFilingMandate(
  wallet: string,
  beat: string,
  stakeAtomic: bigint,
  database?: DatabaseExecutor,
): Promise<{ bound: false } | { bound: true; principalId: string; delegatedAgentId: string }> {
  const row = await mandateForAgentWallet(wallet, database);
  // The open wire still accepts unbound reporters. They receive no verified
  // independence multiplier and cannot use any protected agent authority.
  if (!row) return { bound: false };
  if (row.principal.status !== "active" || row.delegatedAgent.status !== "active") {
    throw new MandateDenied("principal_inactive", "This human principal or delegated agent is inactive.");
  }
  if (isExpired(row.mandate.expiresAt)) {
    throw new MandateDenied("mandate_expired", "This newsroom mandate has expired.");
  }
  assertPrincipalNotPaused(row.principal);
  const roles = list(row.mandate.roles);
  const beats = list(row.mandate.allowedBeats);
  if (!roles.includes("file")) throw new MandateDenied("role_denied", "This agent has no filing role.");
  if (!beats.includes(beat)) throw new MandateDenied("beat_denied", `This mandate does not cover the ${beat} beat.`);

  const usage = await usageForDay(
    row.principal.id,
    row.delegatedAgent.id,
    "filing",
    database,
  );
  if (usage.principalCount >= row.principal.dailyFilingLimit) {
    throw new MandateDenied("principal_daily_quota", "The human principal's shared daily filing quota is exhausted.");
  }
  if (usage.agentCount >= row.mandate.dailyFilings) {
    throw new MandateDenied("agent_daily_quota", "This delegated agent's daily filing quota is exhausted.");
  }
  if (usage.principalAmount + stakeAtomic > BigInt(row.principal.dailyStakeAtomic)) {
    throw new MandateDenied("principal_stake_budget", "The human principal's shared filing-stake budget is exhausted.");
  }
  if (usage.agentAmount + stakeAtomic > BigInt(row.mandate.dailyStakeAtomic)) {
    throw new MandateDenied("agent_stake_budget", "This delegated agent's filing-stake budget is exhausted.");
  }
  return { bound: true, principalId: row.principal.id, delegatedAgentId: row.delegatedAgent.id };
}

export async function recordMandateUsage(input: {
  principalId: string;
  delegatedAgentId: string;
  kind: "filing" | "trade";
  amountAtomic: bigint;
  refId?: string;
}, database?: DatabaseExecutor): Promise<void> {
  if (!database) {
    const db = await getDb();
    await withSecurityWriteLock(() =>
      db.transaction((tx) => recordMandateUsage(input, tx)),
    );
    return;
  }
  const db = database;
  const principal = await principalById(input.principalId, db);
  if (!principal) throw new MandateDenied("principal_not_found", "Human principal not found.", 404);
  assertPrincipalNotPaused(principal);
  await db
    .insert(schema.newsroomUsage)
    .values({
      id: randomUUID(),
      principalId: input.principalId,
      delegatedAgentId: input.delegatedAgentId,
      kind: input.kind,
      amountAtomic: input.amountAtomic.toString(),
      day: today(),
      refId: input.refId ?? null,
      createdAt: new Date().toISOString(),
    })
    .run();
}

export async function checkTradeMandate(
  token: string | null | undefined,
  amountAtomic: bigint,
  database?: DatabaseExecutor,
) {
  const row = await mandateFromToken(token, database);
  if (!row) throw new MandateDenied("invalid_mandate", "A live delegated-agent mandate token is required.", 401);
  const roles = list(row.mandate.roles);
  if (!roles.includes("trade_preview")) {
    throw new MandateDenied("role_denied", "This agent cannot prepare newsroom trades.");
  }
  if (amountAtomic > BigInt(row.mandate.maxTradeAtomic)) {
    throw new MandateDenied(
      "trade_cap_exceeded",
      `This order exceeds the mandate's ${formatUsdcAtomic(row.mandate.maxTradeAtomic)} USDC per-trade cap.`,
    );
  }
  const usage = await usageForDay(
    row.principal.id,
    row.delegatedAgent.id,
    "trade",
    database,
  );
  if (usage.principalAmount + amountAtomic > BigInt(row.principal.dailyTradeAtomic)) {
    throw new MandateDenied("principal_trade_budget", "The human principal's shared daily trade budget is exhausted.");
  }

  const threshold = BigInt(row.mandate.freshPassAboveAtomic);
  const autonomous = roles.includes("trade_execute") && amountAtomic <= threshold;
  return {
    ...row,
    roles,
    requiresFreshAgentPass: !autonomous,
  };
}

export async function listPrincipalMandates(ownerWallet: string) {
  const principal = await principalByOwnerWallet(ownerWallet);
  if (!principal) return null;
  const db = await getDb();
  const rows = await db
    .select({
      agent: schema.delegatedAgents,
      mandate: schema.newsroomMandates,
    })
    .from(schema.delegatedAgents)
    .leftJoin(
      schema.newsroomMandates,
      and(
        eq(schema.newsroomMandates.delegatedAgentId, schema.delegatedAgents.id),
        eq(schema.newsroomMandates.status, "active"),
      ),
    )
    .where(eq(schema.delegatedAgents.principalId, principal.id))
    .orderBy(desc(schema.delegatedAgents.createdAt));
  return {
    principal: {
      id: principal.id,
      owner_wallet: principal.ownerWallet,
      status: principal.status,
      world_bound: !!principal.worldSubHash,
      paused: !!principal.pausedAt,
      paused_at: principal.pausedAt,
      pause_reason: principal.pauseReason,
      daily_filing_limit: principal.dailyFilingLimit,
      daily_stake_usdc: formatUsdcAtomic(principal.dailyStakeAtomic),
      daily_trade_usdc: formatUsdcAtomic(principal.dailyTradeAtomic),
    },
    agents: rows.map(({ agent, mandate }) => ({
      id: agent.id,
      agent_wallet: agent.agentWallet,
      label: agent.label,
      status: agent.status,
      credential_issued: !!agent.credentialHash,
      mandate: mandate
        ? {
            id: mandate.id,
            version: mandate.version,
            roles: list(mandate.roles),
            allowed_beats: list(mandate.allowedBeats),
            daily_filings: mandate.dailyFilings,
            daily_stake_usdc: formatUsdcAtomic(mandate.dailyStakeAtomic),
            max_trade_usdc: formatUsdcAtomic(mandate.maxTradeAtomic),
            fresh_agent_pass_above_usdc: formatUsdcAtomic(mandate.freshPassAboveAtomic),
            expires_at: mandate.expiresAt,
          }
        : null,
    })),
  };
}
