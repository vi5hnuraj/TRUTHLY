"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import { BEAT_COLORS, BEAT_LABELS } from "@/lib/constants";
import type { Beat } from "@/lib/constants";

interface Teaser {
  signal: {
    id: string;
    headline: string;
    beat: string;
    score: number | null;
    status: string;
    created_at: string;
    edition_number: number | null;
    reporter: { name: string; address: string };
  };
  excerpt: string;
  withdrawn_notice: string | null;
  evidence_summary: {
    verdict: string | null;
    source_count: number;
    independent_owner_groups: number;
    claim_count: number;
    snapshot_count: number;
    stake_status: string;
    stake_locked: string;
  };
  act_on: { world_market_search: string | null; tokens: string[] };
  price: {
    cents: number;
    usd: string;
    network: string;
    endpoint: string;
    re_read_header: string;
    mcp_tool: string;
    for_sale: boolean;
  };
  diy_vs_buy: {
    price_cents: number;
    price_usd: string;
    buy: { cost_usd: string; gets: string[] };
    diy: {
      filing_stake_cents: number;
      fact_check_atomic: string | null;
      fact_check_usd: string | null;
      steps: string[];
      note: string;
    };
    full_edition: { price_cents: number; detail: string };
    verdict: string;
  };
  purchase_note: string;
}

interface HistoryEntry {
  action: string;
  reason: string;
  actor: string;
  at: string;
}

const VERDICT_LABELS: Record<string, string> = {
  supported: "Herald: verified",
  partially_supported: "Herald: partly verified",
  contradicted: "Herald: sources contradict this",
  unsupported: "Herald: not backed",
  unchecked: "Herald: unchecked",
};

export default function SignalPage() {
  const params = useParams();
  const [teaser, setTeaser] = useState<Teaser | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [shareStatus, setShareStatus] = useState("");
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const id = String(params.id);
    Promise.all([
      fetch(`/api/signals/${id}`).then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
      fetch(`/api/signals/${id}/history`)
        .then((r) => (r.ok ? r.json() : { history: [] }))
        .catch(() => ({ history: [] })),
    ])
      .then(([data, hist]) => {
        setTeaser(data);
        setHistory(hist.history ?? []);
      })
      .catch(() => setMissing(true))
      .finally(() => setLoading(false));
  }, [params.id]);

  if (loading)
    return (
      <div className="min-h-screen bg-[var(--background)] pt-40 px-6 flex justify-center">
        <div className="max-w-4xl w-full animate-pulse space-y-8">
          <div className="h-4 w-32 bg-[var(--border)]" />
          <div className="h-12 w-full bg-[var(--border)]" />
          <div className="h-40 w-full bg-[var(--border)]" />
        </div>
      </div>
    );

  if (missing || !teaser)
    return (
      <div className="min-h-screen bg-[var(--background)] pt-40 px-6 text-center">
        <h1 className="font-sans text-3xl font-bold uppercase">Story Not Found</h1>
        <p className="mt-4 text-[var(--muted)] font-sans italic">
          This story is not on the current wire.
        </p>
        <Link href="/signals" className="mt-6 inline-block font-mono text-xs uppercase tracking-widest">
          &larr; Back to the wire
        </Link>
      </div>
    );

  const { signal, evidence_summary: evidence, diy_vs_buy: compare, price } = teaser;

  async function shareBrief() {
    const url = window.location.href;
    const text = `${signal.headline} — verified TRUTHLY trade brief. Followers buy their own evidence receipt and approve their own protected order.`;
    try {
      if (navigator.share) {
        await navigator.share({ title: signal.headline, text, url });
        setShareStatus("Shared");
      } else {
        await navigator.clipboard.writeText(url);
        setShareStatus("Link copied");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setShareStatus("Could not share");
    }
  }

  return (
    <div className="min-h-screen bg-[var(--background)] pt-40 pb-32 px-6">
      <motion.article
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-4xl mx-auto"
      >
        <header className="mb-10">
          <div className="flex flex-wrap items-center gap-3 mb-6 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--muted)]">
            <span
              className="text-white px-2 py-1"
              style={{ backgroundColor: BEAT_COLORS[signal.beat as Beat] || "#6B7280" }}
            >
              {BEAT_LABELS[signal.beat as Beat] || signal.beat}
            </span>
            <span>{signal.status}</span>
            {signal.score !== null && <span>score {signal.score.toFixed(0)}</span>}
            {signal.edition_number !== null && <span>edition #{signal.edition_number}</span>}
            <span>{new Date(signal.created_at).toLocaleDateString("en-US")}</span>
          </div>

          <h1 className="text-3xl md:text-5xl font-sans font-bold leading-tight mb-6">
            {signal.headline}
          </h1>

          <div className="text-[10px] font-mono uppercase tracking-widest text-[var(--muted)]">
            Filed by {signal.reporter.name}
            {signal.reporter.address
              ? ` · ${signal.reporter.address.slice(0, 10)}…${signal.reporter.address.slice(-6)}`
              : ""}
          </div>
          <div className="flex flex-wrap items-center gap-3 mt-6">
            <button
              type="button"
              onClick={() => void shareBrief()}
              className="border border-[var(--border)] px-4 py-2 font-mono text-[10px] uppercase tracking-widest"
            >
              Share verified brief
            </button>
            <Link
              href={`/trades?signal=${signal.id}`}
              className="border border-[var(--foreground)] px-4 py-2 font-mono text-[10px] uppercase tracking-widest no-underline"
            >
              Build protected Flash order →
            </Link>
            {shareStatus && (
              <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--muted)]">
                {shareStatus}
              </span>
            )}
          </div>
          <p className="mt-3 font-sans text-xs text-[var(--muted)] italic">
            The public link contains no private receipt, wallet credential, size,
            or order. Every follower buys the evidence and approves an independent
            limit + take-profit/stop-loss bracket.
          </p>
        </header>

        {teaser.withdrawn_notice && (
          <div className="border border-[var(--accent)] p-6 mb-12 font-sans text-[var(--accent)] italic">
            {teaser.withdrawn_notice}
          </div>
        )}

        {/* Free excerpt — the sample, never the product */}
        <section className="mb-16">
          <div className="flex items-center justify-between border-b border-[var(--border)] pb-2 mb-4">
            <h3 className="font-mono text-xs uppercase tracking-[0.2em] font-bold text-[var(--muted)]">
              Free excerpt
            </h3>
            <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--accent)]">
              the rest is paid
            </span>
          </div>
          <p className="text-xl font-sans leading-relaxed text-[var(--foreground)]">
            {teaser.excerpt || "No excerpt: this story is no longer published."}
          </p>
        </section>

        {/* Evidence summary */}
        <section className="mb-16">
          <h3 className="font-mono text-xs uppercase tracking-[0.2em] font-bold text-[var(--muted)] border-b border-[var(--border)] pb-2 mb-6">
            Evidence summary
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            {[
              { value: evidence.verdict ? VERDICT_LABELS[evidence.verdict] ?? evidence.verdict : "unverified", label: "Fact-check" },
              { value: String(evidence.source_count), label: "Sources" },
              { value: String(evidence.independent_owner_groups), label: "Independent owners" },
              { value: String(evidence.claim_count), label: "Structured claims" },
              { value: String(evidence.snapshot_count), label: "Archived snapshots" },
              { value: evidence.stake_status, label: "Reporter stake" },
              { value: evidence.stake_locked, label: "Stake locked" },
              { value: compare.verdict, label: "Verdict" },
            ].map((cell) => (
              <div key={cell.label} className="border-l border-[var(--border)] pl-4">
                <div className="text-lg font-sans font-bold capitalize">{cell.value}</div>
                <div className="text-[10px] font-mono uppercase tracking-widest text-[var(--muted)]">
                  {cell.label}
                </div>
              </div>
            ))}
          </div>
          {teaser.act_on.tokens.length > 0 && (
            <p className="mt-6 font-mono text-[10px] uppercase tracking-widest text-[var(--muted)]">
              Action hints: {teaser.act_on.tokens.join(", ")}
              {teaser.act_on.world_market_search
                ? ` · world market search: "${teaser.act_on.world_market_search}"`
                : ""}
            </p>
          )}
        </section>

        {/* DIY vs buy */}
        <section className="mb-16">
          <h3 className="font-mono text-xs uppercase tracking-[0.2em] font-bold text-[var(--muted)] border-b border-[var(--border)] pb-2 mb-6">
            DIY vs buy
          </h3>
          <div className="grid md:grid-cols-2 gap-6">
            <div className="border border-[var(--accent)] p-6 bg-[var(--card)]">
              <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--accent)] font-bold mb-3">
                Buy it — ${compare.price_usd}
              </div>
              <ul className="space-y-2">
                {compare.buy.gets.map((item) => (
                  <li key={item} className="font-sans text-sm text-[var(--foreground)]">
                    &middot; {item}
                  </li>
                ))}
              </ul>
              <p className="mt-4 font-mono text-[10px] uppercase tracking-widest text-[var(--muted)]">
                {compare.full_edition.detail}
              </p>
            </div>
            <div className="border border-[var(--border)] p-6 bg-[var(--card)]">
              <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--muted)] font-bold mb-3">
                Build it yourself
              </div>
              <ul className="space-y-2 mb-4">
                {compare.diy.steps.map((step) => (
                  <li key={step} className="font-sans text-sm text-[var(--muted)]">
                    &middot; {step}
                  </li>
                ))}
              </ul>
              <p className="font-mono text-[10px] uppercase tracking-widest text-[var(--accent)]">
                Cash alone: {compare.diy.filing_stake_cents}&cent; stake
                {compare.diy.fact_check_usd ? ` + $${compare.diy.fact_check_usd} fact-check` : ""}
              </p>
              <p className="mt-3 font-sans text-xs text-[var(--muted)] italic">{compare.diy.note}</p>
            </div>
          </div>
        </section>

        {/* Paywall */}
        {price.for_sale && (
          <div className="border border-[var(--border-strong)] p-8 md:p-12 mb-16 text-center bg-[var(--card)]">
            <div className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--accent)] font-bold mb-4">
              x402 Paywall
            </div>
            <h3 className="font-sans text-2xl font-bold mb-4">
              Full story for ${price.usd} USDC
            </h3>
            <p className="font-sans text-[var(--muted)] italic mb-8 max-w-xl mx-auto">
              {teaser.purchase_note}
            </p>
            <code className="block font-mono text-xs bg-[var(--background)] border border-[var(--border)] px-4 py-3 mb-6">
              {price.endpoint}
            </code>
            <a
              href="/llms.txt"
              style={{ backgroundColor: "var(--foreground)", color: "var(--background)" }}
              className="inline-block font-mono text-xs uppercase tracking-[0.15em] font-bold px-8 py-4 hover:opacity-80 transition-opacity"
            >
              Buy it with your agent &rarr;
            </a>
            <p className="mt-4 font-sans text-sm text-[var(--muted)] italic max-w-lg mx-auto">
              Ask your agent to call the TRUTHLY MCP tool <code>{price.mcp_tool}</code>: the x402 client
              shows the ${price.usd} approval, pays on {price.network}, and returns the story
              plus a receipt.
            </p>
            <p className="mt-6 font-mono text-[9px] text-[var(--muted)] uppercase tracking-widest leading-relaxed max-w-lg mx-auto">
              Re-read free with <code>{price.re_read_header}</code>. That receipt is also the
              proof a Flash trade on this story must present — no receipt, no trade.
            </p>
          </div>
        )}

        {/* Correction history */}
        {history.length > 0 && (
          <section className="mb-16">
            <h3 className="font-mono text-xs uppercase tracking-[0.2em] font-bold text-[var(--muted)] border-b border-[var(--border)] pb-2 mb-6">
              Correction history
            </h3>
            <div className="space-y-4">
              {history.map((entry, idx) => (
                <div key={`${entry.at}-${idx}`} className="border-l border-[var(--border)] pl-4">
                  <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--accent)]">
                    {entry.action} · {new Date(entry.at).toLocaleString()}
                  </div>
                  <div className="font-sans text-sm text-[var(--muted)]">
                    {entry.reason} — {entry.actor}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <div className="flex items-center justify-between border-t border-[var(--border)] pt-6 font-mono text-[10px] uppercase tracking-widest text-[var(--muted)]">
          <Link href="/signals" className="hover:text-[var(--foreground)]">
            &larr; Back to the wire
          </Link>
          <Link href="/trades" className="hover:text-[var(--foreground)]">
            Trade desk &rarr;
          </Link>
        </div>
      </motion.article>
    </div>
  );
}
