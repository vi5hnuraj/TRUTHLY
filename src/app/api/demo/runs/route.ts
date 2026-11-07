import { demoDisabledResponse, demoModeEnabled } from "@/lib/council/mode";
import { recentCouncilRuns, publicCouncilRun } from "@/lib/council/store";
import { recentPaperExecutions, publicPaperExecution } from "@/lib/council/paper";

export async function GET() {
  if (!demoModeEnabled()) return demoDisabledResponse();
  const [runs, papers] = await Promise.all([recentCouncilRuns("demo"), recentPaperExecutions()]);
  return Response.json({
    mode: "demo",
    warning: "Every record in this response is demo/paper-only.",
    runs: runs.map(publicCouncilRun),
    paper_executions: papers.map(publicPaperExecution),
  });
}
