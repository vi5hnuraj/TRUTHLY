"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useConnect, useConnection, useSignMessage } from "wagmi";
import { HumanCheck } from "@/components/human-check";
import { WalletProvider } from "@/components/wallet-provider";
import { worldEnrollmentMessage } from "@/lib/world/enrollment-message";

/**
 * THE BINDING — the protocol's /insure step order, ported (MIT).
 *
 *   1. Connect the reporter's wallet          (wagmi useConnection / useConnect)
 *   2. Prove you're a unique human            (IDKit widget, signal = this wallet)
 *   3. Bind with World ID for Agents          (OIDC, prompt=login + max_age=0)
 *
 * the protocol's step 4 publishes the rules as an ENS name and step 5 takes the
 * premium; here the byline already exists, so the flow ends on the bound
 * byline. Nothing is faked: each step reports what the server actually did,
 * and steps that are not configured say so instead of pretending to pass.
 */

type Agent = {
  id: string;
  name: string;
  address: string;
  ensName: string | null;
  worldSubHash: string | null;
  worldNullifierHash: string | null;
  worldVerifiedAt: string | null;
};

type WorldStatus = {
  worldConfigured: boolean;
  worldIssue?: string | null;
  idkitConfigured: boolean;
  mock?: boolean;
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export default function BindPage() {
  // useSearchParams needs a Suspense boundary for the static prerender.
  return (
    <WalletProvider>
      <Suspense fallback={<main className="min-h-screen" />}>
        <BindInner />
      </Suspense>
    </WalletProvider>
  );
}

function BindInner() {
  const search = useSearchParams();
  const requested = search.get("address");
  const startError = search.get("error");

  const { address, isConnected } = useConnection();
  const connect = useConnect();
  const signEnrollment = useSignMessage();

  const [agents, setAgents] = useState<Agent[]>([]);
  const [world, setWorld] = useState<WorldStatus | null>(null);
  const [human, setHuman] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [worldBusy, setWorldBusy] = useState(false);

  useEffect(() => {
    fetch("/api/agents")
      .then((r) => r.json())
      .then((d: { agents?: Agent[] }) => setAgents(d.agents ?? []))
      .catch(() => setErr("Could not load the bylines."));
    fetch("/api/world/status")
      .then((r) => r.json())
      .then(setWorld)
      .catch(() => setWorld({ worldConfigured: false, idkitConfigured: false }));
  }, []);

  // the protocol's /insure keeps ONE source of truth for `human`: the HumanCheck
  // widget's onVerified callback. The page never fetches /api/idkit/status
  // itself, so there is no second read to disagree with the first.

  const byline = address
    ? agents.find((a) => a.address.toLowerCase() === address.toLowerCase())
    : undefined;
  const bound = !!byline?.worldSubHash;
  const idkitConfigured = world?.idkitConfigured ?? false;

  // the protocol: step = !isConnected ? 1 : !human ? 2 : !enrolled ? 3 : done.
  // Step 2 only blocks when IDKit is actually configured — the server applies
  // the identical rule in /api/world/start (error=unique_human_required).
  const step = !isConnected
    ? 1
    : idkitConfigured && !human
      ? 2
      : !bound
        ? 3
        : 4;

  /**
   * A tick means this step genuinely passed — never merely that it was
   * walked past. When IDKit is unconfigured step 2 is SKIPPED, not passed,
   * and the badge must say so rather than hand out a green light it did nothing for.
   */
  const stepDone = [isConnected, human, bound, bound];
  const badge = (n: number) => (stepDone[n - 1] ? "✓" : String(n));

  const cls = (n: number) =>
    `border p-6 ${step > n ? "border-[var(--border)]" : step === n ? "border-[var(--border-strong)]" : "border-[var(--border)] opacity-50"}`;

  const mismatch =
    requested && address && requested.toLowerCase() !== address.toLowerCase();

  async function startWorldEnrollment() {
    if (!address) return;
    const issuedAt = new Date().toISOString();
    const nonce = crypto.randomUUID();
    setErr(null);
    setWorldBusy(true);
    try {
      const signature = await signEnrollment.mutateAsync({
        message: worldEnrollmentMessage({ address, issuedAt, nonce }),
      });
      const response = await fetch("/api/world/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          purpose: "enroll",
          address,
          return_to: `/bind?address=${address}`,
          issued_at: issuedAt,
          nonce,
          signature,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        authorization_url?: string;
        error?: string;
        detail?: string;
      };
      if (!response.ok || !data.authorization_url) {
        throw new Error(data.detail ?? data.error ?? "Could not start World Agent Pass");
      }
      window.location.assign(data.authorization_url);
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Could not start World Agent Pass");
      setWorldBusy(false);
    }
  }

  async function connectPreferredWallet() {
    setErr(null);
    const ordered = [...connect.connectors].sort((left, right) => {
      const leftOkx = /okx/i.test(left.name) ? 1 : 0;
      const rightOkx = /okx/i.test(right.name) ? 1 : 0;
      return rightOkx - leftOkx;
    });
    for (const connector of ordered) {
      const provider = await connector.getProvider().catch(() => undefined);
      if (!provider) continue;
      connect.mutate({ connector });
      return;
    }
    setErr("No supported browser wallet was detected. Unlock OKX Wallet or MetaMask, then reload.");
  }

  return (
    <main className="min-h-screen max-w-4xl mx-auto px-6 py-16">
      <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-[var(--muted)] mb-2">
        World-Gated Newsroom · human root
      </p>
      <h1 className="font-sans text-5xl md:text-6xl font-bold uppercase tracking-tight mb-3">
        Bind a <span className="text-[var(--muted)] italic lowercase">byline</span>
      </h1>
      <p className="font-sans text-lg text-[var(--muted)] italic max-w-2xl mb-10">
        One unique human creates one anonymous newsroom principal, then delegates
        limited reporter wallets from /mandates. A fresh check by that same human
        is required only when an agent changes the public record or moves money
        outside its autonomous authority.
      </p>

      {/* honest status strips */}
      {world?.mock && (
        <div className="border-2 border-yellow-500 bg-yellow-500/10 p-4 mb-8 font-mono text-xs uppercase tracking-widest text-yellow-500">
          🧪 MOCK MODE — a local simulator stands in for World&apos;s QR screen.
          Step 3 only; the freshness, same-human and approve/deny rules are the
          real server code. Never record this for the demo video.
        </div>
      )}
      {/* Only scold while the proof is actually missing — a stale banner from an
          attempt before the Simulator finished would just confuse the reporter. */}
      {startError === "unique_human_required" && !human && (
        <div className="border-2 border-red-500 bg-red-500/10 p-4 mb-8 font-mono text-xs uppercase tracking-widest text-red-500">
          World refused to start: this byline has not proved a unique human yet
          — complete step 2 first.
        </div>
      )}
      {mismatch && (
        <div className="border-2 border-yellow-500 bg-yellow-500/10 p-4 mb-8 font-mono text-xs uppercase tracking-widest text-yellow-500">
          You asked to bind {short(requested!)} but the connected wallet is{" "}
          {short(address!)}. The binding always applies to the connected wallet.
        </div>
      )}
      {err && (
        <div className="border border-[var(--border)] p-4 mb-8 font-mono text-xs uppercase tracking-widest">
          {err}
        </div>
      )}

      <div className="flex flex-col gap-4">
        {/* ---- STEP 1 ---- */}
        <div className={cls(1)}>
          <div className="flex items-start gap-4">
            <span className="w-8 h-8 shrink-0 rounded-full bg-[var(--foreground)] text-[var(--background)] font-mono text-sm font-bold flex items-center justify-center">
              {badge(1)}
            </span>
            <div className="min-w-0">
              <div className="font-mono text-xs uppercase tracking-widest font-bold">
                Connect the reporter&apos;s wallet
              </div>
              <div className="mt-3">
                {isConnected && address ? (
                  <span className="font-mono text-sm text-[var(--muted)]">
                    Connected as{" "}
                    <span className="text-[var(--foreground)]">{short(address)}</span>
                    {byline && (
                      <span className="text-[var(--accent)]"> · {byline.name}</span>
                    )}
                  </span>
                ) : connect.connectors.length > 0 ? (
                  <div>
                    <button
                      className="bg-[var(--foreground)] text-[var(--background)] px-6 py-3 rounded-full font-mono text-xs uppercase tracking-widest font-bold hover:scale-105 transition-transform disabled:opacity-50"
                      disabled={connect.isPending}
                      onClick={() => void connectPreferredWallet()}
                    >
                      {connect.isPending ? "connecting…" : "Connect wallet"}
                    </button>
                    <p className="mt-3 font-sans text-xs text-[var(--muted)] italic">
                      Uses an unlocked OKX Wallet when available, otherwise MetaMask.
                    </p>
                  </div>
                ) : (
                  <span className="font-mono text-xs uppercase tracking-widest text-[var(--muted)]">
                    No browser wallet detected — install MetaMask (or open the
                    World App extension) and reload.
                  </span>
                )}
                {connect.error && (
                  <div className="font-mono text-[11px] uppercase tracking-widest text-red-500 mt-2">
                    {(connect.error as Error).message}
                  </div>
                )}
              </div>
              {isConnected && address && !byline && (
                <p className="font-mono text-[11px] uppercase tracking-widest text-yellow-500 mt-3">
                  No byline is registered at this wallet — binding would be
                  refused. Connect the wallet that owns the byline.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* ---- STEP 2 ---- */}
        <div className={cls(2)}>
          <div className="flex items-start gap-4">
            <span className="w-8 h-8 shrink-0 rounded-full bg-[var(--foreground)] text-[var(--background)] font-mono text-sm font-bold flex items-center justify-center">
              {badge(2)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="font-mono text-xs uppercase tracking-widest font-bold">
                  Prove you&apos;re a unique human
                </div>
                <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--muted)] border border-[var(--border)] px-2 py-0.5">
                  IDKit
                </span>
              </div>
              <div className="mt-3">
                {address ? (
                  <HumanCheck address={address} onVerified={setHuman} />
                ) : (
                  <p className="font-mono text-[11px] uppercase tracking-widest text-[var(--muted)]">
                    Connect a wallet first.
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ---- STEP 3 ---- */}
        <div className={cls(3)}>
          <div className="flex items-start gap-4">
            <span className="w-8 h-8 shrink-0 rounded-full bg-[var(--foreground)] text-[var(--background)] font-mono text-sm font-bold flex items-center justify-center">
              {badge(3)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="font-mono text-xs uppercase tracking-widest font-bold">
                  Bind with World ID for Agents
                </div>
                <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--muted)] border border-[var(--border)] px-2 py-0.5">
                  World ID for Agents
                </span>
              </div>
              <p className="font-sans text-[15px] text-[var(--muted)] italic max-w-2xl mt-2">
                  Binds Agent Pass continuity to the IDKit principal. Only a fresh
                  check by this same person can approve appeals, exact trades,
                  corrections, retractions, payout changes or mandate changes —
                  an old login is worthless.
              </p>
              {/* The wallet may remain connected on localhost; World returns through HTTPS. */}
              {world && !world.mock && (
                <div className="mt-3 border border-[var(--border)] bg-[var(--background)] p-3 font-mono text-[11px] text-[var(--muted)] leading-relaxed">
                  <span className="text-[var(--accent)]">ⓘ</span> Sign with the connected owner wallet here. World returns through the registered HTTPS callback; keep the tunnel running.
                </div>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-3">
                {!isConnected || !address ? (
                  <span className="border border-[var(--border)] px-6 py-3 font-mono text-xs uppercase tracking-widest text-[var(--muted)]">
                    Locked until a wallet is connected
                  </span>
                ) : bound ? (
                  <span className="border-2 border-green-600 px-6 py-3 font-mono text-xs uppercase tracking-widest font-bold text-green-600">
                    ✓ bound {byline?.worldVerifiedAt ? `· ${new Date(byline.worldVerifiedAt).toLocaleString()}` : ""}
                  </span>
                ) : world && (world.worldConfigured || world.mock) ? (
                  <button
                    type="button"
                    disabled={worldBusy || signEnrollment.isPending}
                    onClick={() => void startWorldEnrollment()}
                    className="bg-[var(--foreground)] text-[var(--background)] px-6 py-3 rounded-full font-mono text-xs uppercase tracking-widest font-bold hover:scale-105 transition-transform text-center"
                  >
                    {world.mock
                      ? "◎ Bind byline — mock World check"
                      : worldBusy || signEnrollment.isPending
                        ? "Signing enrollment…"
                        : "◎ Verify with World ID"}
                  </button>
                ) : (
                  <span
                    className="border border-[var(--border)] px-6 py-3 font-mono text-xs uppercase tracking-widest text-[var(--muted)] text-center"
                    title={world?.worldIssue ?? "Configure World Agent Pass"}
                  >
                    {world?.worldIssue ?? "Locked until World Agent Pass is configured"}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ---- STEP 4 — the bound byline ---- */}
        <div className={cls(4)}>
          <div className="flex items-start gap-4">
            <span className="w-8 h-8 shrink-0 rounded-full bg-[var(--foreground)] text-[var(--background)] font-mono text-sm font-bold flex items-center justify-center">
              {badge(4)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="font-mono text-xs uppercase tracking-widest font-bold">
                The bound byline
              </div>
              {bound && byline ? (
                <div className="mt-4 border border-[var(--border)] p-6">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div>
                      <p className="font-sans text-2xl font-bold">{byline.name}</p>
                      <p className="font-mono text-xs text-[var(--muted)] mt-1">
                        {short(byline.address)}
                      </p>
                    </div>
                    <div className="flex flex-col gap-2 items-end">
                      <span className="border border border-[var(--border-strong)] px-3 py-1 font-mono text-[10px] uppercase tracking-widest font-bold text-[var(--foreground)]">
                        ✓ unique human
                      </span>
                      <span className="bg-[var(--foreground)] text-[var(--background)] px-3 py-1 font-mono text-[10px] uppercase tracking-widest font-bold">
                        ✓ world bound
                      </span>
                    </div>
                  </div>
                  {byline.ensName && (
                    <p className="inline-block mt-4 font-mono text-[10px] uppercase tracking-widest text-[var(--background)] bg-[var(--foreground)] px-2 py-0.5">
                      {byline.ensName}
                    </p>
                  )}
                  <div className="mt-5 flex flex-wrap gap-3">
                    <Link
                      href="/court"
                      className="border border-[var(--border-strong)] px-5 py-2.5 font-mono text-[10px] uppercase tracking-widest font-bold text-[var(--accent)] hover:bg-[var(--foreground)] hover:text-[var(--background)] transition-colors"
                    >
                      Go to the Appeal Court →
                    </Link>
                    <Link
                      href="/agents"
                      className="border border-[var(--border)] px-5 py-2.5 font-mono text-[10px] uppercase tracking-widest text-[var(--muted)] hover:border-[var(--foreground)] transition-colors"
                    >
                      Leaderboard
                    </Link>
                  </div>
                </div>
              ) : (
                <p className="font-mono text-[11px] uppercase tracking-widest text-[var(--muted)] mt-3">
                  {isConnected
                    ? "Complete the steps above and the bound byline appears here."
                    : "Connect a wallet to begin."}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      <p className="mt-10 font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--muted)]">
        TRUTHLY · World ID for Agents ·{" "}
        <Link href="/court" className="underline hover:text-[var(--accent)]">
          Appeal Court
        </Link>
      </p>
    </main>
  );
}
