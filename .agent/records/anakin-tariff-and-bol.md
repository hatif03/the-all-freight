# ADR: Anakin integrations for live tariff fetch and BoL fallback lookup

## Context

Two data paths in the ops room were CSV-only:

- Carrier demurrage/detention tariffs (`backend/tariff_loader.py` loads a
  manually curated CSV into `TariffRate`).
- Bill-of-lading / importer records (`backend/bol_loader.py` loads a CSV
  export into `BolRecord` / `BolLaneImporterIndex`).

Both are read-only, real-data-only paths (no fabricated tariffs, no
fabricated importers) — any new live-fetch path has to preserve that
constraint exactly, including labeling anything it can't verify as
`inferred`, matching how `cost.py` already returns `available: False` rather
than guessing a number.

## Decision

Added `backend/anakin_client.py`: a thin `httpx.AsyncClient` wrapper
(`X-API-Key` auth, base URL `https://api.anakin.io/v1`) with a sync-inline
`scrape_url(url, output_schema, prompt=...)` call (`POST /url-scraper/scrape`)
and two Wire catalog calls (`GET /wire/catalog`, `GET /wire/resolve`). The
sync inline scrape variant was chosen over the async-job variant because both
new call sites are either a scheduled/CLI-triggered refresh
(`tariff_fetcher.py`) or a fallback invoked inline during incident processing
(`bol_live_lookup.py`) — neither needs job polling.

**Tariff fetch** (`backend/tariff_fetcher.py`): scrapes the already-cited
Maersk US-import tariff page with an `outputSchema` for
`{carrier, port, equipment, per_day_rate, free_days, tier}` rows, then calls
a new shared `upsert_tariff_rows(session, rows, default_source_url)` helper
extracted from `tariff_loader.py`'s CSV path — the CLI CSV loader
(`load_tariff_csv`) and the live-fetch path both call it now, so the
dedupe-by-`(carrier, port, equipment, tier, source_url)` upsert logic exists
in exactly one place. Exposed both as a CLI script and as
`POST /admin/tariffs/refresh` on the FastAPI backend.

**BoL live lookup** (`backend/bol_live_lookup.py`):
`resolve_importers_live(vessel_name, voyage, port, date_range)` first checks
Anakin's Wire catalog for a bill-of-lading/import-records action (keyword
match on the action name), and only falls back to a URL-scraper call against
a public BoL/import search page if none exists. **What was actually found:**
this integration was built and verified for structural correctness (import
resolution, request shaping, schema validation) without a live
`ANAKIN_API_KEY` or network access in this environment, so Wire's catalog
contents could not be inspected directly. Given Wire's catalog is oriented
around common consumer/business site actions (travel, shopping, scheduling)
rather than niche customs-trade data, a dedicated BoL/import-records action
is unlikely to exist yet — the code path that checks for one is real and
will pick it up automatically if one appears, but the practical path today is
the scrape fallback. The fallback target
(`https://www.importgenius.com/search`, a public BoL search UI with a limited
free-preview tier) is a best-effort placeholder, not a verified integration —
whoever wires in a real `ANAKIN_API_KEY` should confirm it still returns
parseable results and swap it for a better source if not.

Every record `resolve_importers_live()` returns is labeled `inferred=True`
regardless of source. Wired into `affected_party_resolver.py` as a fallback
via a new `_finalize()` step, called *only* when both existing local-DB
paths (`BolRecord` direct match, `BolLaneImporterIndex` lane-pattern match)
returned nothing — never ahead of them. If Anakin is unconfigured, the Wire
action lookup errors, or the scrape yields nothing schema-shaped, the
function returns an empty list rather than a fabricated record — this is the
explicitly-sanctioned outcome when no real match exists, not a bug to
paper over.

## Consequences

- `ANAKIN_API_KEY` unset is a fully supported, silent no-op for both
  integrations (matches the existing "mock fallback" convention in
  `src/lib/anakin.ts` on the planning-flow side).
- The tariff-fetch and BoL-lookup code paths are structurally complete and
  covered by import/compile checks, but **not** exercised against the real
  Anakin API or the real ImportGenius page in this change — that's the one
  piece of this work that needs a live credential to actually validate.
- `backend/pyproject.toml` gained `httpx` (previously only used by
  `ais_ingestion.py`'s WebSocket dependency chain, not declared directly)
  and `openai` (already imported by `classifier.py` but was missing from
  backend's own dependency list — a pre-existing gap, fixed while making
  this change importable end-to-end).

## Update — verified against the live API (2026-09-10)

The open question above ("needs a live credential to actually validate") has
now been closed by testing every call against `api.anakin.io`. Three of the
assumptions in the Decision section were wrong, and each failed silently:

1. **`scrape_url` never enabled AI extraction.** `generateJson` gates it and
   defaults to false, so the response carried `markdown`/`html` but no
   `generatedJson` at all. The payload also nests results under
   `generatedJson.data`, while both callers read `result["rows"]` /
   `result["records"]` directly. Now sent and unwrapped once in the client.
2. **The cited Maersk tariff URL had rotted to a 404.** Since a missing page
   yields zero rows rather than an error, `tariff_rates` simply stayed empty
   and every negotiating agent reported "no published tariff on file" — the
   demurrage grounding the ops room is built around had never once worked.
   Replaced with a candidate list of published carrier tariff documents, tried
   in order. The current Maersk US-import tariff PDF yields **145 rate rows,
   109 with a non-zero per-day rate**, extracted straight from the PDF.
3. **Wire cannot serve this domain, and the reasoning about why was
   optimistic in the wrong direction.** `GET /wire/catalog` *ignores* its
   `query` parameter and returns the full ~940-site catalog (it opens with a
   recipe blog). There is no bill-of-lading, customs or trade-data action, so
   the keyword-match branch could never fire — it wasn't "unlikely to match
   yet", it was unreachable by construction. **Decision reversed: the Wire
   path is removed**, along with `wire_catalog`/`wire_resolve` from the
   client. `resolve_importers_live()` now goes straight to the scrape, with
   its query string properly URL-encoded (it was previously interpolated raw,
   so any vessel name with a space produced a malformed URL).

The inline-over-async-job choice in the Decision section still holds, but with
a caveat: large tariff PDFs exceed the inline window and return `processing`
plus a job id, so the client now polls in that case.

What did not change: the no-fabricated-data constraint. Every record from
`resolve_importers_live()` is still `inferred=True`, and every path still
returns empty rather than inventing a plausible row.
