import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeUrl, dedupeCandidates, makeCandidate } from "./dedupe";

const base = {
  sourceKind: "rss" as const,
  headline: "Protocol publishes a material governance update",
  summary: "The proposal changes fees after an on-chain vote.",
  sources: ["https://example.com/story"],
  tags: ["governance"],
  beat: "defi" as const,
  publishedAt: "2026-11-01T00:00:00.000Z",
};

test("canonicalizeUrl removes fragments and tracking parameters", () => {
  assert.equal(
    canonicalizeUrl("https://example.com/story/?utm_source=rss&b=2&a=1#top"),
    "https://example.com/story?a=1&b=2",
  );
});

test("dedupeCandidates rejects URL aliases and copied content", () => {
  const first = makeCandidate({ ...base, canonicalUrl: "https://example.com/story" });
  const alias = makeCandidate({
    ...base,
    canonicalUrl: "https://example.com/story?utm_medium=feed",
  });
  const copied = makeCandidate({ ...base, canonicalUrl: "https://mirror.example/news" });
  assert.equal(dedupeCandidates([first, alias, copied]).length, 1);
});

test("canonicalizeUrl rejects private and non-http targets", () => {
  assert.equal(canonicalizeUrl("http://127.0.0.1/admin"), null);
  assert.equal(canonicalizeUrl("file:///etc/passwd"), null);
});
