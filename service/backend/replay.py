"""Replay feeder for captured AIS windows (Kelin - Day-2 Disruption Detection & Replay).

Re-streams a real captured `data/captures/<port>_<date>.jsonl` window through the
SAME `handle_message()` path as live ingestion, but tags the persisted rows
`source='replay'`. This reproduces a real anchorage-dwell / ETA-slip on demand so
the detector fires deterministically during judging (SRS FR-5), without ever
depending on a live event happening at the exact demo minute.

Hard constraint (C1): replay only re-emits REAL captured data. There is no
synthetic/simulated fallback - if the capture file is missing or empty, we stop
with an error rather than fabricate vessels or positions.

Run from the `backend/` directory:

    python replay.py ../data/captures/la_lb_20260616.jsonl              # real-time-ish
    python replay.py ../data/captures/la_lb_20260616.jsonl --speed 20   # 20x faster
    python replay.py ../data/captures/la_lb_20260616.jsonl --no-db      # dry run, no DB writes
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

# Ensure the backend directory is importable (same convention as detector.py).
sys.path.append(os.path.abspath(os.path.dirname(__file__)))

from ais_ingestion import Batcher, CaptureWriter, HealthCounter, handle_message, parse_time_utc


async def run_replay(file_path: str, speed: float, write_db: bool) -> int:
    """Re-stream one captured JSONL window. Returns the number of messages replayed."""
    path = Path(file_path)
    if not path.exists():
        raise SystemExit(f"Capture file not found: {path}. Replay requires a real captured window (C1).")

    lines = [ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]
    if not lines:
        raise SystemExit(f"Capture file is empty: {path}. Nothing real to replay (no synthetic fallback, C1).")

    print(f"Replaying {len(lines)} captured messages from {path} at {speed}x (source='replay', write_db={write_db})...")

    batcher = Batcher(write_db=write_db)
    capture = CaptureWriter(enabled=False)  # never re-capture a replay as if it were live
    health = HealthCounter()

    prev_ts = None
    replayed = 0
    for line in lines:
        try:
            raw = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(raw, dict) or "MessageType" not in raw:
            continue

        # Preserve the real inter-message cadence (scaled by --speed) using the
        # captured time_utc, so a real dwell unfolds the way it actually happened.
        meta = raw.get("MetaData") or {}
        current_ts = parse_time_utc(meta.get("time_utc"))
        if prev_ts is not None and speed > 0:
            gap = (current_ts - prev_ts).total_seconds()
            if gap > 0:
                await asyncio.sleep(min(gap / speed, 5.0))
        prev_ts = current_ts

        handle_message(raw, batcher, capture, health, source="replay")
        replayed += 1
        if batcher.should_flush():
            await batcher.flush()

    await batcher.flush()
    print(f"Replay complete: {replayed} messages re-streamed (source='replay'). Detector should now fire.")
    return replayed


def main() -> None:
    load_dotenv(dotenv_path=os.path.abspath(os.path.join(os.path.dirname(__file__), "../.env")))
    parser = argparse.ArgumentParser(description="Replay a real captured AIS window (no synthetic data).")
    parser.add_argument("file_path", help="Path to a captured JSONL window (data/captures/<port>_<date>.jsonl).")
    parser.add_argument("--speed", type=float, default=20.0, help="Replay speed multiplier (default 20x).")
    parser.add_argument("--no-db", action="store_true", help="Dry run: parse + pace without writing to Postgres.")
    args = parser.parse_args()

    asyncio.run(run_replay(args.file_path, args.speed, write_db=not args.no_db))


if __name__ == "__main__":
    main()
