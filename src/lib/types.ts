// Core domain types for the shipment risk planning flow

export interface ShipmentInput {
  product: string;
  origin: string;
  destination: string;
  weightKg: number;
  quantity?: number;
  shipDate: string; // free-form, e.g. "September 2026" or ISO date
  shippingMode?: string; // "Ocean (container)" | "Air" | "Rail" | "Truck"
  containerSize?: string; // "20ft" | "40ft" | "40ft HC" | "LCL" | "Pallets"
  pricePerKg?: number; // USD per kg — used to value the goods and compute duty
  specialRequirements?: string[]; // Refrigerated | Frozen | Standard (ambient) | Fragile | Hazardous | Organic
  locked?: string[]; // already-committed costs: "Goods" | "Freight" | "Duty"
}

// Result of the conversational intake: what we extracted, what's still missing,
// and the follow-up question to ask the user.
export interface IntakeResult {
  input: ShipmentInput;
  missing: string[]; // human-readable labels of required fields still missing
  missingFields: string[]; // field keys still missing (for quick-pick buttons)
  question: string | null; // follow-up to ask, or null when complete
  ready: boolean;
}

export type RiskCategory =
  | "commodity"
  | "freight"
  | "port"
  | "weather"
  | "geopolitical"
  | "supplier"
  | "regulatory";

export interface Source {
  title: string;
  url: string;
  snippet?: string;
}

export interface MaterialBreakdown {
  material: string;
  pct: number;
}

export interface RiskFactor {
  category: RiskCategory;
  score: number; // 0-100, higher = more risk
  label: string; // short headline
  detail: string; // one-paragraph explanation
  actionable: string; // concrete, time-bound insight or action (the headline of the card)
  trend: "up" | "down" | "flat";
  keyFindings: string[];
  sources: Source[];
}

export interface CostForecast {
  horizonDays: 30 | 60 | 90;
  productCostPct: number;
  freightCostPct: number;
  landedCostPct: number;
}

export interface RouteOption {
  method: string; // Ocean / Air / Rail / Truck
  cost: number; // USD
  transitDays: number;
  recommended: boolean;
  note: string;
}

export interface Alert {
  severity: "high" | "medium" | "low";
  title: string;
  impact: string;
}

export interface Recommendation {
  action: string;
  rationale: string;
}

export interface ActionItem {
  action: string; // imperative, concise
  deadline: string; // display label, e.g. "By Jul 31, 2026"
  dueDate: string | null; // ISO YYYY-MM-DD for sorting, null if undated
  category: RiskCategory | "general";
  urgency: "high" | "medium" | "low";
  why: string; // one-line rationale
}

export interface DependencyNode {
  node: string;
  children: string[];
}

export interface DriverPoint {
  t: string; // period label, e.g. "W-9"
  v: number | null; // historical value (null on forecast points)
  f?: number | null; // forecast value (null on history points)
}

export interface DependencyDriver {
  name: string; // e.g. "Oil (Brent)"
  unit: string; // e.g. "$/bbl" or "index"
  current: number; // latest (live) value
  changePct: number; // change over the window
  trend: "up" | "down" | "flat";
  impact: "high" | "medium" | "low"; // impact on THIS shipment
  affects: string; // short note: what it drives
  forecastPct: number; // projected ~60-day change
  forecastNote: string; // one-line forecast rationale
  priceLive: boolean; // true when `current` came from a live scrape
  series: DriverPoint[];
  sources: Source[]; // where the price came from
}

export interface GeoPoint {
  name: string;
  lat: number;
  lng: number;
}

export interface RouteGeo {
  origin: GeoPoint;
  destination: GeoPoint;
  distanceKm: number;
}

// One live web search that was executed during the analysis.
export interface SearchRecord {
  agent: string; // which agent ran it
  query: string;
  results: number; // sources returned
  mode: "live" | "mock";
}

export interface TariffLine {
  name: string; // e.g. "Section 301 (List 4A)"
  ratePct: number;
}

export interface DocItem {
  name: string;
  url: string; // official source to obtain it, or "" if not found
}

export interface TariffInfo {
  hsCode: string;
  originCountry: string;
  destinationCountry: string;
  baseDutyPct: number; // MFN / base duty
  additional: TariffLine[]; // 301, anti-dumping, etc.
  totalDutyPct: number; // effective total
  documents: DocItem[]; // destination-country required import documents + where to get them
  requirements: string[]; // other compliance requirements
  goodsValueUsd: number; // weightKg * pricePerKg (0 if unknown)
  estimatedDutyUsd: number; // goodsValueUsd * totalDutyPct (0 if unknown)
  notes: string; // caveats / confidence
  sources: Source[];
}

export interface PortOption {
  name: string;
  congestionScore: number; // 0-100, higher = more congested
  waitDays: number; // estimated berth/dwell wait
  freightCost: number; // estimated freight cost to this port (USD)
  recommended: boolean;
  note: string;
  lat: number | null;
  lng: number | null;
  sources: Source[];
}

export interface PortRecommendation {
  recommended: string; // port name
  rationale: string;
  options: PortOption[];
}

export interface AnalysisResult {
  input: ShipmentInput;
  productCategory: string;
  hsCodes: string[];
  materials: MaterialBreakdown[];
  dependencyGraph: DependencyNode[];
  drivers: DependencyDriver[];
  riskScore: number; // 0-100
  riskFactors: RiskFactor[];
  costForecasts: CostForecast[];
  expectedCostIncreasePct: number;
  expectedDelayDays: [number, number];
  routes: RouteOption[];
  alerts: Alert[];
  recommendations: Recommendation[];
  actionPlan: ActionItem[];
  executiveSummary: string;
  news: Source[];
  geo: RouteGeo | null;
  tariff: TariffInfo | null;
  portRecommendation: PortRecommendation | null;
  searches: SearchRecord[];
  generatedAt: string;
  dataMode: "live" | "mock";
}

// Server-sent event payloads streamed to the dashboard
export type AnalyzeEvent =
  | { type: "agent"; id: string; name: string; status: "running" | "done" | "error"; summary?: string }
  | { type: "log"; message: string }
  | { type: "result"; data: AnalysisResult }
  | { type: "error"; message: string };
