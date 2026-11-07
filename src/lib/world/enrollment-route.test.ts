import assert from "node:assert/strict";
import { after, test } from "node:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import { worldEnrollmentMessage } from "./enrollment-message";

const dbFile = path.join(process.cwd(), `.truthly-world-enroll-test-${process.pid}.db`);
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.WORLD_DEV_MOCK = "1";
delete process.env.TURSO_AUTH_TOKEN;

after(async () => {
  await rm(dbFile, { force: true });
  await rm(`${dbFile}-shm`, { force: true });
  await rm(`${dbFile}-wal`, { force: true });
});

test("World enrollment start requires a fresh one-use owner signature", async () => {
  const [dbModule, principalModule, routeModule] = await Promise.all([
    import("../db"),
    import("./principals"),
    import("../../app/api/world/start/route"),
  ]);
  const { getDb, schema } = dbModule;
  const { registerPrincipal } = principalModule;
  const { GET, POST } = routeModule;
  const owner = privateKeyToAccount(`0x${"31".repeat(32)}`);
  const attacker = privateKeyToAccount(`0x${"32".repeat(32)}`);
  const db = await getDb();
  await db.insert(schema.agents).values({
    id: "world-enroll-owner",
    accountId: `eip155:8453:${owner.address.toLowerCase()}`,
    chainId: "eip155:8453",
    address: owner.address,
    name: "World enrollment owner",
    registeredAt: new Date().toISOString(),
  }).run();
  await registerPrincipal(owner.address, "world-enroll-nullifier");

  const unsignedGet = await GET(
    new NextRequest(
      `http://localhost:3000/api/world/start?purpose=enroll&address=${owner.address}`,
    ),
  );
  assert.equal(unsignedGet.status, 405);

  const issuedAt = new Date().toISOString();
  const nonce = "world-enroll-owner-nonce-0001";
  const message = worldEnrollmentMessage({
    address: owner.address,
    issuedAt,
    nonce,
  });
  const signature = await owner.signMessage({ message });
  const request = {
    purpose: "enroll",
    address: owner.address,
    return_to: `/bind?address=${owner.address}`,
    issued_at: issuedAt,
    nonce,
    signature,
  };
  const post = (body: unknown, ip: string) =>
    POST(
      new NextRequest("http://localhost:3000/api/world/start", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify(body),
      }),
    );

  const accepted = await post(request, "198.51.100.41");
  assert.equal(accepted.status, 200);
  assert.match((await accepted.json()).authorization_url, /\/worldid\/mock\?state=/);

  const replay = await post(request, "198.51.100.42");
  assert.equal(replay.status, 409);

  const attackerNonce = "world-enroll-attacker-nonce-0002";
  const attackerSignature = await attacker.signMessage({
    message: worldEnrollmentMessage({
      address: owner.address,
      issuedAt,
      nonce: attackerNonce,
    }),
  });
  const wrongWallet = await post(
    { ...request, nonce: attackerNonce, signature: attackerSignature },
    "198.51.100.43",
  );
  assert.equal(wrongWallet.status, 401);
});
