---
name: tracked-shipment-spine
description: Tracked shipments become the object that joins the planning flow and the ops room, with Anakin monitors watching each lane
---

# ADR: Tracked shipments as the product's spine

## Context

The app had two halves that shared no state. `/` ran the planning flow, whose
`AnalysisResult` lived entirely in React state and was destroyed on refresh.
`/ops` showed whatever single global incident was open, unrelated to anything the
user had planned. The only connections were a nav bar, a header dot for "any
incident anywhere", and one conditional CTA in the dashboard gated on a
hardcoded three-port keyword match.

A previous pass unified the two halves *visually* — shared header, shared
tokens, shared card conventions. The verdict after that pass was that it still
felt like two products with no flow between them, which was correct: the problem
was structural, not cosmetic. Nothing carried the user, or their shipment, from
one half to the other, because there was no object that existed in both.

Separately, the live-web layer had just been fixed (see the update in
`anakin-tariff-and-bol.md`), which made a continuous-monitoring story viable for
the first time — until then the tariff table had never actually populated.

## Decision

**A `TrackedShipment` row is the join.** Planning ends in "Track this shipment";
the watchlist becomes the home page; incidents and web signals attach to
shipments.

- **`TrackedShipment`** stores the summary columns anything lists or matches on,
  plus the entire `AnalysisResult` verbatim as JSON. Not normalised: the
  dashboard renders twelve panels off deeply nested fields, so normalising would
  mean ~8 tables and a reassembly layer whose only job is to reproduce an object
  we already have. `GET /shipments` never selects the blob.
- **`ShipmentIncidentLink`** rather than a FK on the incident, because an
  incident is discovered independently and matches 0..N shipments while a
  shipment accumulates incidents over time — and because the no-fabrication rule
  requires a per-attribution `basis` string, which a FK has nowhere to store.
  This mirrors the existing `AffectedParty` convention.
- **Port resolution happens once, at track time**, against a curated alias list
  in `ports.py`, persisting the matched alias and a human-readable basis.
  Incident-time matching is then exact `port_code` equality — no string
  comparison against a live incident, so every attribution is reproducible.
  Explicitly rejected: similarity scoring, geographic proximity, and asking an
  LLM whether two port names mean the same place.
- **Anakin `/v1/monitors`** watches each tracked lane's port advisories, carrier
  tariff and the FMC billing rule. Monitors are keyed by URL, not by shipment,
  so cost scales with distinct pages rather than with shipments, and a monitor
  is deregistered when the last interested shipment goes.
- **A page change never becomes a `DisruptionEvent`.** That table requires a
  real vessel MMSI, so recording a tariff edit as one would fabricate a vessel
  disruption. Monitor signals are their own class of evidence
  (`monitor_signals`) and are surfaced as web signals.
- **Routing** became `/` watchlist, `/plan`, `/shipments/[id]`, `/ops` index,
  `/ops/[id]` room. `/shipments/{id}/ops` deliberately does not exist: the
  console is built around exactly one incident snapshot, incidents are genuinely
  global objects, and `Incident.id` doubling as the room id is load-bearing for
  six tables.
- **`Dashboard` keeps its `{ result: AnalysisResult }` signature**, serving both
  a fresh SSE result and a rehydrated one.

`Incident.id` remains the room id. No change to the room-bus invariant.

## Consequences

- Two new migrations (`20260910_0003`, `20260910_0004`) and a backend redeploy,
  including `alembic upgrade head` on the VM.
- New env var `PUBLIC_BASE_URL` on the service: the HTTPS origin used to
  register monitor webhooks. Left unset locally, where Anakin cannot reach a
  loopback address — monitors still register, just without a webhook.
- The webhook endpoint is public, so HMAC verification against the per-monitor
  secret is the only thing separating a real delivery from anyone posting at it.
  A recorded-then-failed-to-publish delivery must still return 2xx or Anakin
  redelivers and duplicates the row.
- **No accounts.** The watchlist is one shared workspace, and the UI says so.
  This is a deliberate trade: a reviewer landing on a cold browser sees a
  populated watchlist with real linked incidents. The upgrade path is one
  indexed `workspace` column plus one filter.
- Most tracked lanes will resolve to no monitored port, and the UI has to keep
  saying so plainly rather than implying surveillance that isn't happening.
- Monitors cost credits per check. The guardrails are URL-keyed dedupe,
  6h/24h intervals rather than the 15-minute floor, and deregistration on
  untrack. If the key is ever drained mid-demo, look here first.
