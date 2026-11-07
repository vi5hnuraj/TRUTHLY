import { idkitEnabled } from "@/lib/idkit/proof-of-human";
import { idkitConfig } from "@/lib/idkit/config";

/**
 * IDKit proof-of-human endpoints (mounted at /api/idkit) — port of the protocol's
 * routes/idkit.ts. Frontend flow at byline birth:
 *   1. GET  /api/idkit/config   → app_id, rp_id, action, environment (public values)
 *   2. POST /api/idkit/rp-signature → rp_context for IDKitRequestWidget
 *   3. widget with preset proofOfHuman({ signal: <signal for the wallet> })
 *   4. handleVerify: POST /api/idkit/verify { address, idkitResponse } → { verified, already }
 *   5. then Agent Pass enrollment → the byline's appeal right
 */
export async function GET() {
  return Response.json({
    enabled: idkitEnabled(),
    app_id: idkitConfig.appId || null,
    rp_id: idkitConfig.rpId || null,
    action: idkitConfig.action,
    environment: idkitConfig.environment,
    /** Simulator (staging.world.org) offered next to the phone QR when on. */
    allow_simulator: idkitConfig.allowSimulator,
    /** Signal to pass to the preset: signalFor(address). Shown here so the frontend matches exactly. */
    signalRule: "lowercase byline address",
  });
}
