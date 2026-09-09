# Live end-to-end test of the full stack, and two bugs found + fixed

Ran the entire system for real: Docker Postgres/Redis, FastAPI backend, AIS detector,
all 7 agent processes, and the Next.js app, then fired a simulated disruption through
the whole pipeline and exercised the human decision endpoint.

## Two real bugs found (pre-existing, not introduced by the earlier port) and fixed

1. **`uv` workspace glob breaks on `agents/__pycache__/`.** Every agent imports sibling
   modules (`protocol`, `registry`, `room_bus`) as top-level scripts via `PYTHONPATH`,
   so Python caches their bytecode in `agents/__pycache__/` — which matches the
   `agents/*` workspace-members glob in `service/pyproject.toml` and breaks every
   subsequent `uv run` in the workspace ("missing a pyproject.toml") until the
   directory is manually removed. Fixed with `[tool.uv.workspace] exclude =
   ["agents/__pycache__"]`; verified by creating the directory and confirming `uv run`
   still resolves.
2. **Carrier was recruited into every room but never `@mentioned`.** `agents/sentinel/main.py`
   recruits all 5 negotiating roles including `carrier`, but the only message that
   actually gets sent (`agents/logistics/main.py`) mentioned `finance` only — so
   Carrier's PydanticAI counter-position never ran in the live flow; Carrier only ever
   got a synthetic vote from Sentinel's scoring heuristic. Confirmed this was already
   true in the reference project (grepped for any `@carrier` mention — none exist
   there either). Fixed by having Logistics mention both `finance` and `carrier` when
   posting an option, matching what the architecture docs/diagrams already describe
   ("Carrier counters on tariff terms").
3. **Decision phase computed twice, inconsistently.** `backend/main.py::record_decision`
   computes `new_phase` from `req.action.lower() == "approve"` (verb form) and writes
   it directly; it then published only the raw `action` to the `decisions` Redis
   channel. `agents/sentinel/main.py::listen_decisions` independently re-derived the
   phase from that same `action` value but checked for `"approved"` (adjective form)
   instead — so an `"approve"` action satisfied the REST endpoint's check but failed
   Sentinel's, and Sentinel's later write silently flipped an already-`approved`
   incident to `rejected`. Fixed by publishing the already-computed `new_phase` in the
   Redis payload and having Sentinel use it directly instead of re-deriving it.
   Reproduced live (API said `approved`, Sentinel's log said `rejected` for the same
   decision) and reverified clean after the fix (both agree: `approved`).

## What was verified live (not just imported/curled)

- Docker Postgres + Redis: healthy, Alembic migration chain applied against the real DB.
- FastAPI `/health`, `/incidents/active`, `/incidents/{id}`, `/incidents/{id}/decision`,
  `/incidents/{id}/dossier` all returned correct, non-fabricated data reflecting the
  actual pipeline run.
- WebSocket `/ws`: connects, replays the curated `demo_feed.json` transcript.
- Root Next.js app: both `/` and `/ops` render with correct content (a dev server from
  earlier in the session was already live and picked up all file changes via hot reload).
- Simulated disruption → Sentinel opens a room, resolves 0 affected parties (honest —
  no BoL data loaded), recruits all 5 negotiating agents, seeds context.
- **Gemini-routed agents (Logistics, Procurement, Customer-Impact)**: all three failed
  cleanly with `429 RESOURCE_EXHAUSTED` (the known billing block) and did **not** crash
  their process — each is still alive and subscribed, ready to work the moment the
  GCP project has credits.
- **K2-Think-routed agents (Carrier, Dissent)**: both fully verified working, live, with
  real model output — Dissent generated a specific, DB-grounded objection in ~1s;
  Carrier took ~40s (reasoning models are slow on a complex 6-field structured
  extraction with a long prompt) but correctly cited real FMC regulation (46 CFR part
  541) and declined to fabricate a cost figure.
- Quorum vote → Dissent → `awaiting_approval` → human decision → `approved`: full
  chain confirmed consistent end-to-end after the phase-race fix.
- A synthetic Logistics-shaped message was manually injected (via a throwaway script,
  not saved) to unblock testing Finance/Carrier/Dissent while Gemini was billing-blocked
  at the very first hop (Logistics) — this is a test artifact, not a code change.

## Known limitation

Because Gemini is billing-blocked, no *real* Logistics/Procurement/Customer-Impact
output was exercised in this session — only their clean-failure path. Re-run
`simulate_disruption.py` once Gemini credits are added to get a fully organic run.
