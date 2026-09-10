import logging
import sys
import os
from typing import Any, Dict, Literal, Union
from pydantic import BaseModel
from datetime import datetime

# Add the backend directory to sys.path to allow imports from outside
backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.append(backend_dir)

try:
    from redis_client import get_redis_client  # noqa: E402
except ImportError:
    # If config import fails when called from other directories
    root_dir = os.path.dirname(backend_dir)
    if root_dir not in sys.path:
        sys.path.append(root_dir)
    if backend_dir not in sys.path:
        sys.path.append(backend_dir)
    from redis_client import get_redis_client  # noqa: E402


logger = logging.getLogger(__name__)

class DisruptionEventSchema(BaseModel):
    event_id: Union[int, str]
    mmsi: int
    vessel: str
    port: str
    type: str
    severity: str
    detected_at: str

class RoomEventSchema(BaseModel):
    kind: Literal[
        "room_created",
        "agent_recruited",
        "message",
        "option_added",
        "phase_change",
        "decision",
        # Not tied to a negotiation room — a monitored page changed. Carried on
        # the same channel so the dashboard gets it live without a second
        # relay, with room_id="global" to mark that it belongs to no room.
        "monitor_signal",
    ]
    room_id: str
    ts: str
    payload: Dict[str, Any]

async def publish_disruption(
    event_id: Union[int, str],
    mmsi: int,
    vessel: str,
    port: str,
    type: str,
    severity: str,
    detected_at: Union[str, datetime],
    redis_client=None
) -> None:
    if isinstance(detected_at, datetime):
        detected_at_str = detected_at.isoformat()
    else:
        detected_at_str = str(detected_at)

    event = DisruptionEventSchema(
        event_id=event_id,
        mmsi=mmsi,
        vessel=vessel,
        port=port,
        type=type,
        severity=severity,
        detected_at=detected_at_str
    )

    data_str = event.model_dump_json()

    should_close = False
    if redis_client is None:
        redis_client = get_redis_client()
        should_close = True

    try:
        await redis_client.publish("disruptions", data_str)
        logger.info(f"Published disruption event {event_id} to disruptions channel")
    finally:
        if should_close:
            await redis_client.aclose()

async def publish_room_event(
    kind: Literal[
        "room_created", "agent_recruited", "message", "option_added", "phase_change", "decision", "monitor_signal"
    ],
    room_id: str,
    ts: Union[str, datetime],
    payload: Dict[str, Any],
    redis_client=None
) -> None:
    """
    Publish a structured room event to the Redis 'room_events' channel.
    
    Expected payload structures by kind (Contract B):
    - 'room_created': { 'incident_id': int/str, 'vessel': str, 'port': str, 'detected_at': str }
    - 'agent_recruited': { 'agent_id': str, 'role': str, 'framework': str, 'status': str }
    - 'message': { 'sender': str, 'text': str }
    - 'option_added': { 'option_id': int/str, 'proposer': str, 'type': str, 'feasibility': str, 'eta_delta_hours': float, 'cost_delta': float, 'rationale': str }
    - 'phase_change': { 'old_phase': str, 'new_phase': str }
    - 'decision': { 'action': str, 'actor': str, 'reason': str, 'option_id': int/str | None }
    """
    if isinstance(ts, datetime):
        ts_str = ts.isoformat()
    else:
        ts_str = str(ts)

    event = RoomEventSchema(
        kind=kind,
        room_id=room_id,
        ts=ts_str,
        payload=payload
    )

    data_str = event.model_dump_json()

    should_close = False
    if redis_client is None:
        redis_client = get_redis_client()
        should_close = True

    try:
        await redis_client.publish("room_events", data_str)
        logger.info(f"Published room event {kind} to room_events channel")
    finally:
        if should_close:
            await redis_client.aclose()
