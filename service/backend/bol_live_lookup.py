"""Live bill-of-lading / importer lookup via Anakin, for when the local DB
(loaded by bol_loader.py's CSV import) has no match for an incident's
vessel/voyage.

Never a replacement for the primary path: affected_party_resolver.py calls
this only as a fallback, and every record this module returns is always
labeled `inferred=True` — a live-scraped, unauthenticated importer match is
never asserted as verified fact (same "no fabricated data" rule cost.py
already enforces by returning `available: False` instead of guessing).

Lookup order:
  1. Anakin's Wire catalog — prefer a maintained BoL/import-records site
     action if one exists, over an ad hoc scrape.
  2. Fallback: Anakin's URL Scraper against a public BoL/import search page.

If ANAKIN_API_KEY is unset, no Wire action exists, or the scrape yields
nothing parseable, this returns an empty list — it does not fabricate a
plausible-looking record.
"""

from __future__ import annotations

import datetime as dt
from typing import Optional

from anakin_client import AnakinClient

# A real, publicly reachable BoL/import-records search page (no login wall for
# a basic query). This is the best-effort public fallback when Wire has no
# dedicated BoL action; see docs/records/anakin-tariff-and-bol.md for what was
# actually found in Wire's catalog (or why this fallback path was chosen).
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


async def _find_wire_bol_action(client: AnakinClient) -> Optional[str]:
    """Look for a Wire catalog action that resolves BoL/import records.

    Returns the action id if one exists, else None (Wire's catalog leans
    towards common consumer/business site actions — travel, shopping,
    scheduling — not niche customs-trade data, so this commonly won't find
    a match; that's an expected, non-error outcome).
    """
    try:
        catalog = await client.wire_catalog(query="bill of lading import records")
    except Exception as e:  # noqa: BLE001
        print(f"[bol_live_lookup] Wire catalog lookup failed: {e}")
        return None

    actions = (catalog or {}).get("actions") or catalog or []
    for action in actions if isinstance(actions, list) else []:
        action_id = action.get("id") if isinstance(action, dict) else None
        name = (action.get("name") or "") if isinstance(action, dict) else ""
        if action_id and any(kw in name.lower() for kw in ("bill of lading", "bol", "import record", "customs")):
            return action_id
    return None


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

    try:
        action_id = await _find_wire_bol_action(client)
        if action_id:
            try:
                result = await client.wire_resolve(action_id, {"vessel": vessel_name, "voyage": voyage or "", "port": port or ""})
                records = (result or {}).get("records") or []
                source_url = f"anakin-wire:{action_id}"
            except Exception as e:  # noqa: BLE001
                print(f"[bol_live_lookup] Wire action {action_id} failed: {e}")
                records, source_url = [], None
        else:
            query = " ".join(filter(None, [vessel_name, voyage, port]))
            try:
                result = await client.scrape_url(
                    f"{PUBLIC_BOL_SEARCH_URL}?q={query}",
                    BOL_OUTPUT_SCHEMA,
                    prompt=f"Find bill-of-lading / import records for vessel '{vessel_name}'"
                    + (f", voyage '{voyage}'" if voyage else "")
                    + (f", arriving at '{port}'" if port else "")
                    + ".",
                )
                records = (result or {}).get("records") or []
                source_url = PUBLIC_BOL_SEARCH_URL
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
