import { createHash, randomBytes } from "node:crypto";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

/**
 * Confidential World Agent Pass client using authorization code + PKCE S256.
 * ID tokens are verified against issuer JWKS, audience, nonce, ACR and freshness.
 */

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  acr_values_supported?: string[];
}

const config = {
  issuer: process.env.WORLDID_ISSUER || "https://sandbox.auth.world.org",
  clientId: process.env.WORLDID_CLIENT_ID || "",
  clientSecret: process.env.WORLDID_CLIENT_SECRET || "",
  authMethod: process.env.WORLDID_AUTH_METHOD || "client_secret_basic",
  // Current Orb assurance class from World discovery/step-up documentation.
  acr:
    process.env.WORLDID_ACR?.trim() ||
    "https://world.org/oidc/acr/orb",
  clockSkewSec: 60,
};

export const redirectUri = () =>
  `${(process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000").replace(/\/$/, "")}/api/world/callback`;

/** Public, secret-free configuration diagnosis for the UI/start route. */
export function worldClientConfigurationIssue(): string | null {
  if (!config.clientId || !config.clientSecret) {
    return "World Agent Pass client credentials are not configured.";
  }
  if (!new Set(["client_secret_basic", "client_secret_post"]).has(config.authMethod)) {
    return "WORLDID_AUTH_METHOD must match the registered World client.";
  }
  try {
    const redirect = new URL(redirectUri());
    if (redirect.protocol !== "https:") {
      return "World Agent Pass requires an exact HTTPS callback registered in the World developer portal.";
    }
  } catch {
    return "NEXT_PUBLIC_BASE_URL is not a valid callback origin.";
  }
  return null;
}

let discovery: Discovery | undefined;
let jwks: JWTVerifyGetKey | undefined;

export async function getDiscovery(): Promise<Discovery> {
  if (!discovery) {
    const res = await fetch(`${config.issuer}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
    discovery = (await res.json()) as Discovery;
  }
  return discovery;
}

async function getJwks(): Promise<JWTVerifyGetKey> {
  if (!jwks) jwks = createRemoteJWKSet(new URL((await getDiscovery()).jwks_uri));
  return jwks;
}

export const randomToken = (bytes = 32) =>
  randomBytes(bytes).toString("base64url");

export function pkcePair() {
  const verifier = randomToken(48); // 64 chars, within 43–128
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * @param fresh require a brand-new World check for this attempt
 *              (prompt=login + max_age=0 — the appeal's "show your face NOW").
 */
export async function buildAuthorizeUrl(opts: {
  state: string;
  nonce: string;
  codeChallenge: string;
  fresh: boolean;
}): Promise<string> {
  const discovered = await getDiscovery();
  const { authorization_endpoint } = discovered;
  if (
    discovered.acr_values_supported &&
    !discovered.acr_values_supported.includes(config.acr)
  ) {
    throw new Error("Configured World assurance class is not supported by this issuer");
  }
  const url = new URL(authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: "openid",
    state: opts.state,
    nonce: opts.nonce,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    ...(opts.fresh
      ? {
          prompt: "login",
          max_age: "0",
          claims: JSON.stringify({
            id_token: {
              acr: { essential: true, value: config.acr },
            },
          }),
        }
      : {}),
  }).toString();
  return url.toString();
}

export async function exchangeCode(
  code: string,
  verifier: string,
): Promise<string> {
  const { token_endpoint } = await getDiscovery();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (config.authMethod === "client_secret_post") {
    body.set("client_id", config.clientId);
    body.set("client_secret", config.clientSecret);
  } else {
    const enc = (s: string) => encodeURIComponent(s);
    headers.Authorization = `Basic ${Buffer.from(
      `${enc(config.clientId)}:${enc(config.clientSecret)}`,
    ).toString("base64")}`;
  }

  const res = await fetch(token_endpoint, { method: "POST", headers, body });
  if (!res.ok) {
    // Never log the body or headers — they contain the code and credentials.
    throw new Error(`token exchange failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as { id_token?: string };
  if (!json.id_token) throw new Error("token response has no id_token");
  return json.id_token;
}

export interface WorldIdClaims extends JWTPayload {
  sub: string;
  auth_time: number;
  nonce?: string;
  acr?: string;
  amr?: string[];
}

/** Full validation: exact issuer, RS256 signature via JWKS, audience, expiry, nonce. */
export async function verifyIdToken(
  idToken: string,
  expectedNonce: string,
): Promise<WorldIdClaims> {
  const { issuer } = await getDiscovery();
  const { payload } = await jwtVerify(idToken, await getJwks(), {
    issuer,
    audience: config.clientId,
    algorithms: ["RS256"],
    clockTolerance: config.clockSkewSec,
    requiredClaims: ["sub", "auth_time", "exp", "iat"],
  });
  if (payload.nonce !== expectedNonce) throw new Error("nonce mismatch");
  if (typeof payload.auth_time !== "number")
    throw new Error("missing auth_time");
  if (payload.acr !== config.acr) {
    throw new Error("World ID authentication did not meet the required Orb assurance class");
  }
  return payload as WorldIdClaims;
}
