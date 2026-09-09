"""Live AIS ingestion service (Day-1 AIS Ingestion Lead).

Maintains a persistent, bbox-filtered WebSocket to aisstream.io, normalizes
PositionReport + ShipStaticData messages, and persists them to Postgres
(`vessels` upsert, `position_reports` append, source='live'). Auto-reconnects
with exponential backoff and tees every raw inbound message to a JSONL capture
so we always have a real window to replay during judging (SRS FR-1/2/5, C1).

Run from the `backend/` directory (same convention as bol_loader.py):

    python ais_ingestion.py                 # live -> Postgres + capture
    python ais_ingestion.py --duration 120  # bounded run (sanity check)
    python ais_ingestion.py --no-db         # capture-only, no DB writes
    python ais_ingestion.py --no-capture    # DB-only, no capture file

Requires AISSTREAM_API_KEY in the environment / .env.
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import logging
import re
import signal
from collections import defaultdict
from pathlib import Path

import websockets
from sqlalchemy.dialects.postgresql import insert as pg_insert

from config import settings
from database import SessionLocal
from models import PositionReport, Vessel, utcnow
from ports import PORTS, all_bounding_boxes, port_for

AISSTREAM_WS_URL = "wss://stream.aisstream.io/v0/stream"
CAPTURE_DIR = Path(__file__).resolve().parent.parent / "data" / "captures"

# Flush batched writes whenever either threshold is hit.
FLUSH_MAX_ROWS = 200
FLUSH_INTERVAL_S = 1.0

# Reconnect backoff bounds.
BACKOFF_START_S = 1.0
BACKOFF_MAX_S = 60.0

# Standard AIS navigational-status codes (ITU-R M.1371).
NAV_STATUS = {
    0: "under way using engine",
    1: "at anchor",
    2: "not under command",
    3: "restricted manoeuverability",
    4: "constrained by draught",
    5: "moored",
    6: "aground",
    7: "engaged in fishing",
    8: "under way sailing",
    9: "reserved (HSC)",
    10: "reserved (WIG)",
    11: "reserved",
    12: "reserved",
    13: "reserved",
    14: "AIS-SART / MOB / EPIRB",
    15: "undefined",
}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("ais.ingestion")


def build_subscription(mmsis: list[str] | None = None) -> dict:
    """aisstream subscription: API key + bboxes + message-type filter.

    Must be sent within 3s of connecting or the server closes the socket.

    With ``mmsis`` set, track specific real vessels globally (e.g. to capture a
    named ship like MAERSK DAMIETTA wherever it currently is): aisstream still
    requires a bounding box, so we pass the whole world and rely on the
    server-side MMSI filter (max 50). Without it, we tail the tight
    monitored-port bboxes.
    """
    if mmsis:
        return {
            "APIKey": settings.AISSTREAM_API_KEY,
            "BoundingBoxes": [[[-90.0, -180.0], [90.0, 180.0]]],
            "FiltersShipMMSI": [str(m) for m in mmsis][:50],
            "FilterMessageTypes": ["PositionReport", "ShipStaticData"],
        }
    return {
        "APIKey": settings.AISSTREAM_API_KEY,
        "BoundingBoxes": all_bounding_boxes(),
        "FilterMessageTypes": ["PositionReport", "ShipStaticData"],
    }


def parse_time_utc(value: str | None) -> dt.datetime:
    """Parse aisstream MetaData.time_utc, e.g. '2026-06-16 00:08:02.695818316 +0000 UTC'.

    aisstream broadcasts nanosecond precision (9 fractional digits); Python's
    %f only accepts up to 6, so truncate sub-microsecond digits before parsing.
    Falling back to utcnow() would otherwise collapse every report to ~now and
    destroy dwell/ETA timing.
    """
    if value:
        cleaned = value.replace(" UTC", "").strip()
        cleaned = re.sub(r"(\.\d{6})\d+", r"\1", cleaned)  # ns -> us
        for fmt in ("%Y-%m-%d %H:%M:%S.%f %z", "%Y-%m-%d %H:%M:%S %z"):
            try:
                return dt.datetime.strptime(cleaned, fmt)
            except ValueError:
                continue
    return utcnow()


def parse_eta(eta: dict | None) -> dt.datetime | None:
    """AIS broadcast ETA is {Month, Day, Hour, Minute} (no year).

    Reformat to a tz-aware datetime assuming the nearest plausible year. This is
    a normalization of the real broadcast value, not fabricated data; an
    incomplete/placeholder ETA (month==0) yields None.
    """
    if not isinstance(eta, dict):
        return None
    month = eta.get("Month") or 0
    day = eta.get("Day") or 0
    hour = eta.get("Hour", 24)
    minute = eta.get("Minute", 60)
    if not (1 <= month <= 12 and 1 <= day <= 31 and hour <= 23 and minute <= 59):
        return None
    now = utcnow()
    year = now.year
    try:
        candidate = dt.datetime(year, month, day, hour, minute, tzinfo=dt.UTC)
    except ValueError:
        return None
    # Roll into next year if the broadcast ETA is far in the past (year wrap).
    if candidate < now - dt.timedelta(days=180):
        try:
            candidate = candidate.replace(year=year + 1)
        except ValueError:
            return None
    return candidate


class Batcher:
    """Accumulates vessel upserts + position rows and flushes them together."""

    def __init__(self, *, write_db: bool) -> None:
        self.write_db = write_db
        self._vessels: dict[int, dict] = {}
        self._positions: list[dict] = []
        self._last_flush = asyncio.get_event_loop().time()

    @property
    def pending(self) -> int:
        return len(self._vessels) + len(self._positions)

    def stage_vessel(self, values: dict) -> None:
        mmsi = values["mmsi"]
        existing = self._vessels.get(mmsi, {})
        existing.update({k: v for k, v in values.items() if v is not None})
        existing["mmsi"] = mmsi
        self._vessels[mmsi] = existing

    def stage_position(self, values: dict) -> None:
        self._positions.append(values)

    def should_flush(self) -> bool:
        if self.pending >= FLUSH_MAX_ROWS:
            return True
        return (asyncio.get_event_loop().time() - self._last_flush) >= FLUSH_INTERVAL_S

    async def flush(self) -> None:
        self._last_flush = asyncio.get_event_loop().time()
        if not self.pending:
            return
        vessels = list(self._vessels.values())
        positions = self._positions
        self._vessels = {}
        self._positions = []

        if not self.write_db:
            return

        async with SessionLocal() as session:
            now = utcnow()
            # Upsert vessels: keep identity + last_* fields current.
            for values in vessels:
                values.setdefault("source", "live")
                values["updated_at"] = now
                stmt = pg_insert(Vessel).values(**values)
                update_cols = {
                    col: getattr(stmt.excluded, col)
                    for col in values
                    if col not in ("mmsi", "captured_at")
                }
                stmt = stmt.on_conflict_do_update(
                    index_elements=[Vessel.mmsi],
                    set_=update_cols,
                )
                await session.execute(stmt)

            # Append position reports for vessels we have a row for.
            known = {v["mmsi"] for v in vessels}
            insertable = []
            for row in positions:
                if row["mmsi"] in known:
                    insertable.append(row)
                else:
                    # Position-only update for a vessel we haven't seen static
                    # data for yet: ensure a parent vessel row exists (FK).
                    stub = pg_insert(Vessel).values(
                        mmsi=row["mmsi"], source="live", updated_at=now
                    ).on_conflict_do_nothing(index_elements=[Vessel.mmsi])
                    await session.execute(stub)
                    insertable.append(row)
            if insertable:
                await session.execute(pg_insert(PositionReport), insertable)

            await session.commit()


class CaptureWriter:
    """Tees raw inbound messages to /data/captures/<port>_<date>.jsonl (FR-5)."""

    def __init__(self, enabled: bool) -> None:
        self.enabled = enabled
        self._handles: dict[str, object] = {}
        if enabled:
            CAPTURE_DIR.mkdir(parents=True, exist_ok=True)

    def write(self, port_code: str, raw: dict) -> None:
        if not self.enabled:
            return
        date = dt.datetime.now(dt.UTC).strftime("%Y%m%d")
        key = f"{port_code}_{date}"
        handle = self._handles.get(key)
        if handle is None:
            handle = (CAPTURE_DIR / f"{key}.jsonl").open("a", encoding="utf-8")
            self._handles[key] = handle
        handle.write(json.dumps(raw, separators=(",", ":")) + "\n")
        handle.flush()  # persist immediately so an interrupted capture isn't lost

    def close(self) -> None:
        for handle in self._handles.values():
            try:
                handle.close()
            except Exception:
                pass
        self._handles = {}


class HealthCounter:
    """Per-port msgs/min summary so we can see the feed is alive (task 7)."""

    def __init__(self) -> None:
        self.msgs: dict[str, int] = defaultdict(int)
        self.vessels: dict[str, set[int]] = defaultdict(set)
        self._window_start = asyncio.get_event_loop().time()

    def record(self, port_code: str, mmsi: int) -> None:
        self.msgs[port_code] += 1
        self.vessels[port_code].add(mmsi)

    def maybe_log(self) -> None:
        if asyncio.get_event_loop().time() - self._window_start < 60.0:
            return
        for port in PORTS:
            count = self.msgs.get(port.code, 0)
            vessels = len(self.vessels.get(port.code, ()))
            if count:
                log.info("%s: %d msgs, %d vessels (last 60s)", port.code, count, vessels)
        self.msgs.clear()
        self.vessels.clear()
        self._window_start = asyncio.get_event_loop().time()


def handle_message(
    raw: dict,
    batcher: Batcher,
    capture: CaptureWriter,
    health: HealthCounter,
    source: str = "live",
) -> None:
    """Normalize one aisstream envelope and stage it for persistence.

    `source` tags the persisted rows ('live' for the aisstream feed, 'replay'
    when re-streaming a captured window via replay.py).
    """
    msg_type = raw.get("MessageType")
    meta = raw.get("MetaData") or {}
    body = (raw.get("Message") or {}).get(msg_type) or {}

    mmsi = meta.get("MMSI") or body.get("UserID")
    if mmsi is None:
        return
    mmsi = int(mmsi)

    lat = meta.get("latitude")
    lon = meta.get("longitude")
    port = port_for(lat, lon)
    port_code = port.code if port else "other"

    capture.write(port_code, raw)
    health.record(port_code, mmsi)

    ts = parse_time_utc(meta.get("time_utc"))

    if msg_type == "PositionReport":
        nav_code = body.get("NavigationalStatus")
        nav_status = NAV_STATUS.get(nav_code) if nav_code is not None else None
        sog = body.get("Sog")
        cog = body.get("Cog")
        batcher.stage_vessel(
            {
                "mmsi": mmsi,
                "name": meta.get("ShipName") and str(meta["ShipName"]).strip() or None,
                "last_lat": lat,
                "last_lon": lon,
                "last_sog": sog,
                "last_cog": cog,
                "last_nav_status": nav_status,
                "source": source,
            }
        )
        batcher.stage_position(
            {
                "mmsi": mmsi,
                "lat": lat,
                "lon": lon,
                "sog": sog,
                "cog": cog,
                "nav_status": nav_status,
                "ts": ts,
                "source": source,
                "captured_at": utcnow(),
            }
        )

    elif msg_type == "ShipStaticData":
        dims = body.get("Dimension") or {}
        ship_type = body.get("Type")
        batcher.stage_vessel(
            {
                "mmsi": mmsi,
                "name": (body.get("Name") or meta.get("ShipName") or "").strip() or None,
                "type": str(ship_type) if ship_type is not None else None,
                "imo": str(body["ImoNumber"]) if body.get("ImoNumber") else None,
                "dim_a": dims.get("A"),
                "dim_b": dims.get("B"),
                "dim_c": dims.get("C"),
                "dim_d": dims.get("D"),
                "destination": (body.get("Destination") or "").strip() or None,
                "eta": parse_eta(body.get("Eta")),
                "source": source,
            }
        )


async def ingest_once(
    batcher: Batcher,
    capture: CaptureWriter,
    health: HealthCounter,
    stop: asyncio.Event,
    mmsis: list[str] | None = None,
) -> None:
    """One connection lifetime: connect, subscribe, consume until drop/stop."""
    async with websockets.connect(AISSTREAM_WS_URL, ping_interval=20, ping_timeout=20) as ws:
        await ws.send(json.dumps(build_subscription(mmsis)))
        if mmsis:
            log.info("Connected + subscribed to aisstream for MMSI %s (worldwide)", ",".join(mmsis))
        else:
            log.info("Connected + subscribed to aisstream for %d ports", len(PORTS))
        async for message in ws:
            if stop.is_set():
                break
            try:
                raw = json.loads(message)
            except (json.JSONDecodeError, TypeError):
                continue
            if "error" in raw:
                log.error("aisstream error: %s", raw["error"])
                continue
            handle_message(raw, batcher, capture, health)
            if batcher.should_flush():
                await batcher.flush()
            health.maybe_log()


async def run(write_db: bool, capture_enabled: bool, duration: float | None,
              mmsis: list[str] | None = None) -> None:
    batcher = Batcher(write_db=write_db)
    capture = CaptureWriter(capture_enabled)
    health = HealthCounter()
    stop = asyncio.Event()

    if duration:
        asyncio.get_event_loop().call_later(duration, stop.set)

    # Allow Ctrl-C / SIGTERM to stop cleanly (best-effort on Windows).
    try:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, stop.set)
            except (NotImplementedError, AttributeError):
                pass
    except RuntimeError:
        pass

    backoff = BACKOFF_START_S
    try:
        while not stop.is_set():
            try:
                await ingest_once(batcher, capture, health, stop, mmsis)
                backoff = BACKOFF_START_S  # clean close -> reset
            except asyncio.CancelledError:
                break
            except Exception as exc:  # noqa: BLE001 - feed drops are expected
                log.warning("aisstream connection lost (%s); retrying in %.0fs", exc, backoff)
                await batcher.flush()
                try:
                    await asyncio.wait_for(stop.wait(), timeout=backoff)
                except asyncio.TimeoutError:
                    pass
                backoff = min(backoff * 2, BACKOFF_MAX_S)
    finally:
        await batcher.flush()
        capture.close()
        log.info("Ingestion stopped.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Live aisstream.io AIS ingestion -> Postgres.")
    parser.add_argument("--duration", type=float, default=None, help="Stop after N seconds (sanity runs).")
    parser.add_argument("--no-db", action="store_true", help="Capture-only; do not write to Postgres.")
    parser.add_argument("--no-capture", action="store_true", help="Do not tee raw messages to JSONL.")
    parser.add_argument("--mmsi", nargs="+", default=None,
                        help="Track specific vessel MMSIs worldwide (e.g. capture one named ship). Max 50.")
    args = parser.parse_args()

    if not settings.AISSTREAM_API_KEY:
        raise SystemExit("AISSTREAM_API_KEY is not set (.env). Cannot connect to aisstream.io.")

    asyncio.run(
        run(
            write_db=not args.no_db,
            capture_enabled=not args.no_capture,
            duration=args.duration,
            mmsis=args.mmsi,
        )
    )


if __name__ == "__main__":
    main()
