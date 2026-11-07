import * as z from "zod";

const NOTES_MAX = 280;
const MAX_CANDIDATES = 10;

/** Scans from `start` (a "{") to its matching "}", ignoring braces inside JSON strings. */
function balancedBlock(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** Returns the first {...} block in `text` that parses as a JSON object, or null. */
export function extractFirstJsonObject(
  text: string,
): Record<string, unknown> | null {
  let start = text.indexOf("{");
  for (let tries = 0; start !== -1 && tries < MAX_CANDIDATES; tries++) {
    const block = balancedBlock(text, start);
    if (block) {
      try {
        const value: unknown = JSON.parse(block);
        if (value && typeof value === "object" && !Array.isArray(value))
          return value as Record<string, unknown>;
      } catch {
        // Not JSON (e.g. prose in braces): fall through and try the next "{".
      }
    }
    start = text.indexOf("{", start + 1);
  }
  return null;
}

const verdictSchema = z.object({
  verdict: z
    .string()
    .transform((value) =>
      value
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, "_"),
    )
    .pipe(z.enum(["supported", "partially_supported", "contradicted", "unsupported"])),
  confidence: z.coerce.number().min(0).max(100),
  notes: z.string(),
  world_query: z.string().nullish(),
  tokens: z.array(z.string()).nullish(),
  claim_checks: z
    .array(
      z.object({
        claim_index: z.coerce.number().int().min(1).max(10),
        verdict: z.enum(["supported", "partially_supported", "contradicted", "unsupported"]),
        citations: z.array(z.coerce.number().int().min(1).max(4)).max(4),
        note: z.string(),
      }),
    )
    .max(10)
    .nullish(),
});

export interface ModelClaimCheck {
  claim_index: number;
  verdict: "supported" | "partially_supported" | "contradicted" | "unsupported";
  citations: number[];
  note: string;
}

export interface ModelVerdict {
  verdict: "supported" | "partially_supported" | "contradicted" | "unsupported";
  confidence: number;
  notes: string;
  world_query: string | null;
  tokens: string[];
  claim_checks: ModelClaimCheck[];
}

/** Collapses whitespace, drops control characters and angle brackets, caps length. */
export function plainText(value: string, max: number): string {
  const text = value
    .replace(/[\p{Cc}<>]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function cleanWorldQuery(value: string | null | undefined): string | null {
  const query = plainText(value ?? "", 80);
  return query.length >= 2 && query.toLowerCase() !== "null" ? query : null;
}

function cleanTokens(values: string[] | null | undefined): string[] {
  const tokens = (values ?? [])
    .map((value) => value.trim().replace(/^\$/, ""))
    .filter((value) => /^[A-Za-z0-9._-]{1,64}$/.test(value));
  return [...new Set(tokens)].slice(0, 3);
}

/** Parses Herald's reply into a verdict; null when the reply holds no valid verdict JSON. */
export function parseModelVerdict(text: string): ModelVerdict | null {
  const json = extractFirstJsonObject(text);
  if (!json) return null;
  const parsed = verdictSchema.safeParse(json);
  if (!parsed.success) return null;
  const { verdict, confidence, notes, world_query, tokens, claim_checks } = parsed.data;
  return {
    verdict,
    confidence:
      Math.round((confidence > 1 ? confidence / 100 : confidence) * 100) / 100,
    notes: plainText(notes, NOTES_MAX),
    world_query: cleanWorldQuery(world_query),
    tokens: cleanTokens(tokens),
    claim_checks: (claim_checks ?? []).map((check) => ({
      claim_index: check.claim_index,
      verdict: check.verdict,
      citations: [...new Set(check.citations)],
      note: plainText(check.note, 180),
    })),
  };
}
