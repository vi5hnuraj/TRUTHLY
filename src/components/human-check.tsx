"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  IDKitRequestWidget,
  proofOfHuman,
  useIDKitRequest,
  type IDKitResult,
  type RpContext,
} from "@worldcoin/idkit";
import { useSignMessage } from "wagmi";
import { idkitWalletBindingMessage } from "@/lib/idkit/wallet-binding";

/**
 * Unique-human enrollment with an additional wallet-ownership proof.
 * The RP issues a one-use nonce, the owner wallet signs it, and IDKit binds the
 * proof to that lowercase wallet before the backend creates one principal.
 */

type IdkitConfig = {
  enabled: boolean;
  /** IDKit only accepts an app id in the portal's `app_…` form. */
  app_id: `app_${string}` | null;
  rp_id: string | null;
  action: string;
  environment: "production" | "staging" | "sandbox";
  allow_simulator?: boolean;
  signalRule?: string;
};

async function verificationStatus(address: string): Promise<boolean> {
  const res = await fetch(`/api/idkit/status/${address}`);
  if (!res.ok) throw new Error(`status request failed (${res.status})`);
  const data = (await res.json()) as { verified: boolean };
  return data.verified;
}

/** Server-side verification happens in /api/idkit/verify — the widget never decides. */
async function postVerify(address: string, result: IDKitResult, walletSignature: string) {
  const res = await fetch("/api/idkit/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, idkitResponse: result, walletSignature }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    verified?: boolean;
    error?: string;
  };
  if (!data.verified) throw new Error(data.error ?? "verification failed");
}

/**
 * SIMULATOR PATH — World's official desktop Simulator (simulator.worldcoin.org),
 * env "staging" per docs.world.org/world-id/idkit/integrate ("To test during
 * development, use the simulator and set environment to staging").
 *
 * The old staging.world.org/verify bridge URL in the installed widget's env map
 * is retired (it 307s into the production connect page), so we do NOT open the
 * widget modal here: the request runs headless via useIDKitRequest and its
 * connector URL is handed to the Simulator's "Paste code". The headless hook
 * exposes exactly that URL (connectorURI) and the finished proof (result) —
 * the proof is still validated by our server at /api/idkit/verify, exactly
 * like the phone path.
 */
function SimulatorCheck({
  address,
  appId,
  action,
  rpContext,
  walletSignature,
  onVerified,
  onErr,
}: {
  address: string;
  appId: `app_${string}`;
  action: string;
  rpContext: RpContext;
  walletSignature: string;
  onVerified: () => void;
  onErr: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [posting, setPosting] = useState(false);
  const req = useIDKitRequest({
    app_id: appId,
    action,
    rp_context: rpContext,
    environment: "staging",
    // The Simulator parses the production verify-URL shape; staging.world.org
    // is retired, so build the same shape the app itself would produce.
    override_connect_base_url: "https://world.org/verify",
    allow_legacy_proofs: true,
    preset: proofOfHuman({ signal: address.toLowerCase() }),
  });
  const opened = useRef(false);
  const posted = useRef(false);

  useEffect(() => {
    if (!opened.current) {
      opened.current = true;
      req.open();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Proof arrived → same server endpoint as the phone path. Once.
  useEffect(() => {
    if (!req.result || posted.current) return;
    posted.current = true;
    const result = req.result;
    (async () => {
      try {
        setPosting(true);
        await postVerify(address, result, walletSignature);
        onVerified();
      } catch (e) {
        onErr(`World ID: ${(e as Error).message}`);
      } finally {
        setPosting(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req.result]);

  const connector = req.connectorURI;
  const phase = posting
    ? "verifying with your server…"
    : connector
      ? "waiting for your approval in the Simulator…"
      : "creating the request…";

  return (
    <div className="border border-[var(--border)] p-4 flex flex-col gap-3 font-mono text-[11px]">
      <p className="uppercase tracking-widest font-bold">
        🖥 Simulator mode — no phone needed
      </p>
      <ol className="list-decimal pl-4 flex flex-col gap-1 text-[var(--muted)]">
        <li>
          Open{" "}
          <a
            className="underline text-[var(--accent)] font-bold"
            href="https://simulator.worldcoin.org/"
            target="_blank"
            rel="noreferrer"
            onClick={() =>
              connector &&
              navigator.clipboard?.writeText(connector).then(
                () => setCopied(true),
                () => {},
              )
            }
          >
            simulator.worldcoin.org ↗
          </a>{" "}
          and click <span className="font-bold">Paste code</span> there.
        </li>
        <li>Paste this link (copied for you when the page opened):</li>
      </ol>
      <div className="flex flex-wrap items-stretch gap-2">
        <textarea
          readOnly
          value={connector ?? ""}
          placeholder="generating…"
          rows={2}
          className="flex-1 min-w-64 border border-[var(--border)] bg-transparent p-2 text-[10px] break-all"
        />
        <button
          type="button"
          disabled={!connector}
          onClick={() =>
            connector &&
            navigator.clipboard?.writeText(connector).then(
              () => setCopied(true),
              () => {},
            )
          }
          className="border border-[var(--border)] px-3 py-1 uppercase tracking-widest disabled:opacity-50"
        >
          {copied ? "✓ copied" : "copy"}
        </button>
      </div>
      <ol start={3} className="list-decimal pl-4 text-[var(--muted)]">
        <li>
          Approve inside the Simulator — this page completes on its own.
        </li>
      </ol>
      <p className="uppercase tracking-widest text-[var(--muted)]">
        {req.isError
          ? ""
          : req.isSuccess
            ? "✓ proof received from the Simulator"
            : phase}
      </p>
      {req.isError && (
        <p className="uppercase tracking-widest text-red-500">
          {(() => {
            const dbg = req.getDebugReport();
            const msg = dbg && "message" in dbg ? ` · ${String(dbg.message)}` : "";
            return `World ID: ${req.errorCode}${dbg?.request_id ? ` · request=${dbg.request_id}` : ""}${msg}`;
          })()}
        </p>
      )}
    </div>
  );
}

export function HumanCheck({
  address,
  onVerified,
}: {
  address: string;
  onVerified: (verified: boolean) => void;
}) {
  const [cfg, setCfg] = useState<IdkitConfig | null>(null);
  const [verified, setVerified] = useState<boolean | null>(null);
  const [rp, setRp] = useState<RpContext | null>(null);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [walletSignature, setWalletSignature] = useState<string | null>(null);
  const signMessage = useSignMessage();
  // Which World surface answers the request: the phone app (sandbox/production)
  // or the in-browser Simulator (staging.world.org). Both are World's own
  // environments; the choice only changes where the QR/bridge points.
  const [sim, setSim] = useState(false);
  const environment = sim ? "staging" : cfg?.environment ?? "sandbox";

  const refresh = useCallback(async () => {
    try {
      const status = await verificationStatus(address);
      setVerified(status);
      onVerified(status);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [address, onVerified]);

  useEffect(() => {
    fetch("/api/idkit/config")
      .then((r) => r.json())
      .then((c: IdkitConfig) => setCfg(c))
      .catch((e) => setErr((e as Error).message));
    verificationStatus(address)
      .then((status) => {
        setVerified(status);
        onVerified(status);
      })
      .catch((e) => setErr((e as Error).message));
  }, [address, onVerified]);

  async function start() {
    if (!cfg) return;
    setErr(null);
    setBusy(true);
    try {
      const res = await fetch("/api/idkit/rp-signature", { method: "POST" });
      const data = (await res.json()) as {
        sig?: string;
        nonce?: string;
        created_at?: number;
        expires_at?: number;
        error?: string;
      };
      if (!res.ok || !data.sig || !data.nonce) {
        throw new Error(data.error ?? `rp-signature failed (${res.status})`);
      }
      const signature = await signMessage.mutateAsync({
        message: idkitWalletBindingMessage({
          address,
          nonce: data.nonce,
          action: cfg.action,
        }),
      });
      setWalletSignature(signature);
      setRp({
        rp_id: cfg.rp_id!,
        nonce: data.nonce,
        created_at: data.created_at!,
        expires_at: data.expires_at!,
        signature: data.sig,
      });
      setOpen(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** Server-side verification happens in /api/idkit/verify — the widget never decides. */
  async function handleVerify(result: IDKitResult) {
    if (!walletSignature) throw new Error("owner-wallet signature is missing — start again");
    const res = await fetch("/api/idkit/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, idkitResponse: result, walletSignature }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      verified?: boolean;
      error?: string;
    };
    if (!data.verified) throw new Error(data.error ?? "verification failed");
  }

  // ---- already proven ----
  if (verified) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="border-2 border-[var(--accent)] px-3 py-1 font-mono text-[10px] uppercase tracking-widest font-bold text-[var(--accent)]">
          ✓ unique human
        </span>
        <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--muted)]">
          This wallet is the owner of one verified human principal.
        </span>
      </div>
    );
  }

  // the protocol renders one block in all three states — never a different screen:
  // the button is always there, disabled until the backend is configured, with
  // the reason on the same row.
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3">
        <p className="font-sans text-[15px] text-[var(--muted)] italic max-w-2xl">
          Prove you&apos;re a unique human with World ID. The proof&apos;s signal is
          this owner wallet and creates one anonymous newsroom principal. That
          principal may delegate limited agent wallets, but all of them share one
          reputation, quota and independence boundary. No personal data is shared.
        </p>
        {cfg?.enabled && cfg.allow_simulator && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--muted)]">
              verify with:
            </span>
            <button
              type="button"
              onClick={() => setSim(false)}
              className={`px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest border-2 transition-transform ${
                !sim
                  ? "border-[var(--accent)] font-bold text-[var(--accent)]"
                  : "border-[var(--border)] text-[var(--muted)]"
              }`}
            >
              📱 phone — World ID app (this QR)
            </button>
            <button
              type="button"
              onClick={() => setSim(true)}
              className={`px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest border-2 transition-transform ${
                sim
                  ? "border-[var(--accent)] font-bold text-[var(--accent)]"
                  : "border-[var(--border)] text-[var(--muted)]"
              }`}
            >
              🖥 simulator — right in this browser
            </button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button
            className="bg-[var(--foreground)] text-[var(--background)] px-6 py-3 rounded-full font-mono text-xs uppercase tracking-widest font-bold hover:scale-105 transition-transform disabled:opacity-50 disabled:hover:scale-100"
            disabled={!cfg || busy || !cfg.enabled}
            onClick={() => void start()}
          >
            {busy ? "working…" : "◎ Prove you're human"}
          </button>
          {cfg && !cfg.enabled && (
            <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--muted)]">
              IDKit not configured on the backend
            </span>
          )}
        </div>
      </div>
      {err && (
        <p className="font-mono text-[11px] uppercase tracking-widest text-red-500">
          {err}
        </p>
      )}
      {cfg?.enabled && rp && cfg.app_id && walletSignature && (
        sim ? (
          <SimulatorCheck
            address={address}
            appId={cfg.app_id}
            action={cfg.action}
            rpContext={rp}
            walletSignature={walletSignature}
            onVerified={() => void refresh()}
            onErr={setErr}
          />
        ) : (
          <IDKitRequestWidget
            open={open}
            onOpenChange={setOpen}
            app_id={cfg.app_id}
            action={cfg.action}
            rp_context={rp}
            environment={environment}
            allow_legacy_proofs={true}
            preset={proofOfHuman({ signal: address.toLowerCase() })}
            handleVerify={handleVerify}
            onSuccess={() => void refresh()}
            // World's docs: the debugReport is what replaces the app's generic
            // "Something went wrong" with a real error code + request_id we can
            // correlate against the bridge. Never swallow it.
            onError={(code, debugReport) =>
              setErr(
                `World ID: ${code}` +
                  (debugReport
                    ? ` · transport=${debugReport.transport ?? "?"}` +
                      (debugReport.request_id ? ` · request=${debugReport.request_id}` : "") +
                      ("message" in debugReport && debugReport.message
                        ? ` · ${String(debugReport.message)}`
                        : "")
                    : ""),
              )
            }
          />
        )
      )}
    </div>
  );
}
