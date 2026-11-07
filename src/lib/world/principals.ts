import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { getAddress } from "viem";
import { getDb, schema, type DatabaseExecutor } from "@/lib/db";
import { withSecurityWriteLock } from "@/lib/db/write-lock";

const ALL_BEATS = [
  "bitcoin",
  "defi",
  "agentic-payments",
  "infrastructure",
  "regulation",
  "market-signals",
] as const;

export class PrincipalConflict extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 409,
  ) {
    super(message);
  }
}

export const normalizeWallet = (wallet: string) => getAddress(wallet).toLowerCase();

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function principalIdForNullifierHash(nullifierHash: string): string {
  return `principal_${digest(`truthly/principal/v1|${nullifierHash}`)}`;
}

/**
 * IDKit's verified nullifier is reduced immediately to two domain-separated
 * hashes. The raw World identifier is never persisted or returned.
 */
export async function registerPrincipal(
  wallet: string,
  rawNullifier: string,
): Promise<{ principalId: string; already: boolean }> {
  const db = await getDb();
  const ownerWallet = normalizeWallet(wallet);
  // Keep the pre-principal deployment's sha256(nullifier) representation so an
  // already verified human upgrades in place rather than appearing different.
  const nullifierHash = digest(rawNullifier);

  const [byHuman, byWallet] = await Promise.all([
    db
      .select()
      .from(schema.humanPrincipals)
      .where(eq(schema.humanPrincipals.nullifierHash, nullifierHash))
      .get(),
    db
      .select()
      .from(schema.humanPrincipals)
      .where(sql`lower(${schema.humanPrincipals.ownerWallet}) = ${ownerWallet}`)
      .get(),
  ]);

  if (byHuman && byHuman.ownerWallet.toLowerCase() !== ownerWallet) {
    throw new PrincipalConflict(
      "This unique human already controls a newsroom principal. A second wallet cannot create independent reputation.",
    );
  }
  if (byWallet && byWallet.nullifierHash !== nullifierHash) {
    throw new PrincipalConflict("This wallet already belongs to a different newsroom principal.");
  }

  const agent = await db
    .select({ id: schema.agents.id, name: schema.agents.name, registeredAt: schema.agents.registeredAt })
    .from(schema.agents)
    .where(sql`lower(${schema.agents.address}) = ${ownerWallet}`)
    .get();
  if (!agent) throw new PrincipalConflict("no byline registered at this address", 400);

  const existing = byHuman ?? byWallet;
  const principalId = existing?.id ?? principalIdForNullifierHash(nullifierHash);
  const now = new Date().toISOString();

  if (!existing) {
    await db
      .insert(schema.humanPrincipals)
      .values({
        id: principalId,
        nullifierHash,
        ownerWallet,
        status: "active",
        dailyFilingLimit: 5,
        dailyStakeAtomic: "50000",
        dailyTradeAtomic: "5000000",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  // Preserve the old column for pre-event appeal/profile compatibility while
  // making the principal table the source of truth for new behavior.
  await db
    .update(schema.agents)
    .set({ worldNullifierHash: nullifierHash })
    .where(sql`lower(${schema.agents.address}) = ${ownerWallet}`)
    .run();

  let delegated = await db
    .select()
    .from(schema.delegatedAgents)
    .where(sql`lower(${schema.delegatedAgents.agentWallet}) = ${ownerWallet}`)
    .get();
  if (!delegated) {
    const delegatedId = randomUUID();
    await db
      .insert(schema.delegatedAgents)
      .values({
        id: delegatedId,
        principalId,
        agentWallet: ownerWallet,
        label: agent.name,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    delegated = await db
      .select()
      .from(schema.delegatedAgents)
      .where(eq(schema.delegatedAgents.id, delegatedId))
      .get();
  }

  if (delegated && delegated.principalId !== principalId) {
    throw new PrincipalConflict("This agent wallet is already delegated by another human principal.");
  }

  const activeMandate = delegated
    ? await db
        .select({ id: schema.newsroomMandates.id })
        .from(schema.newsroomMandates)
        .where(
          and(
            eq(schema.newsroomMandates.delegatedAgentId, delegated.id),
            eq(schema.newsroomMandates.status, "active"),
          ),
        )
        .get()
    : null;

  if (delegated && !activeMandate) {
    await db
      .insert(schema.newsroomMandates)
      .values({
        id: randomUUID(),
        principalId,
        delegatedAgentId: delegated.id,
        version: 1,
        roles: JSON.stringify(["scout", "file", "trade_preview"]),
        allowedBeats: JSON.stringify(ALL_BEATS),
        dailyFilings: 5,
        dailyStakeAtomic: "50000",
        maxTradeAtomic: "2000000",
        freshPassAboveAtomic: "500000",
        status: "active",
        createdAt: now,
      })
      .run();
  }

  return { principalId, already: !!existing };
}

export async function principalById(id: string, database?: DatabaseExecutor) {
  const db = database ?? (await getDb());
  return db
    .select()
    .from(schema.humanPrincipals)
    .where(eq(schema.humanPrincipals.id, id))
    .get();
}

/** A paused principal blocks every delegated agent until the human resumes. */
export const principalPaused = (principal: { pausedAt?: string | null } | null | undefined) =>
  !!principal?.pausedAt;

const isWriteContention = (error: unknown) => {
  const messages: string[] = [];
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    messages.push(String(current));
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return /SQLITE_BUSY|database is locked|transaction.*busy/i.test(messages.join("\n"));
};

const contentionBackoff = (attempt: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, Math.min(5 * 2 ** attempt, 100)));

/**
 * Emergency stop. Deliberately independent of World: the switch that halts an
 * agent must work even when the identity provider or the agent is unavailable.
 * Idempotent — repeating a pause keeps the original timestamp and reason.
 */
export async function pausePrincipal(
  principalId: string,
  reason: string,
): Promise<{ pausedAt: string; pauseVersion: number; alreadyPaused: boolean }> {
  return withSecurityWriteLock(async () => {
    const db = await getDb();
    // The conditional UPDATE is the pause linearization point. Concurrent pause
    // calls cannot replace the first timestamp/reason, and a concurrent resume
    // either happens wholly before this statement or wholly after it.
    for (let contentionAttempt = 0; ; ) {
      const pausedAt = new Date().toISOString();
      let result;
      try {
        result = await db
          .update(schema.humanPrincipals)
          .set({
            pausedAt,
            pauseReason: reason,
            pauseVersion: sql`${schema.humanPrincipals.pauseVersion} + 1`,
            updatedAt: pausedAt,
          })
          .where(
            and(
              eq(schema.humanPrincipals.id, principalId),
              isNull(schema.humanPrincipals.pausedAt),
            ),
          )
          .run();
      } catch (error) {
        // The emergency path is an idempotent conditional write, so retrying a
        // local/remote SQLite writer collision is safe. Consequential multi-row
        // actions are not blindly retried; they fail closed instead.
        if (!isWriteContention(error) || contentionAttempt >= 7) throw error;
        await contentionBackoff(contentionAttempt++);
        continue;
      }

      const principal = await principalById(principalId, db);
      if (!principal) throw new PrincipalConflict("newsroom principal not found", 404);
      if (principal.pausedAt) {
        return {
          pausedAt: principal.pausedAt,
          pauseVersion: principal.pauseVersion,
          alreadyPaused: result.rowsAffected !== 1,
        };
      }
      // A resume won between the failed conditional update and the read. Retry
      // so a successful pause response always corresponds to a paused row.
    }
  });
}

/** Resume is consequential: clear only the exact pause generation approved. */
export async function resumePrincipal(
  principalId: string,
  expectedPauseVersion: number,
): Promise<{ resumed: boolean; reason?: "already_active" | "pause_changed" }> {
  return withSecurityWriteLock(async () => {
    const db = await getDb();
    const result = await db
      .update(schema.humanPrincipals)
      .set({ pausedAt: null, pauseReason: null, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(schema.humanPrincipals.id, principalId),
          eq(schema.humanPrincipals.pauseVersion, expectedPauseVersion),
          isNotNull(schema.humanPrincipals.pausedAt),
        ),
      )
      .run();
    if (result.rowsAffected === 1) return { resumed: true };

    const principal = await principalById(principalId, db);
    if (!principal) throw new PrincipalConflict("newsroom principal not found", 404);
    return {
      resumed: false,
      reason: principal.pausedAt ? "pause_changed" : "already_active",
    };
  });
}

/**
 * Orders already accepted by the execution provider are NOT cancelled by a
 * pause. TRUTHLY has no provider-level cancel authority here, so a pause
 * reports them instead of pretending it recalled them.
 */
export async function openTradesForPrincipal(principalId: string) {
  const db = await getDb();
  return db
    .select({
      id: schema.trades.id,
      signalId: schema.trades.signalId,
      status: schema.trades.status,
      orderId: schema.trades.orderId,
      bracketOrderId: schema.trades.bracketOrderId,
      createdAt: schema.trades.createdAt,
    })
    .from(schema.trades)
    .where(
      and(
        eq(schema.trades.principalId, principalId),
        inArray(schema.trades.status, ["submitting", "submitted", "needs_review"]),
      ),
    )
    .orderBy(schema.trades.createdAt);
}

export async function principalByOwnerWallet(wallet: string, database?: DatabaseExecutor) {
  const db = database ?? (await getDb());
  const normalized = normalizeWallet(wallet);
  return db
    .select()
    .from(schema.humanPrincipals)
    .where(sql`lower(${schema.humanPrincipals.ownerWallet}) = ${normalized}`)
    .get();
}

export async function principalForAgentWallet(wallet: string, database?: DatabaseExecutor) {
  const db = database ?? (await getDb());
  const normalized = normalizeWallet(wallet);
  return db
    .select({
      principal: schema.humanPrincipals,
      delegatedAgent: schema.delegatedAgents,
    })
    .from(schema.delegatedAgents)
    .innerJoin(
      schema.humanPrincipals,
      eq(schema.humanPrincipals.id, schema.delegatedAgents.principalId),
    )
    .where(sql`lower(${schema.delegatedAgents.agentWallet}) = ${normalized}`)
    .get();
}

export async function principalForSignal(signalId: string, database?: DatabaseExecutor) {
  const db = database ?? (await getDb());
  return db
    .select({
      principal: schema.humanPrincipals,
      delegatedAgent: schema.delegatedAgents,
      agent: schema.agents,
    })
    .from(schema.signals)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.signals.agentId))
    .innerJoin(
      schema.delegatedAgents,
      sql`lower(${schema.delegatedAgents.agentWallet}) = lower(${schema.agents.address})`,
    )
    .innerJoin(
      schema.humanPrincipals,
      eq(schema.humanPrincipals.id, schema.delegatedAgents.principalId),
    )
    .where(eq(schema.signals.id, signalId))
    .get();
}

/** Bind once. Neither another principal nor another subject may overwrite it. */
export async function bindPrincipalSubject(principalId: string, subHash: string): Promise<void> {
  const db = await getDb();
  const [principal, subjectOwner] = await Promise.all([
    principalById(principalId),
    db
      .select({ id: schema.humanPrincipals.id })
      .from(schema.humanPrincipals)
      .where(eq(schema.humanPrincipals.worldSubHash, subHash))
      .get(),
  ]);
  if (!principal) throw new PrincipalConflict("newsroom principal not found", 404);
  if (principal.worldSubHash && principal.worldSubHash !== subHash) {
    throw new PrincipalConflict("This principal is already bound to a different World subject.");
  }
  if (subjectOwner && subjectOwner.id !== principalId) {
    throw new PrincipalConflict("This World subject already controls another principal.");
  }
  await db
    .update(schema.humanPrincipals)
    .set({ worldSubHash: subHash, updatedAt: new Date().toISOString() })
    .where(eq(schema.humanPrincipals.id, principalId))
    .run();
}

export async function independenceGroupForWallet(wallet: string): Promise<string> {
  const bound = await principalForAgentWallet(wallet);
  return bound?.principal.id ?? `unbound_${digest(normalizeWallet(wallet))}`;
}
