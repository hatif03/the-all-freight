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

MAERSK_IMPORT_TARIFF_URL = (
    "https://www.maersk.com/~/media_sc9/maersk/local-information/files/north-america/"
    "united-states-of-america/import/us-import-demurrage-tariff-effective-01-jan-2026-v2.pdf"
)

# Carriers publish D&D tariffs as dated PDFs and silently re-path them, so a
# single hardcoded URL rots — the previous one had become a 404 and, because a
# missing page yields zero rows rather than an error, the whole table just
# stayed empty. Try each in order and take the first that actually parses.
# ponytail: static list; swap for search-based discovery if these rot too.
TARIFF_SOURCES: list[str] = [
    MAERSK_IMPORT_TARIFF_URL,
    "https://www.msc.com/-/media/files/msc-cargo/local-information/america/united-states/"
    "detention-demurrage-and-per-diem-charges-updated.pdf",
    "https://www.hapag-lloyd.com/content/dam/website/downloads/detention_demurrage/"
    "Detention_and_Demurrage_Guide_USA_October_1_2024.pdf",
]

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


EXTRACTION_PROMPT = (
    "Extract every published demurrage/detention rate row: carrier, port, "
    "equipment type, per-day rate (USD), free days, and the day-range tier "
    "the rate applies to."
)


async def fetch_live_tariff_rows(url: str | None = None) -> list[dict]:
    """Scrape published tariff documents into rows shaped like tariff_loader's CSV rows.

    Tries each source in `TARIFF_SOURCES` (or just `url` when one is given) and
    returns the first non-empty result. Returns an empty list — never fabricated
    rows — if Anakin isn't configured or nothing yields anything the schema
    recognizes.
    """
    client = AnakinClient()
    if not client.enabled:
        print("[tariff_fetcher] ANAKIN_API_KEY not set; skipping live fetch.")
        await client.aclose()
        return []

    sources = [url] if url else TARIFF_SOURCES
    try:
        for source in sources:
            try:
                result = await client.scrape_url(source, TARIFF_OUTPUT_SCHEMA, prompt=EXTRACTION_PROMPT)
            except Exception as e:  # noqa: BLE001 - a scrape failure should not crash the caller
                print(f"[tariff_fetcher] Live scrape failed for {source}: {e}")
                continue

            rows = (result or {}).get("rows") or []
            rows = [r for r in rows if isinstance(r, dict) and r.get("per_day_rate") is not None]
            if not rows:
                print(f"[tariff_fetcher] No tariff rows parsed from {source}.")
                continue

            for row in rows:
                row.setdefault("source_url", source)
            print(f"[tariff_fetcher] Parsed {len(rows)} row(s) from {source}.")
            return rows
    finally:
        await client.aclose()

    return []


async def refresh_tariffs(url: str | None = None) -> int:
    rows = await fetch_live_tariff_rows(url)
    if not rows:
        return 0
    async with SessionLocal() as session:
        return await upsert_tariff_rows(session, rows, default_source_url=rows[0]["source_url"])


async def main() -> None:
    loaded = await refresh_tariffs()
    print(f"Live tariff fetch loaded or updated {loaded} row(s).")


if __name__ == "__main__":
    asyncio.run(main())
