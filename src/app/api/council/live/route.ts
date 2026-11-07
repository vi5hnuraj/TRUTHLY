import { NextRequest, NextResponse } from "next/server";
import * as z from "zod";
import { verifyEditorAuth } from "@/lib/editor-auth";
import {
  LiveCouncilDenied,
  LiveCouncilRunFailed,
  runLiveCouncilForSignal,
} from "@/lib/council/live";
import { publicCouncilRun } from "@/lib/council/store";
import { CouncilUnavailable, publicCouncilFailure } from "@/lib/council/types";

const requestSchema = z.object({ signal_id: z.string().uuid() }).strict();

export async function POST(req: NextRequest) {
  const auth = await verifyEditorAuth(req);
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: 401 });
  }
  const parsed = requestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_council_request" }, { status: 400 });
  }
  try {
    const result = await runLiveCouncilForSignal(parsed.data.signal_id, {
      reuseCompleted: false,
      decisionOrigin: "human_mediated",
    });
    return NextResponse.json({
      mode: "live",
      label:
        "LIVE COUNCIL — REAL HERALD VERIFICATION + DEFINITIVE/UNISWAP MARKET INTEGRITY",
      run: publicCouncilRun(result.row),
      execution_note:
        "The agents only decide. A paid receipt, mandate, explicit approval and fresh market guard are still required before Definitive execution.",
    });
  } catch (error) {
    if (error instanceof LiveCouncilDenied) {
      return NextResponse.json(
        { error: error.code, detail: error.message },
        { status: error.status },
      );
    }
    const cause = error instanceof LiveCouncilRunFailed ? error.causeValue : error;
    return NextResponse.json(
      {
        error: cause instanceof CouncilUnavailable
          ? "council_not_configured"
          : "live_council_failed",
        detail: publicCouncilFailure(cause),
        council_run_id: error instanceof LiveCouncilRunFailed ? error.councilRunId : null,
      },
      { status: cause instanceof CouncilUnavailable ? 503 : 502 },
    );
  }
}
