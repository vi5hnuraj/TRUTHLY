import Link from "next/link";
import { MOCK_PERSONAS, mockEnabled } from "@/lib/world/mock";

/**
 * The screen World would show (a QR to scan with the World App). Since this
 * machine has no World account, the developer picks which human "scans" here.
 *
 * It is a server component on purpose: the session state arrives as a query
 * param, and every button is a plain link into /api/world/callback — the same
 * entry point World's redirect uses, so the callback path under test is the
 * real one. DEV ONLY: without WORLD_DEV_MOCK=1 this page says so and offers
 * nothing to click.
 */
export const dynamic = "force-dynamic";

export default async function MockWorldPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string; error?: string }> | { state?: string; error?: string };
}) {
  const sp = await Promise.resolve(searchParams);
  const state = sp.state ?? "";

  if (!mockEnabled()) {
    return (
      <main className="min-h-screen max-w-xl mx-auto px-6 py-20 font-mono text-sm">
        <h1 className="text-2xl font-bold uppercase tracking-widest mb-4">
          Mock verification is off
        </h1>
        <p className="text-[var(--muted)] mb-6">
          Set WORLD_DEV_MOCK=1 in .env.local to simulate a World check locally,
          or start the real flow at /api/world/start with World credentials.
        </p>
        <Link href="/court" className="underline">
          Back to the Appeal Court
        </Link>
      </main>
    );
  }

  if (!state) {
    return (
      <main className="min-h-screen max-w-xl mx-auto px-6 py-20 font-mono text-sm">
        <h1 className="text-2xl font-bold uppercase tracking-widest mb-4">
          No attempt to continue
        </h1>
        <p className="text-[var(--muted)] mb-6">
          This page was opened without a session state. Start the flow from the
          Appeal Court instead.
        </p>
        <Link href="/court" className="underline">
          Back to the Appeal Court
        </Link>
      </main>
    );
  }

  const cb = (params: Record<string, string>) =>
    `/api/world/callback?${new URLSearchParams({ state, ...params }).toString()}`;

  return (
    <main className="min-h-screen max-w-2xl mx-auto px-6 py-16">
      <div className="border-2 border-yellow-500 bg-yellow-500/10 p-4 mb-8 font-mono text-xs uppercase tracking-widest text-yellow-500">
        🧪 Mock verification — local only. No World App account was used. A
        judge-facing demo must record the real auth.world.org screen instead.
      </div>

      <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-[var(--muted)] mb-2">
        TRUTHLY · World ID for Agents
      </p>
      <h1 className="font-sans text-4xl md:text-5xl font-bold uppercase tracking-tight mb-3">
        Who is <span className="italic lowercase text-[var(--accent)]">scanning</span>?
      </h1>
      <p className="font-sans text-lg text-[var(--muted)] italic mb-10">
        In production this is World&apos;s QR page. Pick the human the World App
        would be holding — each choice sends a different identity back through
        the real callback.
      </p>

      <div className="space-y-3 mb-8">
        {MOCK_PERSONAS.map((p) => (
          <a
            key={p.id}
            href={cb({ mock: p.id })}
            className="block border border-[var(--border)] p-5 hover:border-[var(--accent)] hover:bg-[var(--accent)]/5 transition-colors"
          >
            <p className="font-mono text-xs uppercase tracking-widest font-bold">
              {p.label}
            </p>
            <p className="font-sans text-sm text-[var(--muted)] mt-1">{p.note}</p>
          </a>
        ))}
        <a
          href={cb({ error: "access_denied" })}
          className="block border border-[var(--border)] border-dashed p-5 text-[var(--muted)] hover:border-red-500 hover:text-red-500 transition-colors"
        >
          <p className="font-mono text-xs uppercase tracking-widest font-bold">
            Cancel at the prompt
          </p>
          <p className="font-sans text-sm mt-1">
            The user refuses — the attempt is recorded as cancelled and nothing is unlocked.
          </p>
        </a>
      </div>

      <Link href="/court" className="font-mono text-xs uppercase tracking-widest underline">
        ← Back to the Appeal Court
      </Link>
    </main>
  );
}
