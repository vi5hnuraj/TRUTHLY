import * as z from "zod";

export const VERDICTS = [
  "supported",
  "partially_supported",
  "contradicted",
  "unsupported",
  "unchecked",
] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * The split: "contradicted" means the sources directly state the opposite of
 * the story (a falsehood); "unsupported" means the sources fail to establish
 * the claim (an over-claim) without directly denying it. Both refute the story
 * — it is rejected and its filing stake is slashed — but the record says which
 * kind of failure Herald actually found.
 */
export const REFUTING_VERDICTS = ["contradicted", "unsupported"] as const;

/** Whether a verdict rejects the story and costs the filing stake. */
export function refutesStory(verdict: string): boolean {
  return (REFUTING_VERDICTS as readonly string[]).includes(verdict);
}

export interface ClaimCheck {
  claim_index: number;
  verdict: "supported" | "partially_supported" | "contradicted" | "unsupported";
  citations: string[];
  note: string;
}

export interface SourceEvidence {
  url: string;
  title: string | null;
  published_at: string | null;
  content_hash: string;
  fetched_at: string;
}

/** Herald's fact-check of one signal, stored as JSON in signals.verification. */
export interface Verification {
  verdict: Verdict;
  confidence: number;
  notes: string;
  world_query: string | null;
  tokens: string[];
  model: string | null;
  checked_at: string;
  cost_atomic: string | null;
  payment_tx: string | null;
  claim_checks: ClaimCheck[];
  source_evidence: SourceEvidence[];
}

/** What paying readers see: the verdict and Herald's reasoning, not costs or act-on hints. */
export type PublicVerification = Pick<
  Verification,
  "verdict" | "confidence" | "notes" | "model" | "checked_at" | "claim_checks" | "source_evidence"
>;

export interface PaidCall {
  model: string | null;
  cost_atomic: string | null;
  payment_tx: string | null;
}

const NO_CALL: PaidCall = { model: null, cost_atomic: null, payment_tx: null };

/** A verification that carries no judgement, only why Herald could not check the story. */
export function uncheckedVerification(reason: string, paid: PaidCall = NO_CALL): Verification {
  return {
    verdict: "unchecked",
    confidence: 0,
    notes: reason.slice(0, 280),
    world_query: null,
    tokens: [],
    ...paid,
    checked_at: new Date().toISOString(),
    claim_checks: [],
    source_evidence: [],
  };
}

const storedSchema = z.object({
  verdict: z.enum(VERDICTS),
  confidence: z.number(),
  notes: z.string(),
  model: z.string().nullable(),
  checked_at: z.string(),
  claim_checks: z
    .array(
      z.object({
        claim_index: z.number(),
        verdict: z.enum(["supported", "partially_supported", "contradicted", "unsupported"]),
        citations: z.array(z.string()),
        note: z.string(),
      }),
    )
    .default([]),
  source_evidence: z
    .array(
      z.object({
        url: z.string(),
        title: z.string().nullable(),
        published_at: z.string().nullable(),
        content_hash: z.string(),
        fetched_at: z.string(),
      }),
    )
    .default([]),
});

/** Parses signals.verification; anything missing or malformed reads as "no verification". */
export function readVerification(raw: string | null | undefined): PublicVerification | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    console.error("Stored Herald verification is not valid JSON:", error instanceof Error ? error.message : error);
    return null;
  }
  const parsed = storedSchema.safeParse(value);
  if (!parsed.success) {
    console.error("Stored Herald verification has an unexpected shape; ignoring it.");
    return null;
  }
  return parsed.data;
}
