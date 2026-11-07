import { REPUTABLE_DOMAINS } from "./constants";
import { isActOnTag } from "./act-on";
import {
  independentOwnerGroups,
  isLikelyPrimarySource,
  type SourceMetadata,
} from "./evidence";

interface SignalForScoring {
  headline: string;
  body: string;
  sources: string[];
  sourceMetadata?: SourceMetadata[];
  tags: string[];
  beat: string;
  agentStreak: number;
  agentSignalsIncluded: number;
}

interface BeatCounts {
  [beat: string]: number;
}

export function scoreSignal(
  signal: SignalForScoring,
  beatCounts: BeatCounts
): { score: number; breakdown: Record<string, number> } {
  const breakdown: Record<string, number> = {};
  let score = 0;

  // Independently owned source groups (max 20). Sister domains never inflate this.
  const owners = independentOwnerGroups(signal.sources, signal.sourceMetadata ?? []);
  if (owners.length >= 3) {
    breakdown.sourceCount = 20;
  } else if (owners.length === 2) {
    breakdown.sourceCount = 15;
  } else {
    breakdown.sourceCount = 10;
  }
  score += breakdown.sourceCount;

  // Source reputation (max 10)
  const reputableSources = signal.sources.filter((url) => {
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, "");
      return REPUTABLE_DOMAINS.some(
        (d) => hostname === d || hostname.endsWith("." + d)
      );
    } catch {
      return false;
    }
  });
  breakdown.sourceQuality = Math.min(10, reputableSources.length * 5);
  score += breakdown.sourceQuality;

  // Primary evidence bonus (max 5), classified conservatively from URL + metadata.
  const primarySources = (signal.sourceMetadata ?? []).filter(isLikelyPrimarySource);
  breakdown.primarySources = Math.min(5, primarySources.length * 3);
  score += breakdown.primarySources;

  // Headline conciseness (max 10)
  breakdown.headline =
    signal.headline.length <= 140 ? 10 : signal.headline.length <= 200 ? 5 : 0;
  score += breakdown.headline;

  // Body depth (max 10)
  const wordCount = signal.body.split(/\s+/).length;
  breakdown.bodyDepth = wordCount >= 50 ? 10 : wordCount >= 25 ? 5 : 2;
  score += breakdown.bodyDepth;

  // Tag relevance (max 10)
  const tagCount = signal.tags.filter((tag) => !isActOnTag(tag)).length;
  breakdown.tags = tagCount >= 3 && tagCount <= 7 ? 10 : 5;
  score += breakdown.tags;

  // Agent streak bonus (max 10)
  breakdown.streak = Math.min(10, signal.agentStreak * 3);
  score += breakdown.streak;

  // Agent track record (max 5)
  breakdown.trackRecord = Math.min(5, signal.agentSignalsIncluded);
  score += breakdown.trackRecord;

  // Beat diversity bonus (max 10)
  const avgCount =
    Object.values(beatCounts).reduce((a, b) => a + b, 0) /
    Math.max(Object.keys(beatCounts).length, 1);
  const thisBeatCount = beatCounts[signal.beat] || 0;
  // A quiet wire (one or two pending stories) shouldn't make any beat look crowded.
  breakdown.diversity = thisBeatCount <= Math.max(1, avgCount) ? 10 : 0;
  score += breakdown.diversity;

  return { score: Math.min(100, score), breakdown };
}
