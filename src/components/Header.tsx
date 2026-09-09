import Link from "next/link";

export function Header({ dataMode }: { dataMode?: "live" | "mock" }) {
  return (
    <header className="border-b border-border bg-panel/60 backdrop-blur sticky top-0 z-30">
      <div className="mx-auto max-w-7xl px-5 h-14 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="group grid size-10 place-items-center">
            <svg viewBox="0 0 32 32" className="size-10">
              <circle cx="16" cy="16" r="14" className="fill-accent" />
              <g className="origin-center transition-transform duration-700 group-hover:rotate-45">
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
        </div>
        <div className="flex items-center gap-3 text-[11px] mono">
          {dataMode && (
            <span
              className={
                "px-2 py-1 rounded-md border " +
                (dataMode === "live"
                  ? "border-ok/40 text-ok bg-ok/10"
                  : "border-warn/40 text-warn bg-warn/10")
              }
            >
              {dataMode === "live" ? "● LIVE DATA" : "● DEMO DATA"}
            </span>
          )}
          <Link
            href="/ops"
            className="px-2 py-1 rounded-md border border-border text-muted hover:text-foreground hover:border-accent/40 transition"
          >
            Live Ops Room
          </Link>
          <span className="text-muted hidden sm:inline">powered by</span>
          <span className="text-accent-2 font-semibold">Anakin</span>
        </div>
      </div>
    </header>
  );
}
