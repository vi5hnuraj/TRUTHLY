import { NextRequest, NextResponse } from "next/server";
import { fetchMarketIntegritySnapshot } from "@/lib/council/market";
import { checkRateLimit } from "@/lib/rate-limit";
import { ethPriceAt } from "@/lib/market/coinbase";
import { uniswapApiConfigured } from "@/lib/uniswap/quote";

export const dynamic = "force-dynamic";

const CACHE_MS = 20_000;
let cachedMarket:
  | { at: number; value: Awaited<ReturnType<typeof fetchMarketIntegritySnapshot>> }
  | null = null;
let pendingMarket: Promise<Awaited<ReturnType<typeof fetchMarketIntegritySnapshot>>> | null = null;

async function liveMarket() {
  if (cachedMarket && Date.now() - cachedMarket.at < CACHE_MS) return cachedMarket.value;
  if (!pendingMarket) {
    pendingMarket = fetchMarketIntegritySnapshot({
      requireUniswap: false,
      notionalUsdc: "5",
      decisionOrigin: "human_mediated",
    })
      .then((value) => {
        cachedMarket = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        pendingMarket = null;
      });
  }
  return pendingMarket;
}

export async function GET(req: NextRequest) {
  const limited = checkRateLimit(req, 30);
  if (limited) return limited;
  const postedRaw = req.nextUrl.searchParams.get("posted_at");
  const postedAt = postedRaw ? new Date(postedRaw) : null;
  const validPostedAt = postedAt && Number.isFinite(postedAt.getTime()) ? postedAt : null;

  try {
    const [market, postedPrice] = await Promise.all([
      liveMarket(),
      validPostedAt ? ethPriceAt(validPostedAt) : Promise.resolve(null),
    ]);
    const current = Number(market.impliedPriceUsd);
    const sincePostedPct = postedPrice && current > 0
      ? ((current - postedPrice) / postedPrice) * 100
      : null;
    return NextResponse.json({
      pair: "ETH / USDC",
      network: "Base mainnet",
      venue: "Definitive Flash",
      reference: "Uniswap V2/V3/V4",
      current_price_usd: market.impliedPriceUsd,
      posted_price_usd: postedPrice === null ? null : postedPrice.toFixed(8),
      since_posted_pct: sincePostedPct === null ? null : Number(sincePostedPct.toFixed(4)),
      fetched_at: market.fetchedAt,
      definitive: market.executionQuote,
      uniswap: market.referenceQuote,
      integrity: market.integrity,
      uniswap_configured: uniswapApiConfigured(),
    });
  } catch (error) {
    console.error(
      "Public ETH market read failed:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json(
      {
        error: "live_market_unavailable",
        detail: "Definitive could not produce a safe ETH/USDC quote. No price was invented.",
      },
      { status: 502 },
    );
  }
}
