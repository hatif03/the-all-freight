// Builds time-series for each supply-chain driver (Oil, Resin, Steel, Freight,
// Lithium, Copper, ...) so the dashboard can chart what's moving and what it hits.
//
// Dependencies come from the product agent as free-form names ("Lithium
// carbonate/hydroxide pricing"), so we match them to a known commodity by
// keyword. Anything unmatched gets a distinct, seeded value/trend so no two
// cards look identical. These become live numbers once a live price feed is
// wired in (see enrichDriverPrices in agents.ts).

import type { DependencyDriver, DriverPoint, MaterialBreakdown, RiskFactor } from "./types";

interface DriverMeta {
  display: string;
  unit: string;
  base: number;
  drift: number; // net % move across the window (+ = rising cost)
  affects: string;
  material?: string; // material keyword this driver feeds
}

// Keyword → canonical commodity. First match wins, so order by specificity.
const KEYWORD_DRIVERS: { kw: string[]; meta: DriverMeta }[] = [
  { kw: ["lithium"], meta: { display: "Lithium Carbonate", unit: "$/t", base: 14500, drift: 11, affects: "Battery cell cost", material: "lithium" } },
  { kw: ["cobalt"], meta: { display: "Cobalt (LME)", unit: "$/t", base: 27600, drift: 6, affects: "Cathode cost", material: "cobalt" } },
  { kw: ["nickel"], meta: { display: "Nickel (LME)", unit: "$/t", base: 16800, drift: 7, affects: "Cathode cost", material: "nickel" } },
  { kw: ["graphite", "anode"], meta: { display: "Graphite (anode)", unit: "$/t", base: 950, drift: 5, affects: "Anode material", material: "graphite" } },
  { kw: ["electrolyte", "lipf6"], meta: { display: "Electrolyte (LiPF6)", unit: "$/t", base: 8200, drift: 9, affects: "Cell electrolyte" } },
  { kw: ["separator"], meta: { display: "Separator Film", unit: "idx", base: 112, drift: 4, affects: "Cell separator supply" } },
  { kw: ["copper"], meta: { display: "Copper (LME)", unit: "$/t", base: 9200, drift: 5, affects: "Wiring & electronics", material: "copper" } },
  { kw: ["aluminum", "aluminium"], meta: { display: "Aluminum (LME)", unit: "$/t", base: 2400, drift: 4, affects: "Casings & parts", material: "aluminum" } },
  { kw: ["steel", "hrc"], meta: { display: "Steel (HRC)", unit: "$/t", base: 760, drift: 3, affects: "Frames & components", material: "steel" } },
  { kw: ["resin", "polypropylene", "polyethylene", "plastic", "pp ", "pet"], meta: { display: "Plastic Resin (PP)", unit: "$/t", base: 1180, drift: 7, affects: "Primary plastic input", material: "plastic" } },
  { kw: ["crude", "brent", "wti", "oil", "fuel", "diesel", "bunker"], meta: { display: "Oil (Brent)", unit: "$/bbl", base: 84, drift: 9, affects: "Plastics, freight, fuel" } },
  { kw: ["natural gas", "lng", "gas"], meta: { display: "Natural Gas", unit: "$/MMBtu", base: 3.4, drift: 8, affects: "Energy & feedstock" } },
  { kw: ["cotton"], meta: { display: "Cotton (ICE)", unit: "¢/lb", base: 82, drift: 6, affects: "Textile input", material: "cotton" } },
  { kw: ["lumber", "wood", "timber"], meta: { display: "Lumber", unit: "$/mbf", base: 540, drift: 5, affects: "Wood input", material: "wood" } },
  { kw: ["semiconductor", "chip", "wafer"], meta: { display: "Semiconductor Lead", unit: "wks", base: 18, drift: 8, affects: "Electronics supply", material: "semiconductor" } },
  { kw: ["freight", "ocean", "container", "fbx", "shipping rate"], meta: { display: "Ocean Freight (FBX)", unit: "$/FEU", base: 2310, drift: 14, affects: "Per-container cost" } },
  { kw: ["port", "congestion", "dwell", "terminal"], meta: { display: "Port Congestion", unit: "idx", base: 100, drift: 12, affects: "Dwell time & delays" } },
  { kw: ["tariff", "duty", "customs", "301"], meta: { display: "Effective Tariff", unit: "%", base: 9.5, drift: 3, affects: "Duty on landed value" } },
  { kw: ["currency", "exchange", "usd", "cny", "fx", "yuan", "forex"], meta: { display: "USD/CNY", unit: "rate", base: 7.18, drift: -1.5, affects: "FX on goods cost" } },
  { kw: ["labor", "wage", "workforce"], meta: { display: "Origin Labor Cost", unit: "idx", base: 100, drift: 4, affects: "Manufacturing wages" } },
  { kw: ["pmi", "manufacturing"], meta: { display: "Mfg PMI", unit: "idx", base: 50.4, drift: -1, affects: "Supplier output" } },
  { kw: ["dangerous goods", "imdg", "hazmat", "compliance", "regulat"], meta: { display: "Compliance Cost", unit: "idx", base: 108, drift: 5, affects: "Handling & paperwork" } },
];

// Small seeded PRNG so a given driver name produces a stable-looking wiggle.
function seeded(name: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Distinct fallback for an unrecognized dependency so cards never all read "100".
function unknownMeta(dep: string): DriverMeta {
  const rnd = seeded(dep);
  const units = ["idx", "pts", "$/t", "$/unit"];
  const unit = units[Math.floor(rnd() * units.length)];
  const base = unit.startsWith("$") ? Math.round(80 + rnd() * 1900) : Math.round(60 + rnd() * 95);
  const drift = Math.round(rnd() * 26 - 9); // -9 .. +17
  const display = shorten(dep);
  return { display, unit, base, drift, affects: "Input to landed cost" };
}

function shorten(s: string): string {
  return s
    .split(/[-,(/]/)[0]
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join(" ");
}

function matchMeta(dep: string): DriverMeta {
  const p = dep.toLowerCase();
  for (const { kw, meta } of KEYWORD_DRIVERS) {
    if (kw.some((k) => p.includes(k))) return meta;
  }
  return unknownMeta(dep);
}

const POINTS = 10;

function buildSeries(meta: DriverMeta, rnd: () => number): DriverPoint[] {
  const start = meta.base / (1 + meta.drift / 100);
  const series: DriverPoint[] = [];
  for (let i = 0; i < POINTS; i++) {
    const frac = i / (POINTS - 1);
    const trendVal = start + (meta.base - start) * frac;
    const noise = (rnd() - 0.5) * Math.abs(meta.base) * 0.03;
    series.push({ t: `W-${POINTS - 1 - i}`, v: round(trendVal + noise, meta.base) });
  }
  series[series.length - 1].v = round(meta.base, meta.base);
  return series;
}

function round(v: number, scale: number): number {
  if (scale >= 1000) return Math.round(v);
  if (scale >= 10) return Math.round(v * 10) / 10;
  return Math.round(v * 100) / 100;
}

export function buildDrivers(
  dependencies: string[],
  materials: MaterialBreakdown[],
  factors: RiskFactor[],
): DependencyDriver[] {
  const topMaterial = (materials[0]?.material || "").toLowerCase();
  const freightFactor = factors.find((f) => f.category === "freight");
  const usedDisplay = new Set<string>();

  return dependencies
    .slice(0, 9)
    .map((dep) => {
      const meta = matchMeta(dep);
      // Avoid two dependencies collapsing to the same display card.
      if (usedDisplay.has(meta.display)) return null;
      usedDisplay.add(meta.display);

      const rnd = seeded(dep);
      const series = buildSeries(meta, rnd);
      const first = series[0].v ?? meta.base;
      const last = series[series.length - 1].v ?? meta.base;
      const changePct = Math.round(((last - first) / first) * 1000) / 10;
      const trend = changePct > 1.5 ? "up" : changePct < -1.5 ? "down" : "flat";

      let impact: DependencyDriver["impact"] = "medium";
      if (meta.material && topMaterial.includes(meta.material)) impact = "high";
      else if (/freight|ocean|container/i.test(meta.display) && (freightFactor?.score ?? 0) >= 60) impact = "high";
      else if (Math.abs(changePct) >= 8) impact = "high";
      else if (Math.abs(changePct) < 2) impact = "low";

      return {
        name: meta.display,
        unit: meta.unit,
        current: last,
        changePct,
        trend,
        impact,
        affects: meta.affects,
        forecastPct: meta.drift, // seeded projection until live enrichment runs
        forecastNote: "",
        priceLive: false,
        series,
        sources: [],
      } as DependencyDriver;
    })
    .filter((d): d is DependencyDriver => d !== null);
}
