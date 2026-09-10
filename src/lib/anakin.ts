// Live web layer, built on Anakin's REST API. Three capabilities:
//
//   anakinSearch       `/v1/search` — synchronous AI web search with citations.
//   anakinExtract      `/v1/url-scraper/scrape` — AI-extract structured data from
//                      one page against a JSON Schema. Handles both the inline
//                      response and the job-id-to-poll shape a slow page returns.
//   anakinDeepResearch `/v1/agentic-search` — multi-stage research pipeline
//                      (refine, search, scrape, synthesise). Async, ~35s.
//
// The batch scraper (`/v1/url-scraper/batch`) is deliberately unused: it's async
// and needs its own polling path to save nothing over `Promise.all` across the
// inline endpoint.
//
// Fallback: with no API key, or on error/timeout/unparseable response, search
// degrades to synthetic results so a cold clone still demos. Every call records
// its outcome in `searchLog`, and `dataMode` reports whether anything real was
// fetched — so the UI can always say which numbers came off the live web.

import type { Source } from "./types";

const API_KEY = process.env.ANAKIN_API_KEY || "";
const API_BASE = "https://api.anakin.io/v1";

let liveUsed = false;

export function anakinMode(): "live" | "mock" {
  return liveUsed ? "live" : "mock";
}

// Per-analysis log of every search the agents ran, for the transparency panel.
export interface SearchLogEntry {
  query: string;
  results: number;
  mode: "live" | "mock";
  sources: Source[];
}
let searchLog: SearchLogEntry[] = [];
export function resetSearchLog(): void {
  searchLog = [];
  // `liveUsed` is module-global and this module outlives a single request, so
  // without clearing it here one live call would make every later analysis in
  // the same server process claim `dataMode: "live"`.
  liveUsed = false;
}
export function getSearchLog(): SearchLogEntry[] {
  return searchLog;
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);

function headers(): Record<string, string> {
  return { "Content-Type": "application/json", "X-API-Key": API_KEY };
}

// Anakin's exact search response shape isn't fully documented, so parse defensively:
// look for an array under any of the likely keys, and accept several field-name
// variants per item.
interface RawItem {
  title?: string;
  name?: string;
  url?: string;
  link?: string;
  snippet?: string;
  description?: string;
  content?: string;
}

function parseSources(raw: unknown, limit: number): Source[] {
  const sources: Source[] = [];
  const seen = new Set<string>();

  const push = (title?: string, url?: string, snippet?: string) => {
    if (!title || !url || seen.has(url) || sources.length >= limit) return;
    seen.add(url);
    sources.push({ title: title.trim(), url: url.trim(), snippet: snippet?.trim() || undefined });
  };

  if (!raw || typeof raw !== "object") return sources;
  const obj = raw as Record<string, unknown>;
  const candidates = ["results", "citations", "sources", "data", "items"];
  for (const key of candidates) {
    const arr = obj[key];
    if (!Array.isArray(arr)) continue;
    for (const it of arr as RawItem[]) {
      if (!it || typeof it !== "object") continue;
      push(it.title || it.name, it.url || it.link, it.snippet || it.description || it.content);
      if (sources.length >= limit) return sources;
    }
    if (sources.length) return sources;
  }
  return sources;
}

/** Live web search via Anakin's synchronous AI search endpoint. */
export async function anakinSearch(query: string, limit = 5): Promise<Source[]> {
  if (API_KEY) {
    try {
      const res = await withTimeout(
        fetch(`${API_BASE}/search`, {
          method: "POST",
          headers: headers(),
          // The field is `prompt`, not `query` — sending `query` returns
          // HTTP 400 "Prompt is required". `limit` caps at 20 server-side.
          body: JSON.stringify({ prompt: query, limit: Math.min(limit, 20) }),
        }),
        18_000, // a slow query falls back to mock rather than stalling the run
      );
      if (res.ok) {
        const data = await res.json();
        const sources = parseSources(data, limit);
        if (sources.length) {
          liveUsed = true;
          searchLog.push({ query, results: sources.length, mode: "live", sources });
          return sources;
        }
        console.error(`[anakin] search "${query}" returned no parseable sources`);
      } else {
        // Log the body, not just the status — a silent contract change here is
        // what let every search 400 for the life of the project unnoticed.
        console.error(
          `[anakin] search "${query}" failed: HTTP ${res.status} ${await res.text().catch(() => "")}`,
        );
      }
    } catch (err) {
      console.error(`[anakin] search "${query}" failed:`, err);
    }
  }
  const mock = mockSearch(query, limit);
  searchLog.push({ query, results: mock.length, mode: "mock", sources: mock });
  return mock;
}

// A successful extraction or research call is itself a citable live source, so
// it lands in the same log the transparency panel reads — otherwise the panel
// would under-report how much of a result came off the live web.
function logLive(label: string, sources: Source[]): void {
  liveUsed = true;
  searchLog.push({ query: label, results: sources.length, mode: "live", sources });
}

function logMiss(label: string): void {
  searchLog.push({ query: label, results: 0, mode: "mock", sources: [] });
}

/**
 * AI-extract structured data from one page, shaped by a JSON Schema.
 *
 * `generateJson` is what turns extraction on (it defaults to false) and the
 * payload comes back nested under `generatedJson.data`. A slow page — large
 * PDFs, mostly — exceeds the inline window and returns a job id to poll
 * instead, so both shapes are handled here.
 */
export async function anakinExtract<T>(
  url: string,
  outputSchema: Record<string, unknown>,
  prompt: string,
  sourceTitle?: string,
): Promise<T | null> {
  const label = `extract: ${sourceTitle || url}`;
  if (!API_KEY) {
    logMiss(label);
    return null;
  }
  try {
    const res = await withTimeout(
      fetch(`${API_BASE}/url-scraper/scrape`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ url, generateJson: true, outputSchema, prompt }),
      }),
      60_000,
    );
    if (!res.ok) {
      console.error(`[anakin] extract "${url}" failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
      logMiss(label);
      return null;
    }

    let body = await res.json();
    for (let i = 0; i < 10 && (body?.status === "processing" || body?.status === "pending"); i++) {
      if (!body?.id) break;
      await new Promise((r) => setTimeout(r, 5_000));
      const polled = await fetch(`${API_BASE}/url-scraper/${body.id}`, { headers: headers() });
      if (!polled.ok) break;
      body = await polled.json();
    }

    const data = body?.generatedJson?.data;
    if (data && typeof data === "object") {
      logLive(label, [{ title: sourceTitle || url, url, snippet: undefined }]);
      return data as T;
    }
    logMiss(label);
    return null;
  } catch (err) {
    console.error(`[anakin] extract "${url}" failed:`, err);
    logMiss(label);
    return null;
  }
}

export interface DeepResearch {
  summary: string;
  structuredData: Record<string, unknown> | null;
}

/**
 * Anakin's multi-stage research pipeline: it refines the query, searches,
 * scrapes citations and synthesises a report.
 *
 * It returns a prose summary and auto-schema'd structured data but **no
 * citation list**, and it can surface figures several years stale, so it is
 * only ever presented as uncited synthesis alongside separately-cited numbers
 * — never as the basis for a figure the product asserts.
 */
export async function anakinDeepResearch(prompt: string): Promise<DeepResearch | null> {
  const label = `deep research: ${prompt}`;
  if (!API_KEY) {
    logMiss(label);
    return null;
  }
  try {
    const submit = await withTimeout(
      fetch(`${API_BASE}/agentic-search`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ prompt }),
      }),
      20_000,
    );
    if (!submit.ok) {
      console.error(`[anakin] deep research failed to submit: HTTP ${submit.status}`);
      logMiss(label);
      return null;
    }
    const { job_id: jobId } = await submit.json();
    if (!jobId) {
      logMiss(label);
      return null;
    }

    // Typically ~35s. Poll rather than hold one long request open.
    for (let i = 0; i < 18; i++) {
      await new Promise((r) => setTimeout(r, 5_000));
      const res = await fetch(`${API_BASE}/agentic-search/${jobId}`, { headers: headers() });
      if (!res.ok) continue;
      const body = await res.json();
      if (body?.status === "failed") break;
      if (body?.status !== "completed") continue;

      const generated = body?.generatedJson ?? {};
      const summary = typeof generated.summary === "string" ? generated.summary : "";
      if (!summary) break;
      logLive(label, []);
      return {
        summary,
        structuredData:
          generated.structured_data && typeof generated.structured_data === "object"
            ? (generated.structured_data as Record<string, unknown>)
            : null,
      };
    }
    logMiss(label);
    return null;
  } catch (err) {
    console.error(`[anakin] deep research failed:`, err);
    logMiss(label);
    return null;
  }
}

// --- Mock fallback -------------------------------------------------------

function host(seed: string, base: string): string {
  return `https://${base}/${encodeURIComponent(seed.toLowerCase().replace(/\s+/g, "-")).slice(0, 40)}`;
}

function mockSearch(query: string, limit: number): Source[] {
  const q = query.toLowerCase();
  const pick = (arr: Source[]) => arr.slice(0, limit);

  if (/freight|container|shipping rate|ocean/.test(q)) {
    return pick([
      { title: "Drewry World Container Index holds steady week-on-week", url: host(query, "drewry.co.uk"), snippet: "Composite index at $2,310 per 40ft container; Shanghai–LA lane up 3% on capacity tightening." },
      { title: "Freightos Baltic Index: Transpacific rates edge higher", url: host(query, "freightos.com"), snippet: "Spot rates on the China–US West Coast trade rose amid peak-season front-loading." },
      { title: "Carriers announce GRI for transpacific routes", url: host(query, "joc.com"), snippet: "General Rate Increase of $600/FEU planned as blank sailings tighten available space." },
    ]);
  }
  if (/port|congestion|berth|vessel queue/.test(q)) {
    return pick([
      { title: "LA/Long Beach dwell times tick up as imports rise", url: host(query, "porttechnology.org"), snippet: "Container dwell time climbed to 4.1 days; vessel queue forming offshore." },
      { title: "Pacific Merchant Shipping Assn signals labor uncertainty", url: host(query, "freightwaves.com"), snippet: "Ongoing negotiations raise risk of slowdowns at West Coast terminals." },
    ]);
  }
  if (/oil|crude|brent|wti|natural gas|resin|plastic/.test(q)) {
    return pick([
      { title: "Brent crude rises on supply concerns", url: host(query, "reuters.com"), snippet: "Oil up 4% week-on-week; downstream petrochemical and resin feedstock costs expected to follow." },
      { title: "Polypropylene resin prices firm in Asia", url: host(query, "icis.com"), snippet: "Spot PP resin gained on higher propylene; converters face margin pressure." },
    ]);
  }
  if (/steel|aluminum|copper|metal/.test(q)) {
    return pick([
      { title: "Steel benchmark prices steady amid soft demand", url: host(query, "spglobal.com"), snippet: "HRC prices flat; mills hold output as construction demand cools." },
    ]);
  }
  if (/typhoon|weather|storm|hurricane|flood/.test(q)) {
    return pick([
      { title: "South China Sea typhoon season outlook", url: host(query, "tropicaltidbits.com"), snippet: "Forecasters expect above-average tropical activity; shipping lanes may face periodic disruption." },
      { title: "JMA issues storm advisory near major shipping lanes", url: host(query, "jma.go.jp"), snippet: "Vessels advised to monitor developing systems off the southern coast." },
    ]);
  }
  if (/tariff|trade war|sanction|geopolit|export restriction/.test(q)) {
    return pick([
      { title: "US reviews Section 301 tariffs on Chinese goods", url: host(query, "ustr.gov"), snippet: "Potential adjustments to tariff lines covering consumer and industrial imports under review." },
      { title: "Red Sea diversions continue to lengthen some routes", url: host(query, "lloydslist.com"), snippet: "Carriers maintain Cape of Good Hope routing on select services." },
    ]);
  }
  if (/supplier|manufactur|factory|bankrupt|strike|pmi/.test(q)) {
    return pick([
      { title: "China Caixin manufacturing PMI signals modest expansion", url: host(query, "tradingeconomics.com"), snippet: "PMI at 50.8; new export orders mixed amid uneven global demand." },
      { title: "Guangdong factories report stable order books", url: host(query, "scmp.com"), snippet: "Consumer-goods manufacturers see steady but cautious Q3 outlook." },
    ]);
  }
  return pick([
    { title: `Logistics intelligence: ${query}`, url: host(query, "supplychaindive.com"), snippet: "Latest developments relevant to global supply chains and shipping." },
    { title: `Market brief: ${query}`, url: host(query, "splash247.com"), snippet: "Industry coverage of conditions affecting freight and trade flows." },
  ]);
}
