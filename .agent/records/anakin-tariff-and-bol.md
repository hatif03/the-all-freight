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
