"""Live bill-of-lading / importer lookup via Anakin, for when the local DB
(loaded by bol_loader.py's CSV import) has no match for an incident's
vessel/voyage.

Never a replacement for the primary path: affected_party_resolver.py calls
this only as a fallback, and every record this module returns is always
labeled `inferred=True` — a live-scraped, unauthenticated importer match is
never asserted as verified fact (same "no fabricated data" rule cost.py
already enforces by returning `available: False` instead of guessing).

Lookup path: Anakin's URL Scraper with AI extraction, against a public
BoL/import search page. (An earlier version tried Anakin's Wire catalog first,
on the theory that a maintained site action would beat an ad hoc scrape — but
Wire's catalog is consumer/business websites and contains no bill-of-lading,
customs or trade-data action, so that branch could never match. Removed; see
`.agent/records/anakin-tariff-and-bol.md`.)

If ANAKIN_API_KEY is unset or the scrape yields nothing parseable, this returns
an empty list — it does not fabricate a plausible-looking record.
"""

from __future__ import annotations

import datetime as dt
from typing import Optional
from urllib.parse import quote_plus

from anakin_client import AnakinClient

# A real, publicly reachable BoL/import-records search page (no login wall for
# a basic query). Results behind this page's own paywall won't resolve, which is
# why every record this module returns is labeled `inferred=True`.
PUBLIC_BOL_SEARCH_URL = "https://www.importgenius.com/search"

BOL_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "records": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "importer_name": {"type": "string"},
                    "consignee_name": {"type": "string"},
                    "cargo_desc": {"type": "string"},
                    "bol_ref": {"type": "string"},
                    "arrival_date": {"type": "string"},
                },
                "required": ["importer_name"],
            },
        }
    },
    "required": ["records"],
}


async def resolve_importers_live(
    vessel_name: str,
    voyage: Optional[str] = None,
    port: Optional[str] = None,
    date_range: Optional[tuple[dt.date, dt.date]] = None,
) -> list[dict]:
    """Best-effort live importer lookup for one vessel/voyage/port.

    Returns a list of dicts shaped like affected_party_resolver's matches:
    {importer_name, cargo_desc, bol_ref, inferred: True, basis, source, source_url}.
    Always empty (never fabricated) when nothing real can be resolved.
    """
    if not vessel_name:
        return []

    client = AnakinClient()
    if not client.enabled:
        print("[bol_live_lookup] ANAKIN_API_KEY not set; skipping live lookup.")
        await client.aclose()
        return []

    query = " ".join(filter(None, [vessel_name, voyage, port]))
    search_url = f"{PUBLIC_BOL_SEARCH_URL}?q={quote_plus(query)}"
    try:
        result = await client.scrape_url(
            search_url,
            BOL_OUTPUT_SCHEMA,
            prompt=f"Find bill-of-lading / import records for vessel '{vessel_name}'"
            + (f", voyage '{voyage}'" if voyage else "")
            + (f", arriving at '{port}'" if port else "")
            + ".",
        )
        records = (result or {}).get("records") or []
        source_url = search_url
    except Exception as e:  # noqa: BLE001
        print(f"[bol_live_lookup] Public BoL search scrape failed: {e}")
        records, source_url = [], None
    finally:
        await client.aclose()

    matches: list[dict] = []
    for record in records:
        importer_name = (record or {}).get("importer_name") or (record or {}).get("consignee_name")
        if not importer_name:
            continue
        matches.append(
            {
                "importer_name": importer_name,
                "cargo_desc": record.get("cargo_desc"),
                "bol_ref": record.get("bol_ref"),
                "inferred": True,
                "basis": f"Live Anakin lookup for vessel {vessel_name}" + (f", voyage {voyage}" if voyage else "") + "; unverified, treat as inference.",
                "source": "anakin_live_lookup",
                "source_url": source_url,
            }
        )
    return matches
