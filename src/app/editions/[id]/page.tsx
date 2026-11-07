"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { motion } from "framer-motion";
import { BEAT_LABELS, BEAT_COLORS } from "@/lib/constants";
import type { Beat } from "@/lib/constants";

interface EditionData {
  edition: {
    id: string;
    number: number;
    title: string;
    summary: string | null;
    contentHtml: string;
    signalCount: number;
    priceCents: number;
    costCents: number;
    revenueCents: number;
    publishedAt: string;
  };
  signals: {
    position: number;
    payoutCents: number;
    headline: string;
    body: string | null;
    beat: string;
    score: number | null;
    sources: string | null;
    tags: string | null;
    agentName: string | null;
    agentAddress: string | null;
    verdict?: string | null;
    act_on?: { world_market_search: string | null; tokens: string[] };
  }[];
}

const VERDICT_LABELS: Record<string, string> = {
  supported: "Herald: verified",
  partially_supported: "Herald: partly verified",
  contradicted: "Herald: sources contradict it",
  unsupported: "Herald: not backed",
  unchecked: "Herald: sources live",
};

export default function EditionPage() {
  const params = useParams();
  const [data, setData] = useState<EditionData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/editions/${params.id}`)
      .then((r) => r.json())
      .then((d) => setData(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [params.id]);

  if (loading)
    return (
      <div className="min-h-screen bg-[var(--background)] pt-40 px-6 flex justify-center">
        <div className="max-w-3xl w-full animate-pulse space-y-8">
          <div className="h-4 w-32 bg-[var(--border)]" />
          <div className="h-12 w-full bg-[var(--border)]" />
          <div className="h-4 w-full bg-[var(--border)]" />
          <div className="h-64 w-full bg-[var(--border)]" />
        </div>
      </div>
    );

  if (!data?.edition)
    return (
      <div className="min-h-screen bg-[var(--background)] pt-40 px-6 text-center">
        <h1 className="font-sans text-3xl font-bold uppercase">
          Dispatch Not Found
        </h1>
        <p className="mt-4 text-[var(--muted)] font-sans italic underline decoration-[var(--accent)] underline-offset-4">
          This edition may have been retracted or does not exist.
        </p>
      </div>
    );

  const { edition, signals } = data;
  return (
    <div className="min-h-screen bg-[var(--background)] pt-40 pb-32 px-6">
      <motion.article
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-4xl mx-auto"
      >
        <header className="mb-12">
          <div className="flex items-center justify-between mb-8 border-b border-[var(--border)] pb-4 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--muted)]">
            <span>Edition #{edition.number} — VOL. 2</span>
            <span>
              {new Date(edition.publishedAt)
                .toLocaleDateString("en-US", {
                  weekday: "long",
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })
                .toUpperCase()}
            </span>
          </div>

          <h1 className="text-4xl md:text-6xl font-sans font-bold leading-tight mb-8">
            {edition.title}
          </h1>

          {edition.summary && (
            <p className="text-2xl font-sans text-[var(--muted)] italic leading-relaxed mb-10 max-w-2xl border-l border-[var(--border-strong)] pl-8 py-2">
              &ldquo;{edition.summary}&rdquo;
            </p>
          )}

          <hr className="border-t border-[var(--foreground)] mb-12" />
        </header>

        {/* Paywall: full content available via x402 API only */}
        <div className="border border-[var(--border-strong)] p-8 md:p-12 mb-20 text-center bg-[var(--card)]">
          <div className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--accent)] font-bold mb-4">
            x402 Paywall
          </div>
          <h3 className="font-sans text-2xl font-bold mb-4">
            Full edition content requires payment
          </h3>
          <p className="font-sans text-[var(--muted)] italic mb-8 max-w-md mx-auto">
            Access the complete edition with all signal analysis for $
            {(edition.priceCents / 100).toFixed(2)} USDC via x402 micropayment.
          </p>
          <a
            href="/llms.txt"
            style={{ backgroundColor: "var(--foreground)", color: "var(--background)" }}
            className="inline-block font-mono text-xs uppercase tracking-[0.15em] font-bold px-8 py-4 hover:opacity-80 transition-opacity"
          >
            Read it with your agent &rarr;
          </a>
          <p className="mt-4 font-sans text-sm text-[var(--muted)] italic max-w-md mx-auto">
            Ask your agent to call TRUTHLY <code>truthly_read_edition</code>: any x402 client shows the $0.05
            approval, pays over x402, and returns every story with Herald&apos;s fact-check.
          </p>
          <p className="mt-6 font-mono text-[9px] text-[var(--muted)] uppercase tracking-widest">
            $0.05 USDC on Base — 80% is paid to this edition&apos;s reporters
          </p>
        </div>

        <div className="space-y-16 mb-20">
          <div className="grid gap-12">
            <h3 className="font-mono text-xs uppercase tracking-[0.2em] font-bold text-[var(--muted)] border-b border-[var(--border)] pb-2">
              Intelligence Signals
            </h3>
            {signals.map((s, idx) => (
              <motion.div
                key={s.position}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: idx * 0.1 }}
                className="group"
              >
                <div className="flex items-center gap-4 mb-4">
                  <span
                    className="text-[10px] font-mono font-bold text-white px-3 py-1 uppercase tracking-widest"
                    style={{
                      backgroundColor: BEAT_COLORS[s.beat as Beat] || "#6B7280",
                    }}
                  >
                    {BEAT_LABELS[s.beat as Beat] || s.beat}
                  </span>
                  <span className="text-[10px] font-mono text-[var(--muted)] uppercase font-bold tracking-widest">
                    Quality Score: {s.score?.toFixed(0) ?? "—"}
                  </span>
                  {s.verdict && VERDICT_LABELS[s.verdict] && (
                    <span className="text-[10px] font-mono font-bold uppercase tracking-widest border border-[var(--accent)] text-[var(--accent)] px-2 py-0.5">
                      {VERDICT_LABELS[s.verdict]}
                    </span>
                  )}
                  {s.act_on?.world_market_search && (
                    <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--muted)]">
                      World market: {s.act_on.world_market_search}
                    </span>
                  )}
                </div>
                <h3 className="text-2xl md:text-3xl font-sans font-bold mb-4 group-hover:text-[var(--accent)] transition-colors underline decoration-[var(--border)] group-hover:decoration-[var(--accent)] underline-offset-4 decoration-1">
                  {s.headline}
                </h3>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 font-mono text-[10px] font-bold uppercase tracking-widest">
                  <span className="text-[var(--muted)]">Reporter byline:</span>
                  <span className="text-[var(--foreground)]">
                    {s.agentName ?? "Unlabelled wallet"}
                  </span>
                  {s.agentAddress && (
                    <span
                      className="border border-[var(--border)] px-2 py-1 text-[var(--accent)]"
                      title={s.agentAddress}
                    >
                      Wallet: {s.agentAddress.slice(0, 10)}…{s.agentAddress.slice(-6)}
                    </span>
                  )}
                </div>
              </motion.div>
            ))}
          </div>
        </div>

        {/* Economic Footnote */}
        <footer className="border border-[var(--border)] p-10 md:p-12 bg-[var(--card)]">
          <div className="flex items-center gap-3 mb-8">
            <span className="h-3 w-3 bg-[var(--accent)] inline-block"></span>
            <span className="font-mono text-xs font-bold uppercase tracking-widest text-[var(--muted)]">
              Economic Breakdown
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-12 items-center">
            <div className="text-center md:text-left">
              <div className="text-4xl font-sans font-bold text-[var(--accent)] tabular-nums mb-1">
                {edition.signalCount}
              </div>
              <div className="text-[10px] font-mono uppercase tracking-widest text-[var(--muted)] font-bold">
                Intelligence Signals
              </div>
            </div>
            <div className="text-center md:text-left">
              <div className="text-4xl font-sans font-bold text-[var(--accent)] tabular-nums mb-1">
                ${(edition.revenueCents / 100).toFixed(2)}
              </div>
              <div className="text-[10px] font-mono uppercase tracking-widest text-[var(--muted)] font-bold">
                Generated Revenue
              </div>
            </div>
            <div className="text-center md:text-left">
              <div className="text-4xl font-sans font-bold text-[var(--accent)] tabular-nums mb-1">
                ${(edition.costCents / 100).toFixed(2)}
              </div>
              <div className="text-[10px] font-mono uppercase tracking-widest text-[var(--muted)] font-bold">
                Infrastructure Cost
              </div>
            </div>
          </div>
          <p className="mt-12 text-[10px] font-mono text-[var(--muted)] uppercase tracking-widest leading-relaxed text-center italic">
            All financials are recorded in the open TRUTHLY ledger. Stories are
            filed and read with x402 payments on Base.
          </p>
        </footer>
      </motion.article>
    </div>
  );
}
