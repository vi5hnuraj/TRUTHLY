import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { sql } from "drizzle-orm";
import * as z from "zod";
import {
  buildAuthorizeUrl,
  pkcePair,
  worldClientConfigurationIssue,
} from "@/lib/world/oidc";
import { createSession, type WorldPurpose, type WorldSession } from "@/lib/world/sessions";
import { idkitEnabled, humanStatus } from "@/lib/idkit/proof-of-human";
import { mockEnabled } from "@/lib/world/mock";
import { getDb, schema } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  consumeOwnerSignature,
  OwnerSignatureRejected,
} from "@/lib/world/owner-signature";
import { worldEnrollmentMessage } from "@/lib/world/enrollment-message";
import {
  assertWorldActionAllowed,
  AuthorizationDenied,
  authorizationPayloadIntegrity,
  getWorldAuthorization,
} from "@/lib/world/authorizations";
import { isWorldAction, purposeForAction } from "@/lib/world/actions";
import { principalForSignal } from "@/lib/world/principals";

const signedEnrollmentSchema = z
  .object({
    purpose: z.literal("enroll"),
    address: z.string().refine((value) => isAddress(value, { strict: false }), "invalid owner wallet"),
    return_to: z.string().startsWith("/").max(500),
    issued_at: z.iso.datetime({ offset: true }),
    nonce: z.string().trim().min(16).max(128),
    signature: z.string().trim().min(2),
  })
  .strict();

/**
 * Starts an OIDC attempt — ported from the protocol (MIT), `backend/src/server.ts`
 * (/auth/worldid/start). GET serves protected action/appeal challenges; owner-
 * wallet enrollment uses the signed POST handler below.
 * Both moments need the human present, so fresh=true always (prompt=login +
 * max_age=0): World requires a new proof, never a reused session.
 *
 * IDKit alternative path (the protocol parity): when IDKit is enabled, enrollment
 * waits for proof of unique human first — one human, one byline wallet.
 */
export async function GET(req: NextRequest) {
  const purpose = req.nextUrl.searchParams.get("purpose") as WorldPurpose | null;
  const returnTo = req.nextUrl.searchParams.get("returnTo") ?? "/";
  if (!returnTo.startsWith("/")) return new NextResponse("returnTo must be a path", { status: 400 });

  if (!mockEnabled()) {
    const issue = worldClientConfigurationIssue();
    if (issue) return new NextResponse(issue, { status: 503 });
  }

  const { verifier, challenge } = pkcePair();
  let session: WorldSession;
  const authorizationId = req.nextUrl.searchParams.get("authorizationId");

  if (authorizationId) {
    const authorization = await getWorldAuthorization(authorizationId);
    if (!authorization) return new NextResponse("authorization not found", { status: 404 });
    if (authorization.status !== "pending") {
      return new NextResponse(`authorization is ${authorization.status}`, { status: 409 });
    }
    if (!isWorldAction(authorization.action)) {
      return new NextResponse("authorization action is unsupported", { status: 400 });
    }
    if (!authorizationPayloadIntegrity(authorization).valid) {
      return new NextResponse("authorization payload integrity check failed", { status: 409 });
    }
    try {
      await assertWorldActionAllowed(authorization.principalId, authorization.action);
    } catch (error) {
      if (error instanceof AuthorizationDenied) {
        return new NextResponse(error.message, { status: error.status });
      }
      throw error;
    }
    const expectedPurpose = purposeForAction[authorization.action] as WorldPurpose;
    if (purpose && purpose !== expectedPurpose) {
      return new NextResponse("purpose does not match authorization action", { status: 400 });
    }
    session = await createSession({
      purpose: expectedPurpose,
      principalId: authorization.principalId,
      authorizationId: authorization.id,
      action: authorization.action,
      payloadHash: authorization.payloadHash,
      returnTo,
      verifier,
    });
  } else if (purpose === "enroll") {
    return new NextResponse(
      "World enrollment must be started by the signed POST flow.",
      { status: 405, headers: { Allow: "POST" } },
    );
  } else if (purpose === "appeal") {
    const signalId = req.nextUrl.searchParams.get("signalId");
    if (!signalId || !/^[0-9a-f-]{36}$/i.test(signalId)) {
      return new NextResponse("signalId required", { status: 400 });
    }
    const ownership = await principalForSignal(signalId);
    if (ownership?.principal.pausedAt) {
      return new NextResponse(
        "The controlling principal is paused. Resume before starting an appeal.",
        { status: 423 },
      );
    }
    session = await createSession({ purpose, signalId, returnTo, verifier });
  } else {
    return new NextResponse("purpose must be enroll, appeal, or a matching authorization purpose", { status: 400 });
  }

  // DEV-ONLY: with WORLD_DEV_MOCK=1 the browser never leaves this machine —
  // /worldid/mock stands in for World's QR page. The session is still minted
  // exactly as for the real flow, so everything downstream is the real code.
  if (mockEnabled()) {
    // Use the origin the browser is already on (localhost or a live tunnel) —
    // no env var, no dead URL. Dev-only branch.
    return NextResponse.redirect(
      `${req.nextUrl.origin}/worldid/mock?state=${session.state}`,
      302,
    );
  }

  // Session first, authorize URL second — exactly the protocol's order in server.ts.
  const url = await buildAuthorizeUrl({
    state: session.state,
    nonce: session.nonce,
    codeChallenge: challenge,
    fresh: true,
  }).catch(() => null);
  if (!url) return new NextResponse("World ID OIDC discovery failed", { status: 502 });
  return NextResponse.redirect(url, 302);
}

/**
 * Signed enrollment start. The browser may sign on localhost while the World
 * callback uses the registered HTTPS tunnel; the backend trusts the recovered
 * owner signature, never an address copied into a URL.
 */
export async function POST(req: NextRequest) {
  const limited = checkRateLimit(req, 10);
  if (limited) return limited;
  const parsed = signedEnrollmentSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid enrollment request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const body = parsed.data;
  if (!mockEnabled()) {
    const issue = worldClientConfigurationIssue();
    if (issue) return NextResponse.json({ error: issue }, { status: 503 });
  }
  if (idkitEnabled() && (await needsProofOfHuman(body.address))) {
    return NextResponse.json(
      { error: "unique_human_required", detail: "Complete IDKit Proof of Human before Agent Pass enrollment." },
      { status: 409 },
    );
  }

  try {
    await consumeOwnerSignature({
      address: body.address,
      issuedAt: body.issued_at,
      nonce: body.nonce,
      signature: body.signature,
      namespace: "world-enroll",
      message: worldEnrollmentMessage({
        address: body.address,
        issuedAt: body.issued_at,
        nonce: body.nonce,
      }),
    });
  } catch (error) {
    if (error instanceof OwnerSignatureRejected) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }

  const { verifier, challenge } = pkcePair();
  const session = await createSession({
    purpose: "enroll",
    address: body.address,
    returnTo: body.return_to,
    verifier,
  });
  if (mockEnabled()) {
    return NextResponse.json({
      authorization_url: `${req.nextUrl.origin}/worldid/mock?state=${session.state}`,
    });
  }
  const authorizationUrl = await buildAuthorizeUrl({
    state: session.state,
    nonce: session.nonce,
    codeChallenge: challenge,
    fresh: true,
  }).catch(() => null);
  if (!authorizationUrl) {
    return NextResponse.json({ error: "World ID OIDC discovery failed" }, { status: 502 });
  }
  return NextResponse.json({ authorization_url: authorizationUrl });
}

/**
 * IDKit alternative path — the protocol reads requireUniqueHuman/isVerifiedHuman from
 * the gate contract; we read the DB. Returns true when a proof of unique human
 * is still required before enrollment may proceed.
 */
async function needsProofOfHuman(address: string): Promise<boolean> {
  const db = await getDb();
  const agent = await db
    .select({ worldSubHash: schema.agents.worldSubHash })
    .from(schema.agents)
    .where(sql`lower(${schema.agents.address}) = ${address.toLowerCase()}`)
    .get();
  if (agent?.worldSubHash) return false; // already bound → nothing more required
  const status = await humanStatus(address);
  return !status.verified;
}
