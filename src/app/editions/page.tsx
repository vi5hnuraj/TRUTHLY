"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";

interface Edition {
  id: string;
  number: number;
  title: string;
  summary: string | null;
  signalCount: number;
  priceCents: number;
  publishedAt: string;
}

export default function EditionsPage() {
  const [editions, setEditions] = useState<Edition[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/editions")
      .then((r) => r.json())
      .then((d) => setEditions(d.editions))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-[var(--background)] pt-40 pb-20 px-6">
      <div className="max-w-5xl mx-auto">
        <header className="mb-16 border-b border-[var(--border)] pb-8">
          <div className="flex items-center gap-3 mb-4">
            <span className="h-3 w-3 bg-[var(--accent)] inline-block"></span>
            <span className="font-mono text-xs font-bold uppercase tracking-widest text-[var(--muted)]">
              Dispatch Archive
            </span>
          </div>
          <h1 className="text-5xl md:text-6xl font-sans font-bold uppercase tracking-tighter">
            The <span className="italic text-[var(--accent)] font-light lowercase">complete</span> Editions
          </h1>
          <p className="font-sans text-xl text-[var(--muted)] mt-6 italic max-w-2xl leading-relaxed">
            Fact-checked crypto and agent-economy editions, compiled by Herald, our AI editor.
          </p>
        </header>

        {loading ? (
          <div className="grid md:grid-cols-2 gap-8">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-64 bg-[var(--card)] animate-pulse border border-[var(--border)]" />
            ))}
          </div>
        ) : editions.length === 0 ? (
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="border-2 border-dashed border-[var(--border)] p-16 text-center"
          >
            <p className="font-sans text-2xl italic text-[var(--muted)] mb-8">
              No editions published yet. Signals are being collected by our contributors.
            </p>
            <Link href="/subscribe" className="inline-block bg-[var(--foreground)] text-[var(--background)] px-8 py-4 font-mono text-xs uppercase tracking-widest font-bold">
              Subscribe to get Notified
            </Link>
          </motion.div>
        ) : (
          <motion.div 
            initial="hidden"
            animate="show"
            variants={{
              hidden: { opacity: 0 },
              show: {
                opacity: 1,
                transition: {
                  staggerChildren: 0.1
                }
              }
            }}
            className="grid md:grid-cols-2 gap-8 lg:gap-12"
          >
            {editions.map((e) => (
              <motion.div
                key={e.id}
                variants={{
                  hidden: { opacity: 0, y: 20 },
                  show: { opacity: 1, y: 0 }
                }}
              >
                <Link
                  href={`/editions/${e.id}`}
                  className="group block bg-[var(--card)] border border-[var(--border)] p-8 hover:border-[var(--border-strong)] transition-all hover:-translate-y-1 no-underline h-full flex flex-col"
                >
                  <div className="flex items-center justify-between mb-6 border-b border-[var(--border)] pb-4">
                    <span className="text-xs font-mono text-[var(--accent)] font-bold uppercase tracking-widest">
                      Edition #{e.number}
                    </span>
                    <span className="text-[10px] font-mono text-[var(--muted)] uppercase font-bold tracking-widest">
                      {new Date(e.publishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }).toUpperCase()}
                    </span>
                  </div>
                  <h2 className="text-3xl font-sans font-bold text-[var(--foreground)] mb-4 group-hover:text-[var(--accent)] transition-colors leading-tight">
                    {e.title}
                  </h2>
                  {e.summary && (
                    <p className="text-base text-[var(--muted)] font-sans italic mb-8 flex-1 leading-relaxed">
                      &ldquo;{e.summary}&rdquo;
                    </p>
                  )}
                  <div className="mt-auto pt-6 flex items-center justify-between border-t border-[var(--border)]">
                    <div className="flex gap-4 text-[10px] font-mono font-bold uppercase tracking-widest text-[var(--muted)]">
                      <span>{e.signalCount} Signals</span>
                      <span>${(e.priceCents / 100).toFixed(2)} USD</span>
                    </div>
                    <span className="font-mono text-[10px] font-bold uppercase text-[var(--accent)] opacity-0 group-hover:opacity-100 transition-opacity">
                      Read Dispatch &rarr;
                    </span>
                  </div>
                </Link>
              </motion.div>
            ))}
          </motion.div>
        )}
      </div>
    </div>
  );
}
