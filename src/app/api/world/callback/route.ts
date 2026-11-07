import { NextRequest, NextResponse } from "next/server";
import { exchangeCode, verifyIdToken } from "@/lib/world/oidc";
import { saveSession, takeSessionByState, type WorldSession } from "@/lib/world/sessions";
import { completeEnrollment } from "@/lib/world/enroll";
import { completeAppealCheck, fail } from "@/lib/world/complete-appeal";
import { mockClaims, mockEnabled, mockPersona } from "@/lib/world/mock";
import { completeWorldAuthorization } from "@/lib/world/authorizations";

/**
 * World ID redirect target — ported from the protocol (MIT),
 * `backend/src/server.ts` (/auth/worldid/callback). Order matters and is kept:
 *   1. consume state ONCE (replay protection)
 *   2. session expired → fail("expired")
 *   3. World returned an error → fail("cancelled" | "denied")
 *   4. no code → fail("denied")
 *   5. exchange code → verify id_token (issuer, RS256/JWKS, audience, nonce)
 *   6. dispatch by purpose: enroll → bind byline; appeal → fresh check gate
 * The one-time state means this function can never be applied twice.
 */
export async function GET(req: NextRequest) {
  const state = req.nextUrl.searchParams.get("state");
  const session = state ? await takeSessionByState(state) : undefined;
  if (!session) return unknownAttempt();

  if (session.status === "expired") {
    await fail(session, "expired", "login attempt expired");
    return backToFrontend(session, req);
  }

  const error = req.nextUrl.searchParams.get("error");
  if (error) {
    await fail(session, error === "access_denied" ? "cancelled" : "denied", error);
    return backToFrontend(session, req);
  }

  const code = req.nextUrl.searchParams.get("code");

  // DEV-ONLY: the local persona chooser answers here instead of World. Same
  // dispatch, same rules — only the source of sub/auth_time differs, and only
  // while WORLD_DEV_MOCK=1 is set outside a production build.
  const mockId = req.nextUrl.searchParams.get("mock");
  const persona = mockPersona(mockId);
  if (mockId) {
    if (!mockEnabled()) return new NextResponse("Mock verification is disabled.", { status: 403 });
    if (!persona) {
      await fail(session, "denied", `unknown mock persona: ${mockId}`);
      return backToFrontend(session, req);
    }
    try {
      await applyClaims(session, mockClaims(persona));
    } catch (err) {
      await fail(session, "denied", (err as Error).message);
    }
    return backToFrontend(session, req);
  }

  if (!code) {
    await fail(session, "denied", "no authorization code");
    return backToFrontend(session, req);
  }

  try {
    const idToken = await exchangeCode(code, session.verifier);
    const claims = await verifyIdToken(idToken, session.nonce);
    await applyClaims(session, claims);
  } catch (err) {
    await fail(session, "denied", (err as Error).message);
  }
  return backToFrontend(session, req);
}

/** Enroll binds the byline; appeal runs the freshness + same-human gate. */
async function applyClaims(session: WorldSession, claims: { sub: string; auth_time: number }) {
  if (session.authorizationId) await completeWorldAuthorization(session, claims);
  else if (session.purpose === "enroll") await completeEnrollment(session, claims);
  else await completeAppealCheck(session, claims);
  await saveSession(session);
}

/**
 * A state we cannot recognise: an unknown id or a second
 * visit to a state that was already redeemed once (replay protection working).
 * the protocol returns a bare 400 string; we keep the 400 but hand the human a way
 * back to the docket instead of a dead end.
 */
function unknownAttempt() {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unknown or already-used login attempt</title>
<style>body{background:#0b0b0b;color:#e8e8e8;font-family:ui-monospace,Menlo,monospace;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
main{max-width:34rem;padding:2rem}h1{font-size:1.1rem;text-transform:uppercase;letter-spacing:.2em;color:#ff5c5c;margin:0 0 1rem}
p{line-height:1.7;color:#a9a9a9;font-size:.9rem}a{color:#e8e8e8}</style></head>
<body><main><h1>Unknown or already-used login attempt</h1>
<p>This World login attempt is no longer valid. A state may be redeemed only
once (replay protection), and pending attempts expire after 10 minutes.</p>
<p>Nothing was unlocked and no stake was changed.</p>
<p><a href="/court">← Back to the Appeal Court</a></p></main></body></html>`;
  return new NextResponse(html, {
    status: 400,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/** the protocol: the frontend's /worldid/return page polls the session after the redirect. */
function backToFrontend(session: WorldSession, req: NextRequest) {
  // Real flow: World redirects to the registered tunnel URL, so that origin is
  // authoritative. Mock flow: stay on whatever origin the developer is using —
  // NEXT_PUBLIC_BASE_URL may point at a tunnel that isn't currently running.
  const base = mockEnabled()
    ? req.nextUrl.origin
    : process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
  return NextResponse.redirect(`${base}/worldid/return?session=${session.id}`, 302);
}
