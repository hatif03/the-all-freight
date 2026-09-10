"""Monitored port geography for AIS ingestion + Day-2 disruption detection.

Real, publicly-known port and anchorage locations (no fabricated data; C1).
Bounding boxes keep the aisstream.io subscription tight so we stay within the
connection-health limits (SRS Â§2.5 C7 / Day-1 task 1).

bbox        -> [[lat_min, lon_min], [lat_max, lon_max]]
anchorage   -> list of [lat, lon] polygon vertices (used Day-2 for dwell detection)
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Port:
    code: str            # short slug, used for capture-file naming + logs
    name: str            # human label
    bbox: list[list[float]]
    anchorage: list[list[float]]

    @property
    def aisstream_bbox(self) -> list[list[float]]:
        """aisstream wants each box as [[lat1,lon1],[lat2,lon2]] (SW, NE corners)."""
        return self.bbox

    def contains(self, lat: float | None, lon: float | None) -> bool:
        if lat is None or lon is None:
            return False
        (lat_min, lon_min), (lat_max, lon_max) = self.bbox
        return lat_min <= lat <= lat_max and lon_min <= lon <= lon_max

    def in_anchorage(self, lat: float | None, lon: float | None) -> bool:
        if lat is None or lon is None:
            return False
        return _point_in_polygon(lat, lon, self.anchorage)


# Three high-traffic, congestion-prone ports (task 1).
PORTS: list[Port] = [
    Port(
        code="la_lb",
        name="Los Angeles / Long Beach",
        # San Pedro Bay complex (POLA + POLB).
        bbox=[[33.60, -118.35], [33.80, -118.10]],
        # San Pedro Bay container-ship anchorage area (approx).
        anchorage=[
            [33.715, -118.255],
            [33.715, -118.150],
            [33.640, -118.150],
            [33.640, -118.255],
        ],
    ),
    Port(
        code="ny_nj",
        name="New York / New Jersey",
        bbox=[[40.45, -74.30], [40.75, -73.90]],
        # Lower Bay / Stapleton & Gravesend anchorages (approx).
        anchorage=[
            [40.580, -74.080],
            [40.580, -73.980],
            [40.500, -73.980],
            [40.500, -74.080],
        ],
    ),
    Port(
        code="singapore",
        name="Singapore",
        bbox=[[1.10, 103.55], [1.40, 104.10]],
        # Western/Central anchorage belt south of the port, north of the Strait
        # traffic lanes and south of the terminal quays (~1.26N). Bounds confirmed
        # against live AIS: vessels at anchor (nav=1, sog~0) observed at
        # ~1.221-1.228N, 103.798-103.816E (e.g. ALPINE SPIRIT, DING HENG 43).
        anchorage=[
            [1.250, 103.760],
            [1.250, 103.900],
            [1.190, 103.900],
            [1.190, 103.760],
        ],
    ),
]


PORTS_BY_CODE: dict[str, Port] = {port.code: port for port in PORTS}


# Free-text port names from the planning flow ("Los Angeles, USA", "Port of
# Newark") have to resolve to one of the monitored port codes above before a
# tracked shipment can ever be matched to an incident. A curated alias list is
# the whole mechanism: no similarity scoring, no geographic proximity, and
# emphatically no LLM — asking a model "does this mean LA/LB?" is exactly the
# fabrication vector the no-fabricated-data rule exists to prevent.
#
# ponytail: substring match over a curated list. Fine for three ports; if this
# list grows past a handful, qualify by country/state — "Long Beach, NY" would
# currently resolve to la_lb.
PORT_ALIASES: dict[str, list[str]] = {
    "la_lb": ["los angeles", "long beach", "san pedro", "pola", "polb"],
    "ny_nj": ["new york", "new jersey", "newark", "port elizabeth", "bayonne"],
    "singapore": ["singapore", "psa singapore", "tuas"],
}


def resolve_port_code(*candidates: str | None) -> tuple[str, str, str] | None:
    """Resolve the first candidate that names a monitored port.

    Returns `(port_code, matched_alias, candidate_text)`, or None when nothing
    matches — which is a normal, expected outcome, not an error: only three
    ports are AIS-monitored, so most real lanes resolve to nothing and must be
    shown as unmonitored rather than quietly attached to a nearby port.
    """
    for candidate in candidates:
        if not candidate:
            continue
        haystack = candidate.casefold()
        for code, aliases in PORT_ALIASES.items():
            for alias in aliases:
                if alias in haystack:
                    return code, alias, candidate
    return None


def all_bounding_boxes() -> list[list[list[float]]]:
    """All monitored bboxes, shaped for the aisstream `BoundingBoxes` field."""
    return [port.aisstream_bbox for port in PORTS]


def port_for(lat: float | None, lon: float | None) -> Port | None:
    """Return the monitored port whose bbox contains the point, if any."""
    for port in PORTS:
        if port.contains(lat, lon):
            return port
    return None


def _point_in_polygon(lat: float, lon: float, polygon: list[list[float]]) -> bool:
    """Ray-casting point-in-polygon. Polygon vertices are [lat, lon]."""
    inside = False
    n = len(polygon)
    j = n - 1
    for i in range(n):
        lat_i, lon_i = polygon[i]
        lat_j, lon_j = polygon[j]
        intersects = ((lon_i > lon) != (lon_j > lon)) and (
            lat < (lat_j - lat_i) * (lon - lon_i) / (lon_j - lon_i) + lat_i
        )
        if intersects:
            inside = not inside
        j = i
    return inside
