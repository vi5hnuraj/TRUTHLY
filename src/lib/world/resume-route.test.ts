import assert from "node:assert/strict";
import { after, test } from "node:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";

const dbFile = path.join(process.cwd(), `.truthly-resume-route-test-${process.pid}.db`);
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
delete process.env.TURSO_AUTH_TOKEN;
process.env.NEXT_PUBLIC_BASE_URL = "http://localhost:3000";
process.env.WORLDID_CLIENT_ID = "test-client-id";
process.env.WORLDID_CLIENT_SECRET = "test-client-secret";

after(async () => {
  await rm(dbFile, { force: true });
  await rm(`${dbFile}-shm`, { force: true });
  await rm(`${dbFile}-wal`, { force: true });
});

const OWNER_A = "0x7300000000000000000000000000000000004001";
const OWNER_B = "0x7300000000000000000000000000000000004002";

test("resume route is fresh, exact, one-use, same-principal and fail-closed", async () => {
  const [dbModule, principalModule, authModule, sessionModule, freshnessModule, routeModule] =
    await Promise.all([
      import("../db"),
      import("./principals"),
      import("./authorizations"),
      import("./sessions"),
      import("./freshness"),
      import("../../app/api/principal/resume/route"),
    ]);
  const { getDb, schema } = dbModule;
  const {
    bindPrincipalSubject,
    pausePrincipal,
    registerPrincipal,
  } = principalModule;
  const {
    AuthorizationDenied,
    completeWorldAuthorization,
    consumeWorldAuthorization,
    getWorldAuthorization,
  } = authModule;
  const { createSession, takeSessionByState } = sessionModule;
  const { hashSub } = freshnessModule;
  const { POST } = routeModule;
  const db = await getDb();
  const now = new Date().toISOString();

  for (const [id, wallet] of [
    ["resume-owner-a", OWNER_A],
    ["resume-owner-b", OWNER_B],
  ] as const) {
    await db
      .insert(schema.agents)
      .values({
        id,
        accountId: `eip155:8453:${wallet.toLowerCase()}`,
        chainId: "eip155:8453",
        address: wallet,
        name: id,
        registeredAt: now,
      })
      .run();
  }

  const principalA = (await registerPrincipal(OWNER_A, "resume-nullifier-a")).principalId;
  const principalB = (await registerPrincipal(OWNER_B, "resume-nullifier-b")).principalId;
  const subjectA = "resume-world-subject-a";
  const subjectB = "resume-world-subject-b";
  await bindPrincipalSubject(principalA, hashSub(subjectA));
  await bindPrincipalSubject(principalB, hashSub(subjectB));
  const pausedA = await pausePrincipal(principalA, "owner A incident");
  const pausedB = await pausePrincipal(principalB, "owner B incident");

  let requestNumber = 0;
  const post = async (body: Record<string, unknown>) => {
    requestNumber += 1;
    return POST(
      new NextRequest("http://localhost:3000/api/principal/resume", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": `192.0.2.${requestNumber}`,
        },
        body: JSON.stringify(body),
      }),
    );
  };

  const challenge = async (owner: string, reason: string) => {
    const response = await post({ owner_wallet: owner, reason });
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(response.status, 409);
    assert.equal(body.action_required, "world_agent_pass");
    assert.equal(typeof body.authorization_id, "string");
    return body.authorization_id as string;
  };

  const approve = async (authorizationId: string, principalId: string, subject: string) => {
    const authorization = (await getWorldAuthorization(authorizationId))!;
    const session = await createSession({
      purpose: "resume_principal",
      principalId,
      authorizationId,
      action: "resume_principal",
      payloadHash: authorization.payloadHash,
      returnTo: "/pause",
      verifier: "test-pkce-verifier-with-sufficient-length-resume-000000",
    });
    const taken = (await takeSessionByState(session.state))!;
    await completeWorldAuthorization(taken, {
      sub: subject,
      auth_time: Math.floor(Date.now() / 1000),
    });
    assert.equal(taken.status, "approved");
  };

  const reasonA = "reviewed and contained owner A incident";
  const reasonB = "reviewed and contained owner B incident";
  const authA = await challenge(OWNER_A, reasonA);
  const authB = await challenge(OWNER_B, reasonB);
  await approve(authA, principalA, subjectA);
  await approve(authB, principalB, subjectB);

  // A fresh grant from B cannot resume A, even if B controls a valid principal.
  const crossPrincipal = await post({
    owner_wallet: OWNER_A,
    reason: reasonA,
    authorization_id: authB,
  });
  assert.equal(crossPrincipal.status, 403);
  assert.equal((await crossPrincipal.json()).error, "authorization_scope_mismatch");

  // Any post-approval modification is denied without consuming A's valid grant.
  const modified = await post({
    owner_wallet: OWNER_A,
    reason: "a materially different resume reason",
    authorization_id: authA,
  });
  assert.equal(modified.status, 409);
  assert.equal((await modified.json()).error, "modified_payload");

  const resumed = await post({
    owner_wallet: OWNER_A,
    reason: reasonA,
    authorization_id: authA,
  });
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).resume_mode, "world_agent_pass");

  const replayedRoute = await post({
    owner_wallet: OWNER_A,
    reason: reasonA,
    authorization_id: authA,
  });
  assert.equal(replayedRoute.status, 409);
  assert.equal((await replayedRoute.json()).error, "authorization_replayed");

  const exactPayloadA = {
    owner_wallet: OWNER_A.toLowerCase(),
    reason: reasonA,
    paused_at: pausedA.pausedAt,
    pause_reason: "owner A incident",
    pause_version: pausedA.pauseVersion,
  };
  await assert.rejects(
    consumeWorldAuthorization({
      authorizationId: authA,
      principalId: principalA,
      action: "resume_principal",
      payload: exactPayloadA,
    }),
    (error: unknown) =>
      error instanceof AuthorizationDenied && error.code === "authorization_replayed",
  );

  // An approved grant that expires before use cannot restore authority.
  const expiring = await challenge(OWNER_B, "second fresh authorization for expiry test");
  await approve(expiring, principalB, subjectB);
  await db
    .update(schema.worldAuthorizations)
    .set({ status: "expired", reason: "authorization expired" })
    .where(eq(schema.worldAuthorizations.id, expiring))
    .run();
  const expired = await post({
    owner_wallet: OWNER_B,
    reason: "second fresh authorization for expiry test",
    authorization_id: expiring,
  });
  assert.equal(expired.status, 409);
  assert.equal((await expired.json()).error, "authorization_expired");

  // Removing credentials never unlocks the owner-signature fallback.
  const savedClientId = process.env.WORLDID_CLIENT_ID;
  const savedClientSecret = process.env.WORLDID_CLIENT_SECRET;
  delete process.env.WORLDID_CLIENT_ID;
  delete process.env.WORLDID_CLIENT_SECRET;
  const unavailable = await post({
    owner_wallet: OWNER_B,
    reason: "attempted fallback must stay blocked",
  });
  process.env.WORLDID_CLIENT_ID = savedClientId;
  process.env.WORLDID_CLIENT_SECRET = savedClientSecret;
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error, "world_agent_pass_unavailable");

  assert.equal(pausedB.pauseVersion, 1);
});
