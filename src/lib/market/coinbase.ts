const COINBASE_EXCHANGE_API = "https://api.exchange.coinbase.com";
const BINANCE_API = "https://api.binance.com/api/v3";

export const ETH_CHART_INTERVALS = {
  "5m": { granularity: 300, windowSeconds: 24 * 60 * 60 },
  "15m": { granularity: 900, windowSeconds: 3 * 24 * 60 * 60 },
  "1h": { granularity: 3_600, windowSeconds: 12 * 24 * 60 * 60 },
  "6h": { granularity: 21_600, windowSeconds: 72 * 24 * 60 * 60 },
  "1d": { granularity: 86_400, windowSeconds: 290 * 24 * 60 * 60 },
} as const;

export type EthChartInterval = keyof typeof ETH_CHART_INTERVALS;

export interface CryptoBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CryptoBarsResult {
  source: "Coinbase Exchange" | "Binance";
  data: CryptoBar[];
}

export function isEthChartInterval(value: string): value is EthChartInterval {
  return value in ETH_CHART_INTERVALS;
}

async function coinbaseCandles(input: {
  start: Date;
  end: Date;
  granularity: number;
}): Promise<CryptoBar[]> {
  const url = new URL(`${COINBASE_EXCHANGE_API}/products/ETH-USD/candles`);
  url.searchParams.set("start", input.start.toISOString());
  url.searchParams.set("end", input.end.toISOString());
  url.searchParams.set("granularity", String(input.granularity));
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "TRUTHLY/1.0 market-chart",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Coinbase candles unavailable (${response.status})`);
  const raw: unknown = await response.json();
  if (!Array.isArray(raw)) throw new Error("Coinbase returned an invalid candle response");
  const bars = raw.flatMap((entry): CryptoBar[] => {
    if (!Array.isArray(entry) || entry.length < 6) return [];
    const [time, low, high, open, close, volume] = entry.map(Number);
    if (![time, low, high, open, close, volume].every(Number.isFinite)) return [];
    if (time <= 0 || low <= 0 || high <= 0 || open <= 0 || close <= 0) return [];
    return [{ time, low, high, open, close, volume }];
  });
  bars.sort((left, right) => left.time - right.time);
  return bars;
}

const BINANCE_INTERVALS: Record<EthChartInterval, string> = {
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "6h": "6h",
  "1d": "1d",
};

async function binanceCandles(input: {
  start: Date;
  end: Date;
  interval: EthChartInterval;
}): Promise<CryptoBar[]> {
  const url = new URL(`${BINANCE_API}/klines`);
  url.searchParams.set("symbol", "ETHUSDT");
  url.searchParams.set("interval", BINANCE_INTERVALS[input.interval]);
  url.searchParams.set("startTime", String(input.start.getTime()));
  url.searchParams.set("endTime", String(input.end.getTime()));
  url.searchParams.set("limit", "300");
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "TRUTHLY/1.0 market-chart",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Binance candles unavailable (${response.status})`);
  const raw: unknown = await response.json();
  if (!Array.isArray(raw)) throw new Error("Binance returned an invalid candle response");
  const bars = raw.flatMap((entry): CryptoBar[] => {
    if (!Array.isArray(entry) || entry.length < 6) return [];
    const time = Number(entry[0]) / 1_000;
    const open = Number(entry[1]);
    const high = Number(entry[2]);
    const low = Number(entry[3]);
    const close = Number(entry[4]);
    const volume = Number(entry[5]);
    if (![time, low, high, open, close, volume].every(Number.isFinite)) return [];
    if (time <= 0 || low <= 0 || high <= 0 || open <= 0 || close <= 0) return [];
    return [{ time: Math.floor(time), low, high, open, close, volume }];
  });
  bars.sort((left, right) => left.time - right.time);
  return bars;
}

export async function ethHistoricalBars(
  interval: EthChartInterval,
  now = new Date(),
): Promise<CryptoBarsResult> {
  const config = ETH_CHART_INTERVALS[interval];
  const start = new Date(now.getTime() - config.windowSeconds * 1_000);
  try {
    const data = await coinbaseCandles({ start, end: now, granularity: config.granularity });
    if (data.length > 0) return { source: "Coinbase Exchange", data };
  } catch {
    // A second independent public venue keeps the chart available when Coinbase
    // is temporarily empty, rate-limited or unreachable. It never changes the
    // Definitive execution price or the Uniswap integrity decision.
  }
  const data = await binanceCandles({ start, end: now, interval });
  if (data.length === 0) throw new Error("No historical ETH candles were returned");
  return { source: "Binance", data };
}

export async function ethPriceAt(at: Date): Promise<number | null> {
  if (!Number.isFinite(at.getTime())) return null;
  const start = new Date(at.getTime() - 90 * 60_000);
  const end = new Date(at.getTime() + 90 * 60_000);
  try {
    const bars = await coinbaseCandles({ start, end, granularity: 300 });
    const nearest = bars.reduce<CryptoBar | null>((best, bar) => {
      if (!best) return bar;
      return Math.abs(bar.time * 1_000 - at.getTime()) <
        Math.abs(best.time * 1_000 - at.getTime())
        ? bar
        : best;
    }, null);
    return nearest?.close ?? null;
  } catch {
    try {
      const bars = await binanceCandles({ start, end, interval: "5m" });
      const nearest = bars.reduce<CryptoBar | null>((best, bar) => {
        if (!best) return bar;
        return Math.abs(bar.time * 1_000 - at.getTime()) <
          Math.abs(best.time * 1_000 - at.getTime())
          ? bar
          : best;
      }, null);
      return nearest?.close ?? null;
    } catch {
      return null;
    }
  }
}
