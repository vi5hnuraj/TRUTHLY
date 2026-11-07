"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

/**
 * Return page after World ID — the protocol's frontend /worldid/return. Polls
 * /api/world/session/:id until the attempt leaves `pending`, then shows the
 * verdict. The product decides what to do; this only reports it truthfully.
 *
 * For an approved appeal it then exercises the protected action
 * (POST /api/appeal) — sending only the server-minted session id, never any
 * World claim — and reports what the court actually did to the stake.
 */
type SessionView = {
  status: string;
  reason?: string;
  purpose?: string;
  returnTo?: string;
  signalId?: string;
  authorizationId?: string;
  action?: string;
  payloadHash?: string;
};

type Confirmation = { appeal?: string; reason?: string | null };

export default function WorldIdReturn() {
  // useSearchParams requires a Suspense boundary for static prerender (Next build).
  return (
    <Suspense fallback={<main className="min-h-screen" />}>
      <WorldIdReturnInner />
    </Suspense>
  );
}

function WorldIdReturnInner() {
  const search = useSearchParams();
  const id = search.get("session");
  const [view, setView] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const sent = useRef(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/world/session/${id}`);
        if (!res.ok) throw new Error(`session request failed (${res.status})`);
        const data = (await res.json()) as SessionView;
        if (cancelled) return;
        setView(data);
        if (data.status === "pending") setTimeout(tick, 1500);
      } catch {
        if (!cancelled) setError("Could not read the World ID attempt.");
      }
    };
    tick();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // The protected action, fired exactly once with the session id alone.
  useEffect(() => {
    if (!id || !view || view.status !== "approved" || !view.signalId) return;
    if (sent.current) return;
    sent.current = true;
    fetch("/api/appeal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: id, signal_id: view.signalId }),
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as Confirmation;
        setConfirm(data);
        if (!res.ok && !data.reason) setError(`The court refused the request (${res.status}).`);
      })
      .catch(() => setError("Could not confirm what the court did with the stake."));
  }, [id, view]);

  const line =
    view?.status === "approved"
      ? confirm
        ? confirm.appeal === "approved"
          ? "Approved — the stake is re-locked and the story is back in Herald's queue for re-review."
          : `Recorded as ${confirm.appeal}${confirm.reason ? ` — ${confirm.reason}` : ""}.`
        : view.purpose === "appeal"
          ? "Verified — asking the court to release the stake…"
          : view.authorizationId
            ? `Approved — one use of ${view.action ?? "the exact action"} is now unlocked. Return and retry the unchanged payload.`
            : "Verified. The byline is now bound to a fresh human check."
      : view?.status === "pending"
        ? "Waiting for World ID to finish…"
        : view?.status
          ? `Denied — ${view.reason ?? view.status}. The protected action did not happen.`
          : null;

  return (
    <main style={{ minHeight: "60vh", display: "grid", placeItems: "center", padding: "4rem 1rem" }}>
      <div style={{ maxWidth: 460, textAlign: "center" }}>
        <h1 className="font-sans text-3xl mb-4">World ID check</h1>
        {line && <p className="font-mono text-sm uppercase tracking-widest">{line}</p>}
        {(error || !id) && (
          <p className="font-mono text-sm uppercase tracking-widest text-red-500">
            {error ?? "No session reference returned from World ID."}
          </p>
        )}
        {view && view.status !== "pending" && (
          <a
            href={view.returnTo && view.returnTo.startsWith("/") ? view.returnTo : "/court"}
            className="inline-block mt-8 font-mono text-xs uppercase tracking-widest underline underline-offset-4"
          >
            Back to where this attempt began →
          </a>
        )}
      </div>
    </main>
  );
}
