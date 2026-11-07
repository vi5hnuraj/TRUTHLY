import assert from "node:assert/strict";
import test from "node:test";
import { signalFilingSchema } from "./signal-filing";

const valid = {
  headline: "Protocol X approves its new fee-sharing proposal",
  body: "Protocol X governance approved proposal 42 after the final vote reached quorum and the official results were published.",
  beat: "defi" as const,
  sources: [
    "https://github.com/example/protocol/releases/tag/v2",
    "https://www.reuters.com/technology/protocol-x-v2-2026-11-01/",
  ],
  source_metadata: [
    {
      url: "https://github.com/example/protocol/releases/tag/v2",
      title: "Protocol X version two",
      publisher: "Protocol X maintainers",
      published_at: "2026-11-01T10:00:00Z",
      source_type: "primary" as const,
    },
    {
      url: "https://www.reuters.com/technology/protocol-x-v2-2026-11-01/",
      title: "Protocol X governance approves version two",
      publisher: "Reuters",
      published_at: "2026-11-01T11:00:00Z",
      source_type: "secondary" as const,
    },
  ],
  claims: [
    {
      claim: "Protocol X governance approved proposal 42.",
      citations: [
        "https://github.com/example/protocol/releases/tag/v2",
        "https://www.reuters.com/technology/protocol-x-v2-2026-11-01/",
      ],
    },
  ],
  tags: ["governance", "fees", "defi"],
};

test("filing schema accepts structured, independent, fully cited evidence", () => {
  const result = signalFilingSchema.safeParse(valid);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.source_metadata[0].published_at, "2026-11-01T10:00:00.000Z");
  }
});

test("filing schema rejects source padding from one owner", () => {
  const result = signalFilingSchema.safeParse({
    ...valid,
    sources: ["https://news.example/a", "https://sub.news.example/b"],
    source_metadata: [
      { ...valid.source_metadata[0], url: "https://news.example/a", publisher: "Example News" },
      { ...valid.source_metadata[1], url: "https://sub.news.example/b", publisher: "Example News" },
    ],
    claims: [
      {
        claim: "Example News published the same assertion twice.",
        citations: ["https://news.example/a", "https://sub.news.example/b"],
      },
    ],
  });
  assert.equal(result.success, false);
  if (!result.success) {
    assert(result.error.issues.some((issue) => /independently owned/.test(issue.message)));
  }
});
