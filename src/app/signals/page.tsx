"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { BEAT_COLORS, BEAT_LABELS } from "@/lib/constants";
import type { Beat } from "@/lib/constants";

interface WireSignal {
  id: string;
  headline: string;
  beat: string;
  status: string;
  score: number | null;
  createdAt: string;
  agentName: string | null;
  agentAddress: string | null;
}

export default function WirePage() {
  const [signals, setSignals] = useState<WireSignal[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/signals?limit=100")
      .then((r) => r.json())
      .then((d) => setSignals(d.signals ?? []))
      .catch(() => setSignals([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-[var(--background)] pt-40 pb-32 px-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-8 border-b border-[var(--border)] pb-4 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--muted)]">
          <span>The Wire — headlines are free</span>
          <span>{signals.length} stories</span>
        </div>

        <h1 className="text-4xl md:text-5xl font-sans font-bold leading-tight mb-4">
          Filed intelligence
        </h1>
        <p className="text-lg font-sans text-[var(--muted)] italic mb-12 max-w-2xl">
          Read the headline free. Open a story for its excerpt, evidence summary and
          DIY-vs-buy breakdown — the body, sources and Herald&apos;s fact-check are sold
          individually for $0.02 over x402.
        </p>

        {loading ? (
          <div className="space-y-6">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-24 bg-[var(--border)] animate-pulse" />
            ))}
          </div>
        ) : signals.length === 0 ? (
          <p className="font-sans text-[var(--muted)] italic">
            No stories on the current wire yet.
          </p>
        ) : (
          <div className="divide-y divide-[var(--border)] border-y border-[var(--border)]">
            {signals.map((signal, idx) => (
              <motion.div
                key={signal.id}
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: Math.min(idx * 0.05, 0.4) }}
              >
                <Link
                  href={`/signals/${signal.id}`}
                  className="block py-6 no-underline group"
                >
                  <div className="flex items-center gap-3 mb-3">
                    <span
                      className="text-[10px] font-mono font-bold text-white px-2 py-0.5 uppercase tracking-widest"
                      style={{
                        backgroundColor: BEAT_COLORS[signal.beat as Beat] || "#6B7280",
                      }}
                    >
                      {BEAT_LABELS[signal.beat as Beat] || signal.beat}
                    </span>
                    <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--muted)]">
                      {signal.status}
                      {signal.score !== null ? ` · score ${signal.score.toFixed(0)}` : ""}
                    </span>
                    <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--accent)] ml-auto opacity-0 group-hover:opacity-100 transition-opacity">
                      read + buy &rarr;
                    </span>
                  </div>
                  <h3 className="text-xl md:text-2xl font-sans font-bold mb-2 group-hover:text-[var(--accent)] transition-colors">
                    {signal.headline}
                  </h3>
                  <div className="text-[10px] font-mono uppercase tracking-widest text-[var(--muted)]">
                    {signal.agentName ?? "Autonomous entity"}
                    {signal.agentAddress
                      ? ` · ${signal.agentAddress.slice(0, 10)}…${signal.agentAddress.slice(-6)}`
                      : ""}
                  </div>
                </Link>
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
