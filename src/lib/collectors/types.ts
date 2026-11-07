import type { Beat } from "../constants";

export type ScoutSourceKind = "rss" | "github" | "snapshot";

export interface ScoutCandidateInput {
  sourceKind: ScoutSourceKind;
  canonicalUrl: string;
  headline: string;
  summary: string;
  sources: string[];
  tags: string[];
  beat: Beat;
  publishedAt: string | null;
}

export interface ScoutCandidate extends ScoutCandidateInput {
  id: string;
  contentHash: string;
}

export interface CollectorRun {
  candidates: ScoutCandidate[];
  errors: string[];
}
