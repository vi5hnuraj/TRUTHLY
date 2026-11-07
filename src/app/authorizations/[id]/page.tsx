import Link from "next/link";
import { notFound } from "next/navigation";
import { isWorldAction, purposeForAction, type JsonValue } from "@/lib/world/actions";
import {
  getWorldAuthorization,
  publicAuthorizationView,
} from "@/lib/world/authorizations";
import { describeAuthorization } from "@/lib/world/summary";

export const dynamic = "force-dynamic";

export default async function AuthorizationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const [{ id }, search] = await Promise.all([params, searchParams]);
  const authorization = await getWorldAuthorization(id);
  if (!authorization) notFound();
  const view = publicAuthorizationView(authorization);
  const returnTo = search.returnTo?.startsWith("/") ? search.returnTo : "/";
  const purpose = isWorldAction(authorization.action)
    ? purposeForAction[authorization.action]
    : null;

  // The summary is rendered from the same canonical payload that produced the
  // stored digest. A mismatch means the record was altered after approval was
  // requested, so the page refuses to offer the ceremony at all.
  const summary = isWorldAction(authorization.action)
    ? describeAuthorization(
        authorization.action,
        view.payload as Record<string, JsonValue>,
        view.payload_hash,
      )
    : null;
  const tampered = summary ? !summary.integrity.valid : false;

  const start =
    purpose && !tampered
      ? `/api/world/start?${new URLSearchParams({
          purpose,
          authorizationId: authorization.id,
          returnTo,
        }).toString()}`
      : null;

  return (
    <main className="min-h-screen max-w-3xl mx-auto px-6 py-16">
      <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-[var(--muted)] mb-2">
        World-Gated Newsroom Mandate
      </p>
      <h1 className="font-sans text-5xl font-bold uppercase tracking-tight mb-3">
        {summary ? summary.title : <>Exact <span className="text-[var(--accent)] italic lowercase">authorization</span></>}
      </h1>
      <p className="font-sans text-lg text-[var(--muted)] italic mb-8">
        {summary
          ? "This is exactly what your fresh World approval will authorize. Every field below is read from the payload that was hashed."
          : "World proves who is approving. This page shows exactly what that approval can do."}
      </p>

      {tampered ? (
        <section className="border-2 border-red-500 p-5 mb-6">
          <p className="font-mono text-[10px] uppercase tracking-widest text-red-400 mb-2">
            Payload integrity check failed
          </p>
          <p className="font-sans text-sm text-[var(--muted)]">
            This record no longer matches its stored hash, so no approval can be requested for it.
            Start a new request from the original action.
          </p>
          <p className="font-mono text-[10px] break-all mt-3">stored: {summary?.integrity.expected}</p>
          <p className="font-mono text-[10px] break-all">actual: {summary?.integrity.actual}</p>
        </section>
      ) : null}

      {summary ? (
        <>
          <section className="border-2 border-[var(--foreground)] p-5 mb-6">
            <p className="font-mono text-[10px] uppercase tracking-widest mb-2">The operation</p>
            <p className="font-sans text-2xl font-bold leading-tight">{summary.headline}</p>
          </section>

          <div className="grid sm:grid-cols-2 gap-px bg-[var(--border)] border border-[var(--border)] mb-8">
            {summary.fields.map((field) => (
              <div key={field.label} className="bg-[var(--background)] p-4">
                <p className="font-mono text-[9px] uppercase tracking-widest text-[var(--muted)]">
                  {field.label}
                </p>
                <p
                  className={`font-mono break-all mt-1 ${
                    field.emphasis ? "text-sm font-bold" : "text-xs"
                  }`}
                >
                  {field.value}
                </p>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <div className="grid sm:grid-cols-2 gap-px bg-[var(--border)] border border-[var(--border)] mb-8">
        <Fact label="Action" value={view.action} />
        <Fact label="Status" value={view.status} />
        <Fact label="Expires" value={view.expires_at} />
        <Fact label="One use" value={view.consumed_at ? "consumed" : "not consumed"} />
      </div>

      <details className="border border-[var(--border)] p-5 mb-8">
        <summary className="font-mono text-[10px] uppercase tracking-widest cursor-pointer">
          Canonical payload and SHA-256 binding
        </summary>
        <pre className="font-mono text-xs whitespace-pre-wrap break-all overflow-auto mt-3">
          {JSON.stringify(view.payload, null, 2)}
        </pre>
        <p className="font-mono text-[10px] uppercase tracking-widest mt-4 mb-1 text-[var(--muted)]">
          SHA-256 payload binding
        </p>
        <p className="font-mono text-xs break-all">{view.payload_hash}</p>
        <p className="font-mono text-[10px] uppercase tracking-widest mt-3 text-[var(--muted)]">
          {tampered ? "recomputed hash differs" : "recomputed hash matches this payload"}
        </p>
      </details>

      {authorization.status === "pending" && start ? (
        <a
          href={start}
          className="inline-block bg-[var(--foreground)] text-[var(--background)] px-7 py-4 font-mono text-xs uppercase tracking-widest font-bold"
        >
          Approve with fresh World Agent Pass →
        </a>
      ) : (
        <p className="font-mono text-xs uppercase tracking-widest">
          {tampered
            ? "Approval is disabled for this record."
            : `This request is ${authorization.status}. It cannot start another World ceremony.`}
        </p>
      )}

      <p className="font-sans text-sm text-[var(--muted)] mt-6">
        Approving proves a unique human is present now. It does not change these fields: the server
        recomputes the hash from the live request and refuses anything that differs.
      </p>

      <div className="mt-8">
        <Link href={returnTo} className="font-mono text-xs uppercase tracking-widest underline">
          ← Return without approving
        </Link>
      </div>
    </main>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[var(--background)] p-4">
      <p className="font-mono text-[9px] uppercase tracking-widest text-[var(--muted)]">{label}</p>
      <p className="font-mono text-xs break-all mt-1">{value}</p>
    </div>
  );
}
