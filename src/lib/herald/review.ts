import { encodeActOn, isActOnTag } from "../act-on";
import { factCheck } from "./fact-check";
import {
  uncheckedVerification,
  VERDICTS,
  type Verdict,
  type Verification,
} from "./verification";
import type { StoryClaim } from "../evidence";

const CONCURRENCY = 4;
// Each check can cost up to HERALD_MAX_ATOMIC, and filing costs reporters only
// $0.01, so cap paid checks per review run and the run's wall-clock time.
const MAX_CHECKS_PER_RUN = 40;
const RUN_BUDGET_MS = 90_000;

const BONUS: Record<Verdict, number> = {
  supported: 10,
  partially_supported: 3,
  contradicted: 0,
  unsupported: 0,
  unchecked: 0,
};

interface Checkable {
  headline: string;
  body: string;
  live: string[];
  claims: StoryClaim[];
  /** A verification stored by an earlier run (held stories are never paid for twice). */
  stored?: string | null;
}

function priorVerdict(raw: string | null | undefined): Verification | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Verification;
    const known = (VERDICTS as readonly string[]).includes(value?.verdict);
    return known && value.verdict !== "unchecked" ? value : null;
  } catch {
    return null;
  }
}

/** Fact-checks every signal against its live sources, at most 4 in flight. Never throws. */
export async function factCheckAll<T extends Checkable>(
  signals: T[],
): Promise<Array<T & { verification: Verification }>> {
  const results: Verification[] = new Array(signals.length);
  const deadline = Date.now() + RUN_BUDGET_MS;
  let next = 0;

  const worker = async () => {
    while (next < signals.length) {
      const i = next++;
      const { headline, body, live, claims, stored } = signals[i];
      const prior = priorVerdict(stored);
      results[i] = prior
        ? prior
        : i >= MAX_CHECKS_PER_RUN || Date.now() > deadline
          ? uncheckedVerification(
              "Not fact-checked: Herald's per-run check budget was used up.",
            )
          : await factCheck({ headline, body, sources: live, claims });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, signals.length) }, worker),
  );
  return signals.map((signal, i) => ({ ...signal, verification: results[i] }));
}

/** Score after Herald's verdict bonus: supported +10, partially supported +3, capped at 100. */
export function withHeraldBonus(score: number, verdict: Verdict): number {
  return Math.min(100, score + BONUS[verdict]);
}

/** Adds Herald's world/token hints only when the reporter supplied none of their own. */
export function withHeraldActOn(
  tags: string[],
  verification: Verification,
): string[] {
  if (tags.some(isActOnTag)) return tags;
  return encodeActOn(
    tags,
    verification.world_query ?? undefined,
    verification.tokens,
  );
}
