import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import type { StakeVerdict } from "./settle";

const dbFile = path.join(process.cwd(), `.truthly-settle-test-${process.pid}.db`);
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.TREASURY_PRIVATE_KEY;
process.env.NEXT_PUBLIC_BASE_URL = "http://localhost:3000";

after(async () => {
  await rm(dbFile, { force: true });
  await rm(`${dbFile}-shm`, { force: true });
  await rm(`${dbFile}-wal`, { force: true });
});

const AGENT_ID = "agent-settle";
const SIGNAL_IDS: Record<string, string> = {
  contradicted: "aaaaaaaa-1111-4111-8111-111111111111",
  unsupported: "aaaaaaaa-2222-4222-8222-222222222222",
  supported: "aaaaaaaa-3333-4333-8333-333333333333",
  partial: "aaaaaaaa-4444-4444-8444-444444444444",
  unchecked: "aaaaaaaa-5555-4555-8555-555555555555",
};
const VERDICTS: Record<string, StakeVerdict> = {
  contradicted: "contradicted",
  unsupported: "unsupported",
  supported: "supported",
  partial: "partially_supported",
  unchecked: "unchecked",
};

let settle: typeof import("./settle");
let dbModule: typeof import("./db");

before(async () => {
  dbModule = await import("./db");
  settle = await import("./settle");

  const { getDb, schema } = dbModule;
  const db = await getDb();
  const now = new Date().toISOString();

  await db
    .insert(schema.agents)
    .values({
      id: AGENT_ID,
      accountId: "acct-settle",
      chainId: "8453",
      address: `0x${"9".repeat(40)}`,
      name: "Settle Reporter",
      registeredAt: now,
    })
    .run();

  for (const [label, id] of Object.entries(SIGNAL_IDS)) {
    await db
      .insert(schema.signals)
      .values({
        id,
        agentId: AGENT_ID,
        headline: `SETTLE ${label}`,
        body: "body",
        sources: JSON.stringify(["https://example.com/a"]),
        tags: JSON.stringify([]),
        beat: "infrastructure",
        status: "submitted",
        stakeAtomic: "10000", // 1¢ locked
        stakeStatus: "locked",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
});

test("both refuting verdicts slash; every other verdict refunds", async () => {
  const { getDb, schema } = dbModule;
  const db = await getDb();

  const outcomes: Record<string, { action: string; detail: string }> = {};
  for (const [label, id] of Object.entries(SIGNAL_IDS)) {
    outcomes[label] = await settle.settleStake(db, id, VERDICTS[label], "settle test");
  }

  // The economics are unchanged by the verdict split: a story is slashed when
  // its sources refute it — whether they actively contradict it (a lie) or
  // merely fail to establish it (an over-claim) — and refunded otherwise.
  assert.equal(outcomes.contradicted.action, "slash");
  assert.equal(outcomes.unsupported.action, "slash");
  assert.equal(outcomes.supported.action, "refund");
  assert.equal(outcomes.partial.action, "refund");
  assert.equal(outcomes.unchecked.action, "refund");

  const rows = await db
    .select()
    .from(schema.signals)
    .where(inArray(schema.signals.id, Object.values(SIGNAL_IDS)))
    .all();
  const byLabel = new Map(rows.map((row) => [row.headline.replace("SETTLE ", ""), row]));
  assert.equal(byLabel.get("contradicted")?.stakeStatus, "slashed");
  assert.equal(byLabel.get("unsupported")?.stakeStatus, "slashed");
  assert.notEqual(byLabel.get("supported")?.stakeStatus, "slashed");
  assert.notEqual(byLabel.get("partial")?.stakeStatus, "slashed");
  assert.notEqual(byLabel.get("unchecked")?.stakeStatus, "slashed");
});

test("the settlement record says WHICH kind of refutation cost the stake", async () => {
  const { getDb, schema } = dbModule;
  const db = await getDb();

  const rows = await db
    .select()
    .from(schema.settlements)
    .where(inArray(schema.settlements.signalId, [SIGNAL_IDS.contradicted, SIGNAL_IDS.unsupported]))
    .all();

  const contradicted = rows.find((row) => row.signalId === SIGNAL_IDS.contradicted);
  const unsupported = rows.find((row) => row.signalId === SIGNAL_IDS.unsupported);
  assert.equal(contradicted?.action, "slash");
  assert.equal(contradicted?.verdict, "contradicted");
  assert.equal(unsupported?.action, "slash");
  assert.equal(unsupported?.verdict, "unsupported");
});

test("settling twice is a no-op — a retry cannot un-slash or double-slash", async () => {
  const { getDb, schema } = dbModule;
  const db = await getDb();

  const again = await settle.settleStake(db, SIGNAL_IDS.contradicted, "supported", "retry");
  assert.equal(again.action, "none");

  const rows = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(schema.settlements)
    .where(eq(schema.settlements.signalId, SIGNAL_IDS.contradicted))
    .get();
  assert.equal(Number(rows?.count ?? 0), 1);
});
