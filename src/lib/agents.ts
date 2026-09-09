// Agent layer.
//
// Each intelligence agent (commodity, freight, port, weather, geopolitical,
// supplier, regulatory) issues live web searches and then reasons over the
// retrieved sources with OpenAI to produce a structured RiskFactor.
// A product agent decomposes the item into raw-material exposure, and a synthesis
// agent fuses everything into forecasts, routes, alerts, and an executive summary.

import { anakinSearch } from "./anakin";
import { jsonCompletion, textCompletion } from "./openai";
import type {
  ActionItem,
  Alert,
  CostForecast,
  DependencyDriver,
  IntakeResult,
  MaterialBreakdown,
  PortOption,
  PortRecommendation,
  Recommendation,
  RiskCategory,
  RiskFactor,
  RouteOption,
  ShipmentInput,
  Source,
  TariffInfo,
} from "./types";

// ---------------------------------------------------------------------------
// Product + material decomposition agent (Agents 1 & 2)
// ---------------------------------------------------------------------------

export interface ProductProfile {
  productCategory: string;
  hsCodes: string[];
  materials: MaterialBreakdown[];
  dependencies: string[];
  sources: Source[];
}

export async function productAgent(input: ShipmentInput): Promise<ProductProfile> {
  const sources = await anakinSearch(`${input.product} materials composition manufacturing HS code`, 4);

  const guess = guessMaterials(input.product);
  const fallback: ProductProfile = {
    productCategory: input.product,
    hsCodes: [],
    materials: guess.materials,
    dependencies: guess.dependencies,
    sources,
  };

  const result = await jsonCompletion<ProductProfile>({
    system:
      "You are a product analysis and bill-of-materials expert for global trade. " +
      "Given a product, identify its category, likely HS (Harmonized System) codes, the raw-material " +
      "composition by approximate weight percentage (must sum to ~100), and the upstream commodity/logistics " +
      "dependencies that drive its landed cost. " +
      "productCategory MUST be concise: 2-4 words, no semicolons or clauses (e.g. 'Frozen shrimp', 'Plastic furniture'). " +
      "Respond ONLY with JSON.",
    user:
      `Product: ${input.product}\nOrigin: ${input.origin}\nDestination: ${input.destination}\n` +
      `Approx weight (kg): ${input.weightKg}\n\n` +
      `Reference snippets from the web:\n${sources.map((s) => `- ${s.title}: ${s.snippet ?? ""}`).join("\n")}\n\n` +
      `Return JSON of shape:\n` +
      `{"productCategory": string, "hsCodes": string[], "materials": [{"material": string, "pct": number}], ` +
      `"dependencies": string[]}`,
    fallback,
  });

  // attach sources + normalize material percentages
  const total = result.materials?.reduce((a, m) => a + (m.pct || 0), 0) || 0;
  const materials =
    total > 0
      ? result.materials.map((m) => ({ material: m.material, pct: Math.round((m.pct / total) * 100) }))
      : fallback.materials;

  return {
    productCategory: result.productCategory || input.product,
    hsCodes: result.hsCodes?.slice(0, 4) || [],
    materials,
    dependencies: result.dependencies?.length ? result.dependencies : fallback.dependencies,
    sources,
  };
}

// ---------------------------------------------------------------------------
// Generic intelligence agent (Agents 3-8 + regulatory)
// ---------------------------------------------------------------------------

export interface IntelSpec {
  id: string;
  name: string;
  category: RiskCategory;
  queries: string[];
  focus: string; // what this agent assesses
}

export async function intelAgent(spec: IntelSpec, context: string): Promise<{ factor: RiskFactor; sources: Source[] }> {
  // Fan out the searches for this agent in parallel.
  const results = await Promise.all(spec.queries.map((q) => anakinSearch(q, 3)));
  const sources = dedupeSources(results.flat()).slice(0, 5);

  const fallback = heuristicFactor(spec, sources);

  const factor = await jsonCompletion<RiskFactor>({
    system:
      `You are the ${spec.name} for a logistics risk platform. You assess ${spec.focus}. ` +
      `Score risk 0-100 (0 = calm/no risk, 100 = severe disruption likely). Be decisive and quantitative. ` +
      `The MOST IMPORTANT field is "actionable": ONE concrete, time-bound sentence the shipper can act on — ` +
      `name the specific month/window and the concrete event or recommended action ` +
      `(e.g. "Typhoon risk peaks early-to-mid September near Shanghai — sail before Sep 8 or expect 2-5 day delays", ` +
      `or "PP resin likely +6-8% by August — lock pricing now"). No hedging, no vague advice. ` +
      `Respond ONLY with JSON.`,
    user:
      `Shipment context: ${context}\n\n` +
      `Live web findings:\n${sources.map((s) => `- ${s.title}: ${s.snippet ?? ""}`).join("\n") || "(no fresh results)"}\n\n` +
      `Return JSON: {"score": number, "label": string (3-5 word headline), ` +
      `"actionable": string (one concrete, time-bound action/insight), "detail": string (2-3 sentences), ` +
      `"trend": "up"|"down"|"flat", "keyFindings": string[] (2-4 bullets)}`,
    fallback,
  });

  return {
    factor: {
      category: spec.category,
      score: clamp(Math.round(factor.score ?? 50)),
      label: factor.label || fallback.label,
      detail: factor.detail || fallback.detail,
      actionable: factor.actionable || fallback.actionable,
      trend: factor.trend || "flat",
      keyFindings: (factor.keyFindings?.length ? factor.keyFindings : fallback.keyFindings).slice(0, 4),
      sources,
    },
    sources,
  };
}

export function buildIntelSpecs(input: ShipmentInput, profile: ProductProfile): IntelSpec[] {
  const materialList = profile.materials.map((m) => m.material).join(", ");
  return [
    {
      id: "commodity",
      name: "Commodity Intelligence Agent",
      category: "commodity",
      focus: `raw-material cost exposure (${materialList})`,
      queries: [
        `${profile.materials[0]?.material || "raw material"} price trend forecast 2026`,
        `oil crude price impact ${materialList} cost`,
      ],
    },
    {
      id: "freight",
      name: "Freight Intelligence Agent",
      category: "freight",
      focus: "ocean/air freight rates, capacity and route disruptions",
      queries: [
        `${input.origin} to ${input.destination} ocean freight container rates`,
        `container shipping capacity rate forecast transpacific`,
      ],
    },
    {
      id: "port",
      name: "Port Intelligence Agent",
      category: "port",
      focus: "port congestion, vessel queues and throughput",
      queries: [
        `${input.destination} port congestion delays vessel queue`,
        `${input.origin} port throughput congestion`,
      ],
    },
    {
      id: "weather",
      name: "Weather Intelligence Agent",
      category: "weather",
      focus: "storms, typhoons and seasonal disruption on the route",
      queries: [
        `typhoon hurricane storm forecast shipping ${input.origin} ${input.destination}`,
        `extreme weather supply chain disruption ${new Date().getFullYear()}`,
      ],
    },
    {
      id: "geopolitical",
      name: "Geopolitical Intelligence Agent",
      category: "geopolitical",
      focus: "trade restrictions, sanctions and conflict risk",
      queries: [
        `tariffs trade restrictions ${input.origin} ${input.destination} imports`,
        `Red Sea shipping disruption geopolitical risk trade`,
      ],
    },
    {
      id: "supplier",
      name: "Supplier Intelligence Agent",
      category: "supplier",
      focus: "supplier/manufacturing health in the origin region",
      queries: [
        `${input.origin} manufacturing PMI factory output ${profile.productCategory}`,
        `${profile.productCategory} supplier disruption strike factory closure`,
      ],
    },
    {
      id: "regulatory",
      name: "Regulatory Intelligence Agent",
      category: "regulatory",
      focus: "customs, compliance and tariff-classification changes",
      queries: [
        `customs tariff classification change ${profile.productCategory} import ${input.destination}`,
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Port Recommendation Agent
//   1. LLM proposes the realistic alternative entry ports for this lane
//   2. Live web search pulls current congestion for each (parallel)
//   3. LLM scores each + a synthesis pass picks the best with a rationale
// ---------------------------------------------------------------------------

export async function portRecommenderAgent(input: ShipmentInput): Promise<PortRecommendation | null> {
  const candidates = await jsonCompletion<{ ports: string[] }>({
    system:
      "You are a maritime routing expert. Given an ocean shipment, list the realistic candidate " +
      "discharge/entry seaports that could serve the destination — include the intended port AND viable " +
      "nearby alternatives on the same coast/region. Use 'Port City, Country' names. JSON only.",
    user:
      `Origin: ${input.origin}\nIntended destination: ${input.destination}\n\n` +
      `Return JSON: {"ports": string[]} with 3-4 ports, the intended one first.`,
    fallback: { ports: [input.destination] },
  });

  const ports = (candidates.ports || []).filter(Boolean).slice(0, 4);
  if (!ports.length) return null;

  const scored: Omit<PortOption, "recommended" | "lat" | "lng" | "freightCost">[] = await Promise.all(
    ports.map(async (port) => {
      const sources = await anakinSearch(`${port} port congestion dwell time vessel queue delays 2026`, 3);
      const s = await jsonCompletion<{ congestionScore: number; waitDays: number; note: string }>({
        system:
          "Assess this seaport's CURRENT congestion from the findings. Score 0-100 (0 = clear, 100 = " +
          "severe backlog) and estimate berth/dwell wait in days. Be decisive. JSON only.",
        user:
          `Port: ${port}\n\nFindings:\n${sources.map((x) => `- ${x.title}: ${x.snippet ?? ""}`).join("\n") || "(no fresh results)"}\n\n` +
          `Return {"congestionScore": number, "waitDays": number, "note": string (one line)}`,
        fallback: { congestionScore: 50, waitDays: 3, note: `${port}: conditions mixed.` },
      });
      return {
        name: port,
        congestionScore: clamp(Math.round(s.congestionScore ?? 50)),
        waitDays: Math.max(0, Math.round(s.waitDays ?? 3)),
        note: s.note || `${port}: conditions mixed.`,
        sources,
      };
    }),
  );

  // Pick the best: lowest congestion, tie-break on wait. Then write a rationale
  // comparing it to the intended destination.
  const best = [...scored].sort(
    (a, b) => a.congestionScore - b.congestionScore || a.waitDays - b.waitDays,
  )[0];

  const intended = scored[0];
  const rationale = await textCompletion({
    system:
      "You are a logistics advisor. In 1-2 sentences, recommend the best entry port and say why, " +
      "comparing it to the intended port. Mention the congestion/wait difference. Plain text.",
    user:
      `Intended port: ${intended.name} (congestion ${intended.congestionScore}/100, ~${intended.waitDays}d wait). ` +
      `Recommended: ${best.name} (congestion ${best.congestionScore}/100, ~${best.waitDays}d wait). ` +
      `All options: ${scored.map((p) => `${p.name} ${p.congestionScore}/100`).join(", ")}.`,
    fallback:
      best.name === intended.name
        ? `${best.name} remains the best entry port; alternatives offer no congestion advantage.`
        : `Route through ${best.name} instead of ${intended.name} — congestion is ${intended.congestionScore - best.congestionScore} points lower, saving roughly ${Math.max(0, intended.waitDays - best.waitDays)} days of port wait.`,
  });

  const options: PortOption[] = scored.map((p) => ({
    ...p,
    recommended: p.name === best.name,
    freightCost: 0, // filled in by the orchestrator from the freight baseline
    lat: null,
    lng: null,
  }));

  return { recommended: best.name, rationale, options };
}

// ---------------------------------------------------------------------------
// Tariff & Regulation Agent — consolidate the real import duty for this HS code
// and lane (base/MFN + Section 301 / ADD-CVD) plus compliance requirements.
// ---------------------------------------------------------------------------

export async function tariffAgent(input: ShipmentInput, profile: ProductProfile): Promise<TariffInfo | null> {
  const hs = profile.hsCodes[0] || "";
  const special = (input.specialRequirements ?? []).filter((r) => r && r !== "Standard (ambient)");
  const queries = [
    `${input.destination} import duty rate ${profile.productCategory} from ${input.origin} HS code ${hs} 2026`,
    `Section 301 tariff list ${profile.productCategory} ${input.origin} HS ${hs}`,
    `${input.destination} import required documents customs clearance ${profile.productCategory}${special.length ? " " + special.join(" ") : ""}`,
  ];
  const results = await Promise.all(queries.map((q) => anakinSearch(q, 3)));
  const sources = dedupeSources(results.flat()).slice(0, 6);

  const fallback: TariffInfo = {
    hsCode: hs,
    originCountry: input.origin,
    destinationCountry: input.destination,
    baseDutyPct: 0,
    additional: [],
    totalDutyPct: 0,
    documents: [
      { name: "Commercial invoice", url: "" },
      { name: "Packing list", url: "" },
      { name: "Bill of lading / air waybill", url: "" },
      { name: "Certificate of origin", url: "" },
    ],
    requirements: [],
    goodsValueUsd: 0,
    estimatedDutyUsd: 0,
    notes: "Verify with a licensed customs broker before booking.",
    sources,
  };

  const out = await jsonCompletion<TariffInfo>({
    system:
      "You are a licensed customs & trade-compliance expert. From the findings, determine the import duty for " +
      "this product on this exact lane as accurately as possible. Provide: base/MFN duty %, any ADDITIONAL " +
      "tariffs (Section 301, anti-dumping/countervailing) each with its %, the TOTAL effective duty %, the list " +
      "of REQUIRED IMPORT DOCUMENTS specific to the DESTINATION country (commercial invoice, packing list, bill " +
      "of lading, certificate of origin, import license, phytosanitary/health certificate, MSDS for hazardous, " +
      "etc.). For EACH document give an official URL where the importer can obtain or learn about it (the issuing " +
      "agency / chamber of commerce / customs authority page). If you do not have a reliable official URL, set " +
      'url to "" (empty) — do NOT invent or guess a URL. Also give other compliance requirements and a confidence ' +
      "note. Account for special handling. Numbers only for percentages. JSON only.",
    user:
      `Product: ${profile.productCategory}\nHS code: ${hs || "(infer best HS6/HS8)"}\n` +
      `Origin: ${input.origin}\nDestination: ${input.destination}\n` +
      `Special handling: ${special.length ? special.join(", ") : "none"}\n\n` +
      `Findings:\n${sources.map((s) => `- ${s.title} (${s.url}): ${s.snippet ?? ""}`).join("\n") || "(no fresh results)"}\n\n` +
      `Return JSON: {"hsCode":string,"baseDutyPct":number,` +
      `"additional":[{"name":string,"ratePct":number}],"totalDutyPct":number,` +
      `"documents":[{"name":string,"url":string}],"requirements":string[],"notes":string}`,
    fallback,
  });

  const additional = (out.additional ?? []).filter((a) => a && a.name).map((a) => ({ name: a.name, ratePct: Number(a.ratePct) || 0 }));
  const computedTotal = (Number(out.baseDutyPct) || 0) + additional.reduce((s, a) => s + a.ratePct, 0);
  const documents = (Array.isArray(out.documents) && out.documents.length ? out.documents : fallback.documents)
    .filter((d) => d && d.name)
    .slice(0, 8)
    .map((d) => ({ name: d.name, url: /^https?:\/\//.test(d.url || "") ? d.url : "" }));
  return {
    hsCode: out.hsCode || hs,
    originCountry: input.origin,
    destinationCountry: input.destination,
    baseDutyPct: Number(out.baseDutyPct) || 0,
    additional,
    totalDutyPct: Number(out.totalDutyPct) > 0 ? Number(out.totalDutyPct) : computedTotal,
    documents,
    requirements: (out.requirements ?? []).slice(0, 6),
    goodsValueUsd: 0,
    estimatedDutyUsd: 0,
    notes: out.notes || fallback.notes,
    sources,
  };
}

// ---------------------------------------------------------------------------
// Conversational intake — extract fields, merge with what we already know,
// and ask for whatever required info is still missing.
// ---------------------------------------------------------------------------

export const SHIP_MODES = ["Ocean (container)", "Air", "Rail", "Truck"];
export const SPECIAL_REQS = ["Standard (ambient)", "Refrigerated", "Frozen", "Fragile", "Hazardous", "Organic"];

function normalizeMode(raw: string): string {
  const m = (raw || "").toLowerCase();
  if (/container|ocean|sea|fcl|lcl|vessel|ship/.test(m)) return "Ocean (container)";
  if (/air|plane|flight/.test(m)) return "Air";
  if (/rail|train/.test(m)) return "Rail";
  if (/truck|road|lorry|ground/.test(m)) return "Truck";
  return "";
}

function normalizeReqs(raw: string): string[] {
  const m = (raw || "").toLowerCase();
  const out: string[] = [];
  if (/frozen|freezer|deep freeze/.test(m)) out.push("Frozen");
  if (/refrigerat|reefer|chilled|cold[\s-]?chain|cool/.test(m)) out.push("Refrigerated");
  if (/fragile|breakable|delicate/.test(m)) out.push("Fragile");
  if (/hazard|dangerous|hazmat|imdg|flammable|corros|toxic|lithium battery/.test(m)) out.push("Hazardous");
  if (/organic|bio[\s-]?certified/.test(m)) out.push("Organic");
  if (/ambient|standard|none|no special|regular|dry/.test(m)) out.push("Standard (ambient)");
  return [...new Set(out)];
}

export async function intake(text: string, current?: Partial<ShipmentInput>): Promise<IntakeResult> {
  const clean = (s: string) => (s || "").replace(/^[\s,]+|[\s,]+$/g, "");

  const extracted = await jsonCompletion<
    ShipmentInput & { shippingModeRaw?: string; specialRaw?: string; pricePerKg?: number }
  >({
    system:
      "Extract shipment fields from the user's message. Convert any weight to kilograms (1 metric ton = " +
      "1000kg). Detect: shipping mode (ocean/container, air, rail, truck), container size if any (20ft, 40ft, " +
      "40ft HC, LCL, pallets), price per kg in USD (if they give total price, divide by weight), and any special " +
      "handling (refrigerated, frozen, ambient/standard, fragile, hazardous, organic). Leave a field empty/0 if " +
      "not present. Do NOT invent values. JSON only.",
    user:
      `Message: "${text}"\n\n` +
      `Return JSON: {"product": string, "origin": "City, Country", "destination": "City, Country", ` +
      `"weightKg": number, "quantity": number, "containerSize": string, "pricePerKg": number, ` +
      `"shipDate": string, "shippingModeRaw": string, "specialRaw": string}`,
    fallback: { product: "", origin: "", destination: "", weightKg: 0, shipDate: "" },
  });

  const newReqs = normalizeReqs(extracted.specialRaw || "");

  // Merge: keep what we already had, fill in anything new the user just provided.
  const merged: ShipmentInput = {
    product: clean(extracted.product) || current?.product || "",
    origin: clean(extracted.origin) || current?.origin || "",
    destination: clean(extracted.destination) || current?.destination || "",
    weightKg: Number(extracted.weightKg) || current?.weightKg || 0,
    quantity: extracted.quantity ? Number(extracted.quantity) : current?.quantity,
    containerSize: clean(extracted.containerSize || "") || current?.containerSize || "",
    pricePerKg: Number(extracted.pricePerKg) > 0 ? Number(extracted.pricePerKg) : current?.pricePerKg,
    shipDate: clean(extracted.shipDate) || current?.shipDate || "",
    shippingMode: normalizeMode(extracted.shippingModeRaw || "") || current?.shippingMode || "",
    specialRequirements: newReqs.length ? newReqs : current?.specialRequirements,
    locked: current?.locked,
  };

  // Light detection of already-committed costs from the message.
  const lm = text.toLowerCase();
  const detectedLocked = [
    /(goods|product|cargo|po|purchase).{0,15}(paid|locked|bought|secured)/.test(lm) ? "Goods" : "",
    /(freight|shipping|rate|container).{0,15}(locked|booked|fixed|secured)/.test(lm) ? "Freight" : "",
    /(duty|duties|tariff).{0,15}(paid|locked|prepaid)/.test(lm) ? "Duty" : "",
  ].filter(Boolean);
  if (detectedLocked.length) {
    merged.locked = [...new Set([...(merged.locked ?? []), ...detectedLocked])];
  }

  // Required fields: [field key, friendly label, present?]
  const required: [string, string, () => boolean][] = [
    ["product", "what you're shipping", () => !!merged.product],
    ["origin", "where it ships from", () => !!merged.origin],
    ["destination", "where it's going", () => !!merged.destination],
    ["weightKg", "the total weight (kg or tons)", () => merged.weightKg > 0],
    ["shippingMode", "how it should ship (ocean container, air, rail, or truck)", () => !!merged.shippingMode],
    ["pricePerKg", "the price per kg in USD (so I can estimate duties)", () => (merged.pricePerKg ?? 0) > 0],
    ["shipDate", "when it's ready to ship", () => !!merged.shipDate],
    ["specialRequirements", "any special handling (refrigerated, frozen, fragile, hazardous, organic — or just say 'none')", () => (merged.specialRequirements?.length ?? 0) > 0],
  ];

  const stillMissing = required.filter(([, , ok]) => !ok());
  const missing = stillMissing.map(([, label]) => label);
  const missingFields = stillMissing.map(([key]) => key);

  let question: string | null = null;
  if (missing.length === 1) {
    question = `Almost there — could you also tell me ${missing[0]}?`;
  } else if (missing.length > 1) {
    const list = missing.slice(0, -1).join("; ") + "; and " + missing[missing.length - 1];
    question = `Got it so far. To run a full analysis I still need: ${list}.`;
  }

  return { input: merged, missing, missingFields, question, ready: missing.length === 0 };
}

// ---------------------------------------------------------------------------
// Commodity Price Agent — search the live current price for each driver, then
// extract price + a short-term forecast with one LLM call.
// ---------------------------------------------------------------------------

function rnd2(v: number, scale: number): number {
  if (scale >= 1000) return Math.round(v);
  if (scale >= 10) return Math.round(v * 10) / 10;
  return Math.round(v * 100) / 100;
}

export async function enrichDriverPrices(drivers: DependencyDriver[]): Promise<DependencyDriver[]> {
  if (!drivers.length) return drivers;

  // 1. Scrape a price source for each driver in parallel.
  const searched = await Promise.all(
    drivers.map(async (d) => {
      const sources = await anakinSearch(`${d.name} current spot price ${d.unit} today forecast 2026`, 3);
      return { d, sources };
    }),
  );

  // 2. One LLM call extracts the current price + forecast for all of them.
  const payload = searched.map((s, i) => ({
    id: i,
    name: s.d.name,
    unit: s.d.unit,
    snippets: s.sources.map((x) => `${x.title}: ${x.snippet ?? ""}`).slice(0, 3),
  }));

  const out = await jsonCompletion<{
    items: { id: number; currentPrice: number; unit?: string; forecastPct: number; forecastNote: string }[];
  }>({
    system:
      "You are a commodity & freight price analyst. From each item's search snippets, extract the most recent " +
      "CURRENT price as a number in the given unit. Then give a short-term (~60 day) forecast percentage change " +
      "and a one-line rationale. If the snippets lack an explicit number, give your best realistic current-market " +
      "estimate for that commodity in that unit (never 0). JSON only.",
    user:
      `Items:\n${JSON.stringify(payload)}\n\n` +
      `Return JSON: {"items":[{"id":number,"currentPrice":number,"unit":string,"forecastPct":number,"forecastNote":string}]}`,
    fallback: { items: [] },
  });

  const byId = new Map((out.items ?? []).map((it) => [it.id, it]));

  return searched.map((s, i) => {
    const it = byId.get(i);
    const sources = s.sources;
    if (!it || !(it.currentPrice > 0)) {
      return { ...s.d, sources }; // keep seeded values, still attach sources
    }

    const current = it.currentPrice;
    const unit = it.unit || s.d.unit;

    // Rescale the historical shape so it ends at the real current price.
    const oldLast = s.d.series[s.d.series.length - 1]?.v || current;
    const scale = current / (oldLast || current);
    const history: { t: string; v: number | null; f?: number | null }[] = s.d.series.map((p) => ({
      t: p.t,
      v: rnd2((p.v ?? current) * scale, current),
    }));
    history[history.length - 1].v = current;
    history[history.length - 1].f = current; // junction so the dashed forecast connects

    const firstV = history[0].v ?? current;
    const changePct = Math.round(((current - firstV) / firstV) * 1000) / 10;
    const fpct = typeof it.forecastPct === "number" ? it.forecastPct : s.d.forecastPct;
    const target = current * (1 + fpct / 100);
    const forecast = [1, 2, 3].map((k) => ({
      t: `+${k * 20}d`,
      v: null,
      f: rnd2(current + (target - current) * (k / 3), current),
    }));

    return {
      ...s.d,
      current,
      unit,
      changePct,
      trend: changePct > 1.5 ? "up" : changePct < -1.5 ? "down" : "flat",
      forecastPct: fpct,
      forecastNote: it.forecastNote || "",
      priceLive: true,
      series: [...history, ...forecast],
      sources,
    } as DependencyDriver;
  });
}

// ---------------------------------------------------------------------------
// Synthesis agent (Agents 9-12: cost, route, alerts, summary)
// ---------------------------------------------------------------------------

export interface SynthesisOutput {
  costForecasts: CostForecast[];
  expectedCostIncreasePct: number;
  expectedDelayDays: [number, number];
  routes: RouteOption[];
  alerts: Alert[];
  recommendations: Recommendation[];
}

export async function synthesisAgent(
  input: ShipmentInput,
  profile: ProductProfile,
  factors: RiskFactor[],
  riskScore: number,
): Promise<SynthesisOutput> {
  const factorSummary = factors
    .map((f) => `${f.category} (risk ${f.score}/100, ${f.trend}): ${f.label}`)
    .join("\n");

  const fallback: SynthesisOutput = {
    costForecasts: [
      { horizonDays: 30, productCostPct: 2.1, freightCostPct: 3.4, landedCostPct: 2.6 },
      { horizonDays: 60, productCostPct: 3.8, freightCostPct: 5.2, landedCostPct: 4.3 },
      { horizonDays: 90, productCostPct: 5.1, freightCostPct: 8.0, landedCostPct: 6.4 },
    ],
    expectedCostIncreasePct: 6.4,
    expectedDelayDays: [4, 9],
    routes: defaultRoutes(input),
    alerts: factors
      .filter((f) => f.score >= 60)
      .slice(0, 3)
      .map((f) => ({ severity: f.score >= 75 ? "high" : "medium", title: f.label, impact: f.detail })),
    recommendations: [
      { action: "Lock freight rates now", rationale: "Spot rates are trending up into peak season." },
      { action: "Ship 2-3 weeks earlier", rationale: "Buffer against port congestion and weather delays." },
    ],
  };

  const result = await jsonCompletion<SynthesisOutput>({
    system:
      "You are the cost-prediction, route-optimization and alerting brain of a logistics intelligence " +
      "platform. Combine the per-category risk factors into concrete forecasts and recommended actions. " +
      "Cost percentages are EXPECTED INCREASES over the horizon. Be realistic and decisive. JSON only.",
    user:
      `Shipment: ${input.quantity ? input.quantity + " units of " : ""}${input.product}, ` +
      `${input.weightKg}kg, ${input.origin} -> ${input.destination}, ship date ${input.shipDate}.\n` +
      (input.shippingMode
        ? `The shipper has chosen "${input.shippingMode}" — mark THAT mode as recommended:true and base the headline transit/delay on it, but still list the other modes for comparison.\n`
        : "") +
      `Overall risk score: ${riskScore}/100.\n` +
      `Material exposure: ${profile.materials.map((m) => `${m.material} ${m.pct}%`).join(", ")}.\n\n` +
      `Risk factors:\n${factorSummary}\n\n` +
      `Return JSON: {\n` +
      `  "costForecasts": [{"horizonDays":30,"productCostPct":n,"freightCostPct":n,"landedCostPct":n}, (60), (90)],\n` +
      `  "expectedCostIncreasePct": number,\n` +
      `  "expectedDelayDays": [low, high],\n` +
      `  "routes": [{"method":"Ocean Freight","cost":usd,"transitDays":n,"recommended":bool,"note":string}, ...4 modes],\n` +
      `  "alerts": [{"severity":"high|medium|low","title":string,"impact":string}],\n` +
      `  "recommendations": [{"action":string,"rationale":string}]\n}`,
    fallback,
  });

  return {
    costForecasts: result.costForecasts?.length === 3 ? result.costForecasts : fallback.costForecasts,
    expectedCostIncreasePct: result.expectedCostIncreasePct ?? fallback.expectedCostIncreasePct,
    expectedDelayDays: result.expectedDelayDays?.length === 2 ? result.expectedDelayDays : fallback.expectedDelayDays,
    routes: result.routes?.length ? result.routes : fallback.routes,
    alerts: result.alerts?.length ? result.alerts : fallback.alerts,
    recommendations: result.recommendations?.length ? result.recommendations : fallback.recommendations,
  };
}

// ---------------------------------------------------------------------------
// Action Plan Agent — turn every per-factor actionable into one prioritized,
// deadline-sorted checklist.
// ---------------------------------------------------------------------------

export async function actionPlanAgent(
  input: ShipmentInput,
  factors: RiskFactor[],
  synthesis: SynthesisOutput,
): Promise<ActionItem[]> {
  const fallback: ActionItem[] = factors
    .filter((f) => f.score >= 45)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((f) => ({
      action: f.actionable,
      deadline: "Before booking",
      dueDate: null,
      category: f.category,
      urgency: f.score >= 70 ? "high" : f.score >= 55 ? "medium" : "low",
      why: f.label,
    }));

  const plan = await jsonCompletion<{ items: ActionItem[] }>({
    system:
      "You are a logistics operations planner. Turn the per-category risk actions into ONE consolidated, " +
      "deduplicated to-do list for this shipment. Each item: a short imperative action, a concrete deadline " +
      "(prefer a real date derived from the ship date), an ISO dueDate (YYYY-MM-DD) when datable else null, " +
      "the category, an urgency, and a one-line why. Order earliest deadline first. 5-8 items. JSON only.",
    user:
      `Shipment: ${input.product}, ${input.origin} -> ${input.destination}, ship date ${input.shipDate}` +
      `${input.shippingMode ? `, ${input.shippingMode}` : ""}.\n\n` +
      `Per-category actions:\n${factors.map((f) => `- [${f.category}, risk ${f.score}] ${f.actionable}`).join("\n")}\n\n` +
      `Synthesis recommendations:\n${synthesis.recommendations.map((r) => `- ${r.action}: ${r.rationale}`).join("\n")}\n\n` +
      `Return JSON: {"items":[{"action":string,"deadline":string,"dueDate":"YYYY-MM-DD"|null,` +
      `"category":string,"urgency":"high"|"medium"|"low","why":string}]}`,
    fallback: { items: fallback },
  });

  const items = plan.items?.length ? plan.items : fallback;
  // Sort by dueDate ascending; undated items go last.
  return items
    .slice(0, 8)
    .sort((a, b) => {
      if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      return 0;
    });
}

export async function executiveSummaryAgent(
  input: ShipmentInput,
  factors: RiskFactor[],
  riskScore: number,
  synthesis: SynthesisOutput,
): Promise<string> {
  const top = [...factors].sort((a, b) => b.score - a.score).slice(0, 3);
  const fallback =
    `Three major risks currently affect this shipment: ${top
      .map((f) => f.label)
      .join("; ")}. Expected impact: +${synthesis.expectedCostIncreasePct}% cost and a ` +
    `${synthesis.expectedDelayDays[0]}–${synthesis.expectedDelayDays[1]} day delay.`;

  return textCompletion({
    system:
      "You are an executive briefing writer. In 3-4 sentences, plainly explain the top risks to this " +
      "shipment, why they matter, and the headline cost/delay impact. No markdown, no bullet points.",
    user:
      `Shipment: ${input.product}, ${input.origin} -> ${input.destination}, ship date ${input.shipDate}. ` +
      `Overall risk ${riskScore}/100. Top risks: ${top.map((f) => `${f.label} (${f.detail})`).join(" | ")}. ` +
      `Expected +${synthesis.expectedCostIncreasePct}% cost, ${synthesis.expectedDelayDays[0]}-${synthesis.expectedDelayDays[1]} day delay.`,
    fallback,
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

// Deterministic-but-varied baseline used when OpenAI is unavailable, so the
// offline demo still shows a realistic spread of risk rather than flat 50s.
const HEURISTIC_BASE: Record<
  RiskCategory,
  { score: number; trend: RiskFactor["trend"]; label: string; actionable: string }
> = {
  freight: { score: 68, trend: "up", label: "Peak-season rate spike", actionable: "Spot rates climb ~10-15% into Aug-Sep peak season — lock contract rates before July." },
  port: { score: 61, trend: "up", label: "Rising port dwell times", actionable: "Dwell times rising at the destination port — build a 2-3 day buffer into your booking." },
  commodity: { score: 57, trend: "up", label: "Feedstock costs firming", actionable: "Input costs trending up ~6-8% by August — hedge or lock supplier pricing now." },
  geopolitical: { score: 54, trend: "flat", label: "Tariff exposure", actionable: "Tariff review pending — confirm HS classification and duty model before booking." },
  weather: { score: 49, trend: "up", label: "Storm-season exposure", actionable: "Tropical storm risk peaks Aug-Sep on this lane — sail early or expect 2-5 day delays." },
  supplier: { score: 42, trend: "flat", label: "Stable but watch policy", actionable: "Supplier base is deep, but get a backup quote in case of tariff-driven margin pressure." },
  regulatory: { score: 38, trend: "flat", label: "Classification check", actionable: "Verify HS code and any 2026 classification changes 4+ weeks before the ship date." },
};

function heuristicFactor(spec: IntelSpec, sources: Source[]): RiskFactor {
  const base =
    HEURISTIC_BASE[spec.category] ??
    { score: 50, trend: "flat" as const, label: `${spec.name}`, actionable: "Monitor this factor ahead of booking." };
  // nudge score by how much fresh coverage we found
  const score = clamp(base.score + Math.min(sources.length, 4) * 2 - 4);
  return {
    category: spec.category,
    score,
    label: base.label,
    detail: `Assessment of ${spec.focus}. ${sources[0]?.snippet ?? "Conditions warrant active monitoring for this shipment."}`,
    actionable: base.actionable,
    trend: base.trend,
    keyFindings: sources.slice(0, 3).map((s) => s.title),
    sources,
  };
}

function guessMaterials(product: string): { materials: MaterialBreakdown[]; dependencies: string[] } {
  const p = product.toLowerCase();
  const dep = (extra: string[]) => ["Oil Prices", ...extra, "Freight Rates", "Port Congestion", "Tariffs", "Currency Exchange"];
  if (/chair|furniture|toy|bottle|crate|bin|plastic|polymer/.test(p))
    return { materials: [{ material: "Plastic", pct: 80 }, { material: "Steel", pct: 15 }, { material: "Packaging", pct: 5 }], dependencies: dep(["Plastic Resin Prices", "Steel Prices"]) };
  if (/battery|lithium|cell|power/.test(p))
    return { materials: [{ material: "Lithium", pct: 35 }, { material: "Nickel/Cobalt", pct: 30 }, { material: "Aluminum", pct: 20 }, { material: "Plastic", pct: 15 }], dependencies: dep(["Lithium Prices", "Nickel Prices", "Semiconductor Supply"]) };
  if (/shirt|cotton|apparel|garment|textile|cloth/.test(p))
    return { materials: [{ material: "Cotton", pct: 88 }, { material: "Polyester", pct: 8 }, { material: "Packaging", pct: 4 }], dependencies: dep(["Cotton Prices", "Labor Costs"]) };
  if (/steel|metal|machine|tool|appliance/.test(p))
    return { materials: [{ material: "Steel", pct: 65 }, { material: "Aluminum", pct: 20 }, { material: "Plastic", pct: 15 }], dependencies: dep(["Steel Prices", "Aluminum Prices"]) };
  if (/electronic|phone|laptop|chip|device|gadget/.test(p))
    return { materials: [{ material: "Semiconductors", pct: 40 }, { material: "Aluminum", pct: 25 }, { material: "Plastic", pct: 20 }, { material: "Copper", pct: 15 }], dependencies: dep(["Semiconductor Supply", "Copper Prices"]) };
  return { materials: [{ material: "Primary material", pct: 70 }, { material: "Secondary material", pct: 20 }, { material: "Packaging", pct: 10 }], dependencies: dep(["Commodity Prices"]) };
}

function dedupeSources(sources: Source[]): Source[] {
  const seen = new Set<string>();
  return sources.filter((s) => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}

function defaultRoutes(input: ShipmentInput): RouteOption[] {
  const w = input.weightKg || 20000;
  const oceanCost = Math.round(2200 + w * 0.03);
  const airCost = Math.round(oceanCost * 11.5);
  return [
    { method: "Ocean Freight", cost: oceanCost, transitDays: 22, recommended: true, note: "Most cost-effective for non-urgent cargo." },
    { method: "Air Freight", cost: airCost, transitDays: 3, recommended: false, note: "~12x cost; only worth it for time-critical goods." },
    { method: "Rail Freight", cost: Math.round(oceanCost * 1.7), transitDays: 18, recommended: false, note: "Where rail corridors exist; balances cost and speed." },
    { method: "Truck Freight", cost: Math.round(oceanCost * 2.4), transitDays: 12, recommended: false, note: "Regional/last-leg; limited for transoceanic." },
  ];
}
