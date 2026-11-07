import assert from "node:assert/strict";
import { after, test } from "node:test";
import { rm } from "node:fs/promises";
import path from "node:path";

const dbFile = path.join(process.cwd(), `.truthly-world-test-${process.pid}.db`);
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
delete process.env.TURSO_AUTH_TOKEN;
process.env.NEXT_PUBLIC_BASE_URL = "http://localhost:3000";

after(async () => {
  await rm(dbFile, { force: true });
  await rm(`${dbFile}-shm`, { force: true });
  await rm(`${dbFile}-wal`, { force: true });
});

test("Agent Pass is same-human, fresh, payload-bound, one-use and durably audited", async () => {
  const [dbModule, principalModule, authModule, sessionModule, freshnessModule] = await Promise.all([
    import("../db"),
    import("./principals"),
    import("./authorizations"),
    import("./sessions"),
    import("./freshness"),
  ]);
  const { getDb, schema } = dbModule;
  const {
    registerPrincipal,
    bindPrincipalSubject,
    principalForAgentWallet,
  } = principalModule;
  const {
    AuthorizationDenied,
    completeWorldAuthorization,
    consumeWorldAuthorization,
    createWorldAuthorization,
    failWorldAuthorization,
    getWorldAuthorization,
  } = authModule;
  const { createSession, saveSession, takeSessionByState } = sessionModule;
  const { hashSub } = freshnessModule;
  const db = await getDb();

  const owner = "0x7100000000000000000000000000000000001001";
  await db.insert(schema.agents).values({
    id: "world-test-owner",
    accountId: "eip155:8453:0x7100000000000000000000000000000000001001",
    chainId: "eip155:8453",
    address: owner,
    name: "World Test Owner",
    registeredAt: new Date().toISOString(),
  }).run();
  const { principalId } = await registerPrincipal(owner, "world-test-nullifier");
  const humanSub = "world-test-controlling-human";
  await bindPrincipalSubject(principalId, hashSub(humanSub));
  assert.equal((await principalForAgentWallet(owner))?.principal.id, principalId);

  const corePayload = {
    request_id: "00000000-0000-4000-8000-000000000000",
    signal_id: "00000000-0000-4000-8000-000000000001",
    edition_id: "00000000-0000-4000-8000-000000000002",
    receipt_id: "00000000-0000-4000-8000-000000000003",
    token_address: "0x4200000000000000000000000000000000000006",
    side: "buy",
    maximum_spend_atomic: "2000000",
    order_type: "limit",
    limit_cross_price: "3500",
    take_profit_notional_price: "4000",
    stop_loss_notional_price: "3000",
    expire_time: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    maximum_price_impact: "0.05",
    rationale_hash: "0xabc",
  };

  const begin = async () => {
    const authorization = await createWorldAuthorization({
      principalId,
      action: "execute_trade",
      payload: corePayload,
      returnTo: "/trades",
    });
    const session = await createSession({
      purpose: "authorize_trade",
      principalId,
      authorizationId: authorization.id,
      action: "execute_trade",
      payloadHash: authorization.payloadHash,
      returnTo: "/trades",
      verifier: "test-pkce-verifier-with-sufficient-length-000000000000",
    });
    return { authorization, session };
  };

  // 1. Wrong human: valid-looking fresh claims, but subject continuity fails.
  const wrong = await begin();
  const wrongTaken = (await takeSessionByState(wrong.session.state))!;
  await completeWorldAuthorization(wrongTaken, {
    sub: "another-human",
    auth_time: Math.floor(Date.now() / 1000),
  });
  await saveSession(wrongTaken);
  assert.equal(wrongTaken.status, "mismatch");
  assert.equal((await getWorldAuthorization(wrong.authorization.id))?.status, "mismatch");

  // 2. Expired/stale human check never creates an approval.
  const stale = await begin();
  const staleTaken = (await takeSessionByState(stale.session.state))!;
  await completeWorldAuthorization(staleTaken, {
    sub: humanSub,
    auth_time: Math.floor(Date.now() / 1000) - 700,
  });
  await saveSession(staleTaken);
  assert.equal(staleTaken.status, "expired");
  assert.equal((await getWorldAuthorization(stale.authorization.id))?.status, "expired");

  // 3. Cancellation remains terminal and audited.
  const cancelled = await begin();
  await failWorldAuthorization(cancelled.authorization.id, "cancelled", "access_denied");
  assert.equal((await getWorldAuthorization(cancelled.authorization.id))?.status, "cancelled");

  // 4. Success: fresh claims from the principal approve exactly one payload.
  const success = await begin();
  const successTaken = (await takeSessionByState(success.session.state))!;
  await completeWorldAuthorization(successTaken, {
    sub: humanSub,
    auth_time: Math.floor(Date.now() / 1000),
  });
  await saveSession(successTaken);
  assert.equal(successTaken.status, "approved");
  assert.equal((await getWorldAuthorization(success.authorization.id))?.status, "approved");

  // 5. Swapping the paid-intel receipt changes the canonical payload hash and
  // is refused without consuming the valid original grant.
  await assert.rejects(
    consumeWorldAuthorization({
      authorizationId: success.authorization.id,
      principalId,
      action: "execute_trade",
      payload: {
        ...corePayload,
        receipt_id: "00000000-0000-4000-8000-000000000099",
      },
    }),
    (error: unknown) =>
      error instanceof AuthorizationDenied && error.code === "modified_payload",
  );
  assert.equal((await getWorldAuthorization(success.authorization.id))?.status, "approved");

  // $2 -> $20 is the same denial: every approved input remains exact.
  await assert.rejects(
    consumeWorldAuthorization({
      authorizationId: success.authorization.id,
      principalId,
      action: "execute_trade",
      payload: { ...corePayload, maximum_spend_atomic: "20000000" },
    }),
    (error: unknown) =>
      error instanceof AuthorizationDenied && error.code === "modified_payload",
  );
  assert.equal((await getWorldAuthorization(success.authorization.id))?.status, "approved");

  await consumeWorldAuthorization({
    authorizationId: success.authorization.id,
    principalId,
    action: "execute_trade",
    payload: corePayload,
  });
  assert.equal((await getWorldAuthorization(success.authorization.id))?.status, "consumed");

  // 6. Replay of the successful one-use authorization fails.
  await assert.rejects(
    consumeWorldAuthorization({
      authorizationId: success.authorization.id,
      principalId,
      action: "execute_trade",
      payload: corePayload,
    }),
    (error: unknown) =>
      error instanceof AuthorizationDenied && error.code === "authorization_replayed",
  );

  const attempts = await db.select().from(schema.authorizationAttempts);
  assert(attempts.some((attempt) => attempt.status === "mismatch"));
  assert(attempts.some((attempt) => attempt.status === "expired"));
  assert(attempts.some((attempt) => attempt.status === "cancelled"));
  assert(attempts.some((attempt) => attempt.reason === "modified_payload"));
  assert(attempts.some((attempt) => attempt.reason === "replay"));
});

test("IDKit principal prevents a second root while delegated wallets share one independence group", async () => {
  const [dbModule, principalModule, mandateModule, independenceModule] = await Promise.all([
    import("../db"),
    import("./principals"),
    import("./mandates"),
    import("./independence"),
  ]);
  const { getDb, schema } = dbModule;
  const { PrincipalConflict, registerPrincipal } = principalModule;
  const {
    checkFilingMandate,
    checkTradeMandate,
    MandateDenied,
    recordMandateUsage,
    upsertMandate,
  } = mandateModule;
  const { classifyReporterIndependence } = independenceModule;
  const db = await getDb();
  const owner = "0x7100000000000000000000000000000000002001";
  const delegatedWallet = "0x7100000000000000000000000000000000002002";
  for (const [id, wallet] of [["principal-owner", owner], ["delegated-reporter", delegatedWallet]]) {
    await db.insert(schema.agents).values({
      id,
      accountId: `eip155:8453:${wallet.toLowerCase()}`,
      chainId: "eip155:8453",
      address: wallet,
      name: id,
      registeredAt: new Date().toISOString(),
    }).run();
  }
  const { principalId } = await registerPrincipal(owner, "shared-human-nullifier");
  await assert.rejects(
    registerPrincipal(delegatedWallet, "shared-human-nullifier"),
    (error: unknown) => error instanceof PrincipalConflict && error.status === 409,
  );
  const delegatedMandate = await upsertMandate(principalId, {
    agentWallet: delegatedWallet,
    label: "Filing Agent",
    roles: ["file", "trade_preview", "trade_execute"],
    allowedBeats: ["defi"],
    dailyFilings: 5,
    dailyStakeAtomic: "50000",
    maxTradeAtomic: "2000000",
    freshPassAboveAtomic: "500000",
  });
  const result = await classifyReporterIndependence([owner, delegatedWallet]);
  assert.equal(result.reporter_count, 2);
  assert.equal(result.independent_reporter_groups, 1);
  assert.equal(result.verified_human_groups, 1);
  assert(result.reporters.every((reporter) => reporter.group_id === principalId));

  const unbound = await classifyReporterIndependence([
    "0x7100000000000000000000000000000000002991",
    "0x7100000000000000000000000000000000002992",
  ]);
  assert.equal(unbound.independent_reporter_groups, 1);
  assert.equal(unbound.verified_human_groups, 0);
  assert(unbound.reporters.every((reporter) => reporter.group_id === "unbound_unknown_origin"));

  const lowTrade = await checkTradeMandate(delegatedMandate.credential, BigInt(400_000));
  const highTrade = await checkTradeMandate(delegatedMandate.credential, BigInt(600_000));
  assert.equal(lowTrade.requiresFreshAgentPass, false);
  assert.equal(highTrade.requiresFreshAgentPass, true);

  const ownerBinding = (await principalModule.principalForAgentWallet(owner))!;
  for (let i = 0; i < 5; i++) {
    await recordMandateUsage({
      principalId,
      delegatedAgentId: ownerBinding.delegatedAgent.id,
      kind: "filing",
      amountAtomic: BigInt(10_000),
      refId: `filing-${i}`,
    });
  }
  await assert.rejects(
    checkFilingMandate(delegatedWallet, "defi", BigInt(10_000)),
    (error: unknown) =>
      error instanceof MandateDenied && error.code === "principal_daily_quota",
  );

  await recordMandateUsage({
    principalId,
    delegatedAgentId: ownerBinding.delegatedAgent.id,
    kind: "trade",
    amountAtomic: BigInt(4_800_000),
    refId: "shared-budget-fixture",
  });
  await assert.rejects(
    checkTradeMandate(delegatedMandate.credential, BigInt(300_000)),
    (error: unknown) =>
      error instanceof MandateDenied && error.code === "principal_trade_budget",
  );
});
