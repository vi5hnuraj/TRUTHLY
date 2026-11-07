import { NextRequest, NextResponse } from "next/server";
import * as z from "zod";
import { isAddress } from "viem";
import { checkRateLimit } from "@/lib/rate-limit";
import { parseUsdcAtomic } from "@/lib/usdc";
import type { AuthorizationPayload } from "@/lib/world/authorizations";
import {
  agentPassRequiredResponse,
  AuthorizationDenied,
  consumeWorldAuthorization,
  createWorldAuthorization,
} from "@/lib/world/authorizations";
import {
  listPrincipalMandates,
  MANDATE_ROLES,
  MandateDenied,
  mandateForAgentWallet,
  mandateFromToken,
  revokeDelegatedAgent,
  upsertMandate,
} from "@/lib/world/mandates";
import {
  normalizeWallet,
  principalByOwnerWallet,
  principalForAgentWallet,
} from "@/lib/world/principals";

const beats = [
  "bitcoin",
  "defi",
  "agentic-payments",
  "infrastructure",
  "regulation",
  "market-signals",
] as const;

const amount = z.string().regex(/^\d+(?:\.\d{1,6})?$/);

const mutationSchema = z
  .object({
    operation: z.enum(["upsert", "revoke"]),
    owner_wallet: z.string().refine((value) => isAddress(value, { strict: false }), "invalid owner wallet"),
    agent_wallet: z.string().refine((value) => isAddress(value, { strict: false }), "invalid agent wallet"),
    label: z.string().trim().min(2).max(64).optional(),
    roles: z.array(z.enum(MANDATE_ROLES)).min(1).max(MANDATE_ROLES.length).optional(),
    allowed_beats: z.array(z.enum(beats)).min(1).max(beats.length).optional(),
    daily_filings: z.number().int().min(0).max(100).optional(),
    daily_stake_usdc: amount.optional(),
    max_trade_usdc: amount.optional(),
    fresh_agent_pass_above_usdc: amount.optional(),
    expires_at: z.iso.datetime({ offset: true }).nullable().optional(),
    reason: z.string().trim().min(5).max(280).optional(),
    authorization_id: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.operation === "upsert") {
      for (const field of [
        "label",
        "roles",
        "allowed_beats",
        "daily_filings",
        "daily_stake_usdc",
        "max_trade_usdc",
        "fresh_agent_pass_above_usdc",
      ] as const) {
        if (value[field] === undefined) {
          ctx.addIssue({ code: "custom", path: [field], message: `${field} is required for upsert` });
        }
      }
      const max = value.max_trade_usdc ? parseUsdcAtomic(value.max_trade_usdc) : null;
      const threshold = value.fresh_agent_pass_above_usdc
        ? parseUsdcAtomic(value.fresh_agent_pass_above_usdc)
        : null;
      if (max !== null && threshold !== null && threshold > max) {
        ctx.addIssue({
          code: "custom",
          path: ["fresh_agent_pass_above_usdc"],
          message: "fresh approval threshold cannot exceed the per-trade cap",
        });
      }
      if (value.expires_at && Date.parse(value.expires_at) <= Date.now()) {
        ctx.addIssue({ code: "custom", path: ["expires_at"], message: "expiry must be in the future" });
      }
    } else if (!value.reason) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "reason is required for revocation" });
    }
  });

export async function GET(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (token) {
    let row: Awaited<ReturnType<typeof mandateFromToken>>;
    try {
      row = await mandateFromToken(token);
    } catch (error) {
      if (error instanceof MandateDenied) {
        return NextResponse.json({ error: error.code, detail: error.message }, { status: error.status });
      }
      throw error;
    }
    if (!row) return NextResponse.json({ error: "invalid or revoked mandate" }, { status: 401 });
    return NextResponse.json({
      principal_id: row.principal.id,
      agent_wallet: row.delegatedAgent.agentWallet,
      label: row.delegatedAgent.label,
      roles: JSON.parse(row.mandate.roles),
      allowed_beats: JSON.parse(row.mandate.allowedBeats),
      mandate_id: row.mandate.id,
      expires_at: row.mandate.expiresAt,
    });
  }

  const owner = req.nextUrl.searchParams.get("owner_wallet");
  if (!owner || !isAddress(owner, { strict: false })) {
    return NextResponse.json({ error: "owner_wallet is required" }, { status: 400 });
  }
  const result = await listPrincipalMandates(owner);
  return result
    ? NextResponse.json(result)
    : NextResponse.json({ error: "human principal not found" }, { status: 404 });
}

export async function POST(req: NextRequest) {
  const limited = checkRateLimit(req, 20);
  if (limited) return limited;
  const parsed = mutationSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid mandate request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const body = parsed.data;
  const principal = await principalByOwnerWallet(body.owner_wallet);
  if (!principal || principal.status !== "active") {
    return NextResponse.json({ error: "active human principal not found" }, { status: 404 });
  }
  const existingDelegation = await principalForAgentWallet(body.agent_wallet);
  const existingMandate = await mandateForAgentWallet(body.agent_wallet);
  if (body.operation === "revoke") {
    if (!existingDelegation || existingDelegation.principal.id !== principal.id) {
      return NextResponse.json(
        { error: "agent_not_found", detail: "No delegated agent belongs to this principal." },
        { status: 404 },
      );
    }
  } else if (existingDelegation && existingDelegation.principal.id !== principal.id) {
    return NextResponse.json(
      { error: "wallet_already_delegated", detail: "That wallet belongs to another human principal." },
      { status: 409 },
    );
  }

  const corePayload: AuthorizationPayload =
    body.operation === "revoke"
      ? {
          operation: "revoke",
          owner_wallet: normalizeWallet(body.owner_wallet),
          agent_wallet: normalizeWallet(body.agent_wallet),
          current_agent_status: existingDelegation?.delegatedAgent.status ?? null,
          current_mandate_id: existingMandate?.mandate.id ?? null,
          current_mandate_version: existingMandate?.mandate.version ?? null,
          reason: body.reason!,
        }
      : {
          operation: "upsert",
          owner_wallet: normalizeWallet(body.owner_wallet),
          agent_wallet: normalizeWallet(body.agent_wallet),
          current_agent_status: existingDelegation?.delegatedAgent.status ?? null,
          current_mandate_id: existingMandate?.mandate.id ?? null,
          current_mandate_version: existingMandate?.mandate.version ?? null,
          label: body.label!,
          roles: [...body.roles!].sort(),
          allowed_beats: [...body.allowed_beats!].sort(),
          daily_filings: body.daily_filings!,
          daily_stake_atomic: parseUsdcAtomic(body.daily_stake_usdc!)!.toString(),
          max_trade_atomic: parseUsdcAtomic(body.max_trade_usdc!)!.toString(),
          fresh_pass_above_atomic: parseUsdcAtomic(body.fresh_agent_pass_above_usdc!)!.toString(),
          mandate_expires_at: body.expires_at ?? null,
        };
  const action = body.operation === "revoke" ? "revoke_agent" : "change_mandate";

  try {
    if (!body.authorization_id) {
      const authorization = await createWorldAuthorization({
        principalId: principal.id,
        action,
        payload: corePayload,
        returnTo: "/mandates",
      });
      return NextResponse.json(
        {
          ...agentPassRequiredResponse(
            authorization,
            body.operation === "revoke"
              ? "Fresh approval from the controlling human is required to revoke this agent."
              : "Fresh approval from the controlling human is required to create or change this mandate.",
          ),
          request: corePayload,
        },
        { status: 409 },
      );
    }

    await consumeWorldAuthorization({
      authorizationId: body.authorization_id,
      principalId: principal.id,
      action,
      payload: corePayload,
    });

    if (body.operation === "revoke") {
      await revokeDelegatedAgent(principal.id, body.agent_wallet, {
        agentStatus: existingDelegation?.delegatedAgent.status ?? null,
        mandateId: existingMandate?.mandate.id ?? null,
        mandateVersion: existingMandate?.mandate.version ?? null,
      });
      return NextResponse.json({ revoked: true, agent_wallet: normalizeWallet(body.agent_wallet) });
    }

    const result = await upsertMandate(principal.id, {
      agentWallet: body.agent_wallet,
      label: body.label!,
      roles: body.roles!,
      allowedBeats: body.allowed_beats!,
      dailyFilings: body.daily_filings!,
      dailyStakeAtomic: parseUsdcAtomic(body.daily_stake_usdc!)!.toString(),
      maxTradeAtomic: parseUsdcAtomic(body.max_trade_usdc!)!.toString(),
      freshPassAboveAtomic: parseUsdcAtomic(body.fresh_agent_pass_above_usdc!)!.toString(),
      expiresAt: body.expires_at,
    }, {
      agentStatus: existingDelegation?.delegatedAgent.status ?? null,
      mandateId: existingMandate?.mandate.id ?? null,
      mandateVersion: existingMandate?.mandate.version ?? null,
    });
    return NextResponse.json({
      created: true,
      agent_wallet: normalizeWallet(body.agent_wallet),
      delegated_agent_id: result.delegatedAgentId,
      mandate_id: result.mandateId,
      mandate_token: result.credential,
      warning: "This token is shown once. Give it only to the delegated agent; TRUTHLY stores only its hash.",
    });
  } catch (error) {
    if (error instanceof AuthorizationDenied || error instanceof MandateDenied) {
      return NextResponse.json({ error: error.code, detail: error.message }, { status: error.status });
    }
    throw error;
  }
}
