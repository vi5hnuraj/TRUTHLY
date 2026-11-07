"use client";

import { useCallback, useState } from "react";

type Agent = {
  id: string;
  agent_wallet: string;
  label: string;
  status: string;
  credential_issued: boolean;
  mandate: null | {
    roles: string[];
    allowed_beats: string[];
    daily_filings: number;
    daily_stake_usdc: string;
    max_trade_usdc: string;
    fresh_agent_pass_above_usdc: string;
  };
};

type PrincipalView = {
  principal: {
    id: string;
    owner_wallet: string;
    status: string;
    world_bound: boolean;
    paused: boolean;
    paused_at: string | null;
    pause_reason: string | null;
    daily_filing_limit: number;
    daily_stake_usdc: string;
    daily_trade_usdc: string;
  };
  agents: Agent[];
};

type Pending = {
  request: Record<string, unknown>;
  authorization_id: string;
  authorization_url: string;
  payload_hash: string;
};

const BEATS = [
  "bitcoin",
  "defi",
  "agentic-payments",
  "infrastructure",
  "regulation",
  "market-signals",
];

export default function MandatesPage() {
  const [owner, setOwner] = useState("");
  const [view, setView] = useState<PrincipalView | null>(null);
  const [agentWallet, setAgentWallet] = useState("");
  const [label, setLabel] = useState("Trading reporter");
  const [dailyFilings, setDailyFilings] = useState("5");
  const [dailyStake, setDailyStake] = useState("0.05");
  const [maxTrade, setMaxTrade] = useState("2");
  const [freshAbove, setFreshAbove] = useState("0.50");
  const [allowExecute, setAllowExecute] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [credential, setCredential] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (wallet = owner) => {
    if (!wallet) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/mandates?owner_wallet=${encodeURIComponent(wallet)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not load principal");
      setView(data);
    } catch (error) {
      setView(null);
      setMessage(error instanceof Error ? error.message : "Could not load principal");
    } finally {
      setBusy(false);
    }
  }, [owner]);

  function upsertRequest() {
    return {
      operation: "upsert",
      owner_wallet: owner,
      agent_wallet: agentWallet,
      label,
      roles: allowExecute
        ? ["scout", "file", "trade_preview", "trade_execute"]
        : ["scout", "file", "trade_preview"],
      allowed_beats: BEATS,
      daily_filings: Number(dailyFilings),
      daily_stake_usdc: dailyStake,
      max_trade_usdc: maxTrade,
      fresh_agent_pass_above_usdc: freshAbove,
      expires_at: null,
    };
  }

  async function submit(request: Record<string, unknown>, authorizationId?: string) {
    setBusy(true);
    setMessage(null);
    setCredential(null);
    try {
      const response = await fetch("/api/mandates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...request, ...(authorizationId ? { authorization_id: authorizationId } : {}) }),
      });
      const data = await response.json();
      if (response.status === 409 && data.action_required === "world_agent_pass") {
        const next: Pending = {
          request,
          authorization_id: data.authorization_id,
          authorization_url: data.authorization_url,
          payload_hash: data.payload_hash,
        };
        setPending(next);
        window.localStorage.setItem("truthly.pending-mandate", JSON.stringify(next));
        setMessage("Review the exact payload, then approve it with fresh World Agent Pass.");
        return;
      }
      if (!response.ok) throw new Error(data.detail ?? data.error ?? "Mandate change failed");
      setPending(null);
      window.localStorage.removeItem("truthly.pending-mandate");
      if (data.mandate_token) setCredential(data.mandate_token);
      setMessage(data.revoked ? "Agent revoked immediately." : "Mandate active. Copy the token now.");
      await load(owner);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Mandate change failed");
    } finally {
      setBusy(false);
    }
  }

  function restorePending() {
    const raw = window.localStorage.getItem("truthly.pending-mandate");
    if (!raw) return setMessage("No pending mandate was saved in this browser.");
    try {
      setPending(JSON.parse(raw) as Pending);
      setMessage("Pending request restored. Finalize only after World shows it as approved.");
    } catch {
      setMessage("Saved request is invalid.");
    }
  }

  return (
    <main className="min-h-screen max-w-6xl mx-auto px-6 py-16">
      <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-[var(--muted)] mb-2">
        IDKit principal · Agent Pass authority
      </p>
      <h1 className="font-sans text-5xl md:text-6xl font-bold uppercase tracking-tight mb-3">
        Newsroom <span className="text-[var(--accent)] italic lowercase">mandates</span>
      </h1>
      <p className="font-sans text-lg text-[var(--muted)] italic max-w-3xl mb-10">
        One verified human may run several specialized wallets. Their roles differ; their reputation,
        daily limits and emergency revocation remain one human boundary.
      </p>

      {view?.principal.paused && (
        <section className="border-2 border-red-600 p-5 mb-8">
          <p className="font-mono text-xs uppercase tracking-widest font-bold text-red-500 mb-2">
            All agents are paused
          </p>
          <p className="font-sans text-sm text-[var(--muted)]">
            Paused at {view.principal.paused_at} — {view.principal.pause_reason}. Nothing executes
            until the controlling human resumes.
          </p>
        </section>
      )}

      <p className="mb-8">
        <a href="/pause" className="font-mono text-[10px] uppercase tracking-widest underline text-red-600">
          Emergency: pause all agents →
        </a>
      </p>

      <section className="border border-[var(--border)] p-5 mb-8 flex flex-col md:flex-row gap-3">
        <input
          value={owner}
          onChange={(event) => setOwner(event.target.value)}
          placeholder="IDKit principal owner wallet (0x…)"
          className="flex-1 border border-[var(--border)] bg-[var(--background)] p-3 font-mono text-xs"
        />
        <button className="pill pill-solid" disabled={busy} onClick={() => void load()}>
          Load principal
        </button>
        <button className="pill" disabled={busy} onClick={restorePending}>
          Restore pending
        </button>
      </section>

      {view && (
        <section className="grid md:grid-cols-4 gap-px bg-[var(--border)] border border-[var(--border)] mb-8">
          <Fact label="Principal" value={`${view.principal.id.slice(0, 20)}…`} />
          <Fact label="Agent Pass" value={view.principal.world_bound ? "bound" : "bind required"} />
          <Fact label="Shared filings" value={`${view.principal.daily_filing_limit} / UTC day`} />
          <Fact label="Shared trade budget" value={`${view.principal.daily_trade_usdc} USDC / day`} />
        </section>
      )}

      <section className="grid lg:grid-cols-2 gap-8 mb-12">
        <div className="border border-[var(--border)] p-6 space-y-4">
          <h2 className="font-mono text-xs uppercase tracking-[0.25em] font-bold">Delegate or update</h2>
          <Field label="Agent wallet" value={agentWallet} onChange={setAgentWallet} />
          <Field label="Label" value={label} onChange={setLabel} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Daily filings" value={dailyFilings} onChange={setDailyFilings} />
            <Field label="Daily stake USDC" value={dailyStake} onChange={setDailyStake} />
            <Field label="Max trade USDC" value={maxTrade} onChange={setMaxTrade} />
            <Field label="Fresh Pass above" value={freshAbove} onChange={setFreshAbove} />
          </div>
          <label className="flex gap-3 items-start font-mono text-xs uppercase tracking-widest">
            <input type="checkbox" checked={allowExecute} onChange={(event) => setAllowExecute(event.target.checked)} />
            Permit autonomous execution only at or below the fresh-pass threshold
          </label>
          <button
            className="bg-[var(--foreground)] text-[var(--background)] px-6 py-3 font-mono text-xs uppercase tracking-widest font-bold disabled:opacity-40"
            disabled={busy || !owner || !agentWallet}
            onClick={() => void submit(upsertRequest())}
          >
            Request exact mandate approval
          </button>
        </div>

        <div className="border border-[var(--border)] p-6">
          <h2 className="font-mono text-xs uppercase tracking-[0.25em] font-bold mb-4">Delegated agents</h2>
          {!view && <p className="text-[var(--muted)] italic">Load a verified principal first.</p>}
          <div className="space-y-4">
            {(view?.agents ?? []).map((agent) => (
              <div key={agent.id} className="border-b border-[var(--border)] pb-4">
                <p className="font-sans font-bold">{agent.label}</p>
                <p className="font-mono text-[10px] break-all text-[var(--muted)]">{agent.agent_wallet}</p>
                <p className="font-mono text-[10px] uppercase tracking-widest mt-2">
                  {agent.status} · {agent.mandate?.roles.join(" · ") ?? "no active mandate"}
                </p>
                {agent.status === "active" && (
                  <button
                    className="mt-3 text-red-600 font-mono text-[10px] uppercase tracking-widest underline"
                    onClick={() => void submit({
                      operation: "revoke",
                      owner_wallet: owner,
                      agent_wallet: agent.agent_wallet,
                      reason: "Emergency revocation requested by the controlling human",
                    })}
                  >
                    Revoke with Agent Pass
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {pending && (
        <section className="border-2 border-[var(--accent)] p-5 mb-8">
          <p className="font-mono text-xs uppercase tracking-widest font-bold mb-2">Fresh approval required</p>
          <p className="font-mono text-[10px] break-all mb-4">{pending.payload_hash}</p>
          <div className="flex flex-wrap gap-3">
            <a href={pending.authorization_url} className="pill pill-solid">Review + World Agent Pass</a>
            <button
              className="pill"
              disabled={busy}
              onClick={() => void submit(pending.request, pending.authorization_id)}
            >
              Finalize approved change
            </button>
          </div>
        </section>
      )}

      {credential && (
        <section className="border-2 border-green-600 p-5 mb-8">
          <p className="font-mono text-xs uppercase tracking-widest font-bold text-green-600 mb-2">
            One-time mandate token — copy now
          </p>
          <code className="block break-all text-xs">{credential}</code>
        </section>
      )}
      {message && <p className="font-mono text-xs break-words">{message}</p>}
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

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block font-mono text-[10px] uppercase tracking-widest">
      {label}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="block w-full mt-2 border border-[var(--border)] bg-[var(--background)] p-3 normal-case tracking-normal"
      />
    </label>
  );
}
