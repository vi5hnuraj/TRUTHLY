import { randomUUID } from "node:crypto";
import { getDb, schema, type DatabaseExecutor } from "./db";

export interface RevisionSnapshot {
  id: string;
  headline: string;
  body: string;
  sources: string;
  sourceMetadata: string | null;
  claims: string | null;
}

export async function recordSignalRevision(
  signal: RevisionSnapshot,
  action: "filed" | "corrected" | "retracted",
  reason: string,
  actor: string,
  database?: DatabaseExecutor,
) {
  const db = database ?? (await getDb());
  await db
    .insert(schema.signalRevisions)
    .values({
      id: randomUUID(),
      signalId: signal.id,
      action,
      headline: signal.headline,
      body: signal.body,
      sources: signal.sources,
      sourceMetadata: signal.sourceMetadata,
      claims: signal.claims,
      reason,
      actor,
      createdAt: new Date().toISOString(),
    })
    .run();
}
