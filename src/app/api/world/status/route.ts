import { NextResponse } from "next/server";
import { mockEnabled } from "@/lib/world/mock";
import { worldClientConfigurationIssue } from "@/lib/world/oidc";

/**
 * GET /api/world/status — what the UI needs to render the appeal button honestly:
 * worldConfigured → the /api/world/start OIDC flow can run (credentials present).
 * The court page never fakes a verification — without credentials the button
 * explains exactly what is missing instead of pretending.
 */
export async function GET() {
  const worldIssue = worldClientConfigurationIssue();
  return NextResponse.json({
    worldConfigured: worldIssue === null,
    worldIssue,
    // IDKit (byline-birth proof of unique human) presence, for the same honesty.
    idkitConfigured: !!(
      process.env.IDKIT_APP_ID &&
      process.env.IDKIT_RP_ID &&
      process.env.IDKIT_SIGNING_KEY
    ),
    // Local simulator active — the UI must say so rather than imply a real scan.
    mock: mockEnabled(),
  });
}
