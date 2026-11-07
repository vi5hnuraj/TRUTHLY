import { NextRequest } from "next/server";
import { getSession, publicView } from "@/lib/world/sessions";

/**
 * Frontend polls this after returning from World ID — port of the protocol's
 * /api/worldid/session/:id. Returns the public view only: no OIDC secrets,
 * no raw World sub.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const s = await getSession(id);
  if (!s) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(publicView(s));
}
