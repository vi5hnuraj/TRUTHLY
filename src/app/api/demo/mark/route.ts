import { NextRequest, NextResponse } from "next/server";
import * as z from "zod";
import { checkRateLimit } from "@/lib/rate-limit";
import { demoDisabledResponse, demoModeEnabled } from "@/lib/council/mode";
import {
  fetchMarketIntegritySnapshot,
  publicMarketIntegritySnapshot,
} from "@/lib/council/market";
import { markPaperExecution, paperExecutionById, publicPaperExecution } from "@/lib/council/paper";

const schema = z.object({ paper_execution_id: z.string().uuid() }).strict();

export async function POST(req: NextRequest) {
  if (!demoModeEnabled()) return demoDisabledResponse();
  const limited = checkRateLimit(req, 30);
  if (limited) return limited;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_mark_request" }, { status: 400 });
  const execution = await paperExecutionById(parsed.data.paper_execution_id);
  if (!execution) return NextResponse.json({ error: "paper_execution_not_found" }, { status: 404 });

  try {
    const market = await fetchMarketIntegritySnapshot({
      requireUniswap: false,
      notionalUsdc: execution.notionalUsdc,
      decisionOrigin: "human_mediated",
    });
    const mark = await markPaperExecution(execution.id, market);
    const updated = await paperExecutionById(execution.id);
    return NextResponse.json({
      mode: "demo",
      label:
        market.integrity.status === "verified"
          ? "PAPER MARK — HYPOTHETICAL P&L FROM SUBSEQUENT REAL DEFINITIVE + UNISWAP MARKET READS"
          : "PAPER MARK — HYPOTHETICAL P&L FROM A REAL DEFINITIVE READ; UNISWAP REFERENCE UNAVAILABLE",
      market_integrity: publicMarketIntegritySnapshot(market),
      paper_execution: updated ? publicPaperExecution(updated) : null,
      mark: mark
        ? {
            market_price_usd: mark.marketPriceUsd,
            hypothetical_pnl_percent: mark.hypotheticalPnlPercent,
            outcome: mark.outcome,
            provider_quote_id: mark.providerQuoteId,
            marked_at: mark.markedAt,
            transaction_hash: null,
          }
        : null,
    });
  } catch (error) {
    return NextResponse.json(
      { error: "paper_mark_failed", detail: error instanceof Error ? error.message : "Mark failed." },
      { status: 502 },
    );
  }
}
