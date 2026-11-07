import assert from "node:assert/strict";
import test from "node:test";
import { collectGitHubReleases } from "./github";

test("collectGitHubReleases turns releases into candidates", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify([
        {
          html_url: "https://github.com/example/protocol/releases/tag/v2.0.0",
          tag_name: "v2.0.0",
          name: "Protocol v2.0.0",
          body: "Governance and liquidity improvements.",
          published_at: "2026-11-01T09:00:00Z",
          draft: false,
          prerelease: false,
        },
        {
          html_url: "https://github.com/example/protocol/releases/tag/draft",
          tag_name: "draft",
          draft: true,
        },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  const result = await collectGitHubReleases(["example/protocol"], fakeFetch);
  assert.deepEqual(result.errors, []);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].sourceKind, "github");
  assert.equal(result.candidates[0].beat, "defi");
});

test("collectGitHubReleases reports invalid repositories without throwing", async () => {
  const result = await collectGitHubReleases(["not a repo"], fetch);
  assert.equal(result.candidates.length, 0);
  assert.match(result.errors[0], /expected owner\/repository/);
});
