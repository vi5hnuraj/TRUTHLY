"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  createChart,
  createSeriesMarkers,
  type UTCTimestamp,
} from "lightweight-charts";
import styles from "./crypto-chart.module.css";

type Bar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type BarsResponse = {
  source: string;
  interval: string;
  intervals: string[];
  data: Bar[];
  error?: string;
  detail?: string;
};

export default function CryptoChart({ postedAt }: { postedAt?: string | null }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [interval, setInterval] = useState("1h");
  const [intervals, setIntervals] = useState(["5m", "15m", "1h", "6h", "1d"]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [source, setSource] = useState("Coinbase Exchange");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const controller = new AbortController();
    setStatus("loading");

    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#080808" },
        textColor: "#858585",
        fontFamily: "var(--font-mono), monospace",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.035)" },
        horzLines: { color: "rgba(255,255,255,0.035)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
      timeScale: {
        borderColor: "rgba(255,255,255,0.08)",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 2,
        minBarSpacing: 1.5,
      },
      handleScroll: true,
      handleScale: true,
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: "#b5f20b",
      downColor: "#f04ca6",
      borderVisible: false,
      wickUpColor: "#b5f20b",
      wickDownColor: "#f04ca6",
      priceLineColor: "#b5f20b",
      priceLineStyle: 2,
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "",
    });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    void fetch(`/api/market/eth/bars?interval=${encodeURIComponent(interval)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as BarsResponse;
        if (!response.ok) throw new Error(body.detail ?? body.error ?? "Chart unavailable");
        return body;
      })
      .then((body) => {
        if (controller.signal.aborted) return;
        const bars = body.data
          .filter((bar) =>
            [bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite),
          )
          .sort((left, right) => left.time - right.time);
        if (bars.length === 0) throw new Error("No chart points returned");
        candles.setData(
          bars.map((bar) => ({
            time: bar.time as UTCTimestamp,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
          })),
        );
        volume.setData(
          bars.map((bar) => ({
            time: bar.time as UTCTimestamp,
            value: bar.volume,
            color: bar.close >= bar.open
              ? "rgba(181,242,11,0.35)"
              : "rgba(240,76,166,0.35)",
          })),
        );
        const postedMs = postedAt ? Date.parse(postedAt) : Number.NaN;
        if (Number.isFinite(postedMs)) {
          const nearest = bars.reduce((best, bar) =>
            Math.abs(bar.time * 1_000 - postedMs) < Math.abs(best.time * 1_000 - postedMs)
              ? bar
              : best,
          );
          createSeriesMarkers(candles, [{
            time: nearest.time as UTCTimestamp,
            position: "aboveBar",
            color: "#b5f20b",
            shape: "circle",
            text: "STORY",
          }]);
        }
        chart.timeScale().fitContent();
        setIntervals(body.intervals);
        setSource(body.source);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // This is a handled data-availability state. Do not use console.error:
        // Next's development overlay would turn it into a false fatal screen.
        void error;
        setStatus("error");
      });

    return () => {
      controller.abort();
      chart.remove();
    };
  }, [interval, postedAt]);

  return (
    <div className={styles.shell}>
      <div ref={hostRef} className={styles.host} />
      <div className={styles.toolbar} role="group" aria-label="ETH chart timeframe">
        <span className={styles.source}>{source} · ETH-USD</span>
        {intervals.map((option) => (
          <button
            key={option}
            type="button"
            className={option === interval ? styles.active : undefined}
            aria-pressed={option === interval}
            onClick={() => setInterval(option)}
          >
            {option}
          </button>
        ))}
      </div>
      {status !== "ready" && (
        <div className={`${styles.status} ${status === "error" ? styles.error : ""}`}>
          {status === "error" ? "Chart unavailable — no data invented" : <span />}
        </div>
      )}
    </div>
  );
}
