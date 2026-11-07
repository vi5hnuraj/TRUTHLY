import assert from "node:assert/strict";
import test from "node:test";
import { collectSnapshotProposals } from "./snapshot";

test("collectSnapshotProposals turns governance proposals into candidates", async () => {
  const fakeFetch: typeof fetch = async (_url, init) => {
    const sent = JSON.parse(String(init?.body)) as { variables: { spaces: string[] } };
    assert.deepEqual(sent.variables.spaces, ["ens.eth"]);
    return new Response(
      JSON.stringify({
        data: {
          proposals: [
            {
              id: "0xproposal",
              title: "[EP 7.2] Fund the security council",
              body: "Approve **funding** for protocol security work.",
              state: "active",
              created: 1793520000,
              space: { id: "ens.eth", name: "ENS" },
            },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const result = await collectSnapshotProposals(["ENS.ETH"], fakeFetch);
  assert.deepEqual(result.errors, []);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].sourceKind, "snapshot");
  assert.equal(result.candidates[0].beat, "defi");
  assert.match(result.candidates[0].canonicalUrl, /snapshot\.org/);
});

test("collectSnapshotProposals rejects an empty invalid space list", async () => {
  const result = await collectSnapshotProposals(["not a space!"], fetch);
  assert.equal(result.candidates.length, 0);
  assert.match(result.errors[0], /no valid spaces/);
});
