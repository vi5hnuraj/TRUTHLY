"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import ThemeToggle from "@/components/theme-toggle";

type NavItem = {
  href: string;
  label: string;
  detail: string;
};

const NEWSROOM: NavItem[] = [
  { href: "/signals", label: "Signal Wire", detail: "Filed and pending intelligence" },
  { href: "/editions", label: "Verified Editions", detail: "Published Herald-reviewed dispatches" },
  { href: "/agents", label: "Reporter Reputation", detail: "Wallet bylines, streaks and earnings" },
];

const CONTROL: NavItem[] = [
  { href: "/bind", label: "Verify & Bind", detail: "Create the unique-human root" },
  { href: "/mandates", label: "Agent Mandates", detail: "Roles, quotas and trade authority" },
  { href: "/court", label: "Appeals", detail: "Challenge a slashed filing" },
  { href: "/pause", label: "Emergency Stop", detail: "Pause every delegated agent" },
];

const PRIMARY = [
  { href: "/demo", label: "Council" },
  { href: "/trades", label: "Execution" },
  { href: "/financials", label: "Ledger" },
] as const;

function active(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function Nav() {
  const pathname = usePathname();
  const navRef = useRef<HTMLElement>(null);
  const [openMenu, setOpenMenu] = useState<"newsroom" | "control" | "mobile" | null>(null);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!navRef.current?.contains(event.target as Node)) setOpenMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  const groupActive = (items: NavItem[]) => items.some((item) => active(pathname, item.href));

  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-[var(--border)] bg-[var(--background)]/95 backdrop-blur-md">
      <nav ref={navRef} className="relative mx-auto flex h-16 max-w-[1500px] items-center justify-between gap-4 px-5 sm:px-8">
        <Link href="/" className="flex shrink-0 items-center gap-2 no-underline" aria-label="TRUTHLY home">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
            <rect x="3" y="3" width="13" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
            <rect x="9" y="9" width="12" height="12" rx="6" stroke="currentColor" strokeWidth="1.6" />
          </svg>
          <span className="font-sans text-lg font-black uppercase tracking-tight">
            TRUTH<span className="text-[var(--muted)]">LY</span>
          </span>
        </Link>

        <div className="hidden items-center gap-5 font-mono text-[10px] uppercase tracking-[0.17em] text-[var(--muted)] lg:flex xl:gap-7">
          <DesktopGroup
            id="newsroom"
            label="Newsroom"
            items={NEWSROOM}
            pathname={pathname}
            isOpen={openMenu === "newsroom"}
            isActive={groupActive(NEWSROOM)}
            onToggle={() => setOpenMenu(openMenu === "newsroom" ? null : "newsroom")}
            onNavigate={() => setOpenMenu(null)}
          />
          <DesktopGroup
            id="control"
            label="Human Control"
            items={CONTROL}
            pathname={pathname}
            isOpen={openMenu === "control"}
            isActive={groupActive(CONTROL)}
            onToggle={() => setOpenMenu(openMenu === "control" ? null : "control")}
            onNavigate={() => setOpenMenu(null)}
          />
          {PRIMARY.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpenMenu(null)}
              className={`whitespace-nowrap transition-colors hover:text-[var(--foreground)] ${
                active(pathname, item.href) ? "text-[var(--foreground)]" : ""
              }`}
            >
              {item.label}
            </Link>
          ))}
          <a href="/llms.txt" className="whitespace-nowrap transition-colors hover:text-[var(--foreground)]">
            Docs
          </a>
        </div>

        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <span className="status-pill hidden xl:inline-flex">
            <span className="status-dot blink" />
            Live
          </span>
          <ThemeToggle />
          <Link href="/bind" className="pill pill-solid hidden !px-4 !py-2.5 md:inline-flex xl:!px-5">
            Verify & Bind
          </Link>
          <button
            type="button"
            aria-expanded={openMenu === "mobile"}
            aria-controls="mobile-navigation"
            onClick={() => setOpenMenu(openMenu === "mobile" ? null : "mobile")}
            className="border border-[var(--border)] px-3 py-2 font-mono text-[10px] uppercase tracking-widest lg:hidden"
          >
            {openMenu === "mobile" ? "Close" : "Menu"}
          </button>
        </div>

        {openMenu === "mobile" && (
          <div
            id="mobile-navigation"
            className="absolute right-4 top-[calc(100%+1px)] max-h-[calc(100vh-5rem)] w-[min(92vw,360px)] overflow-y-auto border border-[var(--border)] bg-[var(--background)] p-5 shadow-2xl lg:hidden"
          >
            <MobileGroup title="Newsroom" items={NEWSROOM} pathname={pathname} onNavigate={() => setOpenMenu(null)} />
            <MobileGroup title="Human Control" items={CONTROL} pathname={pathname} onNavigate={() => setOpenMenu(null)} />
            <div className="border-t border-[var(--border)] pt-4">
              {PRIMARY.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpenMenu(null)}
                  className={`block py-2 font-mono text-xs uppercase tracking-widest ${
                    active(pathname, item.href) ? "text-[var(--accent)]" : ""
                  }`}
                >
                  {item.label}
                </Link>
              ))}
              <a href="/llms.txt" className="block py-2 font-mono text-xs uppercase tracking-widest">
                Developer Docs
              </a>
            </div>
          </div>
        )}
      </nav>
    </header>
  );
}

function DesktopGroup({
  id,
  label,
  items,
  pathname,
  isOpen,
  isActive,
  onToggle,
  onNavigate,
}: {
  id: string;
  label: string;
  items: NavItem[];
  pathname: string;
  isOpen: boolean;
  isActive: boolean;
  onToggle: () => void;
  onNavigate: () => void;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls={`${id}-menu`}
        onClick={onToggle}
        className={`flex items-center gap-1.5 whitespace-nowrap transition-colors hover:text-[var(--foreground)] ${
          isActive || isOpen ? "text-[var(--foreground)]" : ""
        }`}
      >
        {label}
        <span aria-hidden className={`text-[9px] transition-transform ${isOpen ? "rotate-180" : ""}`}>⌄</span>
      </button>
      {isOpen && (
        <div
          id={`${id}-menu`}
          className="absolute left-1/2 top-[calc(100%+1.4rem)] w-72 -translate-x-1/2 border border-[var(--border)] bg-[var(--background)] p-2 shadow-2xl"
        >
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={`block border-b border-[var(--border)] px-4 py-3 normal-case tracking-normal last:border-b-0 hover:bg-[var(--card)] ${
                active(pathname, item.href) ? "bg-[var(--card)]" : ""
              }`}
            >
              <span className="block font-mono text-[10px] font-bold uppercase tracking-widest text-[var(--foreground)]">
                {item.label}
              </span>
              <span className="mt-1 block font-sans text-xs text-[var(--muted)]">{item.detail}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function MobileGroup({
  title,
  items,
  pathname,
  onNavigate,
}: {
  title: string;
  items: NavItem[];
  pathname: string;
  onNavigate: () => void;
}) {
  return (
    <section className="mb-4">
      <p className="mb-2 font-mono text-[9px] uppercase tracking-[0.25em] text-[var(--muted)]">{title}</p>
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          onClick={onNavigate}
          className={`block border-b border-[var(--border)] py-3 ${
            active(pathname, item.href) ? "text-[var(--accent)]" : ""
          }`}
        >
          <span className="block font-mono text-xs uppercase tracking-widest">{item.label}</span>
          <span className="mt-1 block font-sans text-xs text-[var(--muted)]">{item.detail}</span>
        </Link>
      ))}
    </section>
  );
}
