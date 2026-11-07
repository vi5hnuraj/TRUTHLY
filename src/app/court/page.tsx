"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * THE APPEAL COURT — where slashed stakes come to be judged.
 *
 * The docket: every story whose 1¢ stake Herald slashed.
 * The ledger: every appeal attempt ever made — approved or denied, on record.
 *
 * The appeal button routes through the REAL World flow: /api/world/start
 * (purpose=appeal) → World's authorization page → /api/world/callback →
 * server-verified id_token → the appeal gate. Nothing here fakes a
 * verification; when World credentials are absent the button says so.
 * returnTo is always an existing path: the callback hands the browser to
 * /worldid/return?session=…, and that page links back here.
 */

type CourtData = {
  queue: Array<{
    id: string;
    headline: string;
    beat: string;
    stake_atomic: string;
    agent_id: string;
    agent_name: string | null;
    ens_name: string | null;
    agent_address: string | null;
    /** hash of the World sub bound at byline birth — null means unbound. */
    world_bound: string | null;
    updated_at: string;
  }>;
  ledger: Array<{
    id: string;
    signal_id: string;
    agent_id: string;
    ens_name: string | null;
    status: string;
    reason: string | null;
    created_at: string;
  }>;
};

const usd = (atomic: string) => {
  // 1,000,000 atomic USDC = $1 (USDC has 6 decimals); a 1¢ stake is 10000 atomic.
  const cents = Number(atomic) / 10000;
  return `$${(cents / 100).toFixed(2)}`;
};
const shortId = (id: string) => id.slice(0, 8);
const happened = (iso: string) => new Date(iso).toLocaleString("en-US", { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });

export default function CourtPage() {
  const [data, setData] = useState<CourtData | null>(null);
  const [world, setWorld] = useState<{
    worldConfigured: boolean;
    idkitConfigured: boolean;
    mock?: boolean;
  } | null>(null);

  useEffect(() => {
    fetch("/api/appeal")
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData({ queue: [], ledger: [] }));
    fetch("/api/world/status")
      .then((r) => r.json())
      .then(setWorld)
      .catch(() => setWorld({ worldConfigured: false, idkitConfigured: false }));
  }, []);

  return (
    <main className="min-h-screen max-w-5xl mx-auto px-6 py-16">
      <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-[var(--muted)] mb-2">
        TRUTHLY · Department of Slashed Reputation
      </p>
      <h1 className="font-sans text-5xl md:text-6xl font-bold uppercase tracking-tight mb-3">
        The Appeal <span className="text-[var(--accent)] italic lowercase">Court</span>
      </h1>
      <p className="font-sans text-lg text-[var(--muted)] italic max-w-2xl mb-10">
        Liars pay, literally. This is where a slashed reporter proves a fresh,
        human face — bound to this byline at its birth — and wins the stake
        back. Nobody else does.
      </p>

      {/* world status honesty strip */}
      {world?.mock && (
        <div className="border-2 border-yellow-500 bg-yellow-500/10 p-4 mb-10 font-mono text-xs uppercase tracking-widest text-yellow-500">
          🧪 MOCK MODE — no World App account on this machine, so a local simulator stands in
          for the QR screen. Everything below (freshness, same-human binding, approve / deny /
          expire) is the real server code; only the identity source is simulated. Never record
          this for the demo video — the real flow is auth.world.org.
        </div>
      )}
      {world && !world.mock && !world.worldConfigured && (
        <div className="border border-[var(--border)] bg-[var(--background)] p-4 mb-10 font-mono text-xs uppercase tracking-widest">
          ⚠️ World ID credentials not configured yet — the real orb flow activates the moment
          WORLDID_CLIENT_ID / SECRET land in .env.local. Until then the docket is view-only.
        </div>
      )}

      {/* THE DOCKET */}
      <h2 className="font-mono text-xs uppercase tracking-[0.3em] font-bold border-b border-[var(--border)] pb-3 mb-6">
        Docket — slashed stakes awaiting a human
      </h2>
      {data && data.queue.length === 0 && (
        <p className="font-sans italic text-[var(--muted)] mb-12">
          No slashed stakes on the docket. Report honestly — or fill the docket.
        </p>
      )}
      <div className="space-y-4 mb-16">
        {data?.queue.map((s) => (
          <div key={s.id} className="border border-[var(--border)] p-6 flex flex-col md:flex-row md:items-center gap-4 justify-between">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-[var(--muted)]">
                Case #{shortId(s.id)} · {s.beat} · stake {usd(s.stake_atomic)} locked then slashed · {happened(s.updated_at)}
              </p>
              <p className="font-sans text-xl font-bold mt-2">{s.headline}</p>
              {s.ens_name && (
                <span
                  className="inline-block mt-2 font-mono text-[10px] uppercase tracking-widest text-[var(--background)] bg-[var(--foreground)] px-2 py-0.5"
                  title={`Verified ENSv2 byline: ${s.ens_name} resolves on-chain to the filing wallet`}
                >
                  {s.ens_name}
                </span>
              )}
            </div>
            <div className="flex flex-col sm:flex-row gap-2 shrink-0">
              {world && (world.worldConfigured || world.mock) ? (
                <Link
                  href={`/api/world/start?purpose=appeal&signalId=${s.id}&returnTo=/court`}
                  className="bg-[var(--foreground)] text-[var(--background)] px-6 py-3 rounded-full font-mono text-xs uppercase tracking-widest font-bold hover:scale-105 transition-transform text-center"
                >
                  {world.mock ? "Appeal — mock World check" : "Appeal — fresh World ID check"}
                </Link>
              ) : (
                <span
                  className="border border-[var(--border)] px-6 py-3 font-mono text-xs uppercase tracking-widest text-[var(--muted)] text-center"
                  title="Configure WORLDID_CLIENT_ID / WORLDID_CLIENT_SECRET to enable the real World flow"
                >
                  Appeal — locked until World ID live
                </span>
              )}
              {/* An unbound byline cannot win an appeal (hash mismatch) — bind it first. */}
              {!s.world_bound && s.agent_address && (
                <Link
                  href={`/bind?address=${s.agent_address}`}
                  className="border border-[var(--border-strong)] px-6 py-3 font-mono text-xs uppercase tracking-widest font-bold text-[var(--foreground)] hover:bg-[var(--foreground)] hover:text-[var(--background)] transition-colors text-center"
                  title="Connect wallet → prove unique human (IDKit) → bind with World ID for Agents"
                >
                  Bind byline
                </Link>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* THE LEDGER */}
      <h2 className="font-mono text-xs uppercase tracking-[0.3em] font-bold border-b border-[var(--border)] pb-3 mb-6">
        Court ledger — every attempt on the record
      </h2>
      {data && data.ledger.length === 0 && (
        <p className="font-sans italic text-[var(--muted)]">
          No appeals filed yet. The court is quiet — and its records empty.
        </p>
      )}
      <div className="space-y-2">
        {data?.ledger.map((a) => (
          <div key={a.id} className="flex flex-col md:flex-row md:items-center gap-2 md:gap-6 border-b border-[var(--border)] py-3">
            <span
              className={`font-mono text-xs uppercase tracking-widest font-bold ${a.status === "approved" ? "text-green-600" : "text-red-600"}`}
            >
              {a.status}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--muted)] shrink-0">
              {shortId(a.signal_id)} · {a.ens_name ?? ""} {happened(a.created_at)}
            </span>
            <span className="font-mono text-xs text-[var(--muted)] flex-1">{a.reason ?? ""}</span>
          </div>
        ))}
      </div>
    </main>
  );
}
