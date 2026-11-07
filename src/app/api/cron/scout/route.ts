import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { collectGitHubReleases } from "@/lib/collectors/github";
import { collectRssFeeds } from "@/lib/collectors/rss";
import { collectSnapshotProposals } from "@/lib/collectors/snapshot";
import { dedupeCandidates } from "@/lib/dedupe";
import { getDb, schema } from "@/lib/db";

export const maxDuration = 120;

const DEFAULT_RSS = ["https://blog.ethereum.org/feed.xml"];
const DEFAULT_REPOS = ["ethereum/go-ethereum", "bitcoin/bitcoin"];
const DEFAULT_SNAPSHOT_SPACES = ["ens.eth", "uniswapgovernance.eth", "aave.eth"];
const digest = (value: string) => createHash("sha256").update(value).digest();

function configuredList(raw: string | undefined, fallback: string[]): string[] {
  if (!raw?.trim()) return fallback;
  return [...new Set(raw.split(/[\n,]/).map((value) => value.trim()).filter(Boolean))];
}

/** Collects discoveries into a queue. It deliberately never files or pays for a story. */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get("authorization") ?? "";
  if (!secret || !timingSafeEqual(digest(given), digest(`Bearer ${secret}`))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rssFeeds = configuredList(process.env.SCOUT_RSS_FEEDS, DEFAULT_RSS);
  const githubRepos = configuredList(process.env.SCOUT_GITHUB_REPOS, DEFAULT_REPOS);
  const snapshotSpaces = configuredList(
    process.env.SCOUT_SNAPSHOT_SPACES,
    DEFAULT_SNAPSHOT_SPACES,
  );
  const [rss, github, snapshot] = await Promise.all([
    collectRssFeeds(rssFeeds),
    collectGitHubReleases(githubRepos),
    collectSnapshotProposals(snapshotSpaces),
  ]);
  const candidates = dedupeCandidates([
    ...rss.candidates,
    ...github.candidates,
    ...snapshot.candidates,
  ]);
  const db = await getDb();
  const now = new Date().toISOString();
  let inserted = 0;

  for (const candidate of candidates) {
    const rows = await db
      .insert(schema.scoutCandidates)
      .values({
        id: candidate.id,
        canonicalUrl: candidate.canonicalUrl,
        contentHash: candidate.contentHash,
        sourceKind: candidate.sourceKind,
        headline: candidate.headline,
        summary: candidate.summary,
        sources: JSON.stringify(candidate.sources),
        tags: JSON.stringify(candidate.tags),
        beat: candidate.beat,
        publishedAt: candidate.publishedAt,
        discoveredAt: now,
        status: "candidate",
      })
      .onConflictDoNothing()
      .returning({ id: schema.scoutCandidates.id });
    inserted += rows.length;
  }

  return NextResponse.json({
    collected: candidates.length,
    inserted,
    duplicates: candidates.length - inserted,
    configured: {
      rss_feeds: rssFeeds.length,
      github_repos: githubRepos.length,
      snapshot_spaces: snapshotSpaces.length,
    },
    errors: [...rss.errors, ...github.errors, ...snapshot.errors],
    candidates: candidates.slice(0, 20).map((candidate) => ({
      id: candidate.id,
      headline: candidate.headline,
      beat: candidate.beat,
      source_kind: candidate.sourceKind,
      canonical_url: candidate.canonicalUrl,
    })),
    next_step:
      "These are unpaid discoveries. A research agent must gather independent sources and explicitly file through x402.",
  });
}
