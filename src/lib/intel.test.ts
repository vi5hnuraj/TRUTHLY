import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";

const dbFile = path.join(process.cwd(), `.truthly-intel-test-${process.pid}.db`);
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
delete process.env.TURSO_AUTH_TOKEN;
process.env.NEXT_PUBLIC_BASE_URL = "http://localhost:3000";

after(async () => {
  await rm(dbFile, { force: true });
  await rm(`${dbFile}-shm`, { force: true });
  await rm(`${dbFile}-wal`, { force: true });
});

const AGENT_ID = "agent-intel";
const AGENT_ADDRESS = `0x${"b".repeat(40)}`;
const PAYER = `0x${"c".repeat(40)}`;
const OTHER_WALLET = `0x${"d".repeat(40)}`;
const SIGNAL_ID = "33333333-3333-4333-8333-333333333333";
const UNPUBLISHED_ID = "44444444-4444-4444-8444-444444444444";
const EDITION_ID = "55555555-5555-4555-8555-555555555555";

const BODY =
  "Sequencer upgrade lands after the governance vote. The L2 approved proposal 42 on " +
  "Sunday, raising the batch limit and cutting confirmation times roughly in half for " +
  "the next release. Validators confirmed the rollout window, while the foundation " +
  "published the migration guide and the rollback plan. Exchanges kept deposits open " +
  "throughout, and the team said monitoring would continue for a full week after the " +
  "switch before any further parameter change is proposed to the working group.";
const SOURCES = [
  "https://governance.example/proposal-42",
  "https://reuters.example/sequencer-upgrade",
];
const CLAIM_TEXT = "Proposal 42 raised the batch limit.";

let intel: typeof import("./intel");
let payments: typeof import("./payments");
let dbModule: typeof import("./db");
let verificationModule: typeof import("./herald/verification");
let receiptId: string;

before(async () => {
  dbModule = await import("./db");
  intel = await import("./intel");
  payments = await import("./payments");
  verificationModule = await import("./herald/verification");

  const { getDb, schema } = dbModule;
  const db = await getDb();
  const now = new Date().toISOString();

  await db
    .insert(schema.agents)
    .values({
      id: AGENT_ID,
      accountId: "acct-intel",
      chainId: "8453",
      address: AGENT_ADDRESS,
      name: "Intel Reporter",
      registeredAt: now,
    })
    .run();

  await db
    .insert(schema.editions)
    .values({
      id: EDITION_ID,
      number: 1,
      title: "Test edition",
      summary: null,
      contentHtml: "<p>edition</p>",
      contentText: "edition",
      signalCount: 1,
      publishedAt: now,
      createdAt: now,
      status: "published",
    })
    .run();

  await db
    .insert(schema.signals)
    .values({
      id: SIGNAL_ID,
      agentId: AGENT_ID,
      headline: "Sequencer upgrade approved",
      body: BODY,
      sources: JSON.stringify(SOURCES),
      sourceMetadata: JSON.stringify([
        {
          url: SOURCES[0],
          title: "Proposal 42",
          publisher: "Governance Forum",
          published_at: "2026-11-01T10:00:00.000Z",
          source_type: "primary",
        },
        {
          url: SOURCES[1],
          title: "Sequencer upgrade",
          publisher: "Reuters",
          published_at: "2026-11-01T11:00:00.000Z",
          source_type: "secondary",
        },
      ]),
      claims: JSON.stringify([{ claim: CLAIM_TEXT, citations: [SOURCES[0], SOURCES[1]] }]),
      tags: JSON.stringify(["infrastructure", "token:ETH", "world:sequencer upgrade"]),
      beat: "infrastructure",
      status: "submitted",
      score: 82,
      verification: JSON.stringify({
        verdict: "supported",
        confidence: 0.9,
        notes: "Both sources confirm the vote and the parameter change.",
        model: "test-model",
        checked_at: now,
        claim_checks: [
          {
            claim_index: 1,
            verdict: "supported",
            citations: [SOURCES[0], SOURCES[1]],
            note: "both sources",
          },
        ],
        source_evidence: [],
        cost_atomic: "25000",
      }),
      createdAt: now,
      updatedAt: now,
      stakeAtomic: "10000",
      stakeStatus: "refunded",
    })
    .run();

  await db
    .insert(schema.editionSignals)
    .values({ editionId: EDITION_ID, signalId: SIGNAL_ID, position: 1, payoutCents: 0 })
    .run();

  // Filed but not yet compiled into a published edition: not for sale.
  await db
    .insert(schema.signals)
    .values({
      id: UNPUBLISHED_ID,
      agentId: AGENT_ID,
      headline: "Filed story waiting for an edition",
      body: "Not published yet.",
      sources: JSON.stringify(SOURCES),
      tags: JSON.stringify(["defi"]),
      beat: "defi",
      status: "submitted",
      createdAt: now,
      updatedAt: now,
    })
    .run();
});

test("the free excerpt is bounded and never the whole body", () => {
  const excerpt = intel.signalExcerpt(BODY);
  assert.ok(excerpt.length <= 241, `excerpt too long: ${excerpt.length}`);
  assert.ok(excerpt.endsWith("…"));
  assert.ok(BODY.startsWith(excerpt.slice(0, -1)));
  assert.equal(intel.signalExcerpt("short line"), "short line");
});

test("a story is for sale only inside a published edition", async () => {
  const ok = await intel.findSignalForSale(SIGNAL_ID);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.row.editionId, EDITION_ID);
    assert.equal(ok.row.editionNumber, 1);
  }

  const unpublished = await intel.findSignalForSale(UNPUBLISHED_ID);
  assert.equal(unpublished.ok, false);
  assert.equal(!unpublished.ok && unpublished.reason, "not_in_published_edition");

  const invalid = await intel.findSignalForSale("not-a-uuid");
  assert.equal(!invalid.ok && invalid.reason, "invalid_signal_id");
});

test("the teaser sells the decision, not the story", async () => {
  const lookup = await intel.findPublicSignal(SIGNAL_ID);
  assert.equal(lookup.ok, true);
  if (!lookup.ok) return;

  const teaser = intel.buildSignalTeaser(lookup.row, {
    snapshotCount: 1,
    verification: verificationModule.readVerification(lookup.row.verification),
  });
  const raw = JSON.stringify(teaser);

  assert.ok(teaser.excerpt.length > 0);
  assert.ok(!raw.includes(BODY), "teaser must not contain the paid body");
  assert.ok(!raw.includes(SOURCES[0]), "teaser must not list paid sources");
  assert.ok(!raw.includes(CLAIM_TEXT), "teaser must not contain paid claims");
  assert.equal(teaser.price.for_sale, true);
  assert.equal(teaser.price.cents, 2);
  assert.equal(teaser.evidence_summary.source_count, 2);
  assert.equal(teaser.evidence_summary.independent_owner_groups, 2);
  assert.equal(teaser.evidence_summary.claim_count, 1);
  assert.equal(teaser.evidence_summary.snapshot_count, 1);
  assert.equal(teaser.diy_vs_buy.price_cents, 2);
  assert.equal(teaser.diy_vs_buy.diy.filing_stake_cents, 1);
  assert.equal(teaser.diy_vs_buy.diy.fact_check_atomic, "25000");
  assert.equal(teaser.diy_vs_buy.diy.fact_check_usd, "0.025000");
  assert.equal(teaser.act_on.tokens.length, 1);
  assert.equal(teaser.act_on.world_market_search, "sequencer upgrade");

  const unpublished = await intel.findPublicSignal(UNPUBLISHED_ID);
  assert.equal(unpublished.ok, true);
  if (!unpublished.ok) return;
  const draftTeaser = intel.buildSignalTeaser(unpublished.row, {
    snapshotCount: 0,
    verification: null,
  });
  assert.equal(draftTeaser.price.for_sale, false);
  assert.equal(draftTeaser.signal.edition_number, null);
});

test("a settled signal payment mints a signal-scoped receipt and pays the reporter", async () => {
  const recorded = await payments.recordSignalPayment({
    signalId: SIGNAL_ID,
    editionId: EDITION_ID,
    payerAddress: PAYER,
    amountCents: 2,
    txHash: "0xintel",
    network: "eip155:8453",
  });
  assert.ok(recorded, "first settlement must record");
  receiptId = recorded!.entitlementId;

  const { getDb, schema } = dbModule;
  const db = await getDb();

  const entitlement = await db
    .select()
    .from(schema.entitlements)
    .where(eq(schema.entitlements.id, receiptId))
    .get();
  assert.equal(entitlement?.signalId, SIGNAL_ID);
  assert.equal(entitlement?.accountId, PAYER.toLowerCase());

  const payment = await db
    .select()
    .from(schema.payments)
    .where(eq(schema.payments.id, recorded!.paymentId))
    .get();
  assert.equal(payment?.signalId, SIGNAL_ID);
  assert.equal(payment?.amountCents, 2);

  const edition = await db
    .select()
    .from(schema.editions)
    .where(eq(schema.editions.id, EDITION_ID))
    .get();
  assert.equal(edition?.revenueCents, 2);

  // floor(2¢ * 0.8) = 1¢ to the reporter; the cent remainder stays platform-side.
  const agent = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.id, AGENT_ID))
    .get();
  assert.equal(agent?.totalEarnedCents, 1);

  const editionPayout = await db
    .select()
    .from(schema.editionSignals)
    .where(eq(schema.editionSignals.signalId, SIGNAL_ID))
    .get();
  assert.equal(editionPayout?.payoutCents, 1);

  const duplicate = await payments.recordSignalPayment({
    signalId: SIGNAL_ID,
    editionId: EDITION_ID,
    payerAddress: PAYER,
    amountCents: 2,
    txHash: "0xintel-again",
    network: "eip155:8453",
  });
  assert.ok(duplicate, "a different transaction is a second sale");
  const revenue = await db
    .select()
    .from(schema.editions)
    .where(eq(schema.editions.id, EDITION_ID))
    .get();
  assert.equal(revenue?.revenueCents, 4);
});

test("the receipt gate accepts only this story's receipt and only the paying wallet", async () => {
  const ok = await intel.verifySignalReceipt({
    receiptId,
    signalId: SIGNAL_ID,
    allowedAccounts: [PAYER, AGENT_ADDRESS],
  });
  assert.equal(ok.ok, true);

  const wrongStory = await intel.verifySignalReceipt({
    receiptId,
    signalId: UNPUBLISHED_ID,
  });
  assert.equal(wrongStory.ok, false);
  assert.equal(!wrongStory.ok && wrongStory.reason, "receipt_wrong_story");

  const wrongAccount = await intel.verifySignalReceipt({
    receiptId,
    signalId: SIGNAL_ID,
    allowedAccounts: [OTHER_WALLET],
  });
  assert.equal(wrongAccount.ok, false);
  assert.equal(!wrongAccount.ok && wrongAccount.reason, "receipt_wrong_account");

  const unknown = await intel.verifySignalReceipt({
    receiptId: "11111111-2222-4333-8444-555555555555",
    signalId: SIGNAL_ID,
    allowedAccounts: [PAYER],
  });
  assert.equal(unknown.ok, false);
  assert.equal(!unknown.ok && unknown.reason, "receipt_unknown");

  const blank = await intel.verifySignalReceipt({ receiptId: "  ", signalId: SIGNAL_ID });
  assert.equal(!blank.ok && blank.reason, "receipt_unknown");
});

test("an edition purchase is not a signal receipt", async () => {
  const { getDb, schema } = dbModule;
  const db = await getDb();
  const now = new Date().toISOString();
  const paymentId = "66666666-6666-4666-8666-666666666666";
  const editionEntitlementId = "77777777-7777-4777-8777-777777777777";

  await db
    .insert(schema.payments)
    .values({
      id: paymentId,
      editionId: EDITION_ID,
      payerAddress: PAYER,
      amountCents: 5,
      txHash: "0xedition",
      network: "eip155:8453",
      paidAt: now,
    })
    .run();
  await db
    .insert(schema.entitlements)
    .values({
      id: editionEntitlementId,
      paymentId,
      editionId: EDITION_ID,
      accountId: PAYER,
      grantedAt: now,
    })
    .run();

  const check = await intel.verifySignalReceipt({
    receiptId: editionEntitlementId,
    signalId: SIGNAL_ID,
    allowedAccounts: [PAYER],
  });
  assert.equal(check.ok, false);
  assert.equal(!check.ok && check.reason, "receipt_unknown");
});

test("paid intel returns the product and a usable receipt", async () => {
  const lookup = await intel.findSignalForSale(SIGNAL_ID);
  assert.equal(lookup.ok, true);
  if (!lookup.ok) return;

  const payload = await intel.buildSignalIntel(lookup.row, {
    entitlementId: receiptId,
    payment: { payer: PAYER, transaction: "0xintel", network: "eip155:8453" },
    grantedAt: new Date().toISOString(),
  });

  assert.equal(payload.signal.body, BODY);
  assert.equal(payload.receipt.receipt_id, receiptId);
  assert.equal(payload.receipt.signal_id, SIGNAL_ID);
  assert.equal(payload.receipt.payer, PAYER);
  assert.equal(payload.verification?.verdict, "supported");
  assert.equal(payload.claims.length, 1);
  assert.equal(payload.source_ownership_groups.length, 2);
  assert.equal(payload.stake.status, "refunded");
  assert.equal(payload.excerpt.length <= 241, true);
  assert.equal(payload.diy_vs_buy.price_cents, 2);
  assert.match(payload.receipt.note, /receipt/i);
});
