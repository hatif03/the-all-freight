# Plan: port the ops room to `service/`

Status: done.

## What's changing

Port the reference `freight-room-main/` Python system into a brand-new
`service/` directory at the repo root, dropping its third-party
agent-coordination SaaS in favor of a self-hosted Postgres+Redis room bus,
and adding two new Anakin integrations (live tariff fetch, live BoL fallback
lookup).

## Approach

1. Read the reference's `backend/` (database/redis/models/events conventions)
   and each agent's `main.py` closely before writing anything, so the new
   room bus and rewired agents match existing conventions instead of
   guessing.
2. Copy forward, file-by-file, everything whose *business logic* doesn't
   change: most of `backend/`, the five built negotiating agents'
   `main.py`, `protocol.py`, the procurement stub, infra scripts, data/
   structure. Skip the two Day-1 prototype agent dirs and the disabled CI
   workflow.
3. Replace the coordination layer: new `agents/room_bus/` (Postgres
   `RoomMessage` table + Redis `room_messages` pub/sub channel) implementing
   `create_room` / `recruit` / `send` / `get_context`, plus a `subscribe()`
   helper each agent's asyncio loop uses instead of a WebSocket adapter.
4. Rewire each agent's `main.py`: drop the SaaS adapter subclass + WebSocket
   wiring, keep the actual LLM/framework call logic (LangGraph node,
   PydanticAI agent, cost annotation, dissent generation, quorum tally)
   essentially verbatim.
5. Simplify `registry.py` to a static role dict (no more external
   credentials/heartbeat/peer discovery) and move the per-role model router
   out of the now-deleted `band_lib/` into `agents/model_router.py`.
6. Add the two new Anakin integrations (`anakin_client.py`,
   `tariff_fetcher.py`, `bol_live_lookup.py`), extracting a shared
   `upsert_tariff_rows()` helper so the CSV and live-fetch tariff paths don't
   duplicate upsert/dedup logic.
7. Drop the SaaS dependency and every `THENVOI_*`/`BAND_*` env var; add
   `ANAKIN_API_KEY`.
8. Verify: `uv sync`/`uv lock` clean in both the root agents workspace and
   `backend/`, every module and agent entry point actually imports, the
   Alembic migration chain resolves, and a repo-wide grep for the dropped
   SaaS/prior-project names returns nothing.

## Key design call

`Incident.band_room_id` (the SaaS's external room id) is dropped rather than
renamed — every other room-scoped table (`Participant.room_id`,
`RecoveryOption.room_id`, ...) already treats `room_id` as `incidents.id`, so
keeping a second column that always equals `Incident.id` would just be dead
weight. See `.agent/records/self-hosted-room-bus.md` for the full ADR.
