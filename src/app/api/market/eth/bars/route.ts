import { NextRequest, NextResponse } from "next/server";
import {
  ETH_CHART_INTERVALS,
  ethHistoricalBars,
  isEthChartInterval,
} from "@/lib/market/coinbase";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const limited = checkRateLimit(req, 30);
  if (limited) return limited;
  const requested = req.nextUrl.searchParams.get("interval") ?? "1h";
  if (!isEthChartInterval(requested)) {
    return NextResponse.json(
      { error: "invalid_interval", intervals: Object.keys(ETH_CHART_INTERVALS) },
      { status: 400 },
    );
  }
  try {
    const bars = await ethHistoricalBars(requested);
    return NextResponse.json({
      pair: "ETH-USD",
      source: bars.source,
      series_type: "candlestick",
      interval: requested,
      intervals: Object.keys(ETH_CHART_INTERVALS),
      data: bars.data,
    });
  } catch (error) {
    console.error(
      "ETH chart read failed:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json(
      { error: "chart_unavailable", detail: "No historical ETH candles were returned." },
      { status: 502 },
    );
  }
}
