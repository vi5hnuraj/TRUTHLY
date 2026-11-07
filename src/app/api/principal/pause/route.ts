import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import * as z from "zod";
import { isAddress } from "viem";
import { getDb, schema } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";
import { consumeOwnerSignature, OwnerSignatureRejected } from "@/lib/world/owner-signature";
import { pauseMessage } from "@/lib/world/pause-message";
import {
  normalizeWallet,
  openTradesForPrincipal,
  pausePrincipal,
  principalByOwnerWallet,
} from "@/lib/world/principals";

const requestSchema = z
  .object({
    owner_wallet: z.string().refine((value) => isAddress(value, { strict: false }), "invalid owner wallet"),
    reason: z.string().trim().min(5).max(280),
    issued_at: z.iso.datetime({ offset: true }),
    nonce: z.string().trim().min(16).max(128),
    signature: z.string().trim().min(2),
  })
  .strict();

async function activeAgentCount(principalId: string): Promise<number> {
  const db = await getDb();
  const rows = await db
    .select({ id: schema.delegatedAgents.id })
    .from(schema.delegatedAgents)
    .where(
      and(
        eq(schema.delegatedAgents.principalId, principalId),
        eq(schema.delegatedAgents.status, "active"),
      ),
    );
  return rows.length;
}

const OPEN_ORDER_NOTICE =
  "A request that already crossed into submitting may be in flight, and orders already accepted by the execution provider are not cancelled by a pause. TRUTHLY blocks later submissions and approvals; cancel any open provider order separately.";

/**
 * GET /api/principal/pause?owner_wallet=0x…
 * What the UI needs to show the switch honestly.
 */
export async function GET(req: NextRequest) {
  const owner = req.nextUrl.searchParams.get("owner_wallet");
  if (!owner || !isAddress(owner, { strict: false })) {
    return NextResponse.json({ error: "owner_wallet is required" }, { status: 400 });
  }
  const principal = await principalByOwnerWallet(owner);
  if (!principal) {
    return NextResponse.json({ error: "human principal not found" }, { status: 404 });
  }
  return NextResponse.json({
    principal_id: principal.id,
    paused: !!principal.pausedAt,
    paused_at: principal.pausedAt,
    pause_reason: principal.pauseReason,
    pause_version: principal.pauseVersion,
    active_agents: await activeAgentCount(principal.id),
    open_trades: principal.pausedAt ? await openTradesForPrincipal(principal.id) : [],
    resume_mode:
      process.env.WORLDID_CLIENT_ID &&
      process.env.WORLDID_CLIENT_SECRET &&
      principal.worldSubHash
        ? "world_agent_pass"
        : "unavailable",
  });
}

/**
 * POST /api/principal/pause
 *
 * The emergency switch. It is intentionally gated by an owner-wallet signature
 * rather than World: halting an agent must not depend on the identity provider
 * being reachable. Resuming is the consequential direction and is gated.
 */
export async function POST(req: NextRequest) {
  const limited = checkRateLimit(req, 20);
  if (limited) return limited;

  const parsed = requestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid pause request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const body = parsed.data;

  try {
    const principal = await principalByOwnerWallet(body.owner_wallet);
    if (!principal) {
      return NextResponse.json({ error: "human principal not found" }, { status: 404 });
    }

    await consumeOwnerSignature({
      address: body.owner_wallet,
      issuedAt: body.issued_at,
      nonce: body.nonce,
      signature: body.signature,
      message: pauseMessage({
        address: normalizeWallet(body.owner_wallet),
        reason: body.reason,
        issuedAt: body.issued_at,
        nonce: body.nonce,
      }),
    });

    const result = await pausePrincipal(principal.id, body.reason);
    return NextResponse.json({
      paused: true,
      already_paused: result.alreadyPaused,
      paused_at: result.pausedAt,
      pause_version: result.pauseVersion,
      principal_id: principal.id,
      active_agents_blocked: await activeAgentCount(principal.id),
      open_trades: await openTradesForPrincipal(principal.id),
      notice: OPEN_ORDER_NOTICE,
    });
  } catch (error) {
    if (error instanceof OwnerSignatureRejected) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
