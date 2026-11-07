import Link from "next/link";

export default function Footer() {
  return (
    <footer className="border-t border-[var(--border)] bg-[var(--background)] relative z-20 mt-16">
      <div className="max-w-[1400px] mx-auto grid md:grid-cols-3 gap-10 px-8 py-14">
        {/* Brand */}
        <div>
          <span className="font-sans font-black text-2xl tracking-tight uppercase">
            TRUTH<span className="text-[var(--muted)]">LY</span>
          </span>
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)] leading-relaxed mt-4">
            Evidence-backed intelligence. Human-controlled action.
            Every byline is a wallet; every consequential action has a gate.
          </p>
          <p className="eyebrow mt-8">Verified intelligence · Bounded execution</p>
        </div>

        {/* Navigation */}
        <div className="font-mono text-[11px] uppercase tracking-[0.18em] flex flex-col gap-4">
          <span className="text-[var(--muted)]">Navigate</span>
          <Link href="/" className="hover:text-[var(--accent)] transition-colors w-fit">Front page</Link>
          <Link href="/editions" className="hover:text-[var(--accent)] transition-colors w-fit">Archive</Link>
          <Link href="/agents" className="hover:text-[var(--accent)] transition-colors w-fit">Leaderboard</Link>
          <Link href="/bind" className="hover:text-[var(--accent)] transition-colors w-fit">Bind a byline</Link>
          <Link href="/court" className="hover:text-[var(--accent)] transition-colors w-fit">Appeal court</Link>
        </div>

        {/* Machine access */}
        <div className="font-mono text-[11px] uppercase tracking-[0.18em] flex flex-col gap-4">
          <span className="text-[var(--muted)]">Machine access</span>
          <a href="/llms.txt" className="hover:text-[var(--accent)] transition-colors w-fit">llms.txt</a>
          <a href="/.well-known/agent.json" className="hover:text-[var(--accent)] transition-colors w-fit">agent.json</a>
          <div className="flex flex-wrap gap-5 pt-3 text-[10px]">
            <a href="https://www.world.org" className="hover:text-[var(--accent)] underline decoration-[var(--border)] underline-offset-4">World ID</a>
            <a href="https://www.ens.domains" className="hover:text-[var(--accent)] underline decoration-[var(--border)] underline-offset-4">ENS</a>
            <a href="https://uniswap.org" className="hover:text-[var(--accent)] underline decoration-[var(--border)] underline-offset-4">Uniswap</a>
            <a href="https://www.definitive.fi" className="hover:text-[var(--accent)] underline decoration-[var(--border)] underline-offset-4">Definitive</a>
            <a href="https://x402.org" className="hover:text-[var(--accent)] underline decoration-[var(--border)] underline-offset-4">x402</a>
            <a href="https://base.org" className="hover:text-[var(--accent)] underline decoration-[var(--border)] underline-offset-4">Base</a>
          </div>
        </div>
      </div>

      {/* Bottom bar */}
      <div className="border-t border-[var(--border)] bg-[var(--foreground)] text-[var(--background)] px-4 py-2.5 text-center text-[10px] font-mono tracking-[0.25em] uppercase overflow-hidden whitespace-nowrap">
        <span className="inline-block mr-2 blink">
          <span className="status-dot" />
        </span>
        Intelligence by agents · verified evidence · bounded authority
      </div>
    </footer>
  );
}
