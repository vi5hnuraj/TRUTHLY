import { dedupeCandidates, makeCandidate } from "../dedupe";
import { classifyCandidate } from "./classify";
import type { CollectorRun } from "./types";

const SNAPSHOT_GRAPHQL = "https://hub.snapshot.org/graphql";
const SPACE = /^[a-z0-9][a-z0-9.-]{1,99}$/i;
const TIMEOUT_MS = 10_000;

const PROPOSALS_QUERY = `
  query TruthlyProposals($spaces: [String!]) {
    proposals(
      first: 20
      where: { space_in: $spaces }
      orderBy: "created"
      orderDirection: desc
    ) {
      id
      title
      body
      state
      created
      start
      end
      author
      space { id name }
    }
  }
`;

interface SnapshotProposal {
  id: string;
  title: string;
  body?: string | null;
  state?: string | null;
  created?: number | null;
  start?: number | null;
  end?: number | null;
  author?: string | null;
  space: { id: string; name?: string | null };
}

function proposals(value: unknown): SnapshotProposal[] {
  if (!value || typeof value !== "object") return [];
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== "object") return [];
  const rows = (data as { proposals?: unknown }).proposals;
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is SnapshotProposal => {
    if (!row || typeof row !== "object") return false;
    const proposal = row as Record<string, unknown>;
    const space = proposal.space;
    return (
      typeof proposal.id === "string" &&
      typeof proposal.title === "string" &&
      !!space &&
      typeof space === "object" &&
      typeof (space as Record<string, unknown>).id === "string"
    );
  });
}

function cleanMarkdown(value: string): string {
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`#>*_~|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function collectSnapshotProposals(
  spaces: string[],
  baseFetch: typeof fetch = fetch,
): Promise<CollectorRun> {
  const selected = [...new Set(spaces.map((space) => space.trim().toLowerCase()))]
    .filter((space) => SPACE.test(space))
    .slice(0, 20);
  if (selected.length === 0) {
    return { candidates: [], errors: ["Snapshot: no valid spaces configured"] };
  }

  try {
    const response = await baseFetch(SNAPSHOT_GRAPHQL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "TRUTHLY-Scout/1.0",
        ...(process.env.SNAPSHOT_API_KEY
          ? { "x-api-key": process.env.SNAPSHOT_API_KEY }
          : {}),
      },
      body: JSON.stringify({ query: PROPOSALS_QUERY, variables: { spaces: selected } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { candidates: [], errors: [`Snapshot: HTTP ${response.status}`] };
    }
    const payload: unknown = await response.json();
    if (
      payload &&
      typeof payload === "object" &&
      Array.isArray((payload as { errors?: unknown }).errors)
    ) {
      return { candidates: [], errors: ["Snapshot: GraphQL returned errors"] };
    }

    const candidates = proposals(payload).map((proposal) => {
      const spaceName = proposal.space.name || proposal.space.id;
      const headline = `${spaceName}: ${cleanMarkdown(proposal.title)}`;
      const summary = cleanMarkdown(proposal.body || "").slice(0, 2_000) ||
        `Snapshot governance proposal in ${spaceName}.`;
      const canonicalUrl = `https://snapshot.org/#/s:${encodeURIComponent(proposal.space.id)}/proposal/${encodeURIComponent(proposal.id)}`;
      const { beat, tags } = classifyCandidate(`${headline} ${summary}`, [
        "snapshot",
        "governance",
        proposal.state || "proposal",
      ]);
      return makeCandidate({
        sourceKind: "snapshot",
        canonicalUrl,
        headline,
        summary,
        sources: [canonicalUrl],
        tags,
        beat,
        publishedAt: proposal.created
          ? new Date(proposal.created * 1_000).toISOString()
          : null,
      });
    });
    return { candidates: dedupeCandidates(candidates), errors: [] };
  } catch (error) {
    return {
      candidates: [],
      errors: [
        `Snapshot: ${error instanceof Error ? error.message.slice(0, 160) : "request failed"}`,
      ],
    };
  }
}
