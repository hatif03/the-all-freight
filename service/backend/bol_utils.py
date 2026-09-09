from __future__ import annotations

import datetime as dt
import re
from typing import Any


def clean_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return re.sub(r"\s+", " ", text)


def normalize_key(value: str | None) -> str | None:
    text = clean_text(value)
    if text is None:
        return None
    return text.upper()


def make_lane_key(carrier: str | None, foreign_port: str | None, arrival_port: str | None) -> str | None:
    parts = [normalize_key(carrier), normalize_key(foreign_port), normalize_key(arrival_port)]
    if not any(parts):
        return None
    return "|".join(part or "UNKNOWN" for part in parts)


def parse_date(value: Any) -> dt.date | None:
    text = clean_text(value)
    if text is None:
        return None

    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%Y%m%d", "%d-%b-%Y"):
        try:
            return dt.datetime.strptime(text, fmt).date()
        except ValueError:
            continue

    return None


def parse_bool(value: Any) -> bool:
    text = clean_text(value)
    if text is None:
        return False
    return text.lower() in {"1", "true", "t", "yes", "y", "confidential", "redacted"}
