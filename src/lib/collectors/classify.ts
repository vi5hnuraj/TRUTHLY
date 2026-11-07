import { type Beat } from "../constants";

const RULES: Array<{ beat: Beat; words: RegExp }> = [
  {
    beat: "agentic-payments",
    words: /\b(agentic|agent|x402|payment|wallet|micropayment|usdc)\b/i,
  },
  {
    beat: "bitcoin",
    words: /\b(bitcoin|btc|lightning|taproot|ordinals?|mining)\b/i,
  },
  {
    beat: "regulation",
    words: /\b(sec|cftc|regulat(?:ion|or|ory)|legislation|lawsuit|court|filing|compliance)\b/i,
  },
  {
    beat: "market-signals",
    words: /\b(etf|price|market|trading|volume|liquidation|whale|inflow|outflow)\b/i,
  },
  {
    beat: "defi",
    words: /\b(defi|dao|governance|proposal|liquidity|lending|staking|yield|swap|protocol)\b/i,
  },
];

const TAG_WORDS = [
  "bitcoin",
  "ethereum",
  "defi",
  "governance",
  "security",
  "release",
  "regulation",
  "payments",
  "wallet",
  "infrastructure",
  "markets",
] as const;

/** Lightweight routing only. Herald—not Scout—decides whether a claim is supported. */
export function classifyCandidate(
  text: string,
  fixedTags: string[],
): { beat: Beat; tags: string[] } {
  const beat = RULES.find((rule) => rule.words.test(text))?.beat ?? "infrastructure";
  const lower = text.toLowerCase();
  const discovered = TAG_WORDS.filter((tag) => lower.includes(tag));
  const tags = [...new Set([...fixedTags, ...discovered, beat])]
    .map((tag) => tag.toLowerCase().replace(/[^a-z0-9-]/g, "-"))
    .filter((tag) => tag.length > 0)
    .slice(0, 7);
  return { beat, tags };
}
