import { NextRequest, NextResponse } from "next/server";
import * as z from "zod";
import { isAddress } from "viem";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  agentPassRequiredResponse,
  AuthorizationDenied,
  consumeWorldAuthorization,
  createWorldAuthorization,
  getWorldAuthorization,
} from "@/lib/world/authorizations";
import type { AuthorizationPayload } from "@/lib/world/authorizations";
import {
  normalizeWallet,
  openTradesForPrincipal,
  principalByOwnerWallet,
  resumePrincipal,
} from "@/lib/world/principals";

const requestSchema = z
  .object({
    owner_wallet: z.string().refine((value) => isAddress(value, { strict: false }), "invalid owner wallet"),
    reason: z.string().trim().min(5).max(280),
    authorization_id: z.string().uuid().optional(),
  })
  .strict();

/**
 * POST /api/principal/resume
 *
 * Restoring authority is consequential, so it is gated the same way a mandate
 * change is: a fresh World Agent Pass over the exact resume payload. There is
 * intentionally no owner-signature fallback: stopping must always work, while
 * restoring delegated authority must fail closed until Agent Pass is available.
 */
export async function POST(req: NextRequest) {
  const limited = checkRateLimit(req, 20);
  if (limited) return limited;

  const parsed = requestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid resume request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const body = parsed.data;

  try {
    const principal = await principalByOwnerWallet(body.owner_wallet);
    if (!principal) {
      return NextResponse.json({ error: "human principal not found" }, { status: 404 });
    }
    if (!principal.pausedAt) {
      if (body.authorization_id) {
        const supplied = await getWorldAuthorization(body.authorization_id);
        const replayed = supplied?.status === "consumed" || !!supplied?.consumedAt;
        return NextResponse.json(
          {
            error: replayed ? "authorization_replayed" : "stale_resume_authorization",
            detail: replayed
              ? "This one-use resume authorization was already consumed."
              : "The principal is already active; a resume authorization cannot be applied.",
          },
          { status: 409 },
        );
      }
      return NextResponse.json({ resumed: false, already_active: true, principal_id: principal.id });
    }

    const worldConfigured = !!(
      process.env.WORLDID_CLIENT_ID && process.env.WORLDID_CLIENT_SECRET
    );
    if (!worldConfigured) {
      return NextResponse.json(
        {
          error: "world_agent_pass_unavailable",
          detail: "World Agent Pass is not configured. The principal remains paused.",
        },
        { status: 503 },
      );
    }
    if (!principal.worldSubHash) {
      return NextResponse.json(
        {
          error: "agent_pass_not_bound",
          detail: "Bind World Agent Pass before resuming. The principal remains paused.",
        },
        { status: 428 },
      );
    }

    const payload: AuthorizationPayload = {
      owner_wallet: normalizeWallet(body.owner_wallet),
      reason: body.reason,
      paused_at: principal.pausedAt,
      pause_reason: principal.pauseReason ?? null,
      pause_version: principal.pauseVersion,
    };

    if (!body.authorization_id) {
      const authorization = await createWorldAuthorization({
        principalId: principal.id,
        action: "resume_principal",
        payload,
        returnTo: "/pause",
      });
      return NextResponse.json(
        {
          ...agentPassRequiredResponse(
            authorization,
            "A fresh approval from the controlling human is required to resume all agents.",
          ),
          request: payload,
        },
        { status: 409 },
      );
    }
    await consumeWorldAuthorization({
      authorizationId: body.authorization_id,
      principalId: principal.id,
      action: "resume_principal",
      payload,
    });
    const resumed = await resumePrincipal(principal.id, principal.pauseVersion);
    if (!resumed.resumed) {
      throw new AuthorizationDenied(
        "pause_generation_changed",
        "The pause state changed after approval. Start a new resume authorization.",
        409,
      );
    }
    return NextResponse.json({
      resumed: true,
      principal_id: principal.id,
      resume_mode: "world_agent_pass",
      open_trades: await openTradesForPrincipal(principal.id),
    });
  } catch (error) {
    if (error instanceof AuthorizationDenied) {
      return NextResponse.json(
        { error: error.code, detail: error.message },
        { status: error.status },
      );
    }
    throw error;
  }
}
