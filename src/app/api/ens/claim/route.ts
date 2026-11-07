import { NextRequest, NextResponse } from "next/server";
import * as z from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { verifyBylineOwnership, isPlausibleEnsName, publicEnsClient } from "@/lib/ens/resolution";
import { NETWORK } from "@/lib/x402";

/**
 * POST /api/ens/claim — attach a verified ENSv2 byline to a reporter.
 *
 * Body: { wallet, name, chain? }  (chain: "mainnet" default | "sepolia")
 *
 * The server does the only trusted work: it resolves `name` on a REAL chain
 * RPC and stores it ONLY when the name resolves to exactly `wallet`.
 * A claimant cannot attach someone else's name — the name would have to
 * resolve to the claimant's wallet, which only the name's owner controls.
 * No mock client exists in this path; tests use the lib's `client` param.
 */
const claimSchema = z.object({
  wallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "hex address required"),
  name: z.string().min(3).max(255),
  chain: z.enum(["mainnet", "sepolia"]).default("mainnet"),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = claimSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { verified: false, reason: "invalid_request" },
      { status: 400 },
    );
  }

  const { wallet, name, chain } = parsed.data;
  const normalizedName = name.trim().toLowerCase();

  if (!isPlausibleEnsName(normalizedName)) {
    return NextResponse.json({ verified: false, reason: "invalid_name" }, { status: 400 });
  }

  // REAL on-chain resolution — this is the ENSIP-25 style proof.
  const verification = await verifyBylineOwnership(normalizedName, wallet, publicEnsClient(chain));
  if (!verification.verified) {
    return NextResponse.json(
      { verified: false, reason: verification.reason },
      { status: 200 },
    );
  }

  const db = await getDb();
  // The paying wallet identifies the agent row (same key as signal filing —
  // reuse the x402 NETWORK so the account_id matches the filer's row).
  const accountId = `${NETWORK}:${wallet}`;
  // Match the row by address if it already exists under any network; otherwise
  // create one under the payment network so the byline survives the first filing.
  const existing = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.address, wallet))
    .get();

  const verifiedAt = new Date().toISOString();
  if (existing) {
    await db
      .update(schema.agents)
      .set({ ensName: normalizedName, ensVerifiedAt: verifiedAt })
      .where(eq(schema.agents.id, existing.id))
      .run();
    return NextResponse.json({
      verified: true,
      name: normalizedName,
      agent_id: existing.id,
      verified_at: verifiedAt,
    });
  }

  // No agent row yet: record the verified byline so the row appears with the
  // name already attached when the wallet's first payment (first filing) lands.
  const id = crypto.randomUUID();
  await db
    .insert(schema.agents)
    .values({
      id,
      accountId,
      chainId: NETWORK,
      address: wallet,
      name: `Reporter ${wallet.slice(0, 6)}…${wallet.slice(-4)}`,
      registeredAt: verifiedAt,
      ensName: normalizedName,
      ensVerifiedAt: verifiedAt,
    })
    .run();

  return NextResponse.json({ verified: true, name: normalizedName, agent_id: id, verified_at: verifiedAt });
}

/**
 * GET /api/ens/claim?wallet=0x… — this reporter's current byline row.
 */
export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet");
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return NextResponse.json({ error: "wallet required" }, { status: 400 });
  }
  const db = await getDb();
  const agent = await db
    .select({ id: schema.agents.id, ens_name: schema.agents.ensName, ens_verified_at: schema.agents.ensVerifiedAt })
    .from(schema.agents)
    .where(eq(schema.agents.address, wallet))
    .get();
  return NextResponse.json({ agent: agent ?? null });
}
