"""Self-hosted replacement for a third-party agent-coordination SaaS.

Postgres (`RoomMessage`, see backend/models.py) is the durable message log;
Redis pub/sub (the `room_messages` channel) fans messages out in real time to
every agent process and to the dashboard WebSocket relay (backend/main.py's
`redis_broadcast_listener`, which listens on a *different* channel,
`room_events` — the two coexist).

One room per incident: there is no separate room-provisioning step, the room
id **is** the incident id (see the note on `Incident` in backend/models.py).

Interface mirrors what the agents already expect: `create_room`, `recruit`,
`send` (with `mentions: list[str]`), `get_context`, plus `subscribe()` — the
small asyncio loop each agent runs to wake up on its own @mentions.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
from typing import Any, Awaitable, Callable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models import Incident, Participant, RoomMessage
from redis_client import get_redis_client

ROOM_MESSAGES_CHANNEL = "room_messages"


async def create_room(session: AsyncSession, incident_id: int, title: str | None = None) -> int:
    """Open the room for an incident.

    There's nothing to provision: the room id is the incident id. This just
    confirms the incident exists so callers get a clear error instead of a
    silently-empty room. `title` is accepted (and logged) for interface
    parity with what a hosted-room API would take, but isn't persisted —
    nothing reads it back.
    """
    result = await session.execute(select(Incident.id).where(Incident.id == incident_id))
    if result.scalar_one_or_none() is None:
        raise ValueError(f"Cannot open a room for incident #{incident_id}: incident not found.")
    if title:
        print(f"[room_bus] Room opened for incident #{incident_id}: {title}")
    return incident_id


async def recruit(
    session: AsyncSession,
    room_id: int,
    role: str,
    *,
    agent_id: str | None = None,
    framework: str | None = None,
) -> Participant:
    """Idempotent insert of a room participant (insert-if-not-exists by role)."""
    result = await session.execute(
        select(Participant).where(Participant.room_id == room_id, Participant.role == role)
    )
    existing = result.scalar_one_or_none()
    if existing is not None:
        return existing

    participant = Participant(
        room_id=room_id,
        agent_id=agent_id or f"agent-{role}",
        role=role,
        framework=framework,
        status="active",
    )
    session.add(participant)
    await session.commit()
    await session.refresh(participant)
    return participant


async def send(
    session: AsyncSession,
    room_id: int,
    sender_role: str,
    text: str,
    mentions: list[str] | None = None,
    *,
    redis_client=None,
) -> RoomMessage:
    """Persist a room message, then publish it for real-time fanout."""
    message = RoomMessage(room_id=room_id, sender_role=sender_role, text=text, mentions=list(mentions or []))
    session.add(message)
    await session.commit()
    await session.refresh(message)

    should_close = False
    if redis_client is None:
        redis_client = get_redis_client()
        should_close = True
    try:
        await redis_client.publish(
            ROOM_MESSAGES_CHANNEL,
            json.dumps(
                {
                    "room_id": str(room_id),
                    "sender_role": sender_role,
                    "text": text,
                    "mentions": message.mentions,
                    "created_at": message.created_at.isoformat(),
                }
            ),
        )
    finally:
        if should_close:
            await redis_client.aclose()

    return message


async def get_context(session: AsyncSession, room_id: int) -> list[RoomMessage]:
    """Room history in creation order (used e.g. by Carrier to ground its counter-position)."""
    result = await session.execute(
        select(RoomMessage).where(RoomMessage.room_id == room_id).order_by(RoomMessage.created_at)
    )
    return list(result.scalars().all())


async def subscribe(
    role: str | None,
    on_message: Callable[[dict[str, Any]], Awaitable[None]],
) -> None:
    """Background loop: react to messages on the shared `room_messages` channel.

    Each agent process calls this once at startup. `on_message` is only
    invoked for messages that mention this `role` (or "all"), mirroring how
    the negotiating agents used to wake up on a direct @mention. Pass
    `role=None` to receive every message unfiltered — only the Sentinel
    coordinator needs that, to tally options and drive phase transitions
    regardless of who a message was addressed to.

    Never invoked for a role's own messages (no self-wakeup loops).
    """
    while True:
        redis_client = get_redis_client(for_pubsub=True)
        pubsub = redis_client.pubsub()
        try:
            await pubsub.subscribe(ROOM_MESSAGES_CHANNEL)
            print(f"[room_bus] {role or 'sentinel'} subscribed to '{ROOM_MESSAGES_CHANNEL}'")
            while True:
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if message and message.get("type") == "message":
                    try:
                        data = json.loads(message["data"])
                    except (TypeError, ValueError):
                        continue
                    if data.get("sender_role") == role:
                        continue
                    mentions = data.get("mentions") or []
                    if role is not None and role not in mentions and "all" not in mentions:
                        continue
                    asyncio.create_task(on_message(data))
                await asyncio.sleep(0.01)
        except asyncio.CancelledError:
            break
        except Exception as e:  # noqa: BLE001 - keep the listener alive across transient drops
            print(f"[room_bus] listener error for role={role}: {e}. Retrying in 5s...")
            await asyncio.sleep(5)
        finally:
            try:
                await pubsub.unsubscribe(ROOM_MESSAGES_CHANNEL)
            except Exception:
                pass
            try:
                await redis_client.aclose()
            except Exception:
                pass
