# ADR: Anakin as the live-web search/scrape provider

## Context

The planning flow needs live, cited web search (freight rates, port congestion, tariffs,
weather, supplier health) and single-page scraping to ground the LLM agents' risk
assessments in current information, with a demo-safe fallback when no key is configured.
The prior implementation approach spawned a third-party MCP server as a stdio subprocess
(`@modelcontextprotocol/sdk` + a scraping MCP package), which adds a subprocess lifecycle,
a cold-start `npx` download, and an extra dependency surface for something that is,
functionally, two HTTP endpoints.

## Decision

Replace the MCP subprocess integration with a plain REST client (`src/lib/anakin.ts`)
against Anakin's API:

- `anakinSearch(query, limit)` — `POST /v1/search`, synchronous AI web search with
  citations, parsed defensively (multiple possible response-shape keys/field names)
  since the exact schema isn't guaranteed; falls back to a hardcoded mock dataset on
  any error, timeout (18s), or empty parse — never throws.
- `anakinScrape(url)` — `POST /v1/url-scraper/scrape`, synchronous mode, 45s timeout,
  returns `""` on failure — never throws.
- `anakinMode()` / `SearchLogEntry` / `resetSearchLog()` / `getSearchLog()` — same shape
  as before, so the dashboard's transparency panel and live/mock badge need no changes.

Auth is a single `X-API-Key` header from `ANAKIN_API_KEY`. No subprocess, no SDK
dependency, no job/poll cycle.

## Consequences

- Removed `@brightdata/mcp` and `@modelcontextprotocol/sdk` from `package.json` and the
  Dockerfile's global pre-install step — smaller image, no `npx` cold start on first
  request.
- `agents.ts` and `orchestrator.ts` import `anakinSearch` / `anakinScrape` / `anakinMode`
  instead of the MCP-backed equivalents; call sites are a 1:1 rename, no logic changes.
- Response-shape parsing is defensive/best-effort since Anakin's exact JSON schema for
  `/v1/search` wasn't fully available at implementation time; if live traffic reveals a
  stable schema, `parseSources` in `anakin.ts` can be tightened to it.
- The mock fallback dataset is unchanged in content, so the app still demos fully offline
  with no API key.
