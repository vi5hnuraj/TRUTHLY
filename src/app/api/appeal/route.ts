import { NextRequest, NextResponse } from "next/server";
import * as z from "zod";
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { getSession } from "@/lib/world/sessions";
import { alias } from "drizzle-orm/sqlite-core";

/**
 * POST /api/appeal — the protected action for a slashed stake.
 *
 * Shaped like the protocol's `POST /api/claims/:id/execute` (MIT): the ONLY thing the
 * browser may send is the id of a session this server minted during the OIDC
 * attempt. `sub` and `auth_time` are deliberately absent from this schema — they
 * exist only inside the id_token the callback already verified (issuer, RS256 via
 * JWKS, audience, nonce, freshness, byline match). A forged body grants nothing
 * because there is no claim left to forge.
 *
 * The stake is decided in the callback while the verified claims are in hand;
 * this endpoint confirms that decision for an approved session and 409s for
 * anything else — the same rule the protocol applies before releasing a payout.
 */
const appealSchema = z.object({
  session: z.string().min(1).max(64),
  signal_id: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const parsed = appealSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { appeal: "denied", reason: "invalid_request" },
      { status: 400 },
    );
  }

  const session = await getSession(parsed.data.session);
  if (!session || session.purpose !== "appeal" || session.signalId !== parsed.data.signal_id) {
    return NextResponse.json(
      { appeal: "denied", reason: "no matching appeal session" },
      { status: 400 },
    );
  }
  if (session.status !== "approved") {
    // the protocol: `session is ${status}` — a denied/expired/cancelled attempt unlocks nothing.
    return NextResponse.json(
      {
        appeal: "denied",
        reason: `session is ${session.status}`,
        detail: session.result.reason ?? null,
      },
      { status: 409 },
    );
  }

  // The decision was made server-side at callback time; read the audit row it wrote.
  const db = await getDb();
  const row = await db
    .select({
      status: schema.appeals.status,
      reason: schema.appeals.reason,
    })
    .from(schema.appeals)
    .where(eq(schema.appeals.signalId, session.signalId))
    .orderBy(desc(schema.appeals.createdAt))
    .limit(1)
    .get();

  return NextResponse.json({
    appeal: row?.status ?? "approved",
    reason: row?.reason ?? session.result.reason ?? null,
    signal_id: session.signalId,
  });
}

/**
 * GET /api/appeal — the Appeal Court's public feed:
 *   - queue: every story whose stake is slashed (the appealable court docket)
 *   - ledger: the last appeal attempts with their verdicts — the denied
 *     path is on permanent public record, exactly as World requires.
 */
export async function GET() {
  const db = await getDb();

  // Filing agent join → the docket shows the verified ENSv2 byline, not just a wallet id.
  const filingAgent = alias(schema.agents, "filing_agent");
  const queue = await db
    .select({
      id: schema.signals.id,
      headline: schema.signals.headline,
      beat: schema.signals.beat,
      stake_atomic: schema.signals.stakeAtomic,
      agent_id: schema.signals.agentId,
      agent_name: filingAgent.name,
      ens_name: filingAgent.ensName,
      // Binding state: an unbound byline can still be bound (the enroll flow),
      // and the court UI offers that button instead of a doomed appeal.
      agent_address: filingAgent.address,
      world_bound: filingAgent.worldSubHash,
      updated_at: schema.signals.updatedAt,
    })
    .from(schema.signals)
    .leftJoin(filingAgent, eq(schema.signals.agentId, filingAgent.id))
    .where(eq(schema.signals.stakeStatus, "slashed"))
    .orderBy(desc(schema.signals.updatedAt))
    .limit(50);

  const appellant = alias(schema.agents, "appellant");
  const ledger = await db
    .select({
      id: schema.appeals.id,
      signal_id: schema.appeals.signalId,
      agent_id: schema.appeals.agentId,
      ens_name: appellant.ensName,
      status: schema.appeals.status,
      reason: schema.appeals.reason,
      created_at: schema.appeals.createdAt,
    })
    .from(schema.appeals)
    .leftJoin(appellant, eq(schema.appeals.agentId, appellant.id))
    .orderBy(desc(schema.appeals.createdAt))
    .limit(50);

  return NextResponse.json({ queue, ledger });
}
