from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy import Select, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from bol_utils import make_lane_key
from models import BolLaneImporterIndex, BolRecord


@dataclass(frozen=True)
class AffectedPartyMatch:
    importer_name: str
    cargo_desc: str | None
    bol_ref: str | None
    inferred: bool
    basis: str
    source: str
    source_url: str | None


def _vessel_name(vessel: Any) -> str | None:
    if vessel is None:
        return None
    if isinstance(vessel, str):
        return vessel
    if isinstance(vessel, dict):
        return vessel.get("name") or vessel.get("vessel_name")
    return getattr(vessel, "name", None) or getattr(vessel, "vessel_name", None)


def _dedupe(matches: list[AffectedPartyMatch], limit: int) -> list[AffectedPartyMatch]:
    seen: set[str] = set()
    deduped: list[AffectedPartyMatch] = []
    for match in matches:
        key = match.importer_name.upper()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(match)
        if len(deduped) >= limit:
            break
    return deduped


async def _finalize(
    matches: list[AffectedPartyMatch],
    vessel_name: str | None,
    voyage: str | None,
    arrival_port: str | None,
    limit: int,
) -> list[AffectedPartyMatch]:
    """Dedupe, falling back to a live Anakin lookup only when the local DB
    (BolRecord / BolLaneImporterIndex, both loaded by bol_loader.py) found
    nothing at all. Never the primary path; every live-resolved record is
    labeled inferred.
    """
    if not matches and vessel_name:
        from bol_live_lookup import resolve_importers_live

        try:
            live_records = await resolve_importers_live(vessel_name, voyage, arrival_port)
        except Exception:
            live_records = []
        for record in live_records:
            matches.append(
                AffectedPartyMatch(
                    importer_name=record["importer_name"],
                    cargo_desc=record.get("cargo_desc"),
                    bol_ref=record.get("bol_ref"),
                    inferred=True,
                    basis=record.get("basis", "Live lookup; inferred."),
                    source=record.get("source", "anakin_live_lookup"),
                    source_url=record.get("source_url"),
                )
            )
    return _dedupe(matches, limit)


async def resolve_affected_parties(
    session: AsyncSession,
    vessel: Any,
    voyage: str | None = None,
    *,
    carrier: str | None = None,
    arrival_port: str | None = None,
    foreign_port: str | None = None,
    pre_arrival: bool = True,
    limit: int = 25,
) -> list[AffectedPartyMatch]:
    vessel_name = _vessel_name(vessel)
    matches: list[AffectedPartyMatch] = []
    if not any([vessel_name, carrier, arrival_port, foreign_port]):
        return []

    if vessel_name:
        query: Select[tuple[BolRecord]] = select(BolRecord).where(BolRecord.vessel_name.ilike(vessel_name))
        if voyage:
            query = query.where(BolRecord.voyage == voyage)
        query = query.order_by(BolRecord.arrival_date.desc().nullslast()).limit(limit * 3)
        rows = (await session.execute(query)).scalars().all()
        for row in rows:
            basis = f"Public BoL record for vessel {row.vessel_name or vessel_name}"
            if row.voyage:
                basis += f", voyage {row.voyage}"
            if pre_arrival:
                basis += "; using historical/pre-arrival association, so this is an inference"
            matches.append(
                AffectedPartyMatch(
                    importer_name=row.importer_name,
                    cargo_desc=row.cargo_desc,
                    bol_ref=row.bol_ref,
                    inferred=pre_arrival,
                    basis=basis,
                    source=row.source,
                    source_url=row.source_url,
                )
            )

    if len(matches) < limit:
        lane_key = make_lane_key(carrier, foreign_port, arrival_port)
        index_query = select(BolLaneImporterIndex)
        filters = []
        if lane_key:
            filters.append(BolLaneImporterIndex.lane_key == lane_key)
        if vessel_name:
            filters.append(BolLaneImporterIndex.vessel_name.ilike(vessel_name))
        if carrier:
            filters.append(BolLaneImporterIndex.carrier.ilike(carrier))
        if arrival_port:
            filters.append(BolLaneImporterIndex.arrival_port.ilike(arrival_port))
        if filters:
            index_query = index_query.where(or_(*filters))
        else:
            return await _finalize(matches, vessel_name, voyage, arrival_port, limit)
        index_query = index_query.order_by(BolLaneImporterIndex.shipment_count.desc()).limit(limit * 3)

        index_rows = (await session.execute(index_query)).scalars().all()
        for row in index_rows:
            basis = (
                f"{row.importer_name} appeared in {row.shipment_count} public BoL record(s) "
                "for this historical vessel/lane pattern; pre-arrival association is inferred"
            )
            matches.append(
                AffectedPartyMatch(
                    importer_name=row.importer_name,
                    cargo_desc=None,
                    bol_ref=row.sample_bol_ref,
                    inferred=True,
                    basis=basis,
                    source=row.source,
                    source_url=None,
                )
            )

    return await _finalize(matches, vessel_name, voyage, arrival_port, limit)
