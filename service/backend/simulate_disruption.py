"""Publish a synthetic disruption event to Redis, to exercise the full
Sentinel -> room bus -> agent-swarm pipeline without needing a real captured
AIS window (see replay.py for that path).

Usage: uv run python simulate_disruption.py [event_id] [port]
"""

import asyncio
import json
import os
import sys
import time
from dotenv import load_dotenv

sys.path.append(os.path.abspath(os.path.dirname(__file__)))
load_dotenv(dotenv_path=os.path.abspath(os.path.join(os.path.dirname(__file__), "../.env")))

from database import SessionLocal
from models import Vessel, DisruptionEvent, utcnow
from redis_client import get_redis_client


async def main():
    event_id = int(time.time()) % 100000
    port = "Singapore"

    if len(sys.argv) > 1:
        try:
            event_id = int(sys.argv[1])
        except ValueError:
            print(f"Invalid event ID: {sys.argv[1]}, using dynamic: {event_id}")

    if len(sys.argv) > 2:
        port = sys.argv[2]

    # 1. Pre-populate DB so the Sentinel's affected-party resolver has a vessel/event to join against.
    async with SessionLocal() as session:
        vessel_mmsi = 999999999
        vessel = await session.get(Vessel, vessel_mmsi)
        if not vessel:
            print(f"Creating mock Vessel row with MMSI {vessel_mmsi}...")
            vessel = Vessel(mmsi=vessel_mmsi, name="PIONEER", type="Cargo", source="mock")
            session.add(vessel)
            await session.commit()

        event_row = await session.get(DisruptionEvent, event_id)
        if not event_row:
            print(f"Creating mock DisruptionEvent row with ID {event_id} in port {port}...")
            event_row = DisruptionEvent(
                id=event_id,
                mmsi=vessel_mmsi,
                port=port,
                type="Anchorage Congestion",
                severity="High",
                detected_at=utcnow(),
                source="mock",
            )
            session.add(event_row)
            await session.commit()

    # 2. Publish to the 'disruptions' Redis channel — Sentinel is subscribed and will
    # open a room, recruit the negotiating agents, and kick off the pipeline.
    redis_client = get_redis_client()
    event = {
        "event_id": event_id,
        "vessel": "PIONEER",
        "port": port,
        "type": "Anchorage Congestion",
        "severity": "High",
    }
    print(f"Publishing simulated disruption event: {event}")
    await redis_client.publish("disruptions", json.dumps(event))
    print("Event published successfully!")
    await redis_client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
