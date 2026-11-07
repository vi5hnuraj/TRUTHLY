import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import {
  getWorldAuthorization,
  publicAuthorizationView,
} from "@/lib/world/authorizations";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const authorization = await getWorldAuthorization(id);
  if (!authorization) return Response.json({ error: "not found" }, { status: 404 });
  const db = await getDb();
  const attempts = await db
    .select({
      status: schema.authorizationAttempts.status,
      reason: schema.authorizationAttempts.reason,
      created_at: schema.authorizationAttempts.createdAt,
    })
    .from(schema.authorizationAttempts)
    .where(eq(schema.authorizationAttempts.authorizationId, id))
    .orderBy(desc(schema.authorizationAttempts.createdAt))
    .limit(20);
  return Response.json({ ...publicAuthorizationView(authorization), attempts });
}
