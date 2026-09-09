import os
import sys

# Ensure backend directory is in sys.path to allow imports from other directories (e.g. agents)
backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.append(backend_dir)

import redis.asyncio as redis  # noqa: E402
from config import settings  # noqa: E402


def get_redis_client(for_pubsub: bool = False):
    """Build an async Redis client.

    For a blocking pub/sub listener (``for_pubsub=True``) we must NOT set
    ``socket_timeout``: ``pubsub.listen()`` blocks waiting for messages, so a
    read timeout fires on every idle gap (e.g. between disruptions), tearing the
    subscription down and dropping ``room_events`` during the reconnect. We rely
    on ``health_check_interval`` to keep the connection alive instead. Regular
    command clients keep the read timeout so a stuck call can't hang.
    """
    kwargs = {
        "decode_responses": True,
        "health_check_interval": 30,
        "socket_connect_timeout": 15.0,
    }
    if not for_pubsub:
        kwargs["socket_timeout"] = 15.0
    if settings.REDIS_URL.startswith("rediss"):
        kwargs["ssl_cert_reqs"] = None

    return redis.from_url(settings.REDIS_URL, **kwargs)

