from __future__ import annotations

import argparse
import asyncio
import csv
from pathlib import Path
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from bol_utils import clean_text
from database import SessionLocal
from models import TariffRate, utcnow


FIELD_ALIASES = {
    "carrier": ("carrier", "carrier_name", "line"),
    "port": ("port", "terminal", "location", "us_port"),
    "equipment": ("equipment", "equipment_type", "container_type", "container"),
    "per_day_rate": ("per_day_rate", "rate", "daily_rate", "usd_per_day"),
    "free_days": ("free_days", "free_time", "free_time_days"),
    "tier": ("tier", "days", "day_range", "range"),
    "source_url": ("source_url", "url", "source"),
}


def get_first(row: dict[str, str], canonical_name: str) -> str | None:
    lowered = {key.lower().strip(): value for key, value in row.items()}
    for alias in FIELD_ALIASES[canonical_name]:
        value = clean_text(lowered.get(alias))
        if value:
            return value
    return None


def parse_money(value: Any) -> float:
    text = clean_text(value)
    if text is None:
        raise ValueError("missing per-day rate")
    return float(text.replace("$", "").replace(",", ""))


def parse_int(value: Any) -> int:
    text = clean_text(value)
    if text is None:
        raise ValueError("missing integer")
    return int(float(text))


def row_to_tariff_rate(row: dict[str, str], default_source_url: str | None) -> TariffRate:
    source_url = get_first(row, "source_url") or default_source_url
    if not source_url:
        raise ValueError("tariff row is missing source_url")

    carrier = get_first(row, "carrier")
    port = get_first(row, "port")
    equipment = get_first(row, "equipment")
    if not carrier or not port or not equipment:
        raise ValueError("tariff row must include carrier, port, and equipment")

    return TariffRate(
        carrier=carrier,
        port=port,
        equipment=equipment,
        per_day_rate=parse_money(get_first(row, "per_day_rate")),
        free_days=parse_int(get_first(row, "free_days")),
        tier=get_first(row, "tier"),
        source_url=source_url,
        captured_at=utcnow(),
    )


async def upsert_tariff_rows(
    session: AsyncSession,
    rows: list[dict[str, Any]],
    default_source_url: str | None = None,
) -> int:
    """Shared carrier-tariff upsert: parse raw rows (CSV dict rows, or the
    normalized dicts a live fetch returns) and insert-or-update TariffRate
    rows, deduped on (carrier, port, equipment, tier, source_url). Used by
    both the CLI CSV loader (`main` below) and `tariff_fetcher.py`'s live
    Anakin fetch, so the dedup/upsert logic exists in exactly one place.
    """
    parsed = [row_to_tariff_rate(row, default_source_url) for row in rows]

    loaded = 0
    for row in parsed:
        exists = await session.execute(
            select(TariffRate).where(
                TariffRate.carrier == row.carrier,
                TariffRate.port == row.port,
                TariffRate.equipment == row.equipment,
                TariffRate.tier == row.tier,
                TariffRate.source_url == row.source_url,
            )
        )
        existing = exists.scalar_one_or_none()
        if existing:
            existing.per_day_rate = row.per_day_rate
            existing.free_days = row.free_days
            existing.captured_at = utcnow()
        else:
            session.add(row)
        loaded += 1

    await session.commit()
    return loaded


async def load_tariff_csv(
    session: AsyncSession,
    csv_path: Path,
    *,
    source_url: str | None = None,
    replace: bool = False,
) -> int:
    with csv_path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        rows = list(reader)

    if replace:
        carriers = {get_first(row, "carrier") for row in rows}
        for carrier in carriers:
            if carrier:
                await session.execute(delete(TariffRate).where(TariffRate.carrier == carrier))

    return await upsert_tariff_rows(session, rows, default_source_url=source_url)


async def main() -> None:
    parser = argparse.ArgumentParser(description="Load cited carrier D&D tariff rows into the ops room.")
    parser.add_argument("csv_path", type=Path)
    parser.add_argument("--source-url", default=None)
    parser.add_argument("--replace", action="store_true")
    args = parser.parse_args()

    async with SessionLocal() as session:
        loaded = await load_tariff_csv(
            session,
            args.csv_path,
            source_url=args.source_url,
            replace=args.replace,
        )

    print(f"Loaded or updated {loaded} tariff rows.")


if __name__ == "__main__":
    asyncio.run(main())
