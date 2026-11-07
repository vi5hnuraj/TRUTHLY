"use client";

import { useEffect, useState } from "react";

type Scenario = {
  id: string;
  tone: string;
  label: string;
  headline: string;
  body: string;
};

type DemoResult = {
  warning: string;
  run: {
    id: string;
    verification: { label?: string; notes?: string } | null;
    market_snapshot: {
      impliedPriceUsd?: string;
      providerQuoteId?: string;
      fetchedAt?: string;
      executionQuote?: {
        impliedPriceUsd?: string;
        providerQuoteId?: string;
      };
      referenceQuote?: {
        impliedPriceUsd?: string;
        providerQuoteId?: string;
        providerRequestId?: string;
        routing?: string;
        protocols?: string[];
      } | null;
      integrity?: {
        status?: string;
        deviationBps?: string | null;
        maximumDeviationBps?: number;
        reason?: string | null;
      };
    } | null;
    council: {
      label: string;
      action: string;
      consensus: string;
      consensusConfidence: number;
      entryPriceUsd: string | null;
      stopLossPriceUsd: string | null;
      takeProfitPriceUsd: string | null;
      riskReward: string | null;
      reasoning: string;
      opinions: Array<{
        role: string;
        vote: string;
        confidence: number;
        reasoning: string;
        veto: boolean;
      }>;
    } | null;
  } | null;
  paper_execution: {
    id: string;
    label: string;
    action: string;
    notional_usdc: string;
    entry_price_usd: string | null;
    status: string;
    transaction_hash: null;
    order_id: null;
  } | null;
};

type PaperMarkResult = {
  label: string;
  market_integrity?: {
    executionQuote?: { impliedPriceUsd?: string; providerQuoteId?: string };
    referenceQuote?: {
      impliedPriceUsd?: string;
      providerRequestId?: string;
      providerQuoteId?: string;
      routing?: string;
      protocols?: string[];
    } | null;
    integrity?: {
      status?: string;
      deviationBps?: string | null;
    };
  };
  paper_execution?: {
    action?: string;
    notional_usdc?: string;
    entry_price_usd?: string | null;
    status?: string;
    order_id?: null;
    transaction_hash?: null;
  } | null;
  mark?: {
    market_price_usd?: string;
    hypothetical_pnl_percent?: string;
    outcome?: string;
    provider_quote_id?: string;
    marked_at?: string;
    transaction_hash?: null;
  } | null;
};

export default function DemoModePage() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [selected, setSelected] = useState("");
  const [result, setResult] = useState<DemoResult | null>(null);
  const [mark, setMark] = useState<PaperMarkResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/demo/scenarios", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail ?? data.error ?? "Demo Mode unavailable");
        setScenarios(data.scenarios ?? []);
        setSelected(data.scenarios?.[0]?.id ?? "");
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Demo Mode unavailable"));
  }, []);

  async function run() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setMark(null);
    try {
      const response = await fetch("/api/demo/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario_id: selected }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail ?? data.error ?? "Demo run failed");
      setResult(data as DemoResult);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Demo run failed");
    } finally {
      setBusy(false);
    }
  }

  async function markToMarket() {
    if (!result?.paper_execution) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/demo/mark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paper_execution_id: result.paper_execution.id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail ?? data.error ?? "Paper mark failed");
      setMark(data as PaperMarkResult);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Paper mark failed");
    } finally {
      setBusy(false);
    }
  }

  const scenario = scenarios.find((item) => item.id === selected);
  const council = result?.run?.council;
  const actionIsHold = council?.action === "HOLD";
  const pnlPercent = Number(mark?.mark?.hypothetical_pnl_percent ?? "0");
  const paperNotional = Number(mark?.paper_execution?.notional_usdc ?? "0");
  const hypotheticalPnlUsd = Number.isFinite(pnlPercent) && Number.isFinite(paperNotional)
    ? (paperNotional * pnlPercent) / 100
    : 0;

  return (
    <main className="min-h-screen max-w-7xl mx-auto px-6 py-24">
      <div className="border-2 border-yellow-500 bg-yellow-500/10 p-5 mb-8">
        <p className="font-mono text-xs uppercase tracking-[0.25em] font-bold text-yellow-700">
          Demo Mode · simulated news · paper execution
        </p>
        <p className="font-sans text-sm mt-2">
          Test the decision system without risking funds. Scenario assumptions are fictional;
          Groq council opinions, Definitive pricing and Uniswap V2/V3/V4 routing are real.
        </p>
        <div className="mt-4 flex flex-wrap gap-2 font-mono text-[9px] uppercase tracking-widest">
          <span className="border border-yellow-600 px-2 py-1">Scenario · simulated</span>
          <span className="border border-green-700 px-2 py-1">Council · real models</span>
          <span className="border border-green-700 px-2 py-1">Market · real providers</span>
          <span className="border border-blue-700 px-2 py-1">Execution · paper only</span>
        </div>
      </div>

      <h1 className="font-sans text-5xl font-bold uppercase tracking-tight">
        Intelligence <span className="italic text-[var(--accent)]">Council Lab</span>
      </h1>
      <p className="font-sans text-lg italic text-[var(--muted)] mt-3 mb-10">
        One scenario. Two independent market reads. Five analyst opinions. One deterministic paper decision.
      </p>

      <div className="grid grid-cols-2 gap-px border border-[var(--border)] bg-[var(--border)] mb-6 lg:grid-cols-4">
        <Step number="1" label="Choose scenario" />
        <Step number="2" label="Check both markets" />
        <Step number="3" label="Convene council" />
        <Step number="4" label="Record paper decision" />
      </div>

      <section className="grid lg:grid-cols-[360px_minmax(0,1fr)] gap-6 items-start">
        <div className="border border-[var(--border)] p-5 lg:sticky lg:top-24">
          <p className="font-mono text-[10px] uppercase tracking-widest mb-3">Predefined scenarios</p>
          <div className="space-y-2 max-h-[410px] overflow-y-auto pr-1">
            {scenarios.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setSelected(item.id)}
                className={`block w-full text-left border p-3 ${
                  item.id === selected ? "border-[var(--foreground)] bg-[var(--card)]" : "border-[var(--border)]"
                }`}
              >
                <span className="font-mono text-[9px] uppercase tracking-widest text-yellow-700">
                  {item.label}
                </span>
                <span className="block font-sans text-sm font-bold mt-1">{item.headline}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={!selected || busy}
            onClick={() => void run()}
            className="mt-5 w-full bg-[var(--foreground)] text-[var(--background)] px-5 py-3 font-mono text-xs uppercase tracking-widest disabled:opacity-40"
          >
            {busy ? "Analyzing…" : "Analyze scenario · paper only"}
          </button>
          <button
            type="button"
            disabled={busy || scenarios.length < 2}
            onClick={() => {
              const alternatives = scenarios.filter((item) => item.id !== selected);
              const next = alternatives[Math.floor(Math.random() * alternatives.length)];
              if (next) {
                setSelected(next.id);
                setResult(null);
                setMark(null);
                setError(null);
              }
            }}
            className="mt-2 w-full border border-[var(--border)] px-5 py-3 font-mono text-[10px] uppercase tracking-widest disabled:opacity-40"
          >
            Choose another scenario
          </button>
        </div>

        <div className="border border-[var(--border)] p-6 min-w-0">
          {!result && scenario && (
            <div className="min-h-[420px] flex flex-col justify-between">
              <div>
              <p className="font-mono text-[10px] uppercase tracking-widest text-yellow-700">{scenario.label}</p>
              <h2 className="font-sans text-2xl font-bold mt-2">{scenario.headline}</h2>
              <p className="font-sans text-sm text-[var(--muted)] mt-4">{scenario.body}</p>
              </div>
              <div className="mt-8 border-t border-[var(--border)] pt-5">
                <p className="font-mono text-[10px] uppercase tracking-widest font-bold">What this test proves</p>
                <ul className="mt-3 space-y-2 font-sans text-sm text-[var(--muted)]">
                  <li>→ Definitive and Uniswap independently price the same notional.</li>
                  <li>→ Five agents reason inside the scenario&apos;s assumed world.</li>
                  <li>→ Server policy can force HOLD; models never execute.</li>
                  <li>→ The result is stored without an order ID or transaction hash.</li>
                </ul>
              </div>
            </div>
          )}

          {result && (
            <div className="space-y-6">
              <section className="border border-yellow-500 p-4">
                <p className="font-mono text-[10px] uppercase tracking-widest font-bold">
                  {result.run?.verification?.label}
                </p>
                <p className="font-sans text-sm mt-2">{result.run?.verification?.notes}</p>
              </section>

              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-px bg-[var(--border)] border border-[var(--border)]">
                <Fact label="Definitive execution quote" value={`$${result.run?.market_snapshot?.executionQuote?.impliedPriceUsd ?? result.run?.market_snapshot?.impliedPriceUsd ?? "—"}`} />
                <Fact label="Uniswap AMM reference" value={result.run?.market_snapshot?.referenceQuote?.impliedPriceUsd ? `$${result.run.market_snapshot.referenceQuote.impliedPriceUsd}` : "not configured"} />
                <Fact label="Cross-market divergence" value={result.run?.market_snapshot?.integrity?.deviationBps ? `${result.run.market_snapshot.integrity.deviationBps} bps` : "—"} />
                <Fact label="Integrity guard" value={`${result.run?.market_snapshot?.integrity?.status ?? "unavailable"}${result.run?.market_snapshot?.integrity?.maximumDeviationBps ? ` · max ${result.run.market_snapshot.integrity.maximumDeviationBps} bps` : ""}`} />
                <Fact label="Council action" value={council?.action ?? "—"} />
                <Fact label="Consensus" value={`${council?.consensus ?? "—"} · ${council?.consensusConfidence ?? 0}%`} />
              </div>

              {result.run?.market_snapshot?.referenceQuote && (
                <p className="font-mono text-[10px] uppercase tracking-widest text-[var(--muted)]">
                  Uniswap {result.run.market_snapshot.referenceQuote.routing} · {(result.run.market_snapshot.referenceQuote.protocols ?? []).join(" + ") || "AMM"} · request {result.run.market_snapshot.referenceQuote.providerRequestId?.slice(0, 8) ?? "—"}
                </p>
              )}

              {council && (
                <>
                  <section className="border-2 border-[var(--foreground)] p-5">
                    <p className="font-mono text-[10px] uppercase tracking-widest">{council.label}</p>
                    <p className="font-sans text-xl font-bold mt-2">{council.reasoning}</p>
                    <p className="font-mono text-[10px] uppercase tracking-widest mt-4">
                      entry {council.entryPriceUsd ?? "—"} · stop {council.stopLossPriceUsd ?? "—"} · target {council.takeProfitPriceUsd ?? "—"} · R/R {council.riskReward ?? "—"}
                    </p>
                  </section>
                  <div className="border-y border-[var(--border)]">
                    {council.opinions.map((opinion) => (
                      <details key={opinion.role} className="border-b border-[var(--border)] last:border-b-0">
                        <summary className="cursor-pointer list-none py-4 font-mono text-[10px] uppercase tracking-widest font-bold flex items-center justify-between gap-3">
                          <span>
                            {opinion.role.replace(/_/g, " ")} · {opinion.vote} · {opinion.confidence}%
                            {opinion.veto ? " · VETO" : ""}
                          </span>
                          <span className="text-[var(--muted)]">Read rationale +</span>
                        </summary>
                        <p className="font-sans text-sm text-[var(--muted)] pb-4 pr-5">{opinion.reasoning}</p>
                      </details>
                    ))}
                  </div>
                </>
              )}

              {result.paper_execution && (
                <section className="border-2 border-blue-500 bg-blue-500/5 p-5">
                  <p className="font-mono text-[10px] uppercase tracking-widest font-bold text-blue-700">
                    {result.paper_execution.label}
                  </p>
                  <p className="font-mono text-xs mt-3">
                    {result.paper_execution.action} · ${result.paper_execution.notional_usdc} paper notional · entry ${result.paper_execution.entry_price_usd ?? "—"}
                  </p>
                  <p className="font-mono text-[10px] uppercase tracking-widest mt-2">
                    order id: none · transaction hash: none
                  </p>
                  {actionIsHold ? (
                    <p className="mt-4 font-sans text-sm text-[var(--muted)] italic">
                      No position was opened, so there is no hypothetical P&amp;L to mark.
                    </p>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void markToMarket()}
                      className="mt-4 border border-blue-700 px-4 py-2 font-mono text-[10px] uppercase tracking-widest disabled:opacity-40"
                    >
                      Fetch subsequent quote + mark hypothetical P&amp;L
                    </button>
                  )}
                </section>
              )}

              {mark?.mark && (
                <section className="border-2 border-purple-600 bg-purple-600/5 p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-purple-600">
                        Paper mark · hypothetical only
                      </p>
                      <p className="mt-2 font-sans text-sm text-[var(--muted)]">
                        A later real market read was compared with the paper entry. This is not a fill,
                        realized return or profitability claim.
                      </p>
                    </div>
                    <span className="border border-purple-600 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-purple-600">
                      {mark.mark.outcome?.replace(/_/g, " ") ?? "open"}
                    </span>
                  </div>

                  <div className="mt-5 grid grid-cols-2 gap-px border border-[var(--border)] bg-[var(--border)] lg:grid-cols-4">
                    <Fact label="Paper entry" value={mark.paper_execution?.entry_price_usd ? `$${mark.paper_execution.entry_price_usd}` : "—"} />
                    <Fact label="Latest market" value={mark.mark.market_price_usd ? `$${mark.mark.market_price_usd}` : "—"} />
                    <Fact label="Hypothetical change" value={`${pnlPercent >= 0 ? "+" : ""}${pnlPercent.toFixed(4)}%`} />
                    <Fact label={`On $${paperNotional || 0} paper notional`} value={`${hypotheticalPnlUsd >= 0 ? "+" : "−"}$${Math.abs(hypotheticalPnlUsd).toFixed(4)}`} />
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2 font-mono text-[9px] uppercase tracking-widest text-[var(--muted)]">
                    <span className="border border-[var(--border)] px-2 py-1">
                      Uniswap guard: {mark.market_integrity?.integrity?.status ?? "unavailable"}
                    </span>
                    <span className="border border-[var(--border)] px-2 py-1">
                      Divergence: {mark.market_integrity?.integrity?.deviationBps ?? "—"} bps
                    </span>
                    <span className="border border-[var(--border)] px-2 py-1">
                      Uniswap ref: {mark.market_integrity?.referenceQuote?.impliedPriceUsd ? `$${mark.market_integrity.referenceQuote.impliedPriceUsd}` : "—"}
                    </span>
                    <span className="border border-[var(--border)] px-2 py-1">
                      Order ID: none
                    </span>
                    <span className="border border-[var(--border)] px-2 py-1">
                      Transaction: none
                    </span>
                  </div>

                  <details className="mt-4 border-t border-[var(--border)] pt-4">
                    <summary className="cursor-pointer font-mono text-[9px] uppercase tracking-widest">
                      Audit evidence +
                    </summary>
                    <dl className="mt-3 grid gap-2 font-mono text-[9px] text-[var(--muted)] sm:grid-cols-2">
                      <div><dt className="uppercase">Definitive quote</dt><dd className="break-all">{mark.mark.provider_quote_id ?? "—"}</dd></div>
                      <div><dt className="uppercase">Uniswap request</dt><dd className="break-all">{mark.market_integrity?.referenceQuote?.providerRequestId ?? "—"}</dd></div>
                      <div><dt className="uppercase">Uniswap quote</dt><dd className="break-all">{mark.market_integrity?.referenceQuote?.providerQuoteId ?? "—"}</dd></div>
                      <div><dt className="uppercase">Marked at</dt><dd>{mark.mark.marked_at ? new Date(mark.mark.marked_at).toLocaleString() : "—"}</dd></div>
                    </dl>
                  </details>
                </section>
              )}
            </div>
          )}
          {error && (
            <section className="mt-5 border border-red-600 bg-red-600/5 p-4">
              <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-red-600">
                Run stopped safely
              </p>
              <p className="mt-2 font-sans text-sm text-[var(--muted)]">{error}</p>
              <p className="mt-2 font-mono text-[9px] uppercase tracking-widest text-[var(--muted)]">
                No paper position · no order · no transaction
              </p>
            </section>
          )}
        </div>
      </section>
    </main>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[var(--background)] p-4">
      <p className="font-mono text-[9px] uppercase tracking-widest text-[var(--muted)]">{label}</p>
      <p className="font-mono text-xs mt-1">{value}</p>
    </div>
  );
}

function Step({ number, label }: { number: string; label: string }) {
  return (
    <div className="bg-[var(--background)] p-4">
      <p className="font-mono text-[9px] uppercase tracking-widest text-[var(--accent)]">Step {number}</p>
      <p className="font-sans text-sm font-bold mt-1">{label}</p>
    </div>
  );
}
