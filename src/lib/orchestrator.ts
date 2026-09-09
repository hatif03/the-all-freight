// Orchestrates the full shipment risk analysis pipeline and streams progress.
//
// Flow:
//   1. Product agent      -> category, HS codes, material breakdown, dependencies
//   2. 7 intelligence agents (parallel) -> per-category RiskFactors
//   3. Weighted risk score
//   4. Synthesis agent    -> cost forecasts, routes, alerts, recommendations
//   5. Executive summary agent
//
// Each step emits an AnalyzeEvent via the supplied callback so the dashboard can
// render agents lighting up live.

import {
  actionPlanAgent,
  buildIntelSpecs,
  enrichDriverPrices,
  executiveSummaryAgent,
  portRecommenderAgent,
  productAgent,
  synthesisAgent,
  tariffAgent,
  intelAgent,
} from "./agents";
import { anakinMode, getSearchLog, resetSearchLog } from "./anakin";
import { buildDrivers } from "./drivers";
import { geocode, haversineKm } from "./geo";
import type {
  AnalysisResult,
  AnalyzeEvent,
  DependencyNode,
  RiskFactor,
  RouteGeo,
  SearchRecord,
  ShipmentInput,
  Source,
} from "./types";

// Relative weights for combining category risks into the global score.
const CATEGORY_WEIGHTS: Record<string, number> = {
  commodity: 1.0,
  freight: 1.2,
  port: 1.0,
  weather: 0.8,
  geopolitical: 1.1,
  supplier: 0.9,
  regulatory: 0.7,
};

function weightedRiskScore(factors: RiskFactor[]): number {
  let num = 0;
  let den = 0;
  for (const f of factors) {
    const w = CATEGORY_WEIGHTS[f.category] ?? 1;
    num += f.score * w;
    den += w;
  }
  return den ? Math.round(num / den) : 50;
}

export async function runAnalysis(
  input: ShipmentInput,
  emit: (e: AnalyzeEvent) => void,
): Promise<AnalysisResult> {
  emit({ type: "log", message: `Analyzing ${input.product} · ${input.origin} → ${input.destination}` });
  resetSearchLog();

  // Geocode the lane in the background while agents run.
  const geoPromise: Promise<RouteGeo | null> = (async () => {
    const [o, d] = await Promise.all([geocode(input.origin), geocode(input.destination)]);
    if (!o || !d) return null;
    return { origin: o, destination: d, distanceKm: Math.round(haversineKm(o, d)) };
  })();

  // --- Step 1: product + material decomposition ---
  emit({ type: "agent", id: "product", name: "Product & Material Agent", status: "running" });
  const profile = await productAgent(input);
  emit({
    type: "agent",
    id: "product",
    name: "Product & Material Agent",
    status: "done",
    summary: `${profile.productCategory}: ${profile.materials.map((m) => `${m.material} ${m.pct}%`).join(", ")}`,
  });

  // --- Port recommender runs concurrently with the intelligence agents ---
  emit({ type: "agent", id: "ports", name: "Port Recommendation Agent", status: "running" });
  const portPromise = portRecommenderAgent(input)
    .then(async (pr) => {
      if (!pr) {
        emit({ type: "agent", id: "ports", name: "Port Recommendation Agent", status: "done", summary: "no alternatives found" });
        return null;
      }
      // geocode candidate ports so they can be plotted on the map
      const located = await Promise.all(
        pr.options.map(async (o) => {
          const g = await geocode(o.name);
          return { ...o, lat: g?.lat ?? null, lng: g?.lng ?? null };
        }),
      );
      const out = { ...pr, options: located };
      emit({ type: "agent", id: "ports", name: "Port Recommendation Agent", status: "done", summary: `recommend ${pr.recommended}` });
      return out;
    })
    .catch((err) => {
      emit({ type: "agent", id: "ports", name: "Port Recommendation Agent", status: "error", summary: String(err) });
      return null;
    });

  // --- Tariff & regulation agent (concurrent) ---
  emit({ type: "agent", id: "tariff", name: "Tariff & Regulation Agent", status: "running" });
  const tariffPromise = tariffAgent(input, profile)
    .then((t) => {
      emit({ type: "agent", id: "tariff", name: "Tariff & Regulation Agent", status: "done", summary: t ? `~${t.totalDutyPct}% effective duty` : "no data" });
      return t;
    })
    .catch((err) => {
      emit({ type: "agent", id: "tariff", name: "Tariff & Regulation Agent", status: "error", summary: String(err) });
      return null;
    });

  // --- Step 2: intelligence agents in parallel ---
  const specs = buildIntelSpecs(input, profile);
  const context = `${input.product} (${profile.productCategory}), ${input.weightKg}kg, ${input.origin} -> ${input.destination}, ship date ${input.shipDate}`;

  specs.forEach((s) => emit({ type: "agent", id: s.id, name: s.name, status: "running" }));

  const factorResults = await Promise.all(
    specs.map(async (spec) => {
      try {
        const { factor } = await intelAgent(spec, context);
        emit({ type: "agent", id: spec.id, name: spec.name, status: "done", summary: `risk ${factor.score}/100 · ${factor.label}` });
        return factor;
      } catch (err) {
        emit({ type: "agent", id: spec.id, name: spec.name, status: "error", summary: String(err) });
        return null;
      }
    }),
  );
  const factors = factorResults.filter(Boolean) as RiskFactor[];

  const riskScore = weightedRiskScore(factors);

  // Driver prices can be scraped concurrently with the remaining agents.
  emit({ type: "agent", id: "prices", name: "Commodity Price Agent", status: "running" });
  const driversPromise = enrichDriverPrices(buildDrivers(profile.dependencies, profile.materials, factors)).then((d) => {
    emit({ type: "agent", id: "prices", name: "Commodity Price Agent", status: "done", summary: `${d.filter((x) => x.priceLive).length}/${d.length} live prices` });
    return d;
  });

  // --- Step 3: synthesis (cost / route / alerts) ---
  emit({ type: "agent", id: "synthesis", name: "Cost, Route & Alert Engine", status: "running" });
  const synthesis = await synthesisAgent(input, profile, factors, riskScore);
  emit({ type: "agent", id: "synthesis", name: "Cost, Route & Alert Engine", status: "done", summary: `+${synthesis.expectedCostIncreasePct}% cost · ${synthesis.expectedDelayDays[0]}–${synthesis.expectedDelayDays[1]}d delay` });

  // --- Step 4: executive summary + prioritized action plan (parallel) ---
  emit({ type: "agent", id: "summary", name: "Executive Summary Agent", status: "running" });
  emit({ type: "agent", id: "plan", name: "Action Plan Agent", status: "running" });
  const [executiveSummary, actionPlan] = await Promise.all([
    executiveSummaryAgent(input, factors, riskScore, synthesis),
    actionPlanAgent(input, factors, synthesis),
  ]);
  emit({ type: "agent", id: "summary", name: "Executive Summary Agent", status: "done" });
  emit({ type: "agent", id: "plan", name: "Action Plan Agent", status: "done", summary: `${actionPlan.length} prioritized actions` });

  // --- assemble ---
  const dependencyGraph: DependencyNode[] = [
    { node: profile.productCategory, children: profile.dependencies },
  ];

  const drivers = await driversPromise;

  const geo = await geoPromise;
  const portRecommendation = await portPromise;
  const tariff = await tariffPromise;

  // Compute dollar duty from declared goods value (price/kg × weight).
  if (tariff && input.pricePerKg && input.weightKg) {
    tariff.goodsValueUsd = Math.round(input.pricePerKg * input.weightKg);
    tariff.estimatedDutyUsd = Math.round((tariff.goodsValueUsd * tariff.totalDutyPct) / 100);
  }

  // Price each port option off the real freight baseline: congestion adds
  // surcharges and each wait-day adds ~$180 demurrage.
  if (portRecommendation) {
    const base = (synthesis.routes.find((r) => r.recommended) ?? synthesis.routes[0])?.cost ?? 3000;
    portRecommendation.options = portRecommendation.options.map((p, i) => ({
      ...p,
      freightCost: Math.round(base * (1 + (p.congestionScore / 100) * 0.18) + p.waitDays * 180 + i * 35),
    }));
  }

  // Attribute each executed search to the agent that ran it (log is now complete).
  const queryToAgent = new Map<string, string>();
  specs.forEach((s) => s.queries.forEach((q) => queryToAgent.set(q, s.name)));
  const attribute = (q: string): string => {
    if (queryToAgent.has(q)) return queryToAgent.get(q)!;
    if (/spot price|current .*price|forecast 2026/i.test(q)) return "Commodity Price Agent";
    if (/port congestion|dwell|vessel queue/i.test(q)) return "Port Recommendation Agent";
    if (/duty|tariff|hts|section 301|customs/i.test(q)) return "Tariff & Regulation Agent";
    return "Product & Material Agent";
  };
  const searches: SearchRecord[] = getSearchLog().map((e) => ({
    agent: attribute(e.query),
    query: e.query,
    results: e.results,
    mode: e.mode,
  }));

  const news: Source[] = dedupe([
    ...factors.flatMap((f) => f.sources),
    ...profile.sources,
  ]).slice(0, 12);

  return {
    input,
    productCategory: profile.productCategory,
    hsCodes: profile.hsCodes,
    materials: profile.materials,
    dependencyGraph,
    drivers,
    riskScore,
    riskFactors: factors,
    costForecasts: synthesis.costForecasts,
    expectedCostIncreasePct: synthesis.expectedCostIncreasePct,
    expectedDelayDays: synthesis.expectedDelayDays,
    routes: synthesis.routes,
    alerts: synthesis.alerts,
    recommendations: synthesis.recommendations,
    actionPlan,
    executiveSummary,
    news,
    geo,
    tariff,
    portRecommendation,
    searches,
    generatedAt: new Date().toISOString(),
    dataMode: anakinMode(),
  };
}

function dedupe(sources: Source[]): Source[] {
  const seen = new Set<string>();
  return sources.filter((s) => {
    if (!s?.url || seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}
