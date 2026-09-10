"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const NAV_ITEMS = [
  { href: "/", label: "Watchlist" },
  { href: "/plan", label: "Plan" },
  { href: "/ops", label: "Incidents" },
] as const;

/**
 * Whether any tracked shipment currently has an open incident.
 *
 * Reads the watchlist rather than the global incident feed, so the dot means
 * "something is happening to *your* shipment" rather than "something is
 * happening somewhere". One poll, one endpoint — the Supabase pooler has a low
 * client cap, so this deliberately doesn't grow into a per-shipment watcher.
 */
function useOpenIncidents(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const apiBase = process.env.NEXT_PUBLIC_API_URL;
    if (!apiBase) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(`${apiBase}/shipments`);
        if (!res.ok) {
          if (!cancelled) setCount(0);
          return;
        }
        const rows: { open_incident_count?: number }[] = await res.json();
        const open = rows.reduce((n, r) => n + (r.open_incident_count ?? 0), 0);
        if (!cancelled) setCount(open);
      } catch {
        // The backend is a separate deployment and may be down; an ambient
        // signal isn't worth surfacing an error for.
        if (!cancelled) setCount(0);
      }
    };

    poll();
    const id = setInterval(poll, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return count;
}

export function Header() {
  const pathname = usePathname();
  const openIncidents = useOpenIncidents();

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
              // Sub-routes should light their section: /shipments/3 belongs to
              // the watchlist, /ops/12 to incidents.
              const isActive =
                item.href === "/"
                  ? pathname === "/" || pathname.startsWith("/shipments")
                  : pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  data-tour={item.href === "/ops" ? "nav-ops" : undefined}
                  className={`px-2 py-1 rounded-md border transition flex items-center gap-1.5 ${
                    isActive
                      ? "border-accent/40 text-accent bg-accent/10"
                      : "border-border text-muted hover:text-foreground hover:border-accent/40"
                  }`}
                >
                  {item.href === "/ops" && openIncidents > 0 && (
                    <span
                      className="size-1.5 rounded-full bg-danger animate-pulse"
                      title={`${openIncidents} open incident${openIncidents > 1 ? "s" : ""} on your tracked shipments`}
                    />
                  )}
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <Link
            href="/how-it-works"
            title="How this works"
            aria-label="How this works"
            className="size-6 grid place-items-center rounded-md border border-border text-muted hover:text-foreground hover:border-accent/40 transition"
          >
            ?
          </Link>
          <span data-tour="provenance" className="flex items-center gap-1.5">
            <span className="text-muted hidden sm:inline">powered by</span>
            <span className="text-accent-2 font-semibold">Anakin</span>
          </span>
        </div>
      </div>
    </header>
  );
}
