"use client";

import { useSyncExternalStore } from "react";

const THEME_EVENT = "truthly-theme-change";

function subscribe(onChange: () => void) {
  window.addEventListener(THEME_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(THEME_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function currentTheme(): "light" | "dark" {
  return document.documentElement.getAttribute("data-theme") === "dark"
    ? "dark"
    : "light";
}

/** Injected before paint by layout.tsx; this component just controls it. */
export default function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "light");

  const flip = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      /* private mode; fine */
    }
    window.dispatchEvent(new Event(THEME_EVENT));
  };

  return (
    <button
      onClick={flip}
      aria-label="Toggle dark mode"
      className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] p-1 transition-colors hover:border-[var(--border-strong)]"
    >
      {/* sun */}
      <span
        className={`flex h-7 w-7 items-center justify-center rounded-full text-[13px] transition-all ${
          theme === "light"
            ? "bg-[var(--foreground)] text-[var(--background)]"
            : "text-[var(--muted)]"
        }`}
      >
        ☀
      </span>
      {/* moon */}
      <span
        className={`flex h-7 w-7 items-center justify-center rounded-full text-[13px] transition-all ${
          theme === "dark"
            ? "bg-[var(--foreground)] text-[var(--background)]"
            : "text-[var(--muted)]"
        }`}
      >
        ☾
      </span>
    </button>
  );
}
