/**
 * IDKit configuration — keys and defaults copied from the protocol (MIT),
 * `backend/src/config.ts` → `config.idkit`. the protocol's winning setup used the
 * exact same keys (IDKIT_APP_ID, IDKIT_RP_ID, IDKIT_SIGNING_KEY,
 * IDKIT_ACTION, IDKIT_ENVIRONMENT, IDKIT_VERIFY_URL, IDKIT_STAGING_TOKEN).
 *
 * IDKIT_ENVIRONMENT selects which World App answers the request:
 *   staging    → the World ID Simulator, no phone and no orb (default, and the
 *                documented way to test on localhost — docs.world.org/world-id/idkit/integrate)
 *   sandbox    → the sandbox World ID app builds (TestFlight / private Play track)
 *   production → the real World App, orb-level proofs
 * All three verify at the same endpoint (developer.world.org/api/v4/verify/{rp_id});
 * `checkResult` rejects a proof whose `environment` is not this one.
 *
 * IDKIT_SIGNING_KEY comes from the Developer Portal — the portal generates and
 * owns that key pair and hands the private key over exactly once at create or
 * rotate time. It is server-only: never a NEXT_PUBLIC_ var.
 */

const optional = (key: string, fallback = "") => process.env[key] || fallback;

export const idkitConfig = {
  appId: optional("IDKIT_APP_ID"),
  // Nullifier-holding identifier, minted by the portal when you enable World ID
  // 4.0 on the app (rp_…). The v4 verify path accepts app_… too, but rp_… is
  // what the widget and signRequest expect — save the rp_ value, not the app_ one.
  rpId: optional("IDKIT_RP_ID"),
  signingKey: optional("IDKIT_SIGNING_KEY"),
  // Default action name mirrors the protocol's ("reference-buy-policy" → our trust moment).
  action: optional("IDKIT_ACTION", "truthly-human-principal"),
  environment: optional("IDKIT_ENVIRONMENT", "staging") as "staging" | "production" | "sandbox",
  // Developer Portal verification endpoint (the protocol's default, v4).
  verifyBaseUrl: optional("IDKIT_VERIFY_URL", "https://developer.world.org/api/v4/verify"),
  /**
   * Staging (simulator) proofs are only accepted inside a 24h staging window opened by the app's
   * team; the token it issues must be sent as `x-staging-verification-token`. Not needed in production.
   */
  stagingToken: optional("IDKIT_STAGING_TOKEN"),
  /**
   * Opt-in second path: the World ID Simulator (staging.world.org) next to the
   * phone app. IDKIT_ALLOW_SIMULATOR=1 exposes both on /bind — the phone QR
   * (sandbox) and the in-browser simulator (staging). Both are World's own
   * environments and both verify at the same Developer Portal endpoint; the
   * staging one additionally needs IDKIT_STAGING_TOKEN. Default OFF so a
   * production deployment only ever accepts the configured environment.
   */
  allowSimulator: process.env.IDKIT_ALLOW_SIMULATOR === "1",
} as const;
