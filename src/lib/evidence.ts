import * as z from "zod";
import { getDomain } from "tldts";
import { canonicalizeUrl } from "./dedupe";

export const evidenceUrlSchema = z
  .url()
  .max(500)
  .refine((value) => /^https?:\/\//i.test(value), "Sources must be public http(s) URLs")
  .refine(
    (value) => canonicalizeUrl(value) !== null,
    "Sources cannot use credentials, loopback, private or internal hosts",
  );

const publishedAtSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "Must be an ISO publication timestamp")
  .transform((value) => new Date(value).toISOString())
  .nullable();

export const sourceMetadataSchema = z
  .object({
    url: evidenceUrlSchema,
    title: z.string().trim().min(2).max(300),
    publisher: z.string().trim().min(2).max(120),
    published_at: publishedAtSchema,
    source_type: z.enum(["primary", "secondary"]),
  })
  .strict();

export const storyClaimSchema = z
  .object({
    claim: z.string().trim().min(10).max(500),
    citations: z.array(evidenceUrlSchema).min(1).max(5),
  })
  .strict();

export const sourceMetadataListSchema = z.array(sourceMetadataSchema).min(2).max(5);
export const storyClaimsSchema = z.array(storyClaimSchema).min(1).max(10);

export type SourceMetadata = z.infer<typeof sourceMetadataSchema>;
export type StoryClaim = z.infer<typeof storyClaimSchema>;

function hostname(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "invalid";
  }
}

function ownershipMap(): Record<string, string> {
  const defaults: Record<string, string> = {
    "coindesk.com": "bullish-group",
    "blockworks.co": "blockworks",
    "blockworks.com": "blockworks",
  };
  const raw = process.env.SOURCE_OWNERSHIP_MAP?.trim();
  if (!raw) return defaults;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaults;
    for (const [domain, owner] of Object.entries(parsed)) {
      if (typeof owner === "string" && /^[a-z0-9.-]+$/i.test(domain)) {
        defaults[domain.toLowerCase()] = owner.toLowerCase();
      }
    }
  } catch {
    console.error("SOURCE_OWNERSHIP_MAP is invalid JSON; using built-in ownership groups.");
  }
  return defaults;
}

function baseOwner(url: string): string {
  const host = hostname(url);
  const domain = getDomain(host) ?? host;
  const mapped = ownershipMap()[domain];
  return mapped ? `owner:${mapped}` : `domain:${domain}`;
}

const publisherKey = (publisher: string) =>
  publisher.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Groups subdomains, configured sister publications, and metadata rows that
 * explicitly name the same publisher. Metadata can collapse groups, never split
 * two URLs from the same registrable domain.
 */
export function independentOwnerGroups(
  sources: string[],
  metadata: SourceMetadata[],
): string[] {
  const rows = sources.map((url) => {
    const canonical = canonicalizeUrl(url) ?? url;
    const meta = metadata.find(
      (item) => (canonicalizeUrl(item.url) ?? item.url) === canonical,
    );
    return { base: baseOwner(url), publisher: meta ? publisherKey(meta.publisher) : "" };
  });
  const publisherCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.publisher) {
      publisherCounts.set(row.publisher, (publisherCounts.get(row.publisher) ?? 0) + 1);
    }
  }
  return [...new Set(rows.map((row) =>
    row.publisher && (publisherCounts.get(row.publisher) ?? 0) > 1
      ? `publisher:${row.publisher}`
      : row.base,
  ))];
}

function configuredPrimaryDomains(): string[] {
  return (process.env.PRIMARY_SOURCE_DOMAINS ?? "")
    .split(/[\n,]/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

/** Conservative automatic primary-source classification used for scoring. */
export function isLikelyPrimarySource(source: SourceMetadata): boolean {
  const url = new URL(source.url);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.toLowerCase();
  const configured = configuredPrimaryDomains().some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
  const officialPlatform =
    host === "snapshot.org" ||
    host.endsWith(".snapshot.org") ||
    host === "sec.gov" ||
    host.endsWith(".sec.gov") ||
    host.endsWith(".gov");
  const officialArtifact =
    host === "github.com" && /\/(releases|security\/advisories|pull)\//.test(path);
  const governanceArtifact = /\/(governance|proposal|proposals|press|releases?)\b/.test(path);
  return source.source_type === "primary" &&
    (configured || officialPlatform || officialArtifact || governanceArtifact);
}

export interface EvidenceIssue {
  path: (string | number)[];
  message: string;
}

/** Cross-field checks applied before an x402 challenge is ever returned. */
export function evidenceIssues(
  sources: string[],
  metadata: SourceMetadata[],
  claims: StoryClaim[],
): EvidenceIssue[] {
  const issues: EvidenceIssue[] = [];
  const canonicalSources = sources.map((source) => canonicalizeUrl(source) ?? source);
  const sourceSet = new Set(canonicalSources);
  if (sourceSet.size !== sources.length) {
    issues.push({ path: ["sources"], message: "Sources must be unique after URL normalization" });
  }

  const metadataUrls = metadata.map((item) => canonicalizeUrl(item.url) ?? item.url);
  if (
    metadataUrls.length !== sourceSet.size ||
    metadataUrls.some((url) => !sourceSet.has(url)) ||
    sourceSet.size !== new Set(metadataUrls).size
  ) {
    issues.push({
      path: ["source_metadata"],
      message: "Provide exactly one metadata row for every source URL",
    });
  }

  const owners = independentOwnerGroups(sources, metadata);
  if (owners.length < 2) {
    issues.push({
      path: ["sources"],
      message: "At least two independently owned source groups are required",
    });
  }

  const cited = new Set<string>();
  claims.forEach((claim, claimIndex) => {
    claim.citations.forEach((citation, citationIndex) => {
      const canonical = canonicalizeUrl(citation) ?? citation;
      if (!sourceSet.has(canonical)) {
        issues.push({
          path: ["claims", claimIndex, "citations", citationIndex],
          message: "Every claim citation must appear in sources",
        });
      } else {
        cited.add(canonical);
      }
    });
  });
  canonicalSources.forEach((source, index) => {
    if (!cited.has(source)) {
      issues.push({
        path: ["sources", index],
        message: "Every source must support at least one explicit claim",
      });
    }
  });
  return issues;
}
