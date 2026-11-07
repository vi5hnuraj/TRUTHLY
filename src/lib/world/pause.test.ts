import assert from "node:assert/strict";
import { after, test } from "node:test";
import { rm } from "node:fs/promises";
import path from "node:path";

const dbFile = path.join(process.cwd(), `.truthly-pause-test-${process.pid}.db`);
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
delete process.env.TURSO_AUTH_TOKEN;
process.env.NEXT_PUBLIC_BASE_URL = "http://localhost:3000";

after(async () => {
  await rm(dbFile, { force: true });
  await rm(`${dbFile}-shm`, { force: true });
  await rm(`${dbFile}-wal`, { force: true });
});

const OWNER = "0x7200000000000000000000000000000000003001";
const AGENT_A = "0x7200000000000000000000000000000000003002";
const AGENT_B = "0x7200000000000000000000000000000000003003";
const AGENT_C = "0x7200000000000000000000000000000000003004";

test("a paused principal blocks every delegated agent until a gated resume", async () => {
  const [
    dbModule,
    principalModule,
    mandateModule,
    authModule,
    sessionModule,
    freshnessModule,
    actionsModule,
    paymentGuardModule,
  ] =
    await Promise.all([
      import("../db"),
      import("./principals"),
      import("./mandates"),
      import("./authorizations"),
      import("./sessions"),
      import("./freshness"),
      import("./actions"),
      import("./payment-guard"),
    ]);
  const { getDb, schema } = dbModule;
  const {
    bindPrincipalSubject,
    openTradesForPrincipal,
    pausePrincipal,
    registerPrincipal,
    resumePrincipal,
  } = principalModule;
  const { checkFilingMandate, checkTradeMandate, MandateDenied, upsertMandate } = mandateModule;
  const {
    AuthorizationDenied,
    completeWorldAuthorization,
    consumeWorldAuthorization,
    createWorldAuthorization,
  } = authModule;
  const { createSession, takeSessionByState } = sessionModule;
  const { hashSub } = freshnessModule;
  const { rejectPausedPaymentPayer } = paymentGuardModule;

  const db = await getDb();
  const now = new Date().toISOString();
  await db
    .insert(schema.agents)
    .values({
      id: "pause-owner",
      accountId: `eip155:8453:${OWNER.toLowerCase()}`,
      chainId: "eip155:8453",
      address: OWNER,
      name: "Pause Owner",
      registeredAt: now,
    })
    .run();

  const { principalId } = await registerPrincipal(OWNER, "pause-test-nullifier");
  const humanSub = "pause-test-human";
  await bindPrincipalSubject(principalId, hashSub(humanSub));

  const mandateA = await upsertMandate(principalId, {
    agentWallet: AGENT_A,
    label: "Trading Agent A",
    roles: ["file", "trade_preview", "trade_execute"],
    allowedBeats: ["defi"],
    dailyFilings: 5,
    dailyStakeAtomic: "50000",
    maxTradeAtomic: "2000000",
    freshPassAboveAtomic: "500000",
  });
  const mandateB = await upsertMandate(principalId, {
    agentWallet: AGENT_B,
    label: "Trading Agent B",
    roles: ["file", "trade_preview", "trade_execute"],
    allowedBeats: ["defi"],
    dailyFilings: 5,
    dailyStakeAtomic: "50000",
    maxTradeAtomic: "2000000",
    freshPassAboveAtomic: "500000",
  });

  // Before the pause both agents hold live authority.
  const before = await checkTradeMandate(mandateA.credential, BigInt(400_000));
  assert.equal(before.requiresFreshAgentPass, false);
  assert.equal(
    (await checkTradeMandate(mandateB.credential, BigInt(400_000))).principal.id,
    principalId,
  );

  // An already-approved consequential grant still cannot cross a later pause.
  const heldPayload = { request_id: "approved-before-pause" };
  const held = await createWorldAuthorization({
    principalId,
    action: "execute_trade",
    payload: heldPayload,
  });
  const heldSession = await createSession({
    purpose: "authorize_trade",
    principalId,
    authorizationId: held.id,
    action: "execute_trade",
    payloadHash: held.payloadHash,
    returnTo: "/trades",
    verifier: "test-pkce-verifier-with-sufficient-length-held-000000",
  });
  const heldTaken = (await takeSessionByState(heldSession.state))!;
  await completeWorldAuthorization(heldTaken, {
    sub: humanSub,
    auth_time: Math.floor(Date.now() / 1000),
  });
  assert.equal(heldTaken.status, "approved");

  // Concurrent pause calls are idempotent: exactly one generation/reason wins.
  const [mandateRace, ...pauseSettled] = await Promise.allSettled([
    upsertMandate(principalId, {
      agentWallet: AGENT_C,
      label: "Concurrent Agent C",
      roles: ["file", "trade_preview", "trade_execute"],
      allowedBeats: ["defi"],
      dailyFilings: 5,
      dailyStakeAtomic: "50000",
      maxTradeAtomic: "2000000",
      freshPassAboveAtomic: "500000",
    }),
    ...Array.from({ length: 8 }, (_, index) =>
      pausePrincipal(principalId, `suspicious agent activity ${index}`),
    ),
  ]);
  assert(
    pauseSettled.every((result) => result.status === "fulfilled"),
    pauseSettled
      .filter((result) => result.status === "rejected")
      .map((result) =>
        [
          String(result.reason),
          String((result.reason as { cause?: unknown })?.cause ?? ""),
        ].join("\nCAUSE: "),
      )
      .join("\n"),
  );
  const pauseResults = pauseSettled.map(
    (result) => (result as PromiseFulfilledResult<Awaited<ReturnType<typeof pausePrincipal>>>).value,
  );
  assert.equal(pauseResults.filter((result) => !result.alreadyPaused).length, 1);
  const paused = pauseResults.find((result) => !result.alreadyPaused)!;
  assert.equal(paused.alreadyPaused, false);
  assert(pauseResults.every((result) => result.pauseVersion === paused.pauseVersion));

  if (mandateRace.status === "fulfilled") {
    await assert.rejects(
      checkTradeMandate(mandateRace.value.credential, BigInt(400_000)),
      (error: unknown) =>
        error instanceof MandateDenied && error.code === "principal_paused",
    );
  } else {
    assert(
      mandateRace.reason instanceof MandateDenied &&
        mandateRace.reason.code === "principal_paused",
    );
  }

  await assert.rejects(
    consumeWorldAuthorization({
      authorizationId: held.id,
      principalId,
      action: "execute_trade",
      payload: heldPayload,
    }),
    (error: unknown) =>
      error instanceof AuthorizationDenied && error.code === "principal_paused",
  );

  // Nothing an agent holds — token, mandate, autonomous threshold — bypasses it.
  for (const credential of [mandateA.credential, mandateB.credential]) {
    await assert.rejects(
      checkTradeMandate(credential, BigInt(400_000)),
      (error: unknown) =>
        error instanceof MandateDenied &&
        error.code === "principal_paused" &&
        error.status === 423,
    );
  }
  await assert.rejects(
    checkFilingMandate(AGENT_A, "defi", BigInt(10_000)),
    (error: unknown) =>
      error instanceof MandateDenied && error.code === "principal_paused",
  );
  const paidAction = await rejectPausedPaymentPayer(AGENT_A);
  assert.equal(paidAction?.status, 423);
  assert.equal((await paidAction?.json()).error, "principal_paused");
  assert.equal(
    await rejectPausedPaymentPayer("0x7200000000000000000000000000000000003999"),
    null,
  );

  // New consequential authorizations cannot even be minted while paused.
  for (const action of ["execute_trade", "change_mandate", "change_payout"] as const) {
    await assert.rejects(
      createWorldAuthorization({ principalId, action, payload: { any: "value" } }),
      (error: unknown) =>
        error instanceof AuthorizationDenied && error.code === "principal_paused",
    );
  }

  // Authority-widening writes are refused; revocation stays available.
  await assert.rejects(
    upsertMandate(principalId, {
      agentWallet: AGENT_A,
      label: "Widened",
      roles: ["file", "trade_preview", "trade_execute"],
      allowedBeats: ["defi"],
      dailyFilings: 50,
      dailyStakeAtomic: "500000",
      maxTradeAtomic: "9000000",
      freshPassAboveAtomic: "500000",
    }),
    (error: unknown) => error instanceof MandateDenied && error.code === "principal_paused",
  );
  assert(
    await createWorldAuthorization({
      principalId,
      action: "revoke_agent",
      payload: { agent_wallet: AGENT_B },
    }),
  );

  // A trade already accepted by the provider is reported, never silently recalled.
  await db
    .insert(schema.trades)
    .values({
      id: "pause-open-trade",
      chain: "base",
      side: "buy",
      qty: "2.00",
      targetAsset: "0x4200000000000000000000000000000000000006",
      contraAsset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      funder: "burner",
      status: "submitted",
      orderId: "open-order-1",
      principalId,
      createdAt: now,
    })
    .run();
  const open = await openTradesForPrincipal(principalId);
  assert.equal(open.length, 1);
  assert.equal(open[0].status, "submitted");

  // Resume is itself an exact, fresh, one-use human authorization.
  const payload = {
    owner_wallet: OWNER.toLowerCase(),
    reason: "cleared the agent",
    pause_version: paused.pauseVersion,
  };
  const resumeAuth = await createWorldAuthorization({
    principalId,
    action: "resume_principal",
    payload,
    returnTo: "/mandates",
  });
  const session = await createSession({
    purpose: "resume_principal",
    principalId,
    authorizationId: resumeAuth.id,
    action: "resume_principal",
    payloadHash: resumeAuth.payloadHash,
    returnTo: "/mandates",
    verifier: "test-pkce-verifier-with-sufficient-length-000000000000",
  });
  const taken = (await takeSessionByState(session.state))!;
  await completeWorldAuthorization(taken, {
    sub: humanSub,
    auth_time: Math.floor(Date.now() / 1000),
  });
  assert.equal(taken.status, "approved");

  // Changing the resume reason after approval is refused.
  await assert.rejects(
    consumeWorldAuthorization({
      authorizationId: resumeAuth.id,
      principalId,
      action: "resume_principal",
      payload: { ...payload, reason: "different reason" },
    }),
    (error: unknown) =>
      error instanceof AuthorizationDenied && error.code === "modified_payload",
  );

  await consumeWorldAuthorization({
    authorizationId: resumeAuth.id,
    principalId,
    action: "resume_principal",
    payload,
  });
  await assert.rejects(
    consumeWorldAuthorization({
      authorizationId: resumeAuth.id,
      principalId,
      action: "resume_principal",
      payload,
    }),
    (error: unknown) =>
      error instanceof AuthorizationDenied && error.code === "authorization_replayed",
  );
  await resumePrincipal(principalId, paused.pauseVersion);

  // Authority is restored, and the same token works again.
  assert.equal(
    (await checkTradeMandate(mandateA.credential, BigInt(400_000))).principal.id,
    principalId,
  );
  assert.deepEqual(actionsModule.PAUSE_EXEMPT_ACTIONS.has("revoke_agent"), true);
  assert.deepEqual(actionsModule.PAUSE_EXEMPT_ACTIONS.has("execute_trade"), false);

  // A grant for generation N can never clear a newer generation N+1.
  const newerPause = await pausePrincipal(principalId, "new incident after prior resume");
  assert(newerPause.pauseVersion > paused.pauseVersion);
  assert.deepEqual(await resumePrincipal(principalId, paused.pauseVersion), {
    resumed: false,
    reason: "pause_changed",
  });
  await assert.rejects(
    checkTradeMandate(mandateA.credential, BigInt(400_000)),
    (error: unknown) =>
      error instanceof MandateDenied && error.code === "principal_paused",
  );

  await assert.rejects(
    createWorldAuthorization({
      principalId,
      action: "resume_principal",
      payload: { expires_at: 123, reason: "collision" },
    }),
    (error: unknown) =>
      error instanceof AuthorizationDenied && error.code === "reserved_payload_field",
  );
});

test("the approval page summary is derived from the hashed payload", async () => {
  const [summaryModule, actionsModule] = await Promise.all([
    import("./summary"),
    import("./actions"),
  ]);
  const { describeAuthorization } = summaryModule;
  const { hashAuthorizationPayload } = actionsModule;

  const payload = {
    token_symbol: "ETH",
    token_address: "0x4200000000000000000000000000000000000006",
    side: "buy",
    maximum_spend_atomic: "2000000",
    order_type: "limit",
    limit_cross_price: "3500",
    take_profit_notional_price: "4000",
    stop_loss_notional_price: "3000",
    delegated_agent: "0x7200000000000000000000000000000000003002",
    signal_id: "00000000-0000-4000-8000-000000000001",
    expire_time: "2026-11-07T12:00:00.000Z",
  } as const;

  const stored = hashAuthorizationPayload("execute_trade", payload);
  const summary = describeAuthorization("execute_trade", payload, stored);
  assert.equal(summary.integrity.valid, true);
  assert.equal(summary.title, "Execute trade");
  assert.match(summary.headline, /BUY ETH/);
  assert.match(summary.headline, /\$2/);

  const byLabel = new Map(summary.fields.map((field) => [field.label, field.value]));
  assert.equal(byLabel.get("Maximum spend"), "$2 USDC");
  assert.equal(byLabel.get("Asset symbol"), "ETH");
  assert.equal(byLabel.get("Asset contract"), payload.token_address);
  assert.equal(byLabel.get("Network"), "Base (8453)");
  assert.equal(byLabel.get("Delegated agent"), AGENT_A.toLowerCase());
  assert.equal(byLabel.get("Limit price"), "$3500");
  assert.equal(byLabel.get("Take profit"), "$4000");
  assert.equal(byLabel.get("Stop loss"), "$3000");

  // A $2 → $20 change alters both the rendered summary and the digest.
  const changed = describeAuthorization(
    "execute_trade",
    { ...payload, maximum_spend_atomic: "20000000" },
    stored,
  );
  assert.equal(changed.integrity.valid, false);
  assert.equal(new Map(changed.fields.map((f) => [f.label, f.value])).get("Maximum spend"), "$20 USDC");

  const changedAsset = describeAuthorization(
    "execute_trade",
    { ...payload, token_address: "0x1111111111111111111111111111111111111111" },
    stored,
  );
  assert.equal(changedAsset.integrity.valid, false);
  assert.equal(
    new Map(changedAsset.fields.map((field) => [field.label, field.value])).get(
      "Asset contract",
    ),
    "0x1111111111111111111111111111111111111111",
  );

  const changedAction = describeAuthorization("change_payout", payload, stored);
  assert.equal(changedAction.integrity.valid, false);
  assert.equal(changedAction.title, "Change payout destination");

  const payoutPayload = {
    byline_wallet: OWNER.toLowerCase(),
    current_payout_wallet: OWNER.toLowerCase(),
    new_payout_wallet: AGENT_B.toLowerCase(),
    reason: "Move revenue to the approved treasury",
  } as const;
  const payoutHash = hashAuthorizationPayload("change_payout", payoutPayload);
  const payoutSummary = describeAuthorization("change_payout", payoutPayload, payoutHash);
  const payoutFields = new Map(
    payoutSummary.fields.map((field) => [field.label, field.value]),
  );
  assert.equal(payoutSummary.integrity.valid, true);
  assert.equal(payoutFields.get("New payout wallet"), AGENT_B.toLowerCase());
  assert.match(payoutSummary.headline, new RegExp(AGENT_B.toLowerCase()));

  const changedDestination = describeAuthorization(
    "change_payout",
    { ...payoutPayload, new_payout_wallet: AGENT_A.toLowerCase() },
    payoutHash,
  );
  assert.equal(changedDestination.integrity.valid, false);
  assert.equal(
    new Map(changedDestination.fields.map((field) => [field.label, field.value])).get(
      "New payout wallet",
    ),
    AGENT_A.toLowerCase(),
  );
});
