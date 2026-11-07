/**
 * LOCAL WORLD SIMULATOR — development only.
 *
 * You have no World App account yet, so the real QR flow can never complete.
 * This module lets every OTHER part of the pipeline be exercised honestly:
 * /api/world/start still mints a session, the browser still walks a chooser
 * page standing in for World's QR screen, and /api/world/callback still runs
 * the SAME server logic (freshness, same-human binding, approve/deny/expire)
 * over claims it builds itself instead of reading them out of a verified
 * id_token. Nothing below the token layer changes — that is the point.
 *
 * HARD LIMITS (please read):
 *   1. `mockEnabled()` is false whenever NODE_ENV === "production", so a
 *      deployed build can never simulate a verification.
 *   2. It only turns on with WORLD_DEV_MOCK=1 in .env.local.
 *   3. Every screen it touches is labelled MOCK. A judge-facing demo video
 *      must show the real auth.world.org flow — this exists so you can test
 *      the other 90% of the project today, not to substitute for the scan.
 */

export type MockPersona = {
  id: string;
  label: string;
  /** The World `sub` this persona presents — matched against the byline's stored hash. */
  sub: string;
  /** Seconds between this authentication and now. > 0 = not fresh for this attempt. */
  authAgeSec: number;
  note: string;
};

/** The four outcomes the court must be able to show: approved, denied, expired, cancelled. */
export const MOCK_PERSONAS: MockPersona[] = [
  {
    id: "viper",
    label: "Viper — the human bound to this byline",
    sub: "world-sub-of-viper-demo",
    authAgeSec: 0,
    note: "Fresh check by the human bound at byline birth → appeal approved, stake re-locked.",
  },
  {
    id: "maya",
    label: "Maya — the human bound to this byline",
    sub: "world-sub-of-maya-demo",
    authAgeSec: 0,
    note: "Fresh check by the human bound at byline birth → appeal approved, stake re-locked.",
  },
  {
    id: "stranger",
    label: "A stranger — real human, wrong byline",
    sub: "world-sub-of-stranger-mock",
    authAgeSec: 0,
    note: "Genuine freshness, but hash(sub) matches no byline → appeal denied (mismatch).",
  },
  {
    id: "stale",
    label: "Viper — but the proof is 12 minutes old",
    sub: "world-sub-of-viper-demo",
    authAgeSec: 700,
    note: "Correct human, stale auth_time → attempt expired. A reused session buys nothing.",
  },
];

export function mockEnabled(): boolean {
  return (
    process.env.WORLD_DEV_MOCK === "1" && process.env.NODE_ENV !== "production"
  );
}

export function mockPersona(id: string | null | undefined): MockPersona | null {
  if (!id) return null;
  return MOCK_PERSONAS.find((p) => p.id === id) ?? null;
}

/** Claims built locally — the only thing this module fabricates. */
export function mockClaims(persona: MockPersona): {
  sub: string;
  auth_time: number;
} {
  return {
    sub: persona.sub,
    auth_time: Math.floor(Date.now() / 1000) - persona.authAgeSec,
  };
}
