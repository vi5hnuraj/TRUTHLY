import { createHash } from "node:crypto";
import { fetchableUrl } from "./herald/extract-text";
import type {
  ScoutCandidate,
  ScoutCandidateInput,
} from "./collectors/types";

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "source",
]);

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const cleanText = (value: string) => value.replace(/\s+/g, " ").trim();

/** Normalizes a public URL so tracking variants do not become separate stories. */
export function canonicalizeUrl(raw: string, base?: string): string | null {
  const parsed = fetchableUrl(raw, base);
  if (!parsed) return null;
  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMS.has(key.toLowerCase())) {
      parsed.searchParams.delete(key);
    }
  }
  parsed.searchParams.sort();
  if (parsed.pathname !== "/") parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString();
}

export function makeCandidate(
  input: ScoutCandidateInput,
): ScoutCandidate | null {
  const canonicalUrl = canonicalizeUrl(input.canonicalUrl);
  if (!canonicalUrl) return null;
  const headline = cleanText(input.headline).slice(0, 280);
  const summary = cleanText(input.summary).slice(0, 2_000);
  if (headline.length < 5) return null;

  const sources = [canonicalUrl, ...input.sources]
    .map((source) => canonicalizeUrl(source, canonicalUrl))
    .filter((source): source is string => source !== null);
  const uniqueSources = [...new Set(sources)].slice(0, 5);
  const normalizedContent = `${headline}\n${summary}`.toLowerCase();

  return {
    ...input,
    id: digest(canonicalUrl),
    contentHash: digest(normalizedContent),
    canonicalUrl,
    headline,
    summary,
    sources: uniqueSources,
    tags: [...new Set(input.tags.map((tag) => cleanText(tag)).filter(Boolean))].slice(0, 10),
  };
}

/** Deduplicates both URL aliases and copied content from different feeds. */
export function dedupeCandidates(
  candidates: Array<ScoutCandidate | null>,
): ScoutCandidate[] {
  const urls = new Set<string>();
  const hashes = new Set<string>();
  const unique: ScoutCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (urls.has(candidate.canonicalUrl) || hashes.has(candidate.contentHash)) continue;
    urls.add(candidate.canonicalUrl);
    hashes.add(candidate.contentHash);
    unique.push(candidate);
  }
  return unique;
}
