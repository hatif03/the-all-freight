"use client";

import type { DependencyDriver } from "@/lib/types";

const IMPACT_COLOR: Record<DependencyDriver["impact"], string> = {
  high: "#f43f5e",
  medium: "#0284c7",
  low: "#6b7280",
};

function truncate(s: string, n = 18): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function DependencyGraph({
  product,
  drivers,
  onSelect,
}: {
  product: string;
  drivers: DependencyDriver[];
  onSelect?: (d: DependencyDriver) => void;
}) {
  const nodes = drivers.slice(0, 9);
  const W = 760;
  const H = 440;
  const cx = W / 2;
  const cy = H / 2;
  const rx = 250;
  const ry = 150;

  const placed = nodes.map((d, i) => {
    const angle = (i / nodes.length) * Math.PI * 2 - Math.PI / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const x = cx + rx * cos;
    const y = cy + ry * sin;
    const lx = cx + (rx + 18) * cos;
    const ly = cy + (ry + 18) * sin;
    const anchor: "start" | "end" | "middle" = cos > 0.25 ? "start" : cos < -0.25 ? "end" : "middle";
    return { d, x, y, lx, ly, anchor, color: IMPACT_COLOR[d.impact] };
  });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" preserveAspectRatio="xMidYMid meet">
      <defs>
        <radialGradient id="centerGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#2dd4bf" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#2dd4bf" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* edges + flowing particles toward each node */}
      {placed.map((p, i) => (
        <g key={`e${i}`}>
          <line
            x1={cx}
            y1={cy}
            x2={p.x}
            y2={p.y}
            stroke={p.color}
            strokeWidth={p.d.impact === "high" ? 2 : p.d.impact === "medium" ? 1.4 : 1}
            strokeOpacity={0.3}
          />
          <line
            className="edge-flow"
            x1={cx}
            y1={cy}
            x2={p.x}
            y2={p.y}
            stroke={p.color}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeOpacity={0.9}
          />
        </g>
      ))}

      {/* center glow + product node */}
      <circle cx={cx} cy={cy} r={70} fill="url(#centerGlow)" />
      <g>
        <rect
          x={cx - 78}
          y={cy - 20}
          width={156}
          height={40}
          rx={20}
          fill="#ffffff"
          stroke="#0d9488"
          strokeWidth={1.5}
          strokeOpacity={0.8}
        />
        <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="middle" fill="#0d9488" fontSize={14} fontWeight={600}>
          {truncate(product, 20)}
        </text>
      </g>

      {/* dependency nodes */}
      {placed.map((p, i) => {
        const r = p.d.impact === "high" ? 8 : p.d.impact === "medium" ? 6.5 : 5;
        const trendColor = p.d.trend === "up" ? "#f43f5e" : p.d.trend === "down" ? "#22c55e" : "#6b7280";
        return (
          <g
            key={`n${i}`}
            className={onSelect ? "dep-node" : undefined}
            onClick={() => onSelect?.(p.d)}
          >
            <title>
              {p.d.name} · {p.d.changePct > 0 ? "+" : ""}
              {p.d.changePct}% · {p.d.impact} impact · click for details
            </title>
            {/* invisible larger hit area for easier clicking */}
            <circle cx={p.x} cy={p.y} r={r + 14} fill="transparent" />
            <circle cx={p.x} cy={p.y} r={r + 4} fill={p.color} fillOpacity={0.12} />
            <circle cx={p.x} cy={p.y} r={r} fill={p.color} stroke="#ffffff" strokeWidth={1.5} />
            <text
              x={p.lx}
              y={p.ly - 4}
              textAnchor={p.anchor}
              fill="#111827"
              fontSize={12}
              fontWeight={500}
            >
              {truncate(p.d.name)}
            </text>
            <text x={p.lx} y={p.ly + 10} textAnchor={p.anchor} fill={trendColor} fontSize={11} className="mono">
              {p.d.changePct > 0 ? "+" : ""}
              {p.d.changePct}%
            </text>
          </g>
        );
      })}
    </svg>
  );
}
