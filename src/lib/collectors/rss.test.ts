import assert from "node:assert/strict";
import test from "node:test";
import { parseFeed } from "./rss";

test("parseFeed reads RSS and normalizes article URLs", () => {
  const candidates = parseFeed(
    `<?xml version="1.0"?>
     <rss><channel><item>
       <title>Protocol X approves fee-sharing proposal</title>
       <link>https://news.example/proposal/?utm_source=feed#details</link>
       <description><![CDATA[Governance voters approved the protocol fee change.]]></description>
       <pubDate>Sun, 01 Nov 2026 12:00:00 GMT</pubDate>
     </item></channel></rss>`,
    "https://news.example/feed.xml",
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].canonicalUrl, "https://news.example/proposal");
  assert.equal(candidates[0].beat, "defi");
  assert.equal(candidates[0].publishedAt, "2026-11-01T12:00:00.000Z");
});

test("parseFeed reads Atom alternate links and entities", () => {
  const candidates = parseFeed(
    `<feed><entry>
      <title>Wallet &amp; payment agent release</title>
      <link rel="self" href="https://feeds.example/items/1" />
      <link rel="alternate" href="/posts/payment-agent" />
      <summary>New x402 wallet support.</summary>
      <updated>2026-11-01T10:30:00Z</updated>
    </entry></feed>`,
    "https://feeds.example/atom.xml",
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].canonicalUrl, "https://feeds.example/posts/payment-agent");
  assert.equal(candidates[0].headline, "Wallet & payment agent release");
  assert.equal(candidates[0].beat, "agentic-payments");
});
