// Web-search / scrape integration layer.
//
// Primary path: Anakin's REST API — a synchronous AI web search with citations
// (`/v1/search`) and a synchronous URL scraper (`/v1/url-scraper/scrape`). Both are
// plain `fetch` calls, no subprocess, no job/poll cycle.
//
// Fallback path: if no API key is configured, the request errors, times out, or the
// response can't be parsed into usable sources, we degrade gracefully to realistic
// synthetic results so the demo never breaks on stage. `dataMode` in the final result
// reflects which path was used.

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

/** Scrape a single URL to markdown/text via Anakin's synchronous URL scraper. */
export async function anakinScrape(url: string): Promise<string> {
  if (!API_KEY) return "";
  try {
    const res = await withTimeout(
      fetch(`${API_BASE}/url-scraper/scrape`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ url }),
      }),
      45_000,
    );
    if (!res.ok) {
      console.error(`[anakin] scrape "${url}" failed: HTTP ${res.status}`);
      return "";
    }
    const data = await res.json();
    const text: unknown = data?.markdown ?? data?.content ?? data?.text ?? "";
    if (typeof text === "string" && text) {
      liveUsed = true;
      return text;
    }
    return "";
  } catch (err) {
    console.error(`[anakin] scrape "${url}" failed:`, err);
    return "";
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
