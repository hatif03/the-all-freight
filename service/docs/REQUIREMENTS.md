# Requirements & Constraints — Ops Room

Requirements/constraints reference for the ops room half of The All Freight:
a Sentinel agent watches a live AIS vessel feed, detects disruptions, opens a
room, recruits framework-heterogeneous agents to negotiate a demurrage/
detention recovery option, runs a quorum vote with an adversarial dissent
check, and puts the result in front of a human for approve/reject, producing
an audit dossier.

## 1. Scope

When a shipping disruption occurs (a vessel anchors/waits outside a congested
port, or its ETA slips past a threshold), the ops room:

1. **Detects** the event from a live AIS vessel-position feed.
2. **Identifies** which cargo and importers are affected, using public U.S.
   customs bill-of-lading records.
3. **Opens a room** scoped to that incident and **recruits at runtime** only
   the agents relevant to the affected parties (logistics, carrier,
   finance, procurement, customer-impact).
4. Lets those agents **negotiate a recovery plan** — sharing structured
   context, proposing options with real demurrage/detention cost figures
   drawn from published carrier tariffs, and resolving a carrier-vs-shipper
   charge dispute.
5. Runs a **quorum vote with a dedicated dissent check** before surfacing a
   recommendation.
6. Presents the recommendation to a **human operator for approval**.
7. Exports a **decision record / audit dossier** compiled from the room's
   message history.

**In scope:** the end-to-end flow above for a handful of monitored ports and
a bounded set of carriers, driven by real data.

**Out of scope:** write-back into real carrier/ERP systems; booking or paying
real charges; multi-tenant production hardening; predictive ETA modeling
beyond AIS-derived slippage.

## 2. Definitions

| Term | Meaning |
|---|---|
| **Room** | One disruption incident's coordination space. Self-hosted: Postgres for the durable message log, Redis pub/sub for real-time fanout (see `agents/room_bus/`) — there's no external identity, the room id is the incident id. |
| **Recruitment** | Adding a participant agent to a room at runtime (`room_bus.recruit`), idempotent by role. |
| **AIS** | Automatic Identification System — vessels broadcast position/identity; received via aisstream.io. |
| **MMSI** | Maritime Mobile Service Identity — unique vessel radio id. |
| **BoL** | Bill of Lading; U.S. inbound ocean BoLs are public record (19 CFR §103.31). |
| **D&D** | Demurrage & Detention — per-day charges for cargo/containers dwelling beyond free time. |
| **FMC** | U.S. Federal Maritime Commission — regulates ocean shipping, incl. D&D invoicing rules (OSRA). |
| **Quorum** | The minimum set of agent votes required to form a recommendation. |
| **Dissent agent** | An agent whose sole job is to attack the leading proposal before a human sees it. |
| **HITL** | Human-in-the-loop (the operator approval gate). |
| **Sentinel** | The always-on monitoring/coordinating agent that detects disruptions and opens rooms. |

## 3. Architecture

- **Data ingestion & detection** (`backend/ais_ingestion.py`, `backend/detector.py`): a persistent AIS WebSocket, normalized into Postgres, checked against anchorage-dwell and ETA-slip rules.
- **Affected-party resolution** (`backend/affected_party_resolver.py`): maps a disrupted vessel/voyage to real importers from loaded public BoL records, with a live Anakin-backed fallback when the local DB has no match (`backend/bol_live_lookup.py`) — always labeled inferred.
- **Tariff / cost engine** (`backend/cost.py`, `backend/tariff_loader.py`, `backend/tariff_fetcher.py`): computes D&D exposure from tariff rows loaded either from a CSV or a live Anakin fetch of a published carrier tariff page — both paths share one upsert helper.
- **Room bus** (`agents/room_bus/`): the self-hosted coordination layer — see `README`/ADR `self-hosted-room-bus.md` for the Postgres+Redis design.
- **Agent cast**: Sentinel (coordinator), Logistics (LangGraph), Carrier (PydanticAI), Finance, Customer-Impact, Dissent, and Procurement (CrewAI) — three distinct agent frameworks.
- **Backend API** (`backend/main.py`): FastAPI + Postgres + a Redis-relay WebSocket for the dashboard.

## 4. Constraints

- **C1 — No fabricated data (hard).** No fabricated vessels, importers, shipments, tariffs, or costs. Every datum is either live from aisstream.io, a real public customs BoL record, a published carrier tariff value, or a real-historical replay clearly labeled as such. Any inferred field (e.g. a pre-arrival importer mapping, or a live BoL/tariff lookup) is explicitly labeled as inference, never presented as fact.
- **C2 — At least 3 agents must collaborate through the room bus**, and the room bus must be the active collaboration layer (not a notifier or output sink).
- **C3 — Cross-framework:** at least three distinct agent frameworks represented (LangGraph, PydanticAI, plain OpenAI-SDK clients, and a CrewAI slot).
- **C4 — Read-only against the outside world.** No real bookings, no real money, no writes to carrier/customs systems. Recovery "actions" are recommendations and internal state changes only.
- **C5 — Source ToS compliance.** Respect aisstream.io connection-health limits; prefer bulk/FOIA-sourced BoL data over scraping a paywalled search UI; cache tariff values fetched from public carrier pages.

## 5. Functional requirements

Priority: **M** = must, **S** = should, **C** = could.

### 5.1 Data ingestion & detection
- **FR-1 (M):** Maintain a persistent AIS WebSocket filtered to configured ports' bounding boxes, reconnecting automatically on drop.
- **FR-2 (M):** Persist normalized vessel position reports and voyage data to Postgres.
- **FR-3 (M):** Raise a `DisruptionEvent` on anchorage dwell or ETA slippage past a configurable threshold.
- **FR-4 (M):** Every `DisruptionEvent` carries vessel identity, port, type, detection timestamp, and a severity score.
- **FR-5 (S):** Support a real-historical replay mode that re-streams a previously captured AIS window, clearly labeled "historical replay," for deterministic demos.
- **FR-6 (M):** Never generate synthetic vessels or events (C1).

### 5.2 Affected-party resolution
- **FR-7 (M):** On a `DisruptionEvent`, identify affected importers/cargo using real public BoL records.
- **FR-8 (M):** Any pre-arrival association derived from historical lane patterns, or from a live lookup, is flagged `inferred=true` with its basis recorded.

### 5.3 Cost / tariff engine
- **FR-9 (M):** Compute D&D exposure using published carrier tariff values (per-day rates, free-time, tiered escalation).
- **FR-10 (M):** All cost figures are traceable to a cited tariff source and capture time — no fabricated rates.

### 5.4 Room orchestration
- **FR-11 (M):** The Sentinel opens a new room per incident.
- **FR-12 (M):** The Sentinel recruits at runtime only the agents relevant to the affected parties — the recruited set varies with incident content.
- **FR-13 (M):** The Sentinel seeds the room with structured incident context (vessel, port, affected parties, baseline exposure).
- **FR-14 (M):** At least 3 agents across ≥3 frameworks actively exchange messages in the room.

### 5.5 Negotiation
- **FR-15 (M):** Agents coordinate via structured messages with explicit @mentions.
- **FR-16 (M):** Logistics produces ≥1 concrete recovery option; Finance annotates every option with real cost impact; Customer-Impact attaches downstream SLA/order impact.
- **FR-17 (M):** Negotiation is constraint-driven (options carry typed fields: feasibility, ETA delta, cost delta, risk), not free-form chat.
- **FR-18 (S):** The Carrier agent negotiates a D&D charge dispute against the shipper-side agents using tariff/FMC grounding.

### 5.6 Quorum, dissent & decision
- **FR-19 (M):** Tally votes from the participating agents and compute a recommendation.
- **FR-20 (M):** A Dissent agent (a distinct model) attempts to refute the leading recommendation; its objection (or explicit absence of one) is recorded.
- **FR-21 (S):** A material dissent flags the recommendation "contested," requiring explicit human acknowledgment.

### 5.7 Human-in-the-loop
- **FR-22 (M):** Present the recommended plan with full provenance.
- **FR-23 (M):** The operator can Approve or Reject, written back into the room and reflected in incident phase.

### 5.8 Audit & reporting
- **FR-24 (M):** Compile a decision dossier from the room history: timeline, participants, options, costs (cited), votes, recorded dissent, human decision, timestamps.
- **FR-25 (M):** Export the dossier as HTML (print-to-PDF) and JSON, labeling every figure's provenance.

## 6. Data entities (logical)

- **Vessel**, **PositionReport**, **DisruptionEvent**, **AffectedParty** (with `inferred: bool`).
- **TariffRate** (carrier, port, equipment, per_day_rate, free_days, tier, source_url).
- **Incident** (id, event_id, phase, created_at) — the room id *is* `Incident.id`.
- **Participant** (room_id, agent_id, role, framework, status).
- **RoomMessage** (room_id, sender_role, text, mentions, created_at) — the room bus's durable log.
- **RecoveryOption**, **Vote**, **Dissent**, **Decision**, **Dossier**.

## 7. Non-functional requirements

- **Performance:** disruption detection to room creation ≤10s; end-to-end negotiation to recommendation ≤120s for the reference scenario; dashboard reflects room messages with ≤1s perceived latency.
- **Reliability:** auto-reconnect for AIS and Redis; no loss of persisted position reports across reconnect.
- **Security:** secrets in env/secret store, never committed; only public/real data ingested; approval actions attributable to the acting human.
- **Auditability:** every recommendation is fully reconstructable from the room's message log; every monetary figure cites a real tariff source and capture time.
- **Observability:** structured logs for ingestion, detection, recruitment, votes, and human decisions, correlated by incident id.

## 8. Use cases

- **UC-1 — Live congestion disruption → negotiated recovery (primary).** Detect → resolve affected importers → open room + recruit → negotiate options with real costs → quorum + dissent → human approves → dossier exported.
- **UC-2 — Carrier-vs-shipper D&D dispute** (sub-flow of UC-1): the Carrier agent asserts charges per published tariff; shipper-side agents contest using FMC rules; converges to a recorded settlement position.
- **UC-3 — Historical-replay demo.** Replay a labeled real-historical AIS window to deterministically reproduce a disruption.
- **UC-4 — Audit review.** A reviewer opens the dossier and traces every option, cost, vote, dissent, and the human decision back to source.
