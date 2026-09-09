"""Verify the demo-data path is green BEFORE the dress rehearsal.

Confirms that, for the demo vessel/port, the resolver returns real importers
(from loaded bills of lading) and the cost engine returns a real, cited D&D
figure (from loaded tariffs). Read-only.

Run:  cd backend && uv run python verify_demo_data.py
      cd backend && uv run python verify_demo_data.py --vessel "MAERSK DAMIETTA" --port "Los Angeles"
"""

from __future__ import annotations

import argparse
import asyncio
from pathlib import Path

from affected_party_resolver import resolve_affected_parties
from cost import compute_dd_exposure
from database import SessionLocal

CAPTURE_DIR = Path(__file__).resolve().parent.parent / "data" / "captures"
OK, BAD = "[ OK ]", "[FAIL]"


async def main() -> None:
    parser = argparse.ArgumentParser(description="Verify the demo-data path (importers + tariff).")
    parser.add_argument("--vessel", default="MAERSK DAMIETTA")
    parser.add_argument("--port", default="Los Angeles")
    parser.add_argument("--carrier", default="Maersk")
    parser.add_argument("--equipment", default="dry")
    args = parser.parse_args()

    print("=" * 60)
    print(f"DEMO-DATA CHECK - vessel='{args.vessel}', port='{args.port}'")
    print("=" * 60)
    ok = True

    async with SessionLocal() as session:
        # 1. Affected importers (the headline 'real importers' detail)
        parties = await resolve_affected_parties(session, vessel=args.vessel, arrival_port=args.port)
        if parties:
            print(f"{OK} resolve_affected_parties -> {len(parties)} importer(s):")
            for p in parties[:10]:
                tag = "inferred" if p.inferred else "fact"
                print(f"       - {p.importer_name}  [{tag}]  - {p.basis}")
        else:
            print(f"{BAD} resolve_affected_parties returned NOTHING for "
                  f"'{args.vessel}' / '{args.port}'.")
            print("       -> Load real public BoL for this exact vessel_name + arrival_port,")
            print("          OR set --vessel/--port to a vessel that has BoL coverage.")
            ok = False

        # 2. Real D&D cost coverage
        cost = await compute_dd_exposure(session, args.carrier, args.port, args.equipment, days=7)
        if cost.get("available"):
            print(f"{OK} compute_dd_exposure -> ${cost['amount']:.2f} for 7 days "
                  f"({cost['free_days']} free days) | source: {cost['source_url']}")
        else:
            print(f"{BAD} compute_dd_exposure has NO tariff for "
                  f"carrier='{args.carrier}', port='{args.port}', equipment='{args.equipment}'.")
            print(f"       -> {cost.get('basis')}")
            ok = False

    # 3. A real captured AIS window must exist to replay during the demo
    captures = sorted(CAPTURE_DIR.glob("*.jsonl")) if CAPTURE_DIR.exists() else []
    if captures:
        print(f"{OK} {len(captures)} capture file(s) for replay:")
        for c in captures:
            print(f"       - {c.relative_to(CAPTURE_DIR.parent.parent)}")
    else:
        print(f"{BAD} No capture files in data/captures/ — run a live ais_ingestion window first.")
        ok = False

    print("\n" + "=" * 60)
    print(f"{OK} DEMO DATA READY." if ok else f"{BAD} Demo data not ready — see [FAIL] above.")
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    asyncio.run(main())
