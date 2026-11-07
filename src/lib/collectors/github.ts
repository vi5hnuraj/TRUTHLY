import { dedupeCandidates, makeCandidate } from "../dedupe";
import { classifyCandidate } from "./classify";
import type { CollectorRun, ScoutCandidate } from "./types";

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const TIMEOUT_MS = 10_000;

interface GitHubRelease {
  html_url: string;
  tag_name: string;
  name?: string | null;
  body?: string | null;
  published_at?: string | null;
  draft?: boolean;
  prerelease?: boolean;
}

function releases(value: unknown): GitHubRelease[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is GitHubRelease => {
    if (!item || typeof item !== "object") return false;
    const row = item as Record<string, unknown>;
    return typeof row.html_url === "string" && typeof row.tag_name === "string";
  });
}

function githubHeaders(): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "TRUTHLY-Scout/1.0",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(process.env.GITHUB_TOKEN
      ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
      : {}),
  };
}

async function collectRepo(
  repo: string,
  baseFetch: typeof fetch,
): Promise<ScoutCandidate[]> {
  if (!REPO.test(repo)) throw new Error("expected owner/repository");
  const response = await baseFetch(
    `https://api.github.com/repos/${repo}/releases?per_page=5`,
    { headers: githubHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS) },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  const payload: unknown = await response.json();
  const candidates = releases(payload)
    .filter((release) => !release.draft)
    .map((release) => {
      const label = (release.name || release.tag_name).trim();
      const headline = `${repo} released ${label}`;
      const summary = (release.body || `${repo} published release ${release.tag_name}`)
        .replace(/[`#>*_~]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const { beat, tags } = classifyCandidate(`${headline} ${summary}`, [
        "github",
        "release",
        ...(release.prerelease ? ["prerelease"] : []),
      ]);
      return makeCandidate({
        sourceKind: "github",
        canonicalUrl: release.html_url,
        headline,
        summary,
        sources: [release.html_url],
        tags,
        beat,
        publishedAt: release.published_at || null,
      });
    });
  return dedupeCandidates(candidates);
}

export async function collectGitHubReleases(
  repos: string[],
  baseFetch: typeof fetch = fetch,
): Promise<CollectorRun> {
  const candidates: ScoutCandidate[] = [];
  const errors: string[] = [];
  const selected = repos.slice(0, 20);
  const settled = await Promise.allSettled(
    selected.map((repo) => collectRepo(repo, baseFetch)),
  );
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") candidates.push(...result.value);
    else {
      const detail = result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push(`GitHub ${selected[index]}: ${detail.slice(0, 160)}`);
    }
  });
  return { candidates: dedupeCandidates(candidates), errors };
}
