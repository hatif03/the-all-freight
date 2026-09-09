# ADR: Self-hosted room bus instead of a third-party coordination SaaS

## Context

The reference system this was ported from coordinated its 7 agents through a
hosted agent-collaboration SaaS: a thin wrapper (`band_lib`) exposed
`create_room`, `recruit`, `send` (with `@mentions`), `get_context`, wired to a
per-agent-process WebSocket, with the SaaS's own room history as the system
of record for the audit dossier. Every agent required its own external
agent id + API key issued by that platform.

This product already depends on Postgres (Neon, via SQLAlchemy async) and
Redis (Upstash) for everything else — the AIS ingestion pipeline, the
disruption detector, and the dashboard's existing `room_events` Redis-pub/sub
→ WebSocket relay. Requiring a *third* piece of coordination infrastructure,
with its own credential model, for what is fundamentally "durable message
log + real-time fanout" duplicates capability the stack already has.

## Decision

Replace the SaaS with a self-hosted room bus (`agents/room_bus/`):

- **Durable log:** a new `RoomMessage` table (`id`, `room_id`, `sender_role`,
  `text`, `mentions: JSON list[str]`, `created_at`), added via Alembic
  migration `20260909_0002_room_messages`.
- **Real-time fanout:** Redis pub/sub on a new `room_messages` channel,
  published alongside (not replacing) the existing `room_events` channel
  that `backend/main.py`'s `redis_broadcast_listener` already relays to the
  dashboard WebSocket. The two channels serve different audiences: agents
  react to `room_messages` (mention-gated), the dashboard displays whatever
  gets explicitly published to `room_events`.
- **Room identity:** one room per incident, and the room id *is* the
  incident id — no separate room-provisioning step or external room id.
  This was already implicit in the schema (`Participant.room_id`,
  `RecoveryOption.room_id`, `Vote.room_id`, ... are all FKs to
  `incidents.id`); the SaaS's `Incident.band_room_id` was the *only*
  room-scoped column that didn't already follow this pattern. Rather than
  rename it to a provider-agnostic `room_id` and carry a column that always
  equals `Incident.id`, it's dropped outright — `create_room()` becomes an
  existence check that returns the incident id unchanged.
- **Wake-on-mention:** `room_bus.subscribe(role, on_message)` is a small
  asyncio loop each agent process runs, filtering the shared channel to
  messages that mention its `role` (or `"all"`) — the same wake-on-@mention
  behavior the SaaS's per-agent adapters used to gate on, just read off a
  shared bus instead of a private socket. The Sentinel coordinator passes
  `role=None` to see every message unfiltered, since it needs to tally
  options and drive phase transitions regardless of who a message was
  addressed to (it already worked this way against the SaaS, whose raw
  message callback wasn't mention-filtered).

Each agent's actual business logic — the LangGraph node, the PydanticAI
calls, the cost annotation, the dissent generation, the quorum tally — was
preserved essentially verbatim; only the transport underneath a room
changed. One further simplification fell out of removing the SaaS: the
per-role external agent id / API key / handle resolution in the old
`registry.py` (with its Day-1-credential fallback chains and a live
`/agent/me` heartbeat) is gone. A role is now just a name every process
already knows about — `registry.py` is a static `{role: display_name}` dict.

## Consequences

- One fewer external dependency, one fewer credential type to provision.
- The message log is a normal table: it's queryable with SQL, and the
  Carrier agent's `get_context()` call is a plain ordered `SELECT` instead of
  a remote API round-trip.
- Cross-process real-time delivery now depends on Redis being reachable *for
  pub/sub specifically* (not just for the dashboard relay) — if Redis is down,
  agents stop reacting to new messages entirely (they'd previously have lost
  only the dashboard's live feed, not agent coordination itself, since that
  ran over the SaaS's own WebSocket). This mirrors the reliability model the
  Sentinel's own `disruptions`/`decisions` Redis listeners already had.
- `subscribe()`'s per-message dict payload replaces the SaaS's rich
  event/message object shapes; every agent's on-message handler is
  correspondingly simpler (no more `hasattr(event, "msg")` duck-typing
  branches for different event shapes).
