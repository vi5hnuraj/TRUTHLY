import { DEMO_SCENARIOS } from "@/lib/council/scenarios";
import { demoDisabledResponse, demoModeEnabled } from "@/lib/council/mode";

export async function GET() {
  if (!demoModeEnabled()) return demoDisabledResponse();
  return Response.json({
    mode: "demo",
    warning: "DEMO NEWS ONLY — these predefined scenarios are fictional.",
    scenarios: DEMO_SCENARIOS,
  });
}
