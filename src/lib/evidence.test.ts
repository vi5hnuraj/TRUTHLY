import assert from "node:assert/strict";
import test from "node:test";
import {
  evidenceIssues,
  independentOwnerGroups,
  isLikelyPrimarySource,
  type SourceMetadata,
} from "./evidence";

const sources = [
  "https://github.com/example/protocol/releases/tag/v2",
  "https://www.reuters.com/technology/protocol-v2-2026-11-01/",
];
const metadata: SourceMetadata[] = [
  {
    url: sources[0],
    title: "Protocol v2 release",
    publisher: "Protocol maintainers",
    published_at: "2026-11-01T10:00:00.000Z",
    source_type: "primary",
  },
  {
    url: sources[1],
    title: "Protocol releases version two",
    publisher: "Reuters",
    published_at: "2026-11-01T11:00:00.000Z",
    source_type: "secondary",
  },
];

test("evidence requires independent owners and claim-level citations", () => {
  assert.equal(independentOwnerGroups(sources, metadata).length, 2);
  assert.deepEqual(
    evidenceIssues(sources, metadata, [
      { claim: "Protocol maintainers published version two.", citations: [sources[0], sources[1]] },
    ]),
    [],
  );
});

test("evidence rejects duplicate ownership and uncited padding", () => {
  const duplicateSources = ["https://news.example/a", "https://sub.news.example/b"];
  const duplicateMetadata: SourceMetadata[] = duplicateSources.map((url, index) => ({
    url,
    title: `Article ${index}`,
    publisher: "Example News",
    published_at: null,
    source_type: "secondary",
  }));
  const issues = evidenceIssues(duplicateSources, duplicateMetadata, [
    { claim: "A sufficiently long factual claim.", citations: [duplicateSources[0]] },
  ]);
  assert(issues.some((issue) => /independently owned/.test(issue.message)));
  assert(issues.some((issue) => /Every source must support/.test(issue.message)));
});

test("primary-source bonus uses conservative URL classification", () => {
  assert.equal(isLikelyPrimarySource(metadata[0]), true);
  assert.equal(isLikelyPrimarySource({ ...metadata[1], source_type: "primary" }), false);
});
