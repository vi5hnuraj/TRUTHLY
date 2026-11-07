"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";

interface LedgerEntry {
  id: string;
  type: "revenue" | "expense" | "payout" | "refund";
  amountCents: number;
  description: string;
  fromAddress: string | null;
  toAddress: string | null;
  txHash: string | null;
  editionId: string | null;
  createdAt: string;
}

interface Proof {
  distinct_payer_wallets: number;
  reporter_wallets: number;
  herald_checks: number;
  herald_briefs?: number;
  herald_ai_spend_usd: string;
  paid_onchain_usd: string;
  newsroom_wallet: string;
  newsroom_explorer: string;
}

interface Financials {
  revenueCents: number;
  receivedCents?: number;
  expenseCents: number;
  payoutCents: number;
  refundCents?: number;
  profitCents: number;
  paymentRevenueCents?: number;
  entries: LedgerEntry[];
  proof?: Proof;
}

// The builder-funded staff desk used for the first filings and reads (disclosed in JUDGES.md).
const HOUSE_DESK = "0x4ccb868a7bd4fd91c366903f9f0cc94fdc199ebf";

function centsToDisplay(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Whole cents as $0.00; sub-cent amounts (Herald's AI spend) keep four decimals. */
function usd(dollars: number): string {
  const cents = dollars * 100;
  return Math.abs(cents - Math.round(cents)) < 1e-6 ? `$${dollars.toFixed(2)}` : `$${dollars.toFixed(4)}`;
}

function shortAddress(addr: string | null): string {
  if (!addr) return "—";
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).toUpperCase();
}

const TYPE_BADGE: Record<LedgerEntry["type"], { label: string; classes: string }> = {
  revenue: { label: "REVENUE", classes: "bg-green-100 text-green-800 border border-green-400" },
  payout: { label: "PAYOUT", classes: "bg-orange-100 text-[var(--accent)] border border-[var(--accent)]" },
  expense: { label: "EXPENSE", classes: "bg-red-100 text-red-700 border border-red-400" },
  refund: { label: "STAKE REFUND", classes: "bg-blue-100 text-blue-800 border border-blue-400" },
};

function StatCardSkeleton() {
  return (
    <div className="border border-[var(--border)] bg-[var(--card)] p-10 animate-pulse">
      <div className="h-3 w-24 bg-[var(--border)] mb-6 rounded" />
      <div className="h-14 w-36 bg-[var(--border)] mb-4 rounded" />
      <div className="h-3 w-16 bg-[var(--border)] rounded" />
    </div>
  );
}

function LedgerRowSkeleton() {
  return (
    <tr className="border-b border-[var(--border)]">
      {[1, 2, 3, 4, 5].map((i) => (
        <td key={i} className="px-6 py-5">
          <div className="h-3 bg-[var(--border)] animate-pulse rounded w-full max-w-[120px]" />
        </td>
      ))}
    </tr>
  );
}

const containerVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.1 } },
};

const itemVariants = {
  hidden: { opacity: 0, y: 24 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] as const } },
};

export default function FinancialsPage() {
  const [data, setData] = useState<Financials | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/financials")
      .then((r) => r.json())
      .then((d: Financials) => setData(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const revenueUsd = (data?.revenueCents ?? 0) / 100;
  const receivedUsd = (data?.receivedCents ?? data?.revenueCents ?? 0) / 100;
  const elsewhereCents = (data?.revenueCents ?? 0) - (data?.receivedCents ?? data?.revenueCents ?? 0);
  // Settled on Base (payout rows with a tx hash), not just credited.
  const payoutUsd = Number(data?.proof?.paid_onchain_usd ?? (data?.payoutCents ?? 0) / 100);
  const refundUsd = (data?.refundCents ?? 0) / 100;
  const costUsd = (data?.expenseCents ?? 0) / 100 + Number(data?.proof?.herald_ai_spend_usd ?? 0);
  const stats = [
    {
      label: "REVENUE",
      value: loading ? null : usd(revenueUsd),
      note:
        elsewhereCents > 0
          ? `x402 reads and filing fees · ${centsToDisplay(elsewhereCents)} went to an earlier treasury`
          : "x402 reads and filing fees received",
    },
    {
      label: "PAID TO REPORTERS",
      value: loading ? null : usd(payoutUsd),
      note: "80% of every read, sent on-chain",
    },
    {
      label: "COSTS (HERALD AI)",
      value: loading ? null : usd(costUsd),
      note: "Fact-checks and briefs, paid per call via x402",
    },
    {
      label: "NEWSROOM NET",
      value: loading ? null : usd(receivedUsd - payoutUsd - refundUsd - costUsd),
      note: refundUsd > 0 ? `After $${refundUsd.toFixed(2)} in filing-stake refunds` : "Left in the newsroom wallet",
    },
  ];

  // The 80/20 split applies to reads; filing fees fund Herald's fact-checks instead.
  const readRevenue = data?.paymentRevenueCents ?? 0;
  const payouts = data?.payoutCents ?? 0;
  const agentPct = readRevenue > 0 ? Math.min(100, Math.round((payouts / readRevenue) * 100)) : 80;
  const platformPct = 100 - agentPct;

  return (
    <div className="min-h-screen bg-[var(--background)] pt-32 pb-24 px-6">
      <div className="max-w-6xl mx-auto">

        {/* Page Header */}
        <motion.header
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="mb-16 border-b border-[var(--border)] pb-10"
        >
          <div className="flex items-center gap-3 mb-5">
            <span className="h-3 w-3 bg-[var(--accent)] inline-block" />
            <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-[var(--muted)]">
              Open Ledger / Transparent Accounting
            </span>
          </div>
          <h1 className="font-sans text-5xl md:text-7xl font-bold uppercase tracking-tighter mb-6 leading-[0.9]">
            Platform{" "}
            <span className="italic text-[var(--accent)] font-light lowercase">Financials</span>
          </h1>
          <p className="font-sans text-xl text-[var(--muted)] italic max-w-2xl leading-relaxed">
            Every cent earned, paid out and spent — published in full. Every flow is an x402
            payment on Base mainnet; each row links to its transaction.
          </p>
          {data?.proof && (
            <div className="mt-8 grid grid-cols-2 md:grid-cols-4 border border-[var(--border)] font-mono text-[10px] uppercase tracking-widest">
              {[
                ["Distinct paying wallets", String(data.proof.distinct_payer_wallets)],
                ["Paid to reporters on-chain", `$${data.proof.paid_onchain_usd}`],
                ["Herald paid AI calls", `${data.proof.herald_checks + (data.proof.herald_briefs ?? 0)} · $${data.proof.herald_ai_spend_usd}`],
                ["Reporter wallets", String(data.proof.reporter_wallets)],
              ].map(([label, value]) => (
                <div key={label} className="p-4 border-r last:border-r-0 border-[var(--border)]">
                  <div className="text-[var(--muted)] font-bold">{label}</div>
                  <div className="mt-2 text-lg font-bold text-[var(--foreground)] normal-case tracking-normal">{value}</div>
                </div>
              ))}
            </div>
          )}
          {data?.proof?.newsroom_explorer && (
            <a
              href={data.proof.newsroom_explorer}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block mt-4 font-mono text-[10px] uppercase tracking-widest font-bold text-[var(--accent)] underline underline-offset-4"
            >
              Newsroom wallet on BaseScan ↗
            </a>
          )}
        </motion.header>

        {/* Stat Cards */}
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-0 border border-[var(--border)] mb-16">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className={`border-b sm:border-b-0 sm:border-r border-[var(--border)] last:border-r-0 ${i > 2 ? "border-t sm:border-t-0" : ""}`}>
                <StatCardSkeleton />
              </div>
            ))}
          </div>
        ) : (
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate="visible"
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 border border-[var(--border)] mb-16 "
          >
            {stats.map((stat, idx) => (
              <motion.div
                key={stat.label}
                variants={itemVariants}
                className={`p-10 bg-[var(--card)] ${idx < stats.length - 1 ? "border-b-2 lg:border-b-0 lg:border-r border-[var(--border)]" : ""}`}
              >
                <p className="font-mono text-[10px] font-bold uppercase tracking-[0.25em] text-[var(--muted)] mb-5">
                  {stat.label}
                </p>
                <p className="font-sans text-4xl md:text-5xl font-bold tabular-nums tracking-tighter text-[var(--foreground)] mb-3">
                  {stat.value}
                </p>
                <p className="font-mono text-[9px] uppercase tracking-widest text-[var(--muted)] font-bold">
                  {stat.note}
                </p>
              </motion.div>
            ))}
          </motion.div>
        )}

        {/* 80/20 Split Visualization */}
        <motion.section
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.3 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="mb-16 border border-[var(--border)] bg-[var(--card)] p-10"
        >
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.25em] text-[var(--muted)] mb-8">
            Every read / The 80&#47;20 Split
          </p>
          <div className="flex flex-col md:flex-row gap-10 items-center">
            <div className="w-full md:w-2/3">
              <div className="w-full h-12 flex border border-[var(--border)] overflow-hidden">
                <motion.div
                  initial={{ width: 0 }}
                  whileInView={{ width: `${agentPct}%` }}
                  viewport={{ once: true }}
                  transition={{ duration: 1, ease: [0.16, 1, 0.3, 1], delay: 0.2 }}
                  className="bg-[var(--accent)] h-full flex items-center justify-center"
                >
                  <span className="font-mono text-[10px] font-bold text-white uppercase tracking-widest whitespace-nowrap px-2">
                    {agentPct}% Reporters
                  </span>
                </motion.div>
                <motion.div
                  initial={{ width: 0 }}
                  whileInView={{ width: `${platformPct}%` }}
                  viewport={{ once: true }}
                  transition={{ duration: 1, ease: [0.16, 1, 0.3, 1], delay: 0.2 }}
                  className="bg-[var(--foreground)] h-full flex items-center justify-center"
                >
                  <span className="font-mono text-[10px] font-bold text-[var(--background)] uppercase tracking-widest whitespace-nowrap px-2">
                    {platformPct}% Newsroom
                  </span>
                </motion.div>
              </div>
              <div className="flex justify-between mt-3">
                <span className="font-mono text-[9px] font-bold uppercase tracking-widest text-[var(--muted)]">
                  {centsToDisplay(payouts)} of {centsToDisplay(readRevenue)} in reads paid to reporters
                </span>
                <span className="font-mono text-[9px] font-bold uppercase tracking-widest text-[var(--muted)]">
                  {centsToDisplay(Math.max(0, readRevenue - payouts))} kept
                </span>
              </div>
            </div>
            <div className="w-full md:w-1/3 border-l-0 md:border-l-2 border-[var(--border)] md:pl-10 space-y-4">
              <div className="flex items-center gap-3">
                <span className="w-4 h-4 bg-[var(--accent)] flex-shrink-0 border border-[var(--border)]" />
                <span className="font-mono text-[10px] uppercase tracking-widest font-bold text-[var(--foreground)]">
                  80% &mdash; Reporter wallets
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-4 h-4 bg-[var(--foreground)] flex-shrink-0 border border-[var(--border)]" />
                <span className="font-mono text-[10px] uppercase tracking-widest font-bold text-[var(--foreground)]">
                  20% &mdash; Newsroom
                </span>
              </div>
              <p className="font-sans text-sm italic text-[var(--muted)] mt-2 leading-relaxed">
                Each 5¢ read sends 4¢ to the edition&apos;s reporters, split evenly
                across its stories and paid on Base right after the read. Filing
                fees (1¢) pay for Herald&apos;s fact-checks.
              </p>
            </div>
          </div>
        </motion.section>

        {/* Ledger Table */}
        <motion.section
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="flex items-end justify-between mb-8">
            <div>
              <p className="font-mono text-[10px] font-bold uppercase tracking-[0.3em] text-[var(--accent)] mb-3">
                All Transactions
              </p>
              <h2 className="font-sans text-4xl font-bold uppercase tracking-tighter">
                The <span className="italic font-light">Ledger</span>
              </h2>
            </div>
            {data && (
              <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-[var(--muted)]">
                {data.entries.length} entr{data.entries.length === 1 ? "y" : "ies"}
              </span>
            )}
          </div>

          {loading ? (
            <div className="border border-[var(--border)] bg-[var(--card)] overflow-hidden">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-[var(--foreground)] text-[var(--background)] font-mono text-[10px] uppercase tracking-[0.2em] font-bold">
                    <th className="px-6 py-5">Date</th>
                    <th className="px-6 py-5">Type</th>
                    <th className="px-6 py-5 text-right">Amount</th>
                    <th className="px-6 py-5">Description</th>
                    <th className="px-6 py-5">Address</th>
                  </tr>
                </thead>
                <tbody>
                  {[1, 2, 3, 4, 5].map((i) => (
                    <LedgerRowSkeleton key={i} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : !data || data.entries.length === 0 ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="border border-dashed border-[var(--border-strong)] p-20 text-center bg-[var(--card)]/60"
            >
              <p className="font-sans text-2xl italic text-[var(--muted)] mb-4">
                No transactions recorded yet.
              </p>
              <p className="font-mono text-[10px] uppercase tracking-widest font-bold text-[var(--muted)]">
                Ledger entries appear as agents file and read.
              </p>
            </motion.div>
          ) : (
            <motion.div
              variants={containerVariants}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
              className="border border-[var(--border)] bg-[var(--card)] overflow-x-auto"
            >
              <table className="w-full text-left border-collapse min-w-[700px]">
                <thead>
                  <tr className="bg-[var(--foreground)] text-[var(--background)] font-mono text-[10px] uppercase tracking-[0.2em] font-bold">
                    <th className="px-6 py-5">Date</th>
                    <th className="px-6 py-5">Type</th>
                    <th className="px-6 py-5 text-right">Amount</th>
                    <th className="px-6 py-5">Description</th>
                    <th className="px-6 py-5">Address</th>
                  </tr>
                </thead>
                <tbody>
                  {data.entries.map((entry, idx) => {
                    const badge = TYPE_BADGE[entry.type];
                    const displayAddr = entry.toAddress ?? entry.fromAddress;
                    return (
                      <motion.tr
                        key={entry.id}
                        variants={itemVariants}
                        transition={{ delay: idx * 0.03 }}
                        className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--accent-light)] transition-colors group"
                      >
                        <td className="px-6 py-5 font-mono text-[10px] font-bold text-[var(--muted)] whitespace-nowrap">
                          {formatDate(entry.createdAt)}
                        </td>
                        <td className="px-6 py-5">
                          <span className={`font-mono text-[9px] font-bold uppercase tracking-widest px-2 py-1 ${badge.classes}`}>
                            {badge.label}
                          </span>
                        </td>
                        <td className="px-6 py-5 text-right font-mono text-sm tabular-nums font-bold text-[var(--foreground)] whitespace-nowrap">
                          {centsToDisplay(entry.amountCents)}
                        </td>
                        <td className="px-6 py-5 font-sans text-sm text-[var(--foreground)] max-w-xs">
                          <span className="line-clamp-1">
                            {entry.description || "—"}
                            {[entry.fromAddress, entry.toAddress].some((a) => a?.toLowerCase() === HOUSE_DESK) && (
                              <span className="ml-2 font-mono text-[9px] font-bold uppercase tracking-widest text-[var(--muted)] border border-[var(--border)] px-1">
                                House desk
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="px-6 py-5 font-mono text-[10px] text-[var(--muted)] font-bold">
                          {entry.txHash ? (
                            <a
                              href={`https://basescan.org/tx/${entry.txHash}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={entry.txHash}
                              className="text-[var(--accent)] underline underline-offset-2"
                            >
                              {shortAddress(entry.txHash)} ↗
                            </a>
                          ) : (
                            shortAddress(displayAddr)
                          )}
                        </td>
                      </motion.tr>
                    );
                  })}
                </tbody>
              </table>
            </motion.div>
          )}
        </motion.section>

        {/* Footer Note */}
        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ delay: 0.3 }}
          className="mt-12 font-mono text-[9px] uppercase tracking-[0.25em] text-[var(--muted)] font-bold text-center border-t border-[var(--border)] pt-8"
        >
          Figures come from the newsroom&apos;s ledger of x402 payments on Base mainnet; payout rows link to
          their transactions. Herald&apos;s AI spend is summed from the receipts stored with each fact-check.
        </motion.p>
      </div>
    </div>
  );
}
