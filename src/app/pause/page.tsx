"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useConnect, useSignMessage } from "wagmi";
import { injected } from "wagmi/connectors";
import { WalletProvider } from "@/components/wallet-provider";
import { pauseMessage } from "@/lib/world/pause-message";

type PauseStatus = {
  principal_id: string;
  paused: boolean;
  paused_at: string | null;
  pause_reason: string | null;
  pause_version: number;
  active_agents: number;
  open_trades: { id: string; status: string; orderId: string | null }[];
  resume_mode: "world_agent_pass" | "unavailable";
};

type PendingResume = {
  id: string;
  url: string;
  owner: string;
  reason: string;
};

export default function PausePage() {
  return (
    <WalletProvider>
      <EmergencySwitch />
    </WalletProvider>
  );
}

function EmergencySwitch() {
  const { address, isConnected } = useAccount();
  const { connect } = useConnect();
  const signMessage = useSignMessage();
  const [status, setStatus] = useState<PauseStatus | null>(null);
  const [reason, setReason] = useState("Suspicious agent activity");
  const [pendingResume, setPendingResume] = useState<PendingResume | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (wallet: string) => {
    const response = await fetch(`/api/principal/pause?owner_wallet=${encodeURIComponent(wallet)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Could not load principal");
    setStatus(data as PauseStatus);
  }, []);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(
          `/api/principal/pause?owner_wallet=${encodeURIComponent(address)}`,
        );
        const data = await response.json();
        if (cancelled) return;
        if (!response.ok) throw new Error(data.error ?? "Could not load principal");
        setStatus(data as PauseStatus);
        const raw = window.localStorage.getItem("truthly.pending-resume");
        if (raw) {
          try {
            const saved = JSON.parse(raw) as PendingResume;
            if (saved.owner.toLowerCase() === address.toLowerCase()) {
              setPendingResume(saved);
            }
          } catch {
            window.localStorage.removeItem("truthly.pending-resume");
          }
        }
      } catch (error) {
        if (!cancelled) {
          setMessage(error instanceof Error ? error.message : "Could not load principal");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address]);

  async function pause() {
    if (!address) return;
    setBusy(true);
    setMessage(null);
    try {
      const signedReason = reason.trim();
      const issuedAt = new Date().toISOString();
      const nonce = crypto.randomUUID();
      const signature = await signMessage.mutateAsync({
        message: pauseMessage({ address, reason: signedReason, issuedAt, nonce }),
      });
      const response = await fetch("/api/principal/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner_wallet: address,
          reason: signedReason,
          issued_at: issuedAt,
          nonce,
          signature,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Pause failed");
      setPendingResume(null);
      window.localStorage.removeItem("truthly.pending-resume");
      await load(address);
      setMessage(
        `Paused. ${data.active_agents_blocked} active agent(s) are blocked. ${data.notice}`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Pause failed");
    } finally {
      setBusy(false);
    }
  }

  async function resume() {
    if (!address) return;
    setBusy(true);
    setMessage(null);
    try {
      const mode = status?.resume_mode ?? "unavailable";
      if (mode !== "world_agent_pass") {
        setMessage(
          "Resume is unavailable: configure and bind World Agent Pass. The principal remains paused.",
        );
        return;
      }
      if (mode === "world_agent_pass") {
        if (!pendingResume) {
          const resumeReason = reason.trim();
          const response = await fetch("/api/principal/resume", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ owner_wallet: address, reason: resumeReason }),
          });
          const data = await response.json();
          if (
            response.status !== 409 ||
            data.action_required !== "world_agent_pass" ||
            !data.authorization_id ||
            !data.authorization_url
          ) {
            throw new Error(data.detail ?? data.error ?? "Resume request failed");
          }
          const pending = {
            id: data.authorization_id,
            url: data.authorization_url,
            owner: address,
            reason: resumeReason,
          };
          setPendingResume(pending);
          window.localStorage.setItem("truthly.pending-resume", JSON.stringify(pending));
          setMessage("Review and approve the resume with a fresh World Agent Pass.");
          return;
        }
        const response = await fetch("/api/principal/resume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            owner_wallet: address,
            reason: pendingResume.reason,
            authorization_id: pendingResume.id,
          }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Resume failed");
        setPendingResume(null);
        window.localStorage.removeItem("truthly.pending-resume");
        await load(address);
        setMessage("Resumed through fresh World Agent Pass.");
        return;
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Resume failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen max-w-3xl mx-auto px-6 py-16">
      <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-[var(--muted)] mb-2">
        Human principal · emergency control
      </p>
      <h1 className="font-sans text-5xl font-bold uppercase tracking-tight mb-3">
        Stop <span className="text-[var(--accent)] italic lowercase">all agents</span>
      </h1>
      <p className="font-sans text-lg text-[var(--muted)] italic mb-8">
        One signature halts every delegated agent of your principal. It is checked on the server
        before any filing, approval or trade, and it does not depend on World being reachable.
      </p>

      {!isConnected ? (
        <button
          className="pill pill-solid"
          onClick={() => connect({ connector: injected() })}
        >
          Connect owner wallet
        </button>
      ) : (
        <p className="font-mono text-[10px] uppercase tracking-widest mb-6 break-all">
          Owner: {address}
        </p>
      )}

      {status && (
        <>
          <div className="grid sm:grid-cols-3 gap-px bg-[var(--border)] border border-[var(--border)] mb-6">
            <Fact label="State" value={status.paused ? "PAUSED" : "active"} />
            <Fact label="Active agents" value={String(status.active_agents)} />
            <Fact label="Resume mode" value={status.resume_mode.replace(/_/g, " ")} />
          </div>

          {status.paused && (
            <div className="mb-6">
              <p className="font-mono text-xs">
                Paused at {status.paused_at} — {status.pause_reason}
              </p>
              {status.resume_mode === "unavailable" && (
                <p className="mt-2 font-sans text-sm text-red-600">
                  Resume is fail-closed until World Agent Pass is configured and bound.
                </p>
              )}
            </div>
          )}

          {status.open_trades.length > 0 && (
            <section className="border-2 border-[var(--accent)] p-5 mb-6">
              <p className="font-mono text-[10px] uppercase tracking-widest font-bold mb-2">
                In-flight and provider orders are not recalled
              </p>
              <p className="font-sans text-sm text-[var(--muted)] mb-3">
                A pause blocks later order reservations and approvals. A request already marked
                submitting may be crossing the provider boundary; an accepted provider order must be
                cancelled at the execution provider.
              </p>
              <ul className="font-mono text-[10px] space-y-1 break-all">
                {status.open_trades.map((trade) => (
                  <li key={trade.id}>
                    {trade.status} · order {trade.orderId ?? "pending"}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <label className="block font-mono text-[10px] uppercase tracking-widest mb-6">
        Reason (recorded with the signature)
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className="block w-full mt-2 border border-[var(--border)] bg-[var(--background)] p-3 normal-case tracking-normal"
        />
      </label>

      <div className="flex flex-wrap gap-3">
        <button
          className="bg-red-600 text-white px-7 py-4 font-mono text-xs uppercase tracking-widest font-bold disabled:opacity-40"
          disabled={busy || !isConnected || status?.paused === true}
          onClick={() => void pause()}
        >
          Pause all agents now
        </button>
        <button
          className="pill"
          disabled={
            busy ||
            !isConnected ||
            status?.paused !== true ||
            status.resume_mode !== "world_agent_pass"
          }
          onClick={() => void resume()}
        >
          {pendingResume ? "I approved — resume" : "Resume through approval"}
        </button>
      </div>

      {pendingResume && (
        <p className="mt-4">
          <a href={pendingResume.url} className="pill pill-solid">
            Review the exact resume approval →
          </a>
        </p>
      )}

      {message && <p className="font-mono text-xs mt-6 break-words">{message}</p>}
    </main>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[var(--background)] p-4">
      <p className="font-mono text-[9px] uppercase tracking-widest text-[var(--muted)]">{label}</p>
      <p className="font-mono text-xs mt-1 uppercase">{value}</p>
    </div>
  );
}
