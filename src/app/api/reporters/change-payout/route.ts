import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import * as z from "zod";
import { isAddress } from "viem";
import { getDb, schema } from "@/lib/db";
import { withSecurityWriteLock } from "@/lib/db/write-lock";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  agentPassRequiredResponse,
  assertWorldActionAllowed,
  AuthorizationDenied,
  consumeWorldAuthorization,
  createWorldAuthorization,
} from "@/lib/world/authorizations";
import { normalizeWallet, principalForAgentWallet } from "@/lib/world/principals";

const payoutSchema = z
  .object({
    byline_wallet: z.string().refine((value) => isAddress(value, { strict: false })),
    payout_wallet: z.string().refine((value) => isAddress(value, { strict: false })),
    reason: z.string().trim().min(10).max(280),
    authorization_id: z.string().uuid().optional(),
  })
  .strict();

export async function POST(req: NextRequest) {
  const limited = checkRateLimit(req, 10);
  if (limited) return limited;
  const parsed = payoutSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payout change", issues: parsed.error.issues }, { status: 400 });
  }
  const bylineWallet = normalizeWallet(parsed.data.byline_wallet);
  const payoutWallet = normalizeWallet(parsed.data.payout_wallet);
  const ownership = await principalForAgentWallet(bylineWallet);
  if (!ownership || ownership.principal.status !== "active") {
    return NextResponse.json({ error: "active human principal not found" }, { status: 404 });
  }
  const db = await getDb();
  const byline = await db
    .select({
      id: schema.agents.id,
      address: schema.agents.address,
      payoutAddress: schema.agents.payoutAddress,
    })
    .from(schema.agents)
    .where(sql`lower(${schema.agents.address}) = ${bylineWallet}`)
    .get();
  if (!byline) {
    return NextResponse.json({ error: "reporter byline not found" }, { status: 404 });
  }
  const payload = {
    byline_wallet: bylineWallet,
    current_payout_wallet: (byline.payoutAddress || byline.address).toLowerCase(),
    new_payout_wallet: payoutWallet,
    reason: parsed.data.reason,
  };

  try {
    if (!parsed.data.authorization_id) {
      const authorization = await createWorldAuthorization({
        principalId: ownership.principal.id,
        action: "change_payout",
        payload,
        returnTo: "/agents",
      });
      return NextResponse.json(
        {
          error: "world_agent_pass_required",
          ...agentPassRequiredResponse(
            authorization,
            "Fresh approval from the controlling human is required before reporter revenue can move to another wallet.",
          ),
        },
        { status: 409 },
      );
    }
    await consumeWorldAuthorization({
      authorizationId: parsed.data.authorization_id,
      principalId: ownership.principal.id,
      action: "change_payout",
      payload,
    });
    await withSecurityWriteLock(() => db.transaction(async (tx) => {
      await assertWorldActionAllowed(ownership.principal.id, "change_payout", tx);
      const current = await tx
        .select({
          id: schema.agents.id,
          address: schema.agents.address,
          payoutAddress: schema.agents.payoutAddress,
        })
        .from(schema.agents)
        .where(sql`lower(${schema.agents.address}) = ${bylineWallet}`)
        .get();
      const currentPayout = current
        ? (current.payoutAddress || current.address).toLowerCase()
        : null;
      if (!current || currentPayout !== payload.current_payout_wallet) {
        throw new AuthorizationDenied(
          "stale_payout_state",
          "The payout destination changed after approval. Start a new Agent Pass request.",
          409,
        );
      }
      await tx
        .update(schema.agents)
        .set({ payoutAddress: payoutWallet })
        .where(sql`lower(${schema.agents.address}) = ${bylineWallet}`)
        .run();
    }));
  } catch (error) {
    if (error instanceof AuthorizationDenied) {
      return NextResponse.json({ error: error.code, detail: error.message }, { status: error.status });
    }
    throw error;
  }

  return NextResponse.json({
    changed: true,
    byline_wallet: bylineWallet,
    payout_wallet: payoutWallet,
  });
}
