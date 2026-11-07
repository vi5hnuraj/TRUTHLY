import assert from "node:assert/strict";
import { after, test } from "node:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import { pauseMessage, SIGNATURE_WINDOW_MS } from "./pause-message";

const dbFile = path.join(process.cwd(), `.truthly-pause-route-test-${process.pid}.db`);
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
delete process.env.TURSO_AUTH_TOKEN;

after(async () => {
  await rm(dbFile, { force: true });
  await rm(`${dbFile}-shm`, { force: true });
  await rm(`${dbFile}-wal`, { force: true });
});

test("pause route requires a fresh one-use signature from the exact owner", async () => {
  const [dbModule, principalModule, routeModule] = await Promise.all([
    import("../db"),
    import("./principals"),
    import("../../app/api/principal/pause/route"),
  ]);
  const { getDb, schema } = dbModule;
  const { principalById, registerPrincipal } = principalModule;
  const { POST } = routeModule;
  const owner = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const other = privateKeyToAccount(`0x${"22".repeat(32)}`);
  const db = await getDb();
  const now = new Date().toISOString();

  for (const [id, account] of [
    ["pause-route-owner", owner],
    ["pause-route-other", other],
  ] as const) {
    await db
      .insert(schema.agents)
      .values({
        id,
        accountId: `eip155:8453:${account.address.toLowerCase()}`,
        chainId: "eip155:8453",
        address: account.address,
        name: id,
        registeredAt: now,
      })
      .run();
  }
  const ownerPrincipal = (
    await registerPrincipal(owner.address, "pause-route-nullifier-owner")
  ).principalId;
  const otherPrincipal = (
    await registerPrincipal(other.address, "pause-route-nullifier-other")
  ).principalId;

  let requestNumber = 0;
  const post = async (body: Record<string, unknown>) => {
    requestNumber += 1;
    return POST(
      new NextRequest("http://localhost:3000/api/principal/pause", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": `198.51.100.${requestNumber}`,
        },
        body: JSON.stringify(body),
      }),
    );
  };

  const reason = "suspected delegated-agent compromise";
  const issuedAt = new Date().toISOString();
  const nonce = "pause-route-owner-nonce-0001";
  const signature = await owner.signMessage({
    message: pauseMessage({
      address: owner.address.toLowerCase(),
      reason,
      issuedAt,
      nonce,
    }),
  });
  const request = {
    owner_wallet: owner.address,
    reason,
    issued_at: issuedAt,
    nonce,
    signature,
  };

  const paused = await post(request);
  assert.equal(paused.status, 200);
  assert.equal((await paused.json()).paused, true);
  assert((await principalById(ownerPrincipal))?.pausedAt);

  const replay = await post(request);
  assert.equal(replay.status, 409);

  const alteredReason = await post({
    ...request,
    reason: "a different reason than the owner signed",
  });
  assert.equal(alteredReason.status, 401);

  const wrongOwner = await post({
    ...request,
    owner_wallet: other.address,
    nonce: "pause-route-wrong-owner-0002",
  });
  assert.equal(wrongOwner.status, 401);
  assert.equal((await principalById(otherPrincipal))?.pausedAt, null);

  const expiredIssuedAt = new Date(Date.now() - SIGNATURE_WINDOW_MS - 1_000).toISOString();
  const expiredNonce = "pause-route-expired-nonce-0003";
  const expiredSignature = await other.signMessage({
    message: pauseMessage({
      address: other.address.toLowerCase(),
      reason,
      issuedAt: expiredIssuedAt,
      nonce: expiredNonce,
    }),
  });
  const expired = await post({
    owner_wallet: other.address,
    reason,
    issued_at: expiredIssuedAt,
    nonce: expiredNonce,
    signature: expiredSignature,
  });
  assert.equal(expired.status, 401);
  assert.equal((await principalById(otherPrincipal))?.pausedAt, null);
});
