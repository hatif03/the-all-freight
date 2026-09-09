"""Live carrier demurrage/detention tariff fetch via Anakin's URL Scraper.

Augments (never replaces) the manual CSV path in tariff_loader.py: both call
the same `upsert_tariff_rows()` helper, so the dedup/upsert logic exists in
exactly one place. Reuses the same published tariff URL the backend already
cites for cost provenance (see `MAERSK_IMPORT_TARIFF_URL` in main.py).

Usable two ways:
    cd backend && uv run python tariff_fetcher.py     # CLI, one-off refresh
    POST /admin/tariffs/refresh                        # FastAPI endpoint (main.py)
"""

from __future__ import annotations

import asyncio

from anakin_client import AnakinClient
from database import SessionLocal
from tariff_loader import upsert_tariff_rows

MAERSK_IMPORT_TARIFF_URL = "https://www.maersk.com/local-information/united-states/import"

TARIFF_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "rows": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "carrier": {"type": "string"},
                    "port": {"type": "string"},
                    "equipment": {"type": "string"},
                    "per_day_rate": {"type": "number"},
                    "free_days": {"type": "integer"},
                    "tier": {"type": "string"},
                },
                "required": ["carrier", "port", "equipment", "per_day_rate", "free_days"],
            },
        }
    },
    "required": ["rows"],
}


async def fetch_live_tariff_rows(url: str = MAERSK_IMPORT_TARIFF_URL) -> list[dict]:
    """Scrape the published tariff page into rows shaped like tariff_loader's CSV rows.

    Returns an empty list (never fabricated rows) if Anakin isn't configured
    or the page yields nothing the schema recognizes.
    """
    client = AnakinClient()
    if not client.enabled:
        print("[tariff_fetcher] ANAKIN_API_KEY not set; skipping live fetch.")
        await client.aclose()
        return []

    try:
        result = await client.scrape_url(
            url,
            TARIFF_OUTPUT_SCHEMA,
            prompt=(
                "Extract every published demurrage/detention rate row: carrier, port, "
                "equipment type, per-day rate (USD), free days, and the day-range tier "
                "the rate applies to."
            ),
        )
    except Exception as e:  # noqa: BLE001 - a scrape failure should not crash the caller
        print(f"[tariff_fetcher] Live scrape failed: {e}")
        await client.aclose()
        return []
    finally:
        await client.aclose()

    rows = (result or {}).get("rows") or []
    for row in rows:
        row.setdefault("source_url", url)
    return rows


async def refresh_tariffs(url: str = MAERSK_IMPORT_TARIFF_URL) -> int:
    rows = await fetch_live_tariff_rows(url)
    if not rows:
        return 0
    async with SessionLocal() as session:
        return await upsert_tariff_rows(session, rows, default_source_url=url)


async def main() -> None:
    loaded = await refresh_tariffs()
    print(f"Live tariff fetch loaded or updated {loaded} row(s).")


if __name__ == "__main__":
    asyncio.run(main())
