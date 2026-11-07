import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import * as z from "zod";
import { getDb, schema } from "@/lib/db";
import { withSecurityWriteLock } from "@/lib/db/write-lock";
import { verifyEditorAuth } from "@/lib/editor-auth";
import { recordSignalRevision } from "@/lib/revisions";
import { hashPrivateText } from "@/lib/world/actions";
import {
  agentPassRequiredResponse,
  assertWorldActionAllowed,
  AuthorizationDenied,
  consumeWorldAuthorization,
  createWorldAuthorization,
} from "@/lib/world/authorizations";
import { principalForSignal } from "@/lib/world/principals";

const retractionSchema = z
  .object({
    signal_id: z.string().uuid(),
    reason: z.string().trim().min(10).max(500),
    authorization_id: z.string().uuid().optional(),
  })
  .strict();

/** A published-record retraction requires the original principal's fresh yes. */
export async function POST(req: NextRequest) {
  const auth = await verifyEditorAuth(req);
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: 401 });
  }
  const parsed = retractionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid retraction", issues: parsed.error.issues }, { status: 400 });
  }
  const db = await getDb();
  const signal = await db
    .select()
    .from(schema.signals)
    .where(eq(schema.signals.id, parsed.data.signal_id))
    .get();
  if (!signal) return NextResponse.json({ error: "Signal not found" }, { status: 404 });
  if (signal.status === "retracted") {
    return NextResponse.json({ error: "Signal is already retracted" }, { status: 409 });
  }
  const ownership = await principalForSignal(signal.id);
  if (!ownership || ownership.principal.status !== "active") {
    return NextResponse.json(
      { error: "A retraction requires the active human principal behind the original byline." },
      { status: 428 },
    );
  }
  const payload = {
    signal_id: signal.id,
    current_headline: signal.headline,
    current_revision_hash: hashPrivateText(
      JSON.stringify({
        headline: signal.headline,
        body: signal.body,
        sources: signal.sources,
        source_metadata: signal.sourceMetadata,
        claims: signal.claims,
        updated_at: signal.updatedAt,
      }),
    ),
    reason: parsed.data.reason,
  };

  let retractedAt: string;
  try {
    if (!parsed.data.authorization_id) {
      const authorization = await createWorldAuthorization({
        principalId: ownership.principal.id,
        action: "retract_story",
        payload,
        returnTo: "/court",
      });
      return NextResponse.json(
        {
          error: "world_agent_pass_required",
          ...agentPassRequiredResponse(
            authorization,
            "The original human must freshly approve this exact retraction before TRUTHLY removes the story body.",
          ),
        },
        { status: 409 },
      );
    }
    await consumeWorldAuthorization({
      authorizationId: parsed.data.authorization_id,
      principalId: ownership.principal.id,
      action: "retract_story",
      payload,
    });
    retractedAt = await withSecurityWriteLock(() => db.transaction(async (tx) => {
      await assertWorldActionAllowed(ownership.principal.id, "retract_story", tx);
      const current = await tx
        .select()
        .from(schema.signals)
        .where(eq(schema.signals.id, signal.id))
        .get();
      const liveRevisionHash = current
        ? hashPrivateText(
            JSON.stringify({
              headline: current.headline,
              body: current.body,
              sources: current.sources,
              source_metadata: current.sourceMetadata,
              claims: current.claims,
              updated_at: current.updatedAt,
            }),
          )
        : null;
      if (!current || liveRevisionHash !== payload.current_revision_hash) {
        throw new AuthorizationDenied(
          "stale_story_revision",
          "The story changed after approval. Start a new Agent Pass request.",
          409,
        );
      }
      const now = new Date().toISOString();
      await tx
        .update(schema.signals)
        .set({
          status: "retracted",
          editorFeedback: `Retracted: ${parsed.data.reason}`,
          updatedAt: now,
        })
        .where(eq(schema.signals.id, current.id))
        .run();
      await recordSignalRevision(
        current,
        "retracted",
        parsed.data.reason,
        `Human principal ${ownership.principal.id}`,
        tx,
      );
      return now;
    }));
  } catch (error) {
    if (error instanceof AuthorizationDenied) {
      return NextResponse.json({ error: error.code, detail: error.message }, { status: error.status });
    }
    throw error;
  }

  return NextResponse.json({
    signal_id: signal.id,
    status: "retracted",
    retracted_at: retractedAt,
  });
}
