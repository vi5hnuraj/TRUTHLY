import { NextResponse } from "next/server";
import { principalForAgentWallet } from "./principals";

/**
 * Paid MCP/API calls are authority-bearing even when they do not use a mandate
 * token: they spend the wallet's funds. Once x402 has verified the payer, block
 * every principal-bound wallet whose controlling human has paused it.
 */
export async function rejectPausedPaymentPayer(
  payer: string,
): Promise<NextResponse | null> {
  const ownership = await principalForAgentWallet(payer);
  if (!ownership?.principal.pausedAt) return null;
  return NextResponse.json(
    {
      error: "principal_paused",
      detail:
        "The controlling human paused this principal. No payment was settled and no paid action ran.",
    },
    { status: 423 },
  );
}
