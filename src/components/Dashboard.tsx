"use client";

import {
  Area,
  AreaChart,
  Cell,
  Line,
  Pie,
  PieChart,
  PolarAngleAxis,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useState } from "react";
import dynamic from "next/dynamic";
import {
  AlertTriangle,
  Anchor,
  ArrowDownRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  ExternalLink,
  FileText,
  ListChecks,
  Minus,
  Scale,
  Search,
  Ship,
  TrendingUp,
  Zap,
} from "lucide-react";
import type { AnalysisResult, DependencyDriver, PortOption, RiskFactor } from "@/lib/types";
import { categoryMeta, cn, fmtUsd, riskColor, riskLabel } from "@/lib/utils";
import { Badge, Button, EmptyState, LiveBadge, Modal, Panel, SourceLink } from "./ui";
import { CountUp } from "./CountUp";

import { DependencyGraph } from "./DependencyGraph";

// Leaflet touches `window`, so load the map client-side only.
const RouteMap = dynamic(() => import("./RouteMap").then((m) => m.RouteMap), {
  ssr: false,
  loading: () => (
    <div className="h-72 w-full rounded-xl border border-border bg-panel-2/40 grid place-items-center text-muted text-sm">
      Loading map…
    </div>
  ),
});

const MAT_COLORS = ["#2dd4bf", "#38bdf8", "#a78bfa", "#f59e0b", "#f43f5e", "#22c55e"];


// Best-effort parse of a free-form ship date ("September 2026", "2026-09-01").
function parseShipDate(s: string): Date | null {
  if (!s) return null;
  const direct = Date.parse(s);
  if (!isNaN(direct)) return new Date(direct);
  const m = s.match(/([A-Za-z]+)\s+(\d{4})/);
  if (m) {
    const d = Date.parse(`${m[1]} 1, ${m[2]}`);
    if (!isNaN(d)) return new Date(d);
  }
  return null;
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function RiskCategoryIcon({ category }: { category: string }) {
  const { Icon } = categoryMeta(category);
  return <Icon className="size-5 text-muted shrink-0" />;
}

function Trend({ trend }: { trend: RiskFactor["trend"] }) {
  if (trend === "up") return <ArrowUpRight className="size-3.5 text-danger" />;
  if (trend === "down") return <ArrowDownRight className="size-3.5 text-ok" />;
  return <Minus className="size-3.5 text-muted" />;
}

const IMPACT_STYLE: Record<DependencyDriver["impact"], string> = {
  high: "border-danger/40 text-danger bg-danger/10",
  medium: "border-warn/40 text-warn bg-warn/10",
  low: "border-border text-muted bg-panel-2",
};

function DriverCard({ d, onClick }: { d: DependencyDriver; onClick?: () => void }) {
  // Rising cost driver = bad (red); falling = good (green); flat = neutral.
  const color = d.trend === "up" ? "var(--danger)" : d.trend === "down" ? "var(--ok)" : "var(--muted)";
  const gid = `drv-${d.name.replace(/[^a-z0-9]/gi, "")}`;
  const Arrow = d.trend === "up" ? ArrowUpRight : d.trend === "down" ? ArrowDownRight : Minus;
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left rounded-xl border border-border bg-panel-2/40 p-3 flex flex-col hover:border-accent/40 hover:bg-panel-2/70 transition cursor-pointer"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13px] font-medium leading-tight truncate">{d.name}</div>
          <div className="text-[10px] mono text-muted mt-0.5">{d.affects}</div>
        </div>
        <span className={cn("text-[9px] mono uppercase px-1.5 py-0.5 rounded border shrink-0", IMPACT_STYLE[d.impact])}>
          {d.impact}
        </span>
      </div>

      <div className="flex items-end justify-between mt-2">
        <div className="text-lg font-semibold tabular-nums leading-none flex items-center gap-1.5">
          {d.current.toLocaleString("en-US")}
          <span className="text-[10px] mono text-muted font-normal">{d.unit}</span>
          {d.priceLive && <span className="size-1.5 rounded-full bg-ok" title="live price" />}
        </div>
        <div className="flex items-center gap-0.5 text-[12px] mono font-semibold tabular-nums" style={{ color }}>
          <Arrow className="size-3.5" />
          {d.changePct > 0 ? "+" : ""}
          {d.changePct}%
        </div>
      </div>

      <div className="h-12 mt-2 -mx-1">
        <ResponsiveContainer>
          <AreaChart data={d.series} margin={{ top: 2, right: 2, left: 2, bottom: 0 }}>
            <defs>
              <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <Tooltip
              contentStyle={tooltipStyle}
              labelFormatter={(l) => `${l}`}
              formatter={(v) => [`${Number(v).toLocaleString("en-US")} ${d.unit}`, d.name]}
            />
            <Area type="monotone" dataKey="v" stroke={color} strokeWidth={2} fill={`url(#${gid})`} dot={false} connectNulls={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="f" stroke={color} strokeWidth={2} strokeDasharray="4 4" dot={false} connectNulls isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-1.5 flex items-center justify-between text-[10px] mono">
        <span className="text-muted">60d forecast</span>
        <span style={{ color: d.forecastPct > 0 ? "var(--danger)" : d.forecastPct < 0 ? "var(--ok)" : "var(--muted)" }}>
          {d.forecastPct > 0 ? "+" : ""}
          {d.forecastPct}%
        </span>
      </div>
    </button>
  );
}

export function Dashboard({ result }: { result: AnalysisResult }) {
  const { riskScore } = result;
  const sortedFactors = [...result.riskFactors].sort((a, b) => b.score - a.score);
  const recIdx = Math.max(0, result.routes.findIndex((r) => r.recommended));
  const [selectedRouteIdx, setSelectedRouteIdx] = useState(recIdx);
  const recRoute = result.routes[selectedRouteIdx] ?? result.routes[recIdx] ?? result.routes[0];
  const [delayLo, delayHi] = result.expectedDelayDays;
  const searches = result.searches ?? [];

  // What the user has already paid/locked shapes their real cost exposure.
  const locked = result.input.locked ?? [];
  const goodsLocked = locked.includes("Goods");
  const freightLocked = locked.includes("Freight");
  const cf90 = result.costForecasts[result.costForecasts.length - 1];
  let exposurePct = result.expectedCostIncreasePct;
  let exposureLabel = "landed cost, 90-day horizon";
  if (locked.length) {
    if (goodsLocked && freightLocked) {
      exposurePct = 0;
      exposureLabel = "goods & freight locked";
    } else if (goodsLocked) {
      exposurePct = cf90?.freightCostPct ?? exposurePct;
      exposureLabel = "freight exposure (goods locked)";
    } else if (freightLocked) {
      exposurePct = cf90?.productCostPct ?? exposurePct;
      exposureLabel = "goods exposure (freight locked)";
    } else {
      exposureLabel = "open cost, 90-day horizon";
    }
  }
  const costLocked = exposurePct === 0;

  // Port freight prices are computed for the recommended (ocean) route; when the
  // user picks a different mode (e.g. Air), scale them by the cost ratio so the
  // prices below reflect the chosen mode.
  const baseRouteCost = result.routes[recIdx]?.cost || recRoute?.cost || 1;
  const portPriceMult = recRoute && baseRouteCost ? recRoute.cost / baseRouteCost : 1;
  const [selected, setSelected] = useState<RiskFactor | null>(null);
  const [selectedPort, setSelectedPort] = useState<PortOption | null>(null);
  const [selectedDriver, setSelectedDriver] = useState<DependencyDriver | null>(null);
  const [doneItems, setDoneItems] = useState<Set<number>>(new Set());
  const actionPlan = result.actionPlan ?? [];
  const toggleDone = (i: number) =>
    setDoneItems((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const URGENCY: Record<string, string> = {
    high: "var(--danger)",
    medium: "var(--warn)",
    low: "var(--accent)",
  };
  const [copied, setCopied] = useState(false);

  const planText = () =>
    `The All Freight — Action Plan\n${result.input.product} · ${result.input.origin} → ${result.input.destination} · ship ${result.input.shipDate}\n\n` +
    actionPlan.map((a) => `[ ] ${a.deadline} — ${a.action}\n      ${a.why}`).join("\n\n");

  const copyPlan = async () => {
    try {
      await navigator.clipboard.writeText(planText());
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked */
    }
  };

  const downloadIcs = () => {
    const esc = (s: string) => s.replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
    const stamp = result.generatedAt.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const events = actionPlan
      .filter((a) => a.dueDate)
      .map((a, i) => {
        const d = (a.dueDate as string).replace(/-/g, "");
        return [
          "BEGIN:VEVENT",
          `UID:all-freight-${i}-${d}@theallfreight.app`,
          `DTSTAMP:${stamp}`,
          `DTSTART;VALUE=DATE:${d}`,
          `SUMMARY:${esc(a.action)}`,
          `DESCRIPTION:${esc(`${a.why} — ${result.input.product} ${result.input.origin} → ${result.input.destination}`)}`,
          "BEGIN:VALARM",
          "TRIGGER:-P1D",
          "ACTION:DISPLAY",
          "DESCRIPTION:The All Freight reminder",
          "END:VALARM",
          "END:VEVENT",
        ].join("\r\n");
      });
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//The All Freight//Action Plan//EN", "CALSCALE:GREGORIAN", ...events, "END:VCALENDAR"].join("\r\n");
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "all-freight-action-plan.ics";
    link.click();
    URL.revokeObjectURL(url);
  };
  // Real calendar dates for the forecast horizon, anchored to today.
  const today = new Date();
  const shortDate = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const costChartData = [
    { name: `Today (${shortDate(today)})`, Product: 0, Freight: 0, Landed: 0 },
    ...result.costForecasts.map((c) => ({
      name: shortDate(addDays(today, c.horizonDays)),
      Product: c.productCostPct,
      Freight: c.freightCostPct,
      Landed: c.landedCostPct,
    })),
  ];

  return (
    <div className="flex flex-col gap-5">
      {/* Shipment summary — everything the user provided */}
      <Panel title="Inputs used for this analysis" className="order-11">
        <div className="flex flex-wrap items-stretch gap-x-6 gap-y-3">
          {[
            ["Product", result.input.product],
            ["Route", `${result.input.origin} → ${result.input.destination}`],
            ["Weight", result.input.weightKg ? `${result.input.weightKg.toLocaleString()} kg` : "—"],
            ["Price / kg", result.input.pricePerKg ? `$${result.input.pricePerKg}` : "—"],
            ["Goods value", result.input.pricePerKg && result.input.weightKg ? fmtUsd(result.input.pricePerKg * result.input.weightKg) : "—"],
            ["Quantity", result.input.quantity ? `${result.input.quantity.toLocaleString()} units` : "—"],
            ["Ship date", result.input.shipDate || "—"],
            ["Mode", result.input.shippingMode || "—"],
            ["Container", result.input.containerSize || "—"],
          ].map(([k, v]) => (
            <div key={k} className="min-w-0">
              <div className="text-[10px] mono uppercase tracking-wide text-muted">{k}</div>
              <div className="text-sm font-medium truncate max-w-[200px]" title={v}>{v}</div>
            </div>
          ))}
          {(result.input.specialRequirements?.length ?? 0) > 0 && (
            <div>
              <div className="text-[10px] mono uppercase tracking-wide text-muted">Handling</div>
              <div className="flex flex-wrap gap-1 mt-0.5">
                {result.input.specialRequirements!.map((r) => (
                  <span key={r} className="text-[10px] mono px-1.5 py-0.5 rounded border border-accent/30 bg-accent/10 text-accent">{r}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      </Panel>

      {/* Headline KPI row */}
      <div className="order-1 grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Risk gauge */}
        <Panel title="Global Risk Score" className="flex flex-col items-center justify-center">
          <div className="relative w-full h-44">
            <ResponsiveContainer>
              <RadialBarChart
                innerRadius="74%"
                outerRadius="100%"
                data={[{ value: riskScore, fill: riskColor(riskScore) }]}
                startAngle={220}
                endAngle={-40}
              >
                <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
                <RadialBar dataKey="value" cornerRadius={20} background={{ fill: "#eef0f3" }} />
              </RadialBarChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              {/* Counts up alongside Recharts' own arc sweep, so the number and
                  the dial arrive together. */}
              <CountUp
                value={riskScore}
                className="text-5xl font-bold tabular-nums"
                style={{ color: riskColor(riskScore) }}
              />
              <div className="text-[11px] mono text-muted">/ 100</div>
              <div className="mt-1 text-xs font-semibold" style={{ color: riskColor(riskScore) }}>
                {riskLabel(riskScore)} risk
              </div>
            </div>
          </div>
        </Panel>

        {/* Cost + delay */}
        <Panel title="Expected Impact" className="flex flex-col justify-center">
          <div>
            <div className="text-[11px] mono text-muted mb-1">EXPECTED DELAY</div>
            <div className="text-4xl font-bold text-warn tabular-nums">
              {result.expectedDelayDays[0]}–{result.expectedDelayDays[1]}
              <span className="text-lg font-normal text-muted ml-1">days</span>
            </div>
            <div className="text-xs text-muted mt-1">added to baseline transit — see Cost Forecast below for the cost side</div>
          </div>

          {/* Estimated arrival window */}
          {(() => {
            const start = parseShipDate(result.input.shipDate);
            if (!start || !recRoute) return null;
            const lo = addDays(start, recRoute.transitDays + delayLo);
            const hi = addDays(start, recRoute.transitDays + delayHi);
            return (
              <div className="mt-4 rounded-lg border border-accent/25 bg-accent/5 px-3 py-2.5 flex items-center gap-2.5">
                <Ship className="size-4 text-accent shrink-0" />
                <div>
                  <div className="text-[10px] mono text-muted">ESTIMATED ARRIVAL</div>
                  <div className="text-sm font-semibold">
                    {fmtDate(lo)} – {fmtDate(hi)}
                  </div>
                </div>
                <div className="ml-auto text-right">
                  <div className="text-[10px] mono text-muted">DOOR-TO-DOOR</div>
                  <div className="text-sm font-semibold tabular-nums">
                    {recRoute.transitDays + delayLo}–{recRoute.transitDays + delayHi}d
                  </div>
                </div>
              </div>
            );
          })()}
          <div className="mt-4 pt-4 border-t border-border space-y-1.5 text-xs">
            <div className="text-muted truncate" title={result.productCategory}>
              Product: <span className="text-foreground font-medium">{result.productCategory}</span>
            </div>
            <div className="text-muted truncate" title={`${result.input.origin} → ${result.input.destination}`}>
              Route: <span className="text-foreground font-medium">{result.input.origin || "—"} → {result.input.destination || "—"}</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="text-muted truncate">
                HS: <span className="text-foreground font-medium mono">{result.hsCodes[0] || "—"}</span>
              </div>
              <div className="text-muted truncate">
                Ship: <span className="text-foreground font-medium">{result.input.shipDate || "—"}</span>
              </div>
            </div>
            {(result.input.specialRequirements?.length || result.input.containerSize) && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {result.input.containerSize && (
                  <span className="text-[10px] mono px-1.5 py-0.5 rounded border border-border bg-panel-2 text-muted">{result.input.containerSize}</span>
                )}
                {(result.input.specialRequirements ?? []).map((r) => (
                  <span key={r} className="text-[10px] mono px-1.5 py-0.5 rounded border border-accent/30 bg-accent/10 text-accent">{r}</span>
                ))}
              </div>
            )}
          </div>
        </Panel>

        {/* Material breakdown */}
        <Panel title="Commodity Exposure">
          <div className="flex items-center gap-4">
            <div className="w-28 h-28 shrink-0">
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={result.materials} dataKey="pct" nameKey="material" innerRadius={30} outerRadius={52} paddingAngle={2} stroke="none">
                    {result.materials.map((_, i) => (
                      <Cell key={i} fill={MAT_COLORS[i % MAT_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle} formatter={(v) => `${v}%`} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <ul className="flex-1 space-y-1.5 min-w-0">
              {result.materials.map((m, i) => (
                <li key={m.material} className="flex items-center gap-2 text-sm">
                  <span className="size-2.5 rounded-sm shrink-0" style={{ background: MAT_COLORS[i % MAT_COLORS.length] }} />
                  <span className="truncate">{m.material}</span>
                  <span className="ml-auto mono text-muted tabular-nums">{m.pct}%</span>
                </li>
              ))}
            </ul>
          </div>
        </Panel>
      </div>

      {/* Prioritized action plan */}
      {actionPlan.length > 0 && (
        <Panel
          className="order-2"
          title="Action Plan"
          action={
            <div className="flex items-center gap-3">
              <span className="text-[11px] mono text-muted hidden sm:flex items-center gap-1.5">
                <ListChecks className="size-3.5" /> {doneItems.size}/{actionPlan.length} done
              </span>
              <Button onClick={copyPlan} className="mono text-[11px]">
                <Copy className="size-3.5" /> {copied ? "Copied!" : "Copy"}
              </Button>
              <Button
                onClick={downloadIcs}
                className="mono text-[11px] border-accent/30 bg-accent/10 text-accent hover:bg-accent/20"
              >
                <Download className="size-3.5" /> Calendar
              </Button>
            </div>
          }
        >
          {/* progress bar */}
          <div className="flex items-center gap-3 mb-3">
            <div className="flex-1 h-2 rounded-full bg-border overflow-hidden">
              <div
                className="h-full bg-ok rounded-full transition-all duration-300"
                style={{ width: `${actionPlan.length ? (doneItems.size / actionPlan.length) * 100 : 0}%` }}
              />
            </div>
            <span className="text-[11px] mono text-muted tabular-nums">
              {Math.round((doneItems.size / actionPlan.length) * 100)}%
            </span>
          </div>

          <ul className="divide-y divide-border/60">
            {actionPlan.map((a, i) => {
              const isDone = doneItems.has(i);
              const color = URGENCY[a.urgency] ?? "var(--accent)";
              const meta = categoryMeta(a.category);
              return (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => toggleDone(i)}
                    className="w-full text-left flex items-start gap-3 py-2.5 px-1 transition hover:bg-panel-2/30 rounded-lg"
                  >
                    {/* square checkbox */}
                    <span
                      className={cn(
                        "size-5 rounded-md border-2 grid place-items-center shrink-0 mt-0.5 transition",
                        isDone ? "bg-ok border-ok" : "bg-transparent",
                      )}
                      style={isDone ? {} : { borderColor: color }}
                    >
                      {isDone && <Check className="size-3.5 text-white" strokeWidth={3} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <span className={cn("text-sm font-medium leading-snug", isDone ? "line-through text-muted" : "")}>
                          {a.action}
                        </span>
                        <span
                          className="shrink-0 text-[10px] mono px-2 py-0.5 rounded-full border whitespace-nowrap"
                          style={{ color, borderColor: `color-mix(in srgb, ${color} 45%, transparent)`, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
                        >
                          {a.deadline}
                        </span>
                      </div>
                      <div className="text-[11px] text-muted mt-0.5 flex items-center gap-1.5">
                        <meta.Icon className="size-3.5 shrink-0" />
                        <span className="truncate">{a.why}</span>
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}

      {/* Executive summary + alerts */}
      <div className="order-3 grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Panel title="Executive Summary" className="lg:col-span-2">
          <p className="text-sm leading-relaxed text-foreground/90">{result.executiveSummary}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {result.recommendations.map((r, i) => (
              <div key={i} className="group relative">
                <span className="inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1.5 rounded-md border border-accent/30 bg-accent/10 text-accent">
                  <TrendingUp className="size-3.5" /> {r.action}
                </span>
                <div className="absolute left-0 top-full mt-1 z-10 hidden group-hover:block w-64 text-[11px] bg-panel-2 border border-border rounded-md p-2 text-muted shadow-xl">
                  {r.rationale}
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Active Alerts">
          <ul className="space-y-2.5">
            {result.alerts.length === 0 && (
              <li>
                <EmptyState
                  icon={CheckCircle2}
                  title="No critical alerts"
                  body="That's the good outcome — nothing on this lane crossed the threshold that warrants action before you ship."
                />
              </li>
            )}
            {result.alerts.map((a, i) => (
              <li key={i} className="flex gap-2.5">
                <AlertTriangle
                  className={cn(
                    "size-4 mt-0.5 shrink-0",
                    a.severity === "high" ? "text-danger" : a.severity === "medium" ? "text-warn" : "text-muted",
                  )}
                />
                <div>
                  <div className="text-sm font-medium leading-tight">{a.title}</div>
                  <div className="text-[11px] text-muted mt-0.5">{a.impact}</div>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      {/* Risk factors grid */}
      <Panel title="Risk Factors by Category" className="order-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {sortedFactors.map((f) => {
            const meta = categoryMeta(f.category);
            return (
              <button
                key={f.category}
                type="button"
                onClick={() => setSelected(f)}
                className="text-left rounded-xl border border-border bg-panel-2/40 p-3.5 hover:border-accent/50 hover:bg-panel-2/70 transition cursor-pointer flex flex-col"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[13px] font-medium flex items-center gap-1.5 text-muted">
                    <meta.Icon className="size-4 shrink-0" /> {meta.label}
                  </span>
                  <span
                    className="mono text-[11px] tabular-nums font-semibold flex items-center gap-1 px-1.5 py-0.5 rounded"
                    style={{ color: riskColor(f.score), background: `color-mix(in srgb, ${riskColor(f.score)} 14%, transparent)` }}
                  >
                    {f.score} <Trend trend={f.trend} />
                  </span>
                </div>

                {/* Actionable insight — the hero of the card */}
                <div className="flex gap-1.5 flex-1">
                  <Zap className="size-3.5 mt-0.5 shrink-0" style={{ color: riskColor(f.score) }} />
                  <p className="text-[13px] leading-snug text-foreground font-medium">{f.actionable}</p>
                </div>

                <div className="mt-2.5 text-[10px] mono text-accent-2/80">
                  {f.sources.length} source{f.sources.length === 1 ? "" : "s"} · click for details →
                </div>
              </button>
            );
          })}
        </div>
      </Panel>

      {/* Tariffs & Regulations */}
      {result.tariff && (
        <Panel
          className="order-6"
          title="Tariffs & Regulations"
          action={
            <span className="text-[10px] mono text-muted flex items-center gap-1.5">
              <Scale className="size-3.5" /> duty scraped via Anakin
            </span>
          }
        >
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            {/* Effective duty + breakdown */}
            <div className="lg:col-span-1">
              <div className="rounded-xl border border-danger/30 bg-danger/5 p-4 text-center mb-3">
                <div className="text-[10px] mono text-muted mb-1">TOTAL EFFECTIVE DUTY</div>
                <div className="text-4xl font-bold tabular-nums text-danger">{result.tariff.totalDutyPct}%</div>
                {result.tariff.estimatedDutyUsd > 0 && (
                  <div className="mt-2 pt-2 border-t border-danger/20">
                    <div className="text-xl font-bold tabular-nums text-foreground">{fmtUsd(result.tariff.estimatedDutyUsd)}</div>
                    <div className="text-[10px] mono text-muted">duty on {fmtUsd(result.tariff.goodsValueUsd)} goods value</div>
                  </div>
                )}
                <div className="text-[11px] mono text-muted mt-2">
                  {result.tariff.originCountry} → {result.tariff.destinationCountry}
                  {result.tariff.hsCode ? ` · HS ${result.tariff.hsCode}` : ""}
                </div>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-sm px-1">
                  <span className="text-muted">Base / MFN duty</span>
                  <span className="mono tabular-nums">{result.tariff.baseDutyPct}%</span>
                </div>
                {result.tariff.additional.map((a, i) => (
                  <div key={i} className="flex items-center justify-between text-sm px-1">
                    <span className="text-muted truncate pr-2">{a.name}</span>
                    <span className="mono tabular-nums text-warn">+{a.ratePct}%</span>
                  </div>
                ))}
                <div className="flex items-center justify-between text-sm px-1 pt-1.5 border-t border-border font-semibold">
                  <span>Total</span>
                  <span className="mono tabular-nums text-danger">{result.tariff.totalDutyPct}%</span>
                </div>
              </div>
            </div>

            {/* Documents + requirements + notes */}
            <div className="lg:col-span-2">
              {result.tariff.documents.length > 0 && (
                <div className="mb-3">
                  <div className="text-[11px] mono uppercase tracking-wider text-muted mb-2 flex items-center gap-1.5">
                    <FileText className="size-3.5" /> Required documents for {result.tariff.destinationCountry}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {result.tariff.documents.map((d, i) => (
                      <div key={i} className="text-[12px] flex items-start gap-1.5 rounded-lg border border-accent/25 bg-accent/5 px-2.5 py-2">
                        <FileText className="size-3.5 mt-0.5 shrink-0 text-accent" />
                        <div className="min-w-0">
                          <div>{d.name}</div>
                          {d.url ? (
                            <a href={d.url} target="_blank" rel="noreferrer" className="text-[10px] mono text-accent-2 hover:underline inline-flex items-center gap-1 mt-0.5 max-w-full">
                              <ExternalLink className="size-3 shrink-0" /> <span className="truncate">where to get it</span>
                            </a>
                          ) : (
                            <span className="text-[10px] mono text-muted mt-0.5 block">source not found</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {result.tariff.requirements.length > 0 && (
                <div className="mb-3">
                  <div className="text-[11px] mono uppercase tracking-wider text-muted mb-2 flex items-center gap-1.5">
                    <CheckCircle2 className="size-3.5" /> Compliance requirements
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {result.tariff.requirements.map((r, i) => (
                      <div key={i} className="text-[12px] flex items-start gap-1.5 rounded-lg border border-border bg-panel-2/40 px-2.5 py-2">
                        <CheckCircle2 className="size-3.5 mt-0.5 shrink-0 text-muted" />
                        <span>{r}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {result.tariff.notes && (
                <p className="text-[12px] text-muted leading-snug mb-3">
                  <span className="text-warn font-medium">Note: </span>
                  {result.tariff.notes}
                </p>
              )}
              {result.tariff.sources.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {result.tariff.sources.slice(0, 4).map((s, i) => (
                    <a
                      key={i}
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[10px] mono inline-flex items-center gap-1 px-2 py-1 rounded border border-border bg-panel-2/40 text-accent-2 hover:border-accent/40 transition max-w-[220px]"
                    >
                      <ExternalLink className="size-3 shrink-0" />
                      <span className="truncate">{s.title}</span>
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Panel>
      )}

      {/* Cost forecast + routes */}
      <div className="order-5 grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Panel title="Cost Forecast">
          {/* Headline exposure + plain-English explanation */}
          <div className="rounded-xl border border-border bg-panel-2/40 p-3.5 mb-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[11px] mono uppercase tracking-wide text-muted">
                {locked.length ? "Your cost exposure by ship date" : "Landed-cost increase by ship date"}
              </span>
              {costLocked ? (
                <span className="text-2xl font-bold text-ok tabular-nums">Locked</span>
              ) : (
                <span className="text-2xl font-bold text-danger tabular-nums">+{exposurePct}%</span>
              )}
            </div>
            <p className="text-[12px] text-muted leading-snug mt-1.5">
              {costLocked ? (
                <>You&apos;ve locked goods &amp; freight, so your delivered cost is fixed — the lines below are just market context. Focus on the delay/arrival above.</>
              ) : locked.length ? (
                <>This is the increase on the part you <span className="text-foreground">haven&apos;t committed yet</span> ({exposureLabel}). Locked components don&apos;t move your cost.</>
              ) : (
                <>How much more your <span className="text-foreground">delivered (landed) cost</span> could rise if you don&apos;t lock rates now. <b>Product</b> = goods, <b>Freight</b> = shipping, <b>Landed</b> = total. Lock the lines that are climbing.</>
              )}
            </p>
          </div>
          <div className="h-48">
            <ResponsiveContainer>
              <AreaChart data={costChartData} margin={{ top: 5, right: 8, left: -18, bottom: 0 }}>
                <defs>
                  {["Landed", "Freight", "Product"].map((k, i) => (
                    <linearGradient key={k} id={`g-${k}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={MAT_COLORS[i]} stopOpacity={0.4} />
                      <stop offset="100%" stopColor={MAT_COLORS[i]} stopOpacity={0} />
                    </linearGradient>
                  ))}
                </defs>
                <XAxis dataKey="name" tick={{ fill: "#6b7280", fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "#6b7280", fontSize: 11 }} axisLine={false} tickLine={false} unit="%" />
                <Tooltip contentStyle={tooltipStyle} formatter={(v) => `${v}%`} />
                <Area type="monotone" dataKey="Landed" stroke={MAT_COLORS[0]} fill="url(#g-Landed)" strokeWidth={2} />
                <Area type="monotone" dataKey="Freight" stroke={MAT_COLORS[1]} fill="url(#g-Freight)" strokeWidth={2} />
                <Area type="monotone" dataKey="Product" stroke={MAT_COLORS[2]} fill="url(#g-Product)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="flex flex-wrap gap-4 mt-2 text-[11px] mono">
            {["Landed", "Freight", "Product"].map((k, i) => {
              const isLocked = (k === "Freight" && freightLocked) || (k === "Product" && goodsLocked);
              return (
                <span key={k} className={cn("flex items-center gap-1.5", isLocked ? "text-muted/60 line-through" : "text-muted")}>
                  <span className="size-2 rounded-sm" style={{ background: MAT_COLORS[i] }} /> {k}
                  {isLocked && <span className="no-underline">🔒</span>}
                </span>
              );
            })}
            <span className="text-muted/70 ml-auto">vs. today</span>
          </div>
        </Panel>

        <Panel title="Route Optimization" action={<span className="text-[10px] mono text-muted">tap a method to compare</span>}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] mono text-muted text-left">
                <th className="font-normal pb-2">Method</th>
                <th className="font-normal pb-2 text-right pl-4">Cost</th>
                <th className="font-normal pb-2 text-right pl-5">Transit</th>
                <th className="font-normal pb-2 text-right pl-4 w-16"></th>
              </tr>
            </thead>
            <tbody>
              {result.routes.map((r, idx) => {
                const isSel = idx === selectedRouteIdx;
                return (
                  <tr
                    key={r.method}
                    onClick={() => setSelectedRouteIdx(idx)}
                    className={cn(
                      "border-t border-border/60 cursor-pointer transition",
                      isSel ? "bg-accent/10" : "hover:bg-panel-2/50",
                    )}
                  >
                    <td className="py-2.5">
                      <div className="font-medium flex items-center gap-1.5">
                        <span className={cn("size-3.5 rounded-full border-2 grid place-items-center shrink-0", isSel ? "border-accent" : "border-muted")}>
                          {isSel && <span className="size-1.5 rounded-full bg-accent" />}
                        </span>
                        {r.method}
                      </div>
                      <div className="text-[11px] text-muted pl-5">{r.note}</div>
                    </td>
                    <td className="py-2.5 pl-4 text-right mono tabular-nums align-top whitespace-nowrap">{fmtUsd(r.cost)}</td>
                    <td className="py-2.5 pl-5 text-right mono tabular-nums text-muted align-top whitespace-nowrap">{r.transitDays}d</td>
                    <td className="py-2.5 pl-4 text-right align-top w-16">
                      {r.recommended && <span className="text-[10px] mono px-2 py-0.5 rounded bg-accent/15 text-accent border border-accent/30">PICK</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
      </div>

      {/* Route map + transit time */}
      <div className="order-8 grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Panel
          title="Shipping Route"
          className="lg:col-span-2"
          action={
            result.geo && (
              <span className="text-[10px] mono text-muted">
                ~{result.geo.distanceKm.toLocaleString("en-US")} km · OpenStreetMap
              </span>
            )
          }
        >
          {result.geo ? (
            <RouteMap geo={result.geo} ports={result.portRecommendation?.options ?? []} />
          ) : (
            <div className="h-72 grid place-items-center text-muted text-sm rounded-xl border border-border bg-panel-2/40">
              Couldn&apos;t locate {result.input.origin} → {result.input.destination} on the map.
            </div>
          )}
          {result.geo && (
            <div className="mt-3 flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 text-accent">
                <span className="size-2.5 rounded-full bg-accent" /> {result.geo.origin.name}
              </span>
              <span className="text-muted mono">— — — ✈ — — —</span>
              <span className="flex items-center gap-1.5 text-danger">
                {result.geo.destination.name} <span className="size-2.5 rounded-full bg-danger" />
              </span>
            </div>
          )}
        </Panel>

        <Panel title="Transit Time" className="flex flex-col">
          <div className="flex items-center gap-2 mb-3">
            <Ship className="size-4 text-accent" />
            <span className="text-sm font-medium">{recRoute?.method ?? "Ocean Freight"}</span>
            <span
              className={cn(
                "ml-auto text-[10px] mono px-2 py-0.5 rounded border",
                recRoute?.recommended ? "bg-accent/15 text-accent border-accent/30" : "bg-panel-2 text-muted border-border",
              )}
            >
              {recRoute?.recommended ? "RECOMMENDED" : "SELECTED"}
            </span>
          </div>

          <div className="rounded-xl border border-border bg-panel-2/40 p-4 text-center">
            <div className="text-[11px] mono text-muted mb-1">COST · BASE TRANSIT</div>
            <div className="text-2xl font-bold tabular-nums mb-1">{recRoute ? fmtUsd(recRoute.cost) : "—"}</div>
            <div className="text-3xl font-bold tabular-nums">
              {recRoute?.transitDays ?? "—"}
              <span className="text-base font-normal text-muted ml-1">days</span>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-border bg-panel-2/40 p-3 text-center">
              <div className="text-[10px] mono text-muted mb-1 flex items-center justify-center gap-1">
                <Clock className="size-3" /> RISK DELAY
              </div>
              <div className="text-lg font-semibold text-warn tabular-nums">
                +{delayLo}–{delayHi}d
              </div>
            </div>
            <div className="rounded-lg border border-border bg-panel-2/40 p-3 text-center">
              <div className="text-[10px] mono text-muted mb-1">EST. ARRIVAL</div>
              <div className="text-lg font-semibold tabular-nums">
                {recRoute ? recRoute.transitDays + delayLo : "—"}–{recRoute ? recRoute.transitDays + delayHi : "—"}d
              </div>
            </div>
          </div>
          <div className="mt-3 text-[11px] text-muted leading-snug">{recRoute?.note}</div>
        </Panel>
      </div>

      {/* AI port recommendation */}
      {result.portRecommendation && result.portRecommendation.options.length > 0 && (
        <Panel
          className="order-7"
          title="AI Port Recommendation"
          action={<span className="text-[10px] mono text-muted">prices for {recRoute?.method ?? "Ocean"} · congestion via Anakin</span>}
        >
          <div className="rounded-xl border border-accent/30 bg-accent/10 p-3.5 mb-4 flex items-start gap-3">
            <Anchor className="size-5 text-accent mt-0.5 shrink-0" />
            <div>
              <div className="text-sm">
                Recommended entry port:{" "}
                <span className="font-semibold text-accent">{result.portRecommendation.recommended}</span>
              </div>
              <p className="text-[12px] text-foreground/80 mt-1 leading-snug">{result.portRecommendation.rationale}</p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {[...result.portRecommendation.options]
              .sort((a, b) => a.congestionScore - b.congestionScore)
              .map((p) => (
                <button
                  key={p.name}
                  type="button"
                  onClick={() => setSelectedPort(p)}
                  className={cn(
                    "text-left rounded-xl border p-3.5 transition cursor-pointer",
                    p.recommended
                      ? "border-accent/50 bg-accent/5 hover:bg-accent/10"
                      : "border-border bg-panel-2/40 hover:border-accent/40 hover:bg-panel-2/70",
                  )}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[13px] font-medium truncate">{p.name}</span>
                    {p.recommended && (
                      <span className="text-[9px] mono px-1.5 py-0.5 rounded bg-accent/15 text-accent border border-accent/30 shrink-0">
                        BEST
                      </span>
                    )}
                  </div>

                  <div className="mb-2">
                    <div className="text-[10px] mono text-muted">EST. FREIGHT</div>
                    <div className="text-xl font-bold tabular-nums">{fmtUsd(p.freightCost * portPriceMult)}</div>
                  </div>

                  <div className="flex items-center justify-between text-[11px] mono mb-1.5">
                    <span style={{ color: riskColor(p.congestionScore) }}>congestion {p.congestionScore}</span>
                    <span className="text-muted">~{p.waitDays}d wait</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-border overflow-hidden mb-2">
                    <div className="h-full rounded-full" style={{ width: `${p.congestionScore}%`, background: riskColor(p.congestionScore) }} />
                  </div>
                  <div className="text-[10px] mono text-accent-2/80">{p.sources.length} sources · click to view →</div>
                </button>
              ))}
          </div>
        </Panel>
      )}

      {/* Driver tracker — charts for every supply-chain dependency */}
      <Panel
        className="order-9"
        title="Supply-Chain Driver Tracker"
        action={<span className="text-[10px] mono text-muted">price & index trends · last 9 periods</span>}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {(result.drivers ?? []).map((d) => (
            <DriverCard key={d.name} d={d} onClick={() => setSelectedDriver(d)} />
          ))}
        </div>
      </Panel>

      {/* Dependency graph + news */}
      <div className="order-10 grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Panel
          title="Supply-Chain Dependency Graph"
          action={
            <div className="flex items-center gap-3 text-[10px] mono text-muted">
              <span className="flex items-center gap-1"><span className="size-2 rounded-full" style={{ background: "#f43f5e" }} /> high</span>
              <span className="flex items-center gap-1"><span className="size-2 rounded-full" style={{ background: "#38bdf8" }} /> med</span>
              <span className="flex items-center gap-1"><span className="size-2 rounded-full" style={{ background: "#6b7280" }} /> low</span>
            </div>
          }
        >
          <DependencyGraph product={result.productCategory} drivers={result.drivers ?? []} onSelect={setSelectedDriver} />
        </Panel>

        <Panel title="News Intelligence Feed" action={<span className="text-[10px] mono text-muted">via Anakin</span>}>
          <ul className="space-y-2 max-h-72 overflow-y-auto pr-1">
            {result.news.map((s, i) => (
              <li key={i}>
                <a href={s.url} target="_blank" rel="noreferrer" className="group block rounded-lg border border-border/50 bg-panel-2/30 px-3 py-2 hover:border-accent/40 transition">
                  <div className="text-[13px] font-medium leading-tight group-hover:text-accent transition flex items-start gap-1.5">
                    <ExternalLink className="size-3 mt-1 shrink-0 text-muted" />
                    <span className="line-clamp-2">{s.title}</span>
                  </div>
                  {s.snippet && <div className="text-[11px] text-muted mt-1 line-clamp-2 pl-4.5">{s.snippet}</div>}
                </a>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      {/* Live search transparency */}
      <Panel
        className="order-12"
        title="Live Search Log"
        action={
          <span className="text-[10px] mono text-muted">
            {searches.length} searches · {searches.reduce((a, s) => a + s.results, 0)} sources
          </span>
        }
      >
        <p className="text-[11px] text-muted mb-3">
          Every live web search the agents ran via Anakin&apos;s <span className="text-accent-2">search</span> endpoint.
          Each row is a query and how many sources it returned.
        </p>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
          {searches.map((s, i) => (
            <div key={i} className="flex items-start gap-2.5 rounded-lg border border-border/60 bg-panel-2/40 px-3 py-2">
              <Search className="size-3.5 mt-0.5 shrink-0 text-accent-2" />
              <div className="min-w-0 flex-1">
                <div className="text-[12px] leading-tight truncate" title={s.query}>{s.query}</div>
                <div className="text-[10px] mono text-muted mt-0.5">{s.agent}</div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="text-[11px] mono tabular-nums text-muted">{s.results}</span>
                <LiveBadge live={s.mode === "live"} />
              </div>
            </div>
          ))}
          {searches.length === 0 && (
            <EmptyState
              icon={Search}
              title="No searches recorded"
              body="Every live web lookup an agent runs is logged here with the sources it returned. An empty log means this run used the demo dataset."
            />
          )}
        </div>
      </Panel>

      <div className="order-last text-center text-[11px] mono text-muted pt-2">
        Generated {new Date(result.generatedAt).toLocaleString()} · {result.dataMode === "live" ? "live web intelligence" : "demo dataset"} · The All Freight
      </div>

      {/* Risk factor detail modal */}
      <Modal
        open={!!selected}
        onClose={() => setSelected(null)}
        icon={selected ? <RiskCategoryIcon category={selected.category} /> : undefined}
        title={selected ? `${categoryMeta(selected.category).label} Risk` : undefined}
      >
        {selected && (
          <>
            <div className="flex items-center gap-3 mb-4">
              <span className="text-3xl font-bold tabular-nums" style={{ color: riskColor(selected.score) }}>
                {selected.score}
                <span className="text-sm font-normal text-muted">/100</span>
              </span>
              <span className="text-sm font-medium" style={{ color: riskColor(selected.score) }}>
                {riskLabel(selected.score)}
              </span>
              <span className="ml-auto flex items-center gap-1 text-xs text-muted">
                trend <Trend trend={selected.trend} />
              </span>
            </div>

            <div className="rounded-xl border border-accent/30 bg-accent/10 p-3 mb-4 flex items-start gap-2">
              <Zap className="size-4 text-accent mt-0.5 shrink-0" />
              <div>
                <div className="text-[10px] mono uppercase tracking-wider text-accent/80 mb-0.5">What to do</div>
                <p className="text-sm text-foreground font-medium leading-snug">{selected.actionable}</p>
              </div>
            </div>

            <div className="text-[12px] mono uppercase tracking-wider text-muted mb-1">Detail</div>
            <p className="text-sm text-foreground/85 leading-relaxed mb-4">{selected.detail}</p>

            {selected.keyFindings.length > 0 && (
              <div className="mb-4">
                <div className="text-[11px] mono uppercase tracking-wider text-muted mb-2">Key findings</div>
                <ul className="space-y-1.5">
                  {selected.keyFindings.map((k, i) => (
                    <li key={i} className="text-[13px] flex gap-2">
                      <span className="text-accent mt-0.5">•</span>
                      <span>{k}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {selected.sources.length > 0 && (
              <div>
                <div className="text-[11px] mono uppercase tracking-wider text-muted mb-2">
                  Sources ({selected.sources.length}) · via Anakin
                </div>
                <ul className="space-y-1.5">
                  {selected.sources.map((s, i) => (
                    <li key={i}>
                      <SourceLink url={s.url} title={s.title} snippet={s.snippet} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </Modal>

      {/* Port detail modal */}
      <Modal
        open={!!selectedPort}
        onClose={() => setSelectedPort(null)}
        icon={<Anchor className="size-5 text-accent shrink-0" />}
        title={
          selectedPort ? (
            <span className="flex items-center gap-2">
              {selectedPort.name}
              {selectedPort.recommended && <Badge tone="accent">best</Badge>}
            </span>
          ) : undefined
        }
      >
        {selectedPort && (
          <>
            <div className="grid grid-cols-3 gap-3 mb-4">
              <div className="rounded-lg border border-border bg-panel-2/40 p-3 text-center">
                <div className="text-[10px] mono text-muted mb-1">EST. FREIGHT</div>
                <div className="text-lg font-bold tabular-nums">{fmtUsd(selectedPort.freightCost * portPriceMult)}</div>
              </div>
              <div className="rounded-lg border border-border bg-panel-2/40 p-3 text-center">
                <div className="text-[10px] mono text-muted mb-1">CONGESTION</div>
                <div className="text-lg font-bold tabular-nums" style={{ color: riskColor(selectedPort.congestionScore) }}>
                  {selectedPort.congestionScore}
                </div>
              </div>
              <div className="rounded-lg border border-border bg-panel-2/40 p-3 text-center">
                <div className="text-[10px] mono text-muted mb-1">EST. WAIT</div>
                <div className="text-lg font-bold tabular-nums">{selectedPort.waitDays}d</div>
              </div>
            </div>

            <p className="text-sm text-foreground/85 leading-relaxed mb-4">{selectedPort.note}</p>

            {selectedPort.sources.length > 0 && (
              <div>
                <div className="text-[11px] mono uppercase tracking-wider text-muted mb-2">
                  Congestion sources ({selectedPort.sources.length}) · via Anakin
                </div>
                <ul className="space-y-1.5">
                  {selectedPort.sources.map((s, i) => (
                    <li key={i}>
                      <SourceLink url={s.url} title={s.title} snippet={s.snippet} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </Modal>

      {/* Driver detail modal */}
      <Modal
        open={!!selectedDriver}
        onClose={() => setSelectedDriver(null)}
        title={
          selectedDriver ? (
            <span className="flex items-center gap-2">
              {selectedDriver.name}
              <Badge
                tone={
                  selectedDriver.impact === "high"
                    ? "danger"
                    : selectedDriver.impact === "medium"
                      ? "warn"
                      : "neutral"
                }
              >
                {selectedDriver.impact} impact
              </Badge>
            </span>
          ) : undefined
        }
      >
        {selectedDriver && (
          <>
            <p className="text-[12px] text-muted mb-4 -mt-2">{selectedDriver.affects}</p>

            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="rounded-lg border border-border bg-panel-2/40 p-3">
                <div className="text-[10px] mono text-muted mb-1 flex items-center gap-1.5">
                  CURRENT PRICE
                  <LiveBadge live={selectedDriver.priceLive} mockLabel="est." />
                </div>
                <div className="text-2xl font-bold tabular-nums">
                  {selectedDriver.current.toLocaleString("en-US")}
                  <span className="text-xs font-normal text-muted ml-1">{selectedDriver.unit}</span>
                </div>
              </div>
              <div className="rounded-lg border border-border bg-panel-2/40 p-3">
                <div className="text-[10px] mono text-muted mb-1">60-DAY FORECAST</div>
                <div
                  className="text-2xl font-bold tabular-nums"
                  style={{ color: selectedDriver.forecastPct > 0 ? "var(--danger)" : selectedDriver.forecastPct < 0 ? "var(--ok)" : "var(--muted)" }}
                >
                  {selectedDriver.forecastPct > 0 ? "+" : ""}
                  {selectedDriver.forecastPct}%
                </div>
              </div>
            </div>

            <div className="h-48 -mx-1">
              <ResponsiveContainer>
                <AreaChart data={selectedDriver.series} margin={{ top: 5, right: 6, left: -10, bottom: 0 }}>
                  <defs>
                    <linearGradient id="drv-modal" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={selectedDriver.trend === "down" ? "#22c55e" : "#f43f5e"} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={selectedDriver.trend === "down" ? "#22c55e" : "#f43f5e"} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="t" tick={{ fill: "#6b7280", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: "#6b7280", fontSize: 11 }} axisLine={false} tickLine={false} domain={["auto", "auto"]} width={44} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v) => [`${Number(v).toLocaleString("en-US")} ${selectedDriver.unit}`, "price"]} />
                  <Area
                    type="monotone"
                    dataKey="v"
                    stroke={selectedDriver.trend === "down" ? "#22c55e" : "#f43f5e"}
                    strokeWidth={2}
                    fill="url(#drv-modal)"
                    dot={false}
                    connectNulls={false}
                  />
                  <Line type="monotone" dataKey="f" stroke="#38bdf8" strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="flex items-center gap-4 mt-2 text-[10px] mono text-muted">
              <span className="flex items-center gap-1.5"><span className="w-4 h-0.5" style={{ background: selectedDriver.trend === "down" ? "#22c55e" : "#f43f5e" }} /> history</span>
              <span className="flex items-center gap-1.5"><span className="w-4 h-0.5 border-t border-dashed" style={{ borderColor: "#38bdf8" }} /> forecast</span>
            </div>

            {selectedDriver.forecastNote && (
              <p className="text-[12px] text-foreground/80 mt-3 leading-snug">{selectedDriver.forecastNote}</p>
            )}

            {selectedDriver.sources.length > 0 && (
              <div className="mt-4">
                <div className="text-[11px] mono uppercase tracking-wider text-muted mb-2">
                  Price sources ({selectedDriver.sources.length}) · via Anakin
                </div>
                <ul className="space-y-1.5">
                  {selectedDriver.sources.map((s, i) => (
                    <li key={i}>
                      <SourceLink url={s.url} title={s.title} snippet={s.snippet} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </Modal>
    </div>
  );
}

const tooltipStyle = {
  background: "#ffffff",
  border: "1px solid #e4e7eb",
  borderRadius: 8,
  fontSize: 12,
  color: "#111827",
  boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
};
