# Maximize Anakin, unify the two halves into one product

## Why

Being submitted to the Anakin Forge hackathon. Three things are wrong or missing:

1. **The Anakin integration is broken and the app has never run on live data.** Verified live
   against `api.anakin.io`:
   - `src/lib/anakin.ts` posts `{query}` to `/v1/search`; the API requires `prompt` → HTTP 400
     `"Prompt is required"` on all ~30 searches per analysis, silently falling back to
     `mockSearch()` and its fabricated, non-resolving URLs.
   - `service/backend/anakin_client.py` omits `generateJson: true`, and
     `tariff_fetcher.py` reads `result["rows"]` instead of `result["generatedJson"]["data"]`.
     So `tariff_rates` is always empty and every ops agent reports "no published tariff on
     file" — the demurrage grounding that the ops room is built around has never worked.
   - `/v1/wire/catalog` ignores its `query` param and lists 940+ consumer sites (it opens with
     a recipe blog). There is no bill-of-lading action, so the Wire path in
     `bol_live_lookup.py` is dead by construction.
   - Unused capabilities that fit this product: structured extraction (`generateJson` +
     `outputSchema`), `/url-scraper/batch`, `/agentic-search`, and `/monitors` (scheduled
     page-change monitoring with webhooks).

2. **`/` and `/ops` still feel like two apps.** A previous pass unified the visuals and it
   wasn't enough — they share zero state. An analysis lives in `useState` and dies on refresh;
   `/ops` shows a global incident unrelated to anything the user planned.

3. **No explainer doc, no in-app guidance, no recent production deploy.**

## What changes

**Phase 1 — Anakin.** Fix the search param, the `generateJson` flag and the `generatedJson.data`
read path. Drop the dead Wire path. Stop presenting synthetic URLs as citations. Add
`anakinExtract`/`anakinExtractBatch`. Ground the three pipeline stages that have no web
grounding at all (route costs, driver prices, tariff documents). Add an agentic-search deep
research panel. Build the monitors subsystem: `anakin_monitors` + `monitor_signals` tables, a
per-lane monitor creator, and an HMAC-verified `POST /webhooks/anakin/monitor` receiver.
Monitor signals are their own class of evidence — they never become `DisruptionEvent` rows,
which require a real vessel MMSI.

**Phase 2 — Tracked shipments as the spine.** `TrackedShipment` (summary columns + the full
`AnalysisResult` as JSON) and `ShipmentIncidentLink` (with an `inferred`/`basis` pair, matching
the existing `AffectedParty` convention). Port matching resolves curated aliases **once at
track time** and persists the reason; incident-time matching is exact `port_code` equality, so
no fuzziness ever runs against a live incident. New IA: `/` watchlist, `/plan`,
`/shipments/[id]`, `/ops` index, `/ops/[id]` room. `Dashboard.tsx` keeps its
`{ result: AnalysisResult }` signature so it serves both a fresh analysis and a rehydrated one.

**Phase 3 — UI, motion, guidance.** Extract shared primitives into `src/components/ui.tsx`.
Collapse the vestigial `--ops-*` token namespace so both halves are literally the same
components. Fix the `/ops` empty state (one line — `|| "detected"` — is what fakes an incident),
the 100ms cost ticker that re-renders the whole page 10×/s, the uncapped reconnect loop, and the
two `alert()` calls. Add a motion system on the already-installed-but-unused framer-motion,
with `prefers-reduced-motion` handled globally. Reorder the dashboard decision-first. Add a
hand-rolled first-run tour and `/how-it-works`.

**Phase 4 — Docs and deploy.** `docs/PRODUCT.md` (problem, who hurts, use case, Anakin's role
at each step), ADRs for the pivots, then Vercel + the GCE VM (including `alembic upgrade head`
for the new tables).

## Not doing

Auth/per-user watchlists, normalizing `AnalysisResult`, real historical price series, dark mode,
route transitions, a toast system, `/shipments/{id}/ops`, and LLM or geographic port matching
(the fabrication vector). Full reasoning in the approved plan.
