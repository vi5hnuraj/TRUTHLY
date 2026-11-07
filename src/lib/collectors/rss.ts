import { fetchPublic } from "../herald/extract-text";
import { dedupeCandidates, makeCandidate } from "../dedupe";
import { classifyCandidate } from "./classify";
import type { CollectorRun, ScoutCandidate } from "./types";

const MAX_FEED_BYTES = 1_000_000;
const MAX_ITEMS_PER_FEED = 10;
const TIMEOUT_MS = 10_000;

function decodeXml(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/i, "$1")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
      if (!code.startsWith("#")) return named[code.toLowerCase()] ?? entity;
      const point = code[1]?.toLowerCase() === "x"
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : " ";
    });
}

function plain(value: string): string {
  return decodeXml(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1"))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function element(block: string, names: string[]): string {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(
      `<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}\\s*>`,
      "i",
    ).exec(block);
    if (match) return match[1];
  }
  return "";
}

function entryLink(block: string): string {
  const atomLinks = [...block.matchAll(/<link\b([^>]*)\/?\s*>/gi)];
  for (const match of atomLinks) {
    const attrs = match[1] ?? "";
    if (/\brel\s*=\s*["'](?!alternate)[^"']+["']/i.test(attrs)) continue;
    const href = /\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(attrs);
    if (href) return decodeXml(href[1] ?? href[2] ?? "");
  }
  return plain(element(block, ["link", "guid", "id"]));
}

function isoDate(raw: string): string | null {
  const value = plain(raw);
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Parses RSS 2.0 and Atom without executing or trusting feed markup. */
export function parseFeed(
  xml: string,
  feedUrl: string,
  limit = MAX_ITEMS_PER_FEED,
): ScoutCandidate[] {
  const rssItems = xml.match(/<item\b[\s\S]*?<\/item\s*>/gi) ?? [];
  const atomEntries = xml.match(/<entry\b[\s\S]*?<\/entry\s*>/gi) ?? [];
  const blocks = [...rssItems, ...atomEntries].slice(0, limit);
  const candidates = blocks.map((block) => {
    const headline = plain(element(block, ["title"]));
    const link = entryLink(block);
    let canonicalUrl: string;
    try {
      canonicalUrl = new URL(link, feedUrl).toString();
    } catch {
      return null;
    }
    const summary = plain(
      element(block, ["content:encoded", "content", "description", "summary"]),
    );
    const text = `${headline} ${summary}`;
    const { beat, tags } = classifyCandidate(text, ["rss"]);
    return makeCandidate({
      sourceKind: "rss",
      canonicalUrl,
      headline,
      summary: summary || `New item discovered in ${feedUrl}`,
      sources: [canonicalUrl],
      tags,
      beat,
      publishedAt: isoDate(
        element(block, ["pubDate", "published", "updated", "dc:date"]),
      ),
    });
  });
  return dedupeCandidates(candidates);
}

async function readCapped(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (bytes < MAX_FEED_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    bytes += value.byteLength;
  }
  if (bytes >= MAX_FEED_BYTES) await reader.cancel();
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_FEED_BYTES));
}

async function collectFeed(url: string): Promise<ScoutCandidate[]> {
  const response = await fetchPublic(url, AbortSignal.timeout(TIMEOUT_MS));
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  const type = response.headers.get("content-type") ?? "";
  if (type && !/(xml|rss|atom|text)/i.test(type)) {
    await response.body?.cancel();
    throw new Error(`unsupported content type ${type.split(";")[0]}`);
  }
  return parseFeed(await readCapped(response), response.url || url);
}

export async function collectRssFeeds(urls: string[]): Promise<CollectorRun> {
  const candidates: ScoutCandidate[] = [];
  const errors: string[] = [];
  const settled = await Promise.allSettled(urls.slice(0, 10).map(collectFeed));
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") candidates.push(...result.value);
    else {
      const detail = result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push(`RSS ${urls[index]}: ${detail.slice(0, 160)}`);
    }
  });
  return { candidates: dedupeCandidates(candidates), errors };
}
