from __future__ import annotations

import argparse
import asyncio
import csv
from collections import defaultdict
from pathlib import Path

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from bol_utils import clean_text, make_lane_key, parse_bool, parse_date
from database import SessionLocal
from models import BolLaneImporterIndex, BolRecord, utcnow


FIELD_ALIASES = {
    "bol_ref": ("bol_ref", "bill_of_lading", "bill_of_lading_number", "bol_number", "identifier"),
    "importer_name": ("importer_name", "importer", "consignee", "consignee_name", "notify_party"),
    "consignee_name": ("consignee_name", "consignee"),
    "shipper_name": ("shipper_name", "shipper"),
    "cargo_desc": ("cargo_desc", "cargo_description", "commodity", "commodity_description", "description"),
    "vessel_name": ("vessel_name", "vessel", "vessel_nm"),
    "voyage": ("voyage", "voyage_number", "voyage_no"),
    "carrier": ("carrier", "carrier_name", "scac", "vessel_operator"),
    "container_number": ("container_number", "container", "container_no"),
    "arrival_port": ("arrival_port", "port_of_unlading", "us_port", "destination_port"),
    "foreign_port": ("foreign_port", "foreign_port_of_lading", "port_of_lading", "origin_port"),
    "arrival_date": ("arrival_date", "date", "actual_arrival_date", "estimated_arrival_date"),
    "manifest_confidential": ("manifest_confidential", "confidential", "is_confidential"),
}


def get_first(row: dict[str, str], canonical_name: str) -> str | None:
    lowered = {key.lower().strip(): value for key, value in row.items()}
    for alias in FIELD_ALIASES[canonical_name]:
        value = clean_text(lowered.get(alias))
        if value:
            return value
    return None


def row_to_bol_record(row: dict[str, str], source: str, source_url: str | None) -> BolRecord | None:
    importer_name = get_first(row, "importer_name")
    manifest_confidential = parse_bool(get_first(row, "manifest_confidential"))
    if manifest_confidential or not importer_name:
        return None

    carrier = get_first(row, "carrier")
    foreign_port = get_first(row, "foreign_port")
    arrival_port = get_first(row, "arrival_port")

    return BolRecord(
        bol_ref=get_first(row, "bol_ref"),
        importer_name=importer_name,
        consignee_name=get_first(row, "consignee_name"),
        shipper_name=get_first(row, "shipper_name"),
        cargo_desc=get_first(row, "cargo_desc"),
        vessel_name=get_first(row, "vessel_name"),
        voyage=get_first(row, "voyage"),
        carrier=carrier,
        container_number=get_first(row, "container_number"),
        arrival_port=arrival_port,
        foreign_port=foreign_port,
        arrival_date=parse_date(get_first(row, "arrival_date")),
        lane_key=make_lane_key(carrier, foreign_port, arrival_port),
        manifest_confidential=False,
        source=source,
        source_url=source_url,
        captured_at=utcnow(),
        raw_payload=row,
    )


async def load_bol_csv(
    session: AsyncSession,
    csv_path: Path,
    *,
    source: str = "dlp_cbp_bol",
    source_url: str | None = None,
    limit: int | None = None,
) -> int:
    loaded = 0
    with csv_path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            record = row_to_bol_record(row, source=source, source_url=source_url)
            if record is None:
                continue
            session.add(record)
            loaded += 1
            if limit is not None and loaded >= limit:
                break

    await session.commit()
    return loaded


async def rebuild_bol_lane_importer_index(session: AsyncSession) -> int:
    await session.execute(delete(BolLaneImporterIndex))

    result = await session.execute(
        select(BolRecord).where(
            BolRecord.manifest_confidential.is_(False),
            BolRecord.importer_name.is_not(None),
            BolRecord.lane_key.is_not(None),
        )
    )

    grouped: dict[tuple[str, str | None, str | None, str | None, str | None, str | None], list[BolRecord]] = defaultdict(list)
    for record in result.scalars():
        key = (
            record.importer_name,
            record.vessel_name,
            record.carrier,
            record.arrival_port,
            record.foreign_port,
            record.lane_key,
        )
        grouped[key].append(record)

    for (importer_name, vessel_name, carrier, arrival_port, foreign_port, lane_key), records in grouped.items():
        arrival_dates = [record.arrival_date for record in records if record.arrival_date is not None]
        session.add(
            BolLaneImporterIndex(
                importer_name=importer_name,
                vessel_name=vessel_name,
                carrier=carrier,
                arrival_port=arrival_port,
                foreign_port=foreign_port,
                lane_key=lane_key,
                shipment_count=len(records),
                first_arrival_date=min(arrival_dates) if arrival_dates else None,
                last_arrival_date=max(arrival_dates) if arrival_dates else None,
                sample_bol_ref=records[0].bol_ref,
                source=records[0].source,
                basis=f"{importer_name} appeared in {len(records)} public BoL record(s) for this vessel/lane.",
                captured_at=utcnow(),
            )
        )

    await session.commit()
    return len(grouped)


async def main() -> None:
    parser = argparse.ArgumentParser(description="Load public CBP BoL CSV rows into the ops room.")
    parser.add_argument("csv_path", type=Path)
    parser.add_argument("--source", default="dlp_cbp_bol")
    parser.add_argument("--source-url", default=None)
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    async with SessionLocal() as session:
        loaded = await load_bol_csv(
            session,
            args.csv_path,
            source=args.source,
            source_url=args.source_url,
            limit=args.limit,
        )
        indexed = await rebuild_bol_lane_importer_index(session)

    print(f"Loaded {loaded} BoL records; rebuilt {indexed} importer/lane index rows.")


if __name__ == "__main__":
    asyncio.run(main())
