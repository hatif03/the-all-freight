"""Attribute incidents to tracked shipments, and record why.

Sits alongside `affected_party_resolver.py` and is called from the same place
in the Sentinel's disruption listener, right after affected parties are
resolved.

The design point worth preserving: **all fuzziness happens once, at track
time, and is written down.** `resolve_port_code()` turns a free-text port name
into a monitored port code when a shipment is first tracked, and stores the
alias it matched. By the time an incident arrives there is no string
comparison left to do — matching is exact `port_code` equality, so every
attribution is reproducible and auditable rather than depending on whatever the
alias table happened to say that day.

Every link is `inferred=True` with a `basis` that states the claim is
port-level, not cargo-level: the incident concerns one vessel, and nothing here
establishes that a given shipment's cargo is aboard it.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import selectinload

from models import Incident, ShipmentIncidentLink, TrackedShipment
from ports import PORTS_BY_CODE, resolve_port_code

MATCH_TYPE_MONITORED_PORT = "monitored_port"

# An incident in one of these phases is closed; a shipment tracked afterwards
# shouldn't be retroactively attached to it.
RESOLVED_PHASES = ("approved", "rejected")


def port_code_for_incident(port_name: str | None) -> str | None:
    """Resolve an incident's port name to a monitored port code, if any."""
    resolved = resolve_port_code(port_name)
    return resolved[0] if resolved else None


def _basis(port_code: str, shipment: TrackedShipment) -> str:
    port = PORTS_BY_CODE.get(port_code)
    port_label = port.name if port else port_code
    field = "recommended entry port" if shipment.port_match_field == "entry_port" else "destination"
    source_text = shipment.entry_port if shipment.port_match_field == "entry_port" else shipment.destination
    return (
        f"Incident opened at {port_label}. This shipment's {field} "
        f'("{source_text}") resolves to the same monitored port. Port-level '
        "match only — it does not establish that this cargo is aboard the "
        "affected vessel."
    )


async def _link(session, shipment: TrackedShipment, incident_id: int, port_code: str) -> bool:
    """Insert one attribution, ignoring an existing one.

    The matcher runs from both directions — a new incident scanning shipments,
    and a newly-tracked shipment scanning open incidents — so the same pair can
    legitimately be offered twice. ON CONFLICT DO NOTHING against the unique
    constraint is what keeps that idempotent.
    """
    stmt = (
        pg_insert(ShipmentIncidentLink)
        .values(
            shipment_id=shipment.id,
            incident_id=incident_id,
            match_type=MATCH_TYPE_MONITORED_PORT,
            inferred=True,
            basis=_basis(port_code, shipment),
        )
        .on_conflict_do_nothing(constraint="uq_shipment_incident")
    )
    result = await session.execute(stmt)
    return bool(result.rowcount)


async def link_incident_to_shipments(session, incident_id: int, port_name: str | None) -> int:
    """Attribute a newly-opened incident to every shipment on that port.

    Returns the number of new links created (0 is the common, correct outcome —
    most incidents happen on lanes nobody is tracking).
    """
    port_code = port_code_for_incident(port_name)
    if not port_code:
        return 0

    shipments = (
        await session.execute(select(TrackedShipment).where(TrackedShipment.port_code == port_code))
    ).scalars().all()

    linked = 0
    for shipment in shipments:
        if await _link(session, shipment, incident_id, port_code):
            linked += 1
    if linked:
        await session.commit()
    return linked


async def link_shipment_to_open_incidents(session, shipment: TrackedShipment) -> int:
    """Attribute already-open incidents to a shipment as it's being tracked.

    Without this, tracking a shipment while a relevant incident is already
    running would show nothing until the *next* disruption.
    """
    if not shipment.port_code:
        return 0

    incidents = (
        await session.execute(
            select(Incident)
            .options(selectinload(Incident.event))
            .where(Incident.phase.notin_(RESOLVED_PHASES))
            .order_by(Incident.id.desc())
            .limit(50)
        )
    ).scalars().all()

    linked = 0
    for incident in incidents:
        port_name = incident.event.port if incident.event else None
        # Resolve through the same helper the incident side uses, so both
        # directions can never disagree about what counts as a match.
        if port_code_for_incident(port_name) != shipment.port_code:
            continue
        if await _link(session, shipment, incident.id, shipment.port_code):
            linked += 1
    if linked:
        await session.commit()
    return linked
