import assert from "node:assert/strict";
import test from "node:test";
import { allocatePayoutByOrigin } from "./payout-allocation";

test("extra wallets from one human do not multiply that human's payout share", () => {
  const payout = allocatePayoutByOrigin(40, [
    { key: "human-a-wallet-1", groupId: "principal-a", position: 1 },
    { key: "human-a-wallet-2", groupId: "principal-a", position: 2 },
    { key: "human-b-wallet", groupId: "principal-b", position: 3 },
  ]);
  assert.equal(payout.get("human-a-wallet-1"), 10);
  assert.equal(payout.get("human-a-wallet-2"), 10);
  assert.equal(payout.get("human-b-wallet"), 20);
  assert.equal([...payout.values()].reduce((sum, value) => sum + value, 0), 40);
});

test("all unbound wallets receive one conservative unknown-origin share", () => {
  const payout = allocatePayoutByOrigin(40, [
    { key: "unbound-1", groupId: "unbound_unknown_origin", position: 1 },
    { key: "unbound-2", groupId: "unbound_unknown_origin", position: 2 },
    { key: "verified", groupId: "principal-c", position: 3 },
  ]);
  assert.equal((payout.get("unbound-1") ?? 0) + (payout.get("unbound-2") ?? 0), 20);
  assert.equal(payout.get("verified"), 20);
});
