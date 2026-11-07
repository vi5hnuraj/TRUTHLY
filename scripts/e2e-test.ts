import { config } from "dotenv";
import { createClient } from "@libsql/client";
import { v4 as uuidv4 } from "uuid";

// Load .env.local so the test hits the same Turso DB as the Next.js server
config({ path: ".env.local" });

function getTestDb() {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) {
    throw new Error("TURSO_DATABASE_URL not set — did you create .env.local?");
  }
  return createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}

const BASE_URL = "http://localhost:3000";
const TEST_EMAIL = `e2e-test-${Date.now()}@truthly-test.invalid`;

let passed = 0;
let failed = 0;

function ok(label: string, value: unknown): void {
  if (value) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

async function get(path: string, headers?: Record<string, string>) {
  const res = await fetch(`${BASE_URL}${path}`, { headers });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function post(
  path: string,
  data: unknown,
  headers?: Record<string, string>,
) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(data),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function testStatus() {
  console.log("\n[1] GET /api/status");
  const { status, body } = await get("/api/status");
  ok("responds 200", status === 200);
  ok("status is ok", body?.status === "ok");
  ok("has platform field", typeof body?.platform === "string");
  ok(
    "has stats object",
    body?.stats !== null && typeof body?.stats === "object",
  );
}

async function testAgents(): Promise<string | null> {
  console.log("\n[2] GET /api/agents");
  const { status, body } = await get("/api/agents");
  ok("responds 200", status === 200);
  ok("has agents array", Array.isArray(body?.agents));

  if (!Array.isArray(body?.agents) || body.agents.length === 0) {
    console.log("  INFO  no agents in DB yet, skipping agent-dependent checks");
    return null;
  }

  const agent = body.agents[0];
  ok("agent has id field", typeof agent.id === "string");
  ok("agent has name field", typeof agent.name === "string");
  return null;
}

async function testSignals(): Promise<boolean> {
  console.log("\n[3] GET /api/signals");
  const { status, body } = await get("/api/signals");
  ok("responds 200", status === 200);
  ok("has signals array", Array.isArray(body?.signals));

  if (!Array.isArray(body?.signals) || body.signals.length === 0) {
    console.log("  INFO  no signals in DB yet");
    return false;
  }

  const signal = body.signals[0];
  ok("signal has id", typeof signal.id === "string");
  ok("signal has headline", typeof signal.headline === "string");
  ok("signal has beat", typeof signal.beat === "string");
  ok("signal has status", typeof signal.status === "string");
  return true;
}

async function testEditorReview(hasUnreviewed: boolean) {
  console.log("\n[4] POST /api/editor/review");
  if (!hasUnreviewed) {
    console.log("  SKIP  no submitted signals — skipping editor review");
    return;
  }

  const { status, body } = await post(
    "/api/editor/review",
    {},
    { "x-editor-key": process.env.EDITOR_API_KEY ?? "" },
  );
  ok("responds 200", status === 200);
  ok("has reviewed count", typeof body?.reviewed === "number");
  ok("has message", typeof body?.message === "string");
}

async function testEditions(): Promise<string | null> {
  console.log("\n[5] GET /api/editions");
  const { status, body } = await get("/api/editions");
  ok("responds 200", status === 200);
  ok("has editions array", Array.isArray(body?.editions));

  if (!Array.isArray(body?.editions) || body.editions.length === 0) {
    console.log("  INFO  no editions in DB yet");
    return null;
  }

  const edition = body.editions[0];
  ok("edition has id", typeof edition.id === "string");
  ok("edition has number", typeof edition.number === "number");
  ok("edition has title", typeof edition.title === "string");
  return edition.id as string;
}

async function testEditionById(editionId: string | null) {
  console.log("\n[6] GET /api/editions/{id}");
  if (!editionId) {
    console.log("  SKIP  no edition id available");
    return;
  }

  const { status, body } = await get(`/api/editions/${editionId}`);
  ok("responds 200", status === 200);
  ok(
    "has edition object",
    body?.edition !== null && typeof body?.edition === "object",
  );
  ok(
    "edition strips contentHtml (x402 paywall)",
    body?.edition?.contentHtml === undefined,
  );
  ok("has signals array", Array.isArray(body?.signals));
}

async function testEditionsLatest() {
  console.log("\n[7] GET /api/editions/latest — expect 402 (paywall)");
  const { status } = await get("/api/editions/latest");
  ok("responds 402", status === 402);
}

async function testLeaderboard() {
  console.log("\n[8] GET /api/leaderboard");
  const { status, body } = await get("/api/leaderboard");
  ok("responds 200", status === 200);
  ok("has leaderboard array", Array.isArray(body?.leaderboard));

  if (Array.isArray(body?.leaderboard) && body.leaderboard.length > 0) {
    const first = body.leaderboard[0];
    ok("first entry has rank", first.rank === 1);
    ok("first entry has name", typeof first.name === "string");
    ok("first entry has score", typeof first.score === "number");
  }
}

async function testFinancials() {
  console.log("\n[9] GET /api/financials");
  const { status, body } = await get("/api/financials");
  ok("responds 200", status === 200);
  ok("has revenueCents", typeof body?.revenueCents === "number");
  ok("has payoutCents", typeof body?.payoutCents === "number");
  ok("has refundCents", typeof body?.refundCents === "number");
  ok("revenue > 0", body?.revenueCents > 0);
  ok("payouts > 0", body?.payoutCents > 0);
}

async function testFinancialsDeep() {
  console.log("\n[12] GET /api/financials — deeper field check");
  const { status, body } = await get("/api/financials");
  ok("responds 200", status === 200);
  ok("has entries array", Array.isArray(body?.entries));
  ok("has revenueCents", typeof body?.revenueCents === "number");
  ok("has payoutCents", typeof body?.payoutCents === "number");
  ok("has expenseCents", typeof body?.expenseCents === "number");
  ok("has profitCents", typeof body?.profitCents === "number");
  const expectedProfit =
    body?.revenueCents - body?.expenseCents - body?.payoutCents - body?.refundCents;
  ok(
    `profitCents math includes ${body?.refundCents} cents of stake refunds`,
    body?.profitCents === expectedProfit,
  );
}

async function testEditorPipeline() {
  console.log("\n[13] Full editor pipeline (DB-seeded signal)");

  const db = getTestDb();
  let testSignalId: string | null = null;
  let testEditionId: string | null = null;

  try {
    // Need a real agent to satisfy FK constraint
    const agentResult = await db.execute("SELECT id FROM agents LIMIT 1");
    const agent = agentResult.rows[0] as unknown as { id: string } | undefined;

    if (!agent) {
      console.log("  SKIP  no agents in DB — cannot seed test signal");
      return;
    }

    // Insert fresh test signal with status "submitted"
    testSignalId = uuidv4();
    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO signals (id, agent_id, headline, body, sources, tags, beat, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?)`,
      args: [
        testSignalId,
        agent.id,
        "E2E Test Signal — pipeline smoke test",
        "This signal was inserted by the E2E test suite to exercise the editor pipeline.",
        JSON.stringify(["https://example.com"]),
        JSON.stringify(["e2e", "test"]),
        "technology",
        now,
        now,
      ],
    });
    ok("test signal inserted", true);

    // POST /api/editor/review
    const reviewRes = await post(
      "/api/editor/review",
      {},
      { "x-editor-key": process.env.EDITOR_API_KEY ?? "" },
    );
    ok("review responds 200", reviewRes.status === 200);
    ok(
      "review has reviewed count",
      typeof reviewRes.body?.reviewed === "number",
    );
    ok("review reviewed >= 1", reviewRes.body?.reviewed >= 1);

    // Herald may keep it submitted when paid inference is not configured, or
    // reject unreachable fixture sources. Either way the review must record a
    // decision; the test force-includes it below to exercise compile/publish.
    const includedResult = await db.execute({
      sql: "SELECT id, status, editor_feedback FROM signals WHERE id = ?",
      args: [testSignalId],
    });
    const reviewedSignal = includedResult.rows[0] as unknown as {
      status?: string;
      editor_feedback?: string | null;
    } | undefined;
    ok(
      "signal received a review decision",
      !!reviewedSignal && typeof reviewedSignal.editor_feedback === "string",
    );

    // Force status to "included" so compile can pick it up
    await db.execute({
      sql: "UPDATE signals SET status = 'included' WHERE id = ?",
      args: [testSignalId],
    });

    // POST /api/editor/compile
    const compileRes = await post(
      "/api/editor/compile",
      {},
      { "x-editor-key": process.env.EDITOR_API_KEY ?? "" },
    );
    ok("compile responds 200", compileRes.status === 200);
    ok(
      "compile has edition.id",
      typeof compileRes.body?.edition?.id === "string",
    );
    ok(
      "compile has edition.number",
      typeof compileRes.body?.edition?.number === "number",
    );
    ok(
      "compile has edition.signalCount",
      typeof compileRes.body?.edition?.signalCount === "number",
    );
    testEditionId = compileRes.body?.edition?.id ?? null;

    // POST /api/editor/publish
    const publishRes = await post(
      "/api/editor/publish",
      {},
      { "x-editor-key": process.env.EDITOR_API_KEY ?? "" },
    );
    ok("publish responds 200", publishRes.status === 200);
    ok(
      "publish has emailsSent",
      typeof publishRes.body?.emailsSent === "number",
    );
    ok(
      "publish has subscriberCount",
      typeof publishRes.body?.subscriberCount === "number",
    );
    ok(
      "publish has edition.id",
      typeof publishRes.body?.edition?.id === "string",
    );
  } catch (err) {
    console.error(`  FAIL  editor pipeline error: ${err}`);
    failed++;
  } finally {
    try {
      if (testEditionId) {
        await db.execute({
          sql: "DELETE FROM edition_signals WHERE edition_id = ?",
          args: [testEditionId],
        });
        await db.execute({
          sql: "DELETE FROM ledger WHERE edition_id = ?",
          args: [testEditionId],
        });
        await db.execute({
          sql: "DELETE FROM editions WHERE id = ?",
          args: [testEditionId],
        });
        ok("test edition deleted", true);
      }
      if (testSignalId) {
        for (const table of [
          "source_snapshots",
          "signal_revisions",
          "settlements",
          "appeals",
        ]) {
          await db.execute({
            sql: `DELETE FROM ${table} WHERE signal_id = ?`,
            args: [testSignalId],
          });
        }
        await db.execute({
          sql: "DELETE FROM signals WHERE id = ?",
          args: [testSignalId],
        });
        ok("test signal deleted", true);
      }
    } catch (cleanErr) {
      console.error(`  FAIL  pipeline cleanup error: ${cleanErr}`);
      failed++;
    }
  }
}

async function testSubscribeAndPublishFlow() {
  console.log("\n[14] Subscribe + publish email flow");

  const testSubscriberEmail = `e2e-pub-test-${Date.now()}@truthly-test.invalid`;

  // Subscribe
  const subRes = await post("/api/subscribe", { email: testSubscriberEmail });
  ok("subscribe responds 201", subRes.status === 201);
  ok("subscribe has id", typeof subRes.body?.id === "string");

  // Publish and check emailsSent reflects subscriber (count > 0)
  const publishRes = await post(
    "/api/editor/publish",
    {},
    { "x-editor-key": process.env.EDITOR_API_KEY ?? "" },
  );
  ok(
    "publish responds 200 or 400",
    publishRes.status === 200 || publishRes.status === 400,
  );

  if (publishRes.status === 200) {
    ok(
      "emailsSent is a number",
      typeof publishRes.body?.emailsSent === "number",
    );
    // If the edition was already published (idempotency), subscriberCount may be 0
    if (publishRes.body?.alreadyPublished) {
      ok("publish idempotent — already published", true);
    } else {
      ok(
        "subscriberCount >= 1 (includes new subscriber)",
        publishRes.body?.subscriberCount >= 1,
      );
    }
  } else {
    console.log(
      "  INFO  no compiled edition available for publish — emailsSent check skipped",
    );
  }

  // Cleanup subscriber
  try {
    const db = getTestDb();
    const result = await db.execute({
      sql: "DELETE FROM subscribers WHERE email = ?",
      args: [testSubscriberEmail],
    });
    ok("test subscriber deleted", result.rowsAffected === 1);
  } catch (err) {
    console.error(`  FAIL  subscriber cleanup error: ${err}`);
    failed++;
  }
}

async function testPublishRetryIdempotency() {
  console.log("\n[16] Publish retry idempotency");

  const db = getTestDb();
  let testSignalId: string | null = null;
  let testEditionId: string | null = null;

  try {
    const agentResult = await db.execute("SELECT id FROM agents LIMIT 1");
    const agent = agentResult.rows[0] as unknown as { id: string } | undefined;

    if (!agent) {
      console.log("  SKIP  no agents in DB — cannot test publish retry");
      return;
    }

    // Insert test signal + force to included
    testSignalId = uuidv4();
    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO signals (id, agent_id, headline, body, sources, tags, beat, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'included', ?, ?)`,
      args: [
        testSignalId,
        agent.id,
        "Retry test signal",
        "Testing publish retry idempotency.",
        JSON.stringify(["https://example.com"]),
        JSON.stringify(["test"]),
        "bitcoin",
        now,
        now,
      ],
    });

    // Compile
    const compileRes = await post(
      "/api/editor/compile",
      {},
      { "x-editor-key": process.env.EDITOR_API_KEY ?? "" },
    );
    ok("compile responds 200", compileRes.status === 200);
    testEditionId = compileRes.body?.edition?.id ?? null;

    if (!testEditionId) {
      console.log("  SKIP  compile failed — cannot test publish retry");
      return;
    }

    // First publish
    const pub1 = await post(
      "/api/editor/publish",
      {},
      { "x-editor-key": process.env.EDITOR_API_KEY ?? "" },
    );
    ok("first publish responds 200", pub1.status === 200);
    ok("first publish status is published", pub1.body?.status === "published");

    // Count ledger entries for this edition
    const ledger1 = await db.execute({
      sql: "SELECT COUNT(*) as cnt FROM ledger WHERE edition_id = ?",
      args: [testEditionId],
    });
    const count1 = Number((ledger1.rows[0] as unknown as { cnt: number }).cnt);

    // Second publish (retry) — should be idempotent
    const pub2 = await post(
      "/api/editor/publish",
      {},
      { "x-editor-key": process.env.EDITOR_API_KEY ?? "" },
    );
    ok("retry publish responds 200", pub2.status === 200);
    ok("retry publish is idempotent", pub2.body?.alreadyPublished === true);

    // Verify no duplicate ledger entries
    const ledger2 = await db.execute({
      sql: "SELECT COUNT(*) as cnt FROM ledger WHERE edition_id = ?",
      args: [testEditionId],
    });
    const count2 = Number((ledger2.rows[0] as unknown as { cnt: number }).cnt);
    ok(
      `no duplicate ledger entries (${count1} === ${count2})`,
      count1 === count2,
    );

    // Verify edition status in DB
    const edResult = await db.execute({
      sql: "SELECT status FROM editions WHERE id = ?",
      args: [testEditionId],
    });
    const edStatus = (edResult.rows[0] as unknown as { status: string })
      ?.status;
    ok("edition status is 'published'", edStatus === "published");
  } catch (err) {
    console.error(`  FAIL  publish retry error: ${err}`);
    failed++;
  } finally {
    try {
      if (testEditionId) {
        await db.execute({
          sql: "DELETE FROM edition_signals WHERE edition_id = ?",
          args: [testEditionId],
        });
        await db.execute({
          sql: "DELETE FROM ledger WHERE edition_id = ?",
          args: [testEditionId],
        });
        await db.execute({
          sql: "DELETE FROM editions WHERE id = ?",
          args: [testEditionId],
        });
      }
      if (testSignalId) {
        await db.execute({
          sql: "DELETE FROM signals WHERE id = ?",
          args: [testSignalId],
        });
      }
    } catch (cleanErr) {
      console.error(`  FAIL  retry test cleanup error: ${cleanErr}`);
      failed++;
    }
  }
}

async function testEditionStatusFlow() {
  console.log("\n[17] Edition status flow (compiled -> published)");

  const db = getTestDb();
  let testSignalId: string | null = null;
  let testEditionId: string | null = null;

  try {
    const agentResult = await db.execute("SELECT id FROM agents LIMIT 1");
    const agent = agentResult.rows[0] as unknown as { id: string } | undefined;

    if (!agent) {
      console.log("  SKIP  no agents in DB");
      return;
    }

    testSignalId = uuidv4();
    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO signals (id, agent_id, headline, body, sources, tags, beat, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'included', ?, ?)`,
      args: [
        testSignalId,
        agent.id,
        "Status flow test signal",
        "Testing edition status transitions.",
        JSON.stringify(["https://example.com"]),
        JSON.stringify(["test"]),
        "defi",
        now,
        now,
      ],
    });

    // Compile — should create edition with status 'compiled'
    const compileRes = await post(
      "/api/editor/compile",
      {},
      { "x-editor-key": process.env.EDITOR_API_KEY ?? "" },
    );
    ok("compile responds 200", compileRes.status === 200);
    testEditionId = compileRes.body?.edition?.id ?? null;

    if (testEditionId) {
      const edResult = await db.execute({
        sql: "SELECT status FROM editions WHERE id = ?",
        args: [testEditionId],
      });
      const status = (edResult.rows[0] as unknown as { status: string })
        ?.status;
      ok("edition status after compile is 'compiled'", status === "compiled");

      // Publish — should transition to 'published'
      const pubRes = await post(
        "/api/editor/publish",
        {},
        { "x-editor-key": process.env.EDITOR_API_KEY ?? "" },
      );
      ok("publish responds 200", pubRes.status === 200);

      const edResult2 = await db.execute({
        sql: "SELECT status FROM editions WHERE id = ?",
        args: [testEditionId],
      });
      const status2 = (edResult2.rows[0] as unknown as { status: string })
        ?.status;
      ok(
        "edition status after publish is 'published'",
        status2 === "published",
      );
    }
  } catch (err) {
    console.error(`  FAIL  status flow error: ${err}`);
    failed++;
  } finally {
    try {
      if (testEditionId) {
        await db.execute({
          sql: "DELETE FROM edition_signals WHERE edition_id = ?",
          args: [testEditionId],
        });
        await db.execute({
          sql: "DELETE FROM ledger WHERE edition_id = ?",
          args: [testEditionId],
        });
        await db.execute({
          sql: "DELETE FROM editions WHERE id = ?",
          args: [testEditionId],
        });
      }
      if (testSignalId) {
        await db.execute({
          sql: "DELETE FROM signals WHERE id = ?",
          args: [testSignalId],
        });
      }
    } catch (cleanErr) {
      console.error(`  FAIL  status flow cleanup error: ${cleanErr}`);
      failed++;
    }
  }
}

async function testX402Paywall() {
  console.log("\n[18] x402 paywall on /api/editions/latest");

  // Without payment header — should get 402
  const { status: noPayStatus } = await get("/api/editions/latest");
  ok("no-payment request gets 402", noPayStatus === 402);

  // Check financials includes payment fields
  const { body: fin } = await get("/api/financials");
  ok(
    "financials has paymentRevenueCents",
    typeof fin?.paymentRevenueCents === "number",
  );
  ok("financials has paymentCount", typeof fin?.paymentCount === "number");
}

async function testErrorHandling() {
  console.log("\n[15] Error handling tests");

  // POST /api/editor/review without auth header — expect 401
  const noAuthRes = await post("/api/editor/review", {});
  ok("review without key responds 401", noAuthRes.status === 401);
  ok(
    "review without key has error field",
    typeof noAuthRes.body?.error === "string",
  );

  // POST /api/subscribe with invalid email (no @) — expect 400
  const badEmailRes = await post("/api/subscribe", { email: "notanemail" });
  ok("subscribe with invalid email responds 400", badEmailRes.status === 400);
  ok(
    "subscribe with invalid email has error field",
    typeof badEmailRes.body?.error === "string",
  );

  // GET /api/editions/nonexistent-id — expect 404
  const notFoundRes = await get(
    "/api/editions/nonexistent-id-that-does-not-exist",
  );
  ok("editions/nonexistent-id responds 404", notFoundRes.status === 404);
  ok(
    "editions/nonexistent-id has error field",
    typeof notFoundRes.body?.error === "string",
  );
}

async function testSubscribe(): Promise<string | null> {
  console.log("\n[10] POST /api/subscribe");
  const { status, body } = await post("/api/subscribe", { email: TEST_EMAIL });
  ok("responds 201", status === 201);
  ok("has success message", body?.message === "Subscribed successfully");
  ok("has subscriber id", typeof body?.id === "string");
  return body?.id ?? null;
}

async function cleanupSubscriber(email: string) {
  console.log("\n[11] Cleanup — delete test subscriber from DB");
  try {
    const db = getTestDb();
    const result = await db.execute({
      sql: "DELETE FROM subscribers WHERE email = ?",
      args: [email],
    });
    ok("test subscriber deleted", result.rowsAffected === 1);
  } catch (err) {
    console.error(`  FAIL  cleanup error: ${err}`);
    failed++;
  }
}

async function main() {
  console.log("TRUTHLY E2E Test Suite");
  console.log(`Target: ${BASE_URL}`);
  console.log(`Test email: ${TEST_EMAIL}`);

  // Check server is reachable before running any tests
  try {
    await fetch(`${BASE_URL}/api/status`);
  } catch {
    console.error(
      `\nERROR: Cannot reach ${BASE_URL} — is the dev server running?`,
    );
    process.exit(1);
  }

  await testStatus();
  await testAgents();

  const hasSignals = await testSignals();

  // Check if any signals are in "submitted" status (unreviewed)
  let hasUnreviewed = false;
  if (hasSignals) {
    const { body } = await get("/api/signals?status=submitted");
    hasUnreviewed = Array.isArray(body?.signals) && body.signals.length > 0;
    if (!hasUnreviewed) {
      console.log(
        "\n  INFO  no unreviewed signals found — editor review will be skipped",
      );
    }
  }

  await testEditorReview(hasUnreviewed);
  const editionId = await testEditions();
  await testEditionById(editionId);
  await testEditionsLatest();
  await testLeaderboard();
  await testFinancials();
  await testSubscribe();
  await cleanupSubscriber(TEST_EMAIL);

  await testFinancialsDeep();
  await testEditorPipeline();
  await testSubscribeAndPublishFlow();
  await testErrorHandling();
  await testPublishRetryIdempotency();
  await testEditionStatusFlow();
  await testX402Paywall();

  console.log(`\n${"─".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
