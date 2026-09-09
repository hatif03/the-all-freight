"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const NAV_ITEMS = [
  { href: "/", label: "Plan a Shipment" },
  { href: "/ops", label: "Live Ops Room" },
] as const;

/** Poll the ops backend for whether there's an unresolved incident, so the
 * nav can surface it ambiently from anywhere in the app. Silent no-op if the
 * backend is unreachable — this is a nice-to-have signal, not a hard dependency. */
function useActiveIncident(): boolean {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const apiBase = process.env.NEXT_PUBLIC_API_URL;
    if (!apiBase) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(`${apiBase}/incidents/active`);
        if (!res.ok) {
          if (!cancelled) setActive(false);
          return;
        }
        const data = await res.json();
        // /incidents/active falls back to the latest incident overall when none
        // are unresolved, so a 200 doesn't itself mean "active" — check the phase.
        const phase = data?.incident?.phase;
        const isUnresolved = Boolean(phase) && !["approved", "rejected", "completed"].includes(phase);
        if (!cancelled) setActive(isUnresolved);
      } catch {
        if (!cancelled) setActive(false);
      }
    };

    poll();
    const id = setInterval(poll, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return active;
}

export function Header() {
  const pathname = usePathname();
  const hasActiveIncident = useActiveIncident();

  return (
    <header className="border-b border-border bg-panel/60 backdrop-blur sticky top-0 z-30">
      <div className="mx-auto max-w-7xl px-5 h-14 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-3 group/logo">
          <div className="grid size-10 place-items-center">
            <svg viewBox="0 0 32 32" className="size-10">
              <circle cx="16" cy="16" r="14" className="fill-accent" />
              <g className="origin-center transition-transform duration-700 group-hover/logo:rotate-45">
                <path d="M16 6 L19 16 L16 13 L13 16 Z" className="fill-white" />
                <path d="M16 26 L13 16 L16 19 L19 16 Z" className="fill-white/55" />
              </g>
              <circle cx="16" cy="16" r="1.4" className="fill-white" />
            </svg>
          </div>
          <div className="leading-none">
            <div className="font-semibold tracking-tight text-[15px]">
              The All <span className="text-accent">Freight</span>
            </div>
            <div className="text-[10px] text-muted mono mt-1.5 tracking-[0.18em]">
              SUPPLY-CHAIN RISK INTELLIGENCE
            </div>
          </div>
        </Link>

        <div className="flex items-center gap-3 text-[11px] mono">
          <nav className="flex items-center gap-1">
            {NAV_ITEMS.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`px-2 py-1 rounded-md border transition flex items-center gap-1.5 ${
                    isActive
                      ? "border-accent/40 text-accent bg-accent/10"
                      : "border-border text-muted hover:text-foreground hover:border-accent/40"
                  }`}
                >
                  {item.href === "/ops" && hasActiveIncident && (
                    <span className="size-1.5 rounded-full bg-danger animate-pulse" title="Unresolved incident" />
                  )}
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <span className="text-muted hidden sm:inline">powered by</span>
          <span className="text-accent-2 font-semibold">Anakin</span>
        </div>
      </div>
    </header>
  );
}
