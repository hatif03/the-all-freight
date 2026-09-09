"""Persistent demo showcase incident.

Creates ONE always-available, fully-populated incident so the dashboard looks
complete without needing a live agent run. It's grounded in real data on the
only fully-coherent lane we have: MAERSK DAMIETTA / Los Angeles → real importer
KUEHNE + NAGEL (from a real public bill of lading) and real D&D costs computed
from the loaded Maersk US-import tariff. Agent rationales are illustrative
(model-style) text; every dollar figure is from the real tariff.

Idempotent: re-running replaces the existing showcase incident (identified by
its DisruptionEvent.source == "demo_showcase" marker, since there's no
separate external room id to key off of — the room bus uses the incident id
itself, see agents/room_bus).

    cd backend && uv run python seed_demo.py          # (re)create the showcase incident
    cd backend && uv run python seed_demo.py --clear  # remove it

Also writes backend/demo_feed.json — the room transcript the backend replays
to the dashboard feed on each WebSocket connect (so the feed is populated too).
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
from pathlib import Path

from sqlalchemy import delete, select, update

from cost import compute_dd_exposure
from database import SessionLocal
from affected_party_resolver import resolve_affected_parties
from models import (
    AffectedParty, Decision, DisruptionEvent, Dissent, Dossier, Incident,
    Participant, RecoveryOption, Vessel, Vote, utcnow,
)

DEMO_SOURCE = "demo_showcase"             # marker used to find the showcase incident idempotently
DEMO_MMSI = 220478000                    # MAERSK DAMIETTA (Denmark-flag format)
VESSEL = "MAERSK DAMIETTA"
PORT = "Los Angeles"
FEED_PATH = Path(__file__).resolve().parent / "demo_feed.json"

# 7-agent cast (matches registry roles + frameworks)
CAST = [
    ("sentinel", "LangGraph"), ("logistics", "LangGraph"), ("carrier", "PydanticAI"),
    ("finance", "PydanticAI"), ("procurement", "CrewAI"), ("customer_impact", "PydanticAI"),
    ("dissent", "PydanticAI"),
]


async def clear(session) -> None:
    stmt = (
        select(Incident)
        .join(DisruptionEvent, Incident.event_id == DisruptionEvent.id)
        .where(DisruptionEvent.source == DEMO_SOURCE)
    )
    inc = (await session.execute(stmt)).scalar_one_or_none()
    if not inc:
        return
    for model in (Vote, Dissent, Decision, Dossier, RecoveryOption, Participant):
        await session.execute(delete(model).where(model.room_id == inc.id))
    if inc.event_id:
        await session.execute(delete(AffectedParty).where(AffectedParty.event_id == inc.event_id))
    await session.execute(delete(Incident).where(Incident.id == inc.id))
    if inc.event_id:
        await session.execute(delete(DisruptionEvent).where(DisruptionEvent.id == inc.event_id))
    await session.commit()


async def seed() -> None:
    async with SessionLocal() as session:
        await clear(session)
        now = utcnow()
        detected = now - dt.timedelta(minutes=47)

        # Vessel (real ship + name; placed in the real San Pedro Bay anchorage polygon)
        vessel = (await session.execute(select(Vessel).where(Vessel.mmsi == DEMO_MMSI))).scalar_one_or_none()
        if not vessel:
            vessel = Vessel(mmsi=DEMO_MMSI)
            session.add(vessel)
        vessel.name = VESSEL
        vessel.type = "Container Ship"
        vessel.last_lat, vessel.last_lon, vessel.last_sog = 33.68, -118.20, 0.1
        vessel.last_nav_status = "at anchor"
        vessel.destination = "Los Angeles"
        vessel.source = "demo_showcase"
        await session.commit()

        event = DisruptionEvent(
            mmsi=DEMO_MMSI, port=PORT, type="anchorage_dwell", severity="High",
            detected_at=detected, source="demo_showcase",
            basis=f"{VESSEL} at anchor in the San Pedro Bay anchorage for 47 min awaiting a berth at {PORT}.",
        )
        session.add(event)
        await session.commit()
        await session.refresh(event)

        # Real affected importer from the loaded public BoL (KUEHNE + NAGEL)
        parties = await resolve_affected_parties(session, vessel=VESSEL, arrival_port=PORT)
        for p in parties:
            session.add(AffectedParty(
                event_id=event.id, importer_name=p.importer_name, cargo_desc=p.cargo_desc,
                bol_ref=p.bol_ref, inferred=p.inferred, basis=p.basis, source=p.source, source_url=p.source_url,
            ))
        await session.commit()

        incident = Incident(event_id=event.id, phase="awaiting_approval")
        session.add(incident)
        await session.commit()
        await session.refresh(incident)

        for role, fw in CAST:
            session.add(Participant(room_id=incident.id, agent_id=f"demo-{role}", role=role, framework=fw, status="active"))

        # Options with REAL D&D costs computed from the loaded Maersk LA tariff
        async def dd(days):
            r = await compute_dd_exposure(session, "Maersk", PORT, "dry", days)
            return round(r["amount"], 2) if r.get("available") else None

        specs = [
            dict(proposer="logistics", type="expedite", feasibility="High", eta=0.0, days=5,
                 risk="Relies on a terminal overtime slot being granted.",
                 rationale="Request priority berthing window; cargo discharged within free time, minimal D&D."),
            dict(proposer="logistics", type="reroute", feasibility="Medium", eta=36.0, days=6,
                 risk="Added fuel + repositioning; downstream drayage must be re-booked.",
                 rationale="Divert to Oakland to bypass San Pedro Bay congestion; ~36h later but avoids most demurrage."),
            dict(proposer="carrier", type="hold", feasibility="Low", eta=120.0, days=12,
                 risk="Demurrage accrues daily; exposure compounds at tiered rates.",
                 rationale="Wait at anchor for a natural berth opening — no diversion cost but the cost clock runs."),
        ]
        options = []
        for s in specs:
            cost = await dd(s["days"])
            opt = RecoveryOption(
                room_id=incident.id, proposer=s["proposer"], type=s["type"], feasibility=s["feasibility"],
                eta_delta_hours=s["eta"], cost_delta=cost, risk=s["risk"], rationale=s["rationale"],
            )
            session.add(opt)
            options.append(opt)
        await session.commit()
        for opt in options:
            await session.refresh(opt)

        expedite, reroute, hold = options
        # Quorum votes (summed confidence -> expedite leads)
        conf = {
            expedite.id: {"logistics": 0.9, "carrier": 0.7, "finance": 1.0, "procurement": 0.8, "customer_impact": 1.0},
            reroute.id: {"logistics": 0.7, "carrier": 0.8, "finance": 0.7, "procurement": 0.6, "customer_impact": 0.6},
            hold.id: {"logistics": 0.3, "carrier": 0.6, "finance": 0.2, "procurement": 0.4, "customer_impact": 0.3},
        }
        for opt_id, roles in conf.items():
            for role, c in roles.items():
                session.add(Vote(room_id=incident.id, agent_id=f"demo-{role}", option_id=opt_id, confidence=c,
                                 rationale=f"{role} weighting of feasibility, ETA and cost."))
        session.add(Dissent(
            room_id=incident.id, target_option_id=expedite.id, material=True,
            objection="Expedite assumes a terminal overtime slot that the marine terminal has not confirmed; if it falls through the vessel reverts to a costly multi-day hold.",
            basis="Port of LA berth-window availability is not guaranteed during peak congestion.",
        ))
        await session.commit()

        # Make the showcase the sole active incident: archive any other still-open
        # incidents (old test data like PIONEER) so /incidents/active can't fall
        # back to them if a judge approves the showcase. A later live run creates a
        # higher-id open incident, which still supersedes this one.
        await session.execute(
            update(Incident)
            .where(Incident.id != incident.id, Incident.phase.notin_(["approved", "rejected", "completed"]))
            .values(phase="completed")
        )
        await session.commit()

        _write_feed(incident.id, options, parties)
        print(f"Seeded showcase incident #{incident.id} (room {incident.id}), phase=awaiting_approval")
        print(f"  vessel={VESSEL} mmsi={DEMO_MMSI} port={PORT}")
        print(f"  importers={[p.importer_name for p in parties] or '(none resolved)'}")
        print(f"  options={[(o.type, float(o.cost_delta) if o.cost_delta else None) for o in options]}")
        print(f"  recommendation=expedite (quorum leader) + 1 material dissent")
        print(f"  wrote feed transcript -> {FEED_PATH}")


def _write_feed(incident_id, options, parties) -> None:
    base = utcnow() - dt.timedelta(minutes=46)

    def ts(sec):
        return (base + dt.timedelta(seconds=sec)).isoformat()

    importer = parties[0].importer_name if parties else "the affected importer"
    ev = []
    ev.append({"kind": "room_created", "room_id": str(incident_id), "ts": ts(0),
               "payload": {"incident_id": incident_id, "vessel": VESSEL, "port": PORT}})
    for i, (role, fw) in enumerate([c for c in CAST if c[0] != "sentinel"]):
        ev.append({"kind": "agent_recruited", "room_id": str(incident_id), "ts": ts(3 + i),
                   "payload": {"role": role, "agent_id": f"demo-{role}", "framework": fw, "status": "active"}})
    ev.append({"kind": "message", "room_id": str(incident_id), "ts": ts(12),
               "payload": {"sender": "sentinel", "text": f"@logistics @procurement @customer_impact {VESSEL} is stuck at anchor at {PORT}; {importer}'s cargo is affected. Propose recovery options."}})
    ev.append({"kind": "message", "room_id": str(incident_id), "ts": ts(20),
               "payload": {"sender": "logistics", "text": "@finance Proposing expedite (priority berth), reroute (Oakland, +36h), and hold. Please cost each against the Maersk tariff."}})
    for i, o in enumerate(options):
        ev.append({"kind": "option_added", "room_id": str(incident_id), "ts": ts(24 + i * 2),
                   "payload": {"option_id": o.id, "proposer": o.proposer, "type": o.type,
                               "feasibility": o.feasibility, "eta_delta_hours": o.eta_delta_hours,
                               "cost_delta": float(o.cost_delta) if o.cost_delta is not None else None}})
    ev.append({"kind": "message", "room_id": str(incident_id), "ts": ts(34),
               "payload": {"sender": "finance", "text": "@sentinel Costed all three from the real Maersk US-import demurrage tariff (4 free days, tiered). Hold is by far the most expensive."}})
    ev.append({"kind": "message", "room_id": str(incident_id), "ts": ts(40),
               "payload": {"sender": "carrier", "text": "@sentinel Carrier can support expedite if a terminal slot opens; otherwise the hold tariff applies per our published rates."}})
    ev.append({"kind": "phase_change", "room_id": str(incident_id), "ts": ts(46), "payload": {"phase": "evaluating"}})
    ev.append({"kind": "message", "room_id": str(incident_id), "ts": ts(52),
               "payload": {"sender": "dissent", "text": "@sentinel Objection (material): expedite assumes an unconfirmed terminal overtime slot; if it falls through we revert to a costly multi-day hold."}})
    ev.append({"kind": "phase_change", "room_id": str(incident_id), "ts": ts(58), "payload": {"phase": "awaiting_approval"}})
    ev.append({"kind": "message", "room_id": str(incident_id), "ts": ts(62),
               "payload": {"sender": "sentinel", "text": "Quorum recommends EXPEDITE (lowest cost, no delay), with a recorded material dissent. Awaiting Ops Manager approval."}})
    FEED_PATH.write_text(json.dumps(ev, indent=2), encoding="utf-8")


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clear", action="store_true", help="Remove the showcase incident and exit.")
    args = ap.parse_args()
    if args.clear:
        async with SessionLocal() as s:
            await clear(s)
        print("Cleared showcase incident.")
        return
    await seed()


if __name__ == "__main__":
    asyncio.run(main())
