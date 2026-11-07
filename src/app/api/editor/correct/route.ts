import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import * as z from "zod";
import { getDb, schema } from "@/lib/db";
import { withSecurityWriteLock } from "@/lib/db/write-lock";
import { verifyEditorAuth } from "@/lib/editor-auth";
import {
  evidenceIssues,
  evidenceUrlSchema,
  sourceMetadataListSchema,
  storyClaimsSchema,
} from "@/lib/evidence";
import { SIGNAL_LIMITS } from "@/lib/constants";
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

const correctionSchema = z
  .object({
    signal_id: z.uuid(),
    headline: z.string().trim().min(10).max(SIGNAL_LIMITS.headlineMaxLen),
    body: z.string().trim().min(40).max(SIGNAL_LIMITS.bodyMaxLen),
    sources: z
      .array(evidenceUrlSchema)
      .min(SIGNAL_LIMITS.minSources)
      .max(SIGNAL_LIMITS.maxSources),
    source_metadata: sourceMetadataListSchema,
    claims: storyClaimsSchema,
    reason: z.string().trim().min(10).max(500),
    authorization_id: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((correction, ctx) => {
    for (const issue of evidenceIssues(
      correction.sources,
      correction.source_metadata,
      correction.claims,
    )) {
      ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
  });

/** Records a full correction and sends the revised story back through Herald. */
export async function POST(req: NextRequest) {
  const auth = await verifyEditorAuth(req);
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: 401 });
  }
  const parsed = correctionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid correction", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const db = await getDb();
  const existing = await db
    .select()
    .from(schema.signals)
    .where(eq(schema.signals.id, parsed.data.signal_id))
    .get();
  if (!existing) {
    return NextResponse.json({ error: "Signal not found" }, { status: 404 });
  }
  if (existing.stakeStatus === "slashed") {
    return NextResponse.json(
      { error: "A slashed story must use the World ID appeal flow before correction." },
      { status: 409 },
    );
  }

  const ownership = await principalForSignal(existing.id);
  if (!ownership || ownership.principal.status !== "active") {
    return NextResponse.json(
      { error: "A correction requires the active human principal behind the original byline." },
      { status: 428 },
    );
  }
  const revisionHash = hashPrivateText(
    JSON.stringify({
      signal_id: parsed.data.signal_id,
      headline: parsed.data.headline,
      body: parsed.data.body,
      sources: parsed.data.sources,
      source_metadata: parsed.data.source_metadata,
      claims: parsed.data.claims,
      reason: parsed.data.reason,
    }),
  );
  const currentRevisionHash = hashPrivateText(
    JSON.stringify({
      headline: existing.headline,
      body: existing.body,
      sources: existing.sources,
      source_metadata: existing.sourceMetadata,
      claims: existing.claims,
      updated_at: existing.updatedAt,
    }),
  );
  const authorizationPayload = {
    signal_id: parsed.data.signal_id,
    current_revision_hash: currentRevisionHash,
    headline: parsed.data.headline,
    reason: parsed.data.reason,
    revision_hash: revisionHash,
  };

  let correctionRecordedAt: string;
  try {
    if (!parsed.data.authorization_id) {
      const authorization = await createWorldAuthorization({
        principalId: ownership.principal.id,
        action: "correct_story",
        payload: authorizationPayload,
        returnTo: "/court",
      });
      return NextResponse.json(
        {
          error: "world_agent_pass_required",
          ...agentPassRequiredResponse(
            authorization,
            "The original human must freshly approve this exact correction before the public record changes.",
          ),
        },
        { status: 409 },
      );
    }
    await consumeWorldAuthorization({
      authorizationId: parsed.data.authorization_id,
      principalId: ownership.principal.id,
      action: "correct_story",
      payload: authorizationPayload,
    });
    correctionRecordedAt = await withSecurityWriteLock(() => db.transaction(async (tx) => {
      await assertWorldActionAllowed(ownership.principal.id, "correct_story", tx);
      const current = await tx
        .select()
        .from(schema.signals)
        .where(eq(schema.signals.id, existing.id))
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
      if (!current || liveRevisionHash !== authorizationPayload.current_revision_hash) {
        throw new AuthorizationDenied(
          "stale_story_revision",
          "The story changed after approval. Start a new Agent Pass request.",
          409,
        );
      }

      const now = new Date().toISOString();
      const corrected = {
        ...current,
        headline: parsed.data.headline,
        body: parsed.data.body,
        sources: JSON.stringify(parsed.data.sources),
        sourceMetadata: JSON.stringify(parsed.data.source_metadata),
        claims: JSON.stringify(parsed.data.claims),
      };
      await tx
        .update(schema.signals)
        .set({
          headline: corrected.headline,
          body: corrected.body,
          sources: corrected.sources,
          sourceMetadata: corrected.sourceMetadata,
          claims: corrected.claims,
          status: "submitted",
          verification: null,
          score: null,
          editorFeedback: `Corrected: ${parsed.data.reason}`,
          updatedAt: now,
        })
        .where(eq(schema.signals.id, current.id))
        .run();
      await recordSignalRevision(
        corrected,
        "corrected",
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
    signal_id: existing.id,
    status: "submitted",
    correction_recorded_at: correctionRecordedAt,
  });
}
