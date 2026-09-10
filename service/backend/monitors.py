"""Scheduled page-change monitoring via Anakin's `/v1/monitors`.

This is the half of the product that watches the *web* rather than the AIS
feed. When a shipment is tracked, the pages that could change its economics —
the port's advisories, the carrier's demurrage tariff, the FMC billing rule —
get registered as monitors, and Anakin posts back to this service when one
changes.

Three things worth knowing before editing:

1. **Monitors are keyed by URL, not by shipment.** Each check costs credits, so
   twenty shipments routing through Los Angeles share one monitor on the port's
   advisories page. `ShipmentMonitorLink` records who cares, and a monitor is
   only deregistered when the last interested shipment is deleted. Without this
   the credit burn scales with shipments instead of with distinct pages.

2. **A detected change is not a vessel disruption.** It never becomes a
   `DisruptionEvent` (that table requires a real MMSI) and never opens a
   negotiation room. It's recorded as a `MonitorSignal` and shown as a web
   signal, which is what it actually is.

3. **Targets are curated and verified, not discovered.** Letting a search
   result choose what to monitor would register whatever URL happened to rank
   first and then pay to poll it forever. Every URL below was checked by hand
   to make sure it resolves and yields real dated content.
"""

from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass
from typing import Any, Optional

import httpx
from sqlalchemy import select

from anakin_client import ANAKIN_BASE_URL
from config import settings
from models import AnakinMonitor, MonitorSignal, ShipmentMonitorLink, TrackedShipment

# 6h for advisories, daily for the slower-moving legal/tariff documents. The
# API floor is 15 minutes; nothing here changes anywhere near that fast, and a
# 15-minute cadence on five pages would be ~480 checks a day for no new signal.
ADVISORY_INTERVAL_MINUTES = 360
DOCUMENT_INTERVAL_MINUTES = 1440


@dataclass(frozen=True)
class MonitorTarget:
    url: str
    kind: str  # port_advisory | carrier_tariff | regulation
    label: str
    interval_minutes: int
    ai_goal: str
    port_code: Optional[str] = None


# Per-port advisory pages, verified reachable and yielding dated notices.
PORT_ADVISORY_TARGETS: dict[str, MonitorTarget] = {
    "la_lb": MonitorTarget(
        url="https://www.portoflosangeles.org/",
        kind="port_advisory",
        label="Port of Los Angeles — notices",
        interval_minutes=ADVISORY_INTERVAL_MINUTES,
        ai_goal=(
            "Only report changes that announce a new operational notice, advisory, "
            "congestion or labour issue, terminal closure, or cargo-volume update. "
            "Ignore navigation, marketing and event listings."
        ),
        port_code="la_lb",
    ),
    "ny_nj": MonitorTarget(
        url="https://www.panynj.gov/port-authority/en/alerts.html",
        kind="port_advisory",
        label="Port Authority of NY & NJ — alerts",
        interval_minutes=ADVISORY_INTERVAL_MINUTES,
        ai_goal=(
            "Only report changes that add or modify an alert affecting port, marine "
            "terminal or freight operations. Ignore airport and transit alerts."
        ),
        port_code="ny_nj",
    ),
    "singapore": MonitorTarget(
        url="https://www.mpa.gov.sg/media-centre?type=Shipping%20Circulars",
        kind="port_advisory",
        label="MPA Singapore — shipping circulars",
        interval_minutes=ADVISORY_INTERVAL_MINUTES,
        ai_goal=(
            "Only report changes that publish a new shipping or port marine circular. "
            "Ignore navigation and unrelated media items."
        ),
        port_code="singapore",
    ),
}

# Watched for every tracked shipment: these set the cost of a disruption
# regardless of lane.
GLOBAL_TARGETS: list[MonitorTarget] = [
    MonitorTarget(
        url=(
            "https://www.maersk.com/~/media_sc9/maersk/local-information/files/north-america/"
            "united-states-of-america/import/us-import-demurrage-tariff-effective-01-jan-2026-v2.pdf"
        ),
        kind="carrier_tariff",
        label="Maersk US import demurrage tariff",
        interval_minutes=DOCUMENT_INTERVAL_MINUTES,
        ai_goal="Only report changes to per-day demurrage rates, free-time days, or the tiers they apply to.",
    ),
    MonitorTarget(
        url="https://www.govinfo.gov/content/pkg/CFR-2025-title46-vol9/pdf/CFR-2025-title46-vol9-part541.pdf",
        kind="regulation",
        label="46 CFR Part 541 — FMC demurrage & detention billing",
        interval_minutes=DOCUMENT_INTERVAL_MINUTES,
        ai_goal="Only report changes to billing deadlines, dispute windows, or who may be invoiced.",
    ),
]

TARIFF_CHANGE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "headline": {"type": "string"},
        "effective_date": {"type": "string"},
        "notes": {"type": "string"},
    },
}


def targets_for_shipment(port_code: Optional[str]) -> list[MonitorTarget]:
    """Which pages matter for this lane.

    An unmonitored port contributes no advisory target — there's no honest page
    to watch for a lane we don't cover — but the tariff and regulation pages
    still apply, because they set what a disruption costs anywhere.
    """
    targets = list(GLOBAL_TARGETS)
    if port_code and port_code in PORT_ADVISORY_TARGETS:
        targets.insert(0, PORT_ADVISORY_TARGETS[port_code])
    return targets


def _webhook_url() -> Optional[str]:
    base = (settings.PUBLIC_BASE_URL or "").rstrip("/")
    if not base or base.startswith("http://localhost") or base.startswith("http://127."):
        # Anakin can't reach a loopback address, so in local dev we register no
        # webhook and rely on polling instead of pretending delivery will work.
        return None
    return f"{base}/webhooks/anakin/monitor"


async def _register(client: httpx.AsyncClient, target: MonitorTarget) -> Optional[dict]:
    payload: dict[str, Any] = {
        "url": target.url,
        "intervalMinutes": target.interval_minutes,
        "watchMode": "full_page",
        "watchFormat": "markdown",
        # aiMode costs an extra credit per check but filters out the nav/footer
        # churn that would otherwise fire an alert on every single run.
        "aiMode": True,
        "aiGoal": target.ai_goal,
        "isActive": True,
    }
    hook = _webhook_url()
    if hook:
        payload["alertWebhookUrl"] = hook

    try:
        response = await client.post("/monitors", json=payload)
        response.raise_for_status()
        return response.json()
    except Exception as e:  # noqa: BLE001 - tracking a shipment must not fail on this
        print(f"[monitors] Failed to register monitor for {target.url}: {e}")
        return None


async def ensure_monitors_for_shipment(session, shipment: TrackedShipment) -> int:
    """Register (or reuse) monitors for a shipment's lane. Returns links added."""
    if not settings.ANAKIN_API_KEY:
        print("[monitors] ANAKIN_API_KEY not set; skipping monitor registration.")
        return 0

    targets = targets_for_shipment(shipment.port_code)
    linked = 0

    async with httpx.AsyncClient(
        base_url=ANAKIN_BASE_URL,
        headers={"X-API-Key": settings.ANAKIN_API_KEY},
        timeout=60.0,
    ) as client:
        for target in targets:
            monitor = (
                await session.execute(select(AnakinMonitor).where(AnakinMonitor.url == target.url))
            ).scalar_one_or_none()

            if not monitor:
                created = await _register(client, target)
                if not created or not created.get("id"):
                    continue
                monitor = AnakinMonitor(
                    anakin_monitor_id=str(created["id"]),
                    url=target.url,
                    kind=target.kind,
                    label=target.label,
                    port_code=target.port_code,
                    interval_minutes=target.interval_minutes,
                    webhook_secret=created.get("alertWebhookSecret"),
                )
                session.add(monitor)
                await session.flush()
                print(f"[monitors] Registered {target.label} ({target.interval_minutes}m).")

            existing_link = (
                await session.execute(
                    select(ShipmentMonitorLink).where(
                        ShipmentMonitorLink.shipment_id == shipment.id,
                        ShipmentMonitorLink.monitor_id == monitor.id,
                    )
                )
            ).scalar_one_or_none()
            if not existing_link:
                session.add(ShipmentMonitorLink(shipment_id=shipment.id, monitor_id=monitor.id))
                linked += 1

    await session.commit()
    return linked


async def release_monitors_for_shipment(session, shipment_id: int) -> int:
    """Deregister any monitor left with no interested shipment. Returns count removed.

    Called on shipment deletion. The links themselves cascade; this exists to
    stop paying for a page nobody is watching any more.
    """
    monitor_ids = (
        await session.execute(
            select(ShipmentMonitorLink.monitor_id).where(ShipmentMonitorLink.shipment_id == shipment_id)
        )
    ).scalars().all()
    if not monitor_ids:
        return 0

    removed = 0
    async with httpx.AsyncClient(
        base_url=ANAKIN_BASE_URL,
        headers={"X-API-Key": settings.ANAKIN_API_KEY or ""},
        timeout=30.0,
    ) as client:
        for monitor_id in monitor_ids:
            others = (
                await session.execute(
                    select(ShipmentMonitorLink).where(
                        ShipmentMonitorLink.monitor_id == monitor_id,
                        ShipmentMonitorLink.shipment_id != shipment_id,
                    )
                )
            ).first()
            if others:
                continue

            monitor = (
                await session.execute(select(AnakinMonitor).where(AnakinMonitor.id == monitor_id))
            ).scalar_one_or_none()
            if not monitor:
                continue
            if settings.ANAKIN_API_KEY:
                try:
                    await client.delete(f"/monitors/{monitor.anakin_monitor_id}")
                except Exception as e:  # noqa: BLE001
                    print(f"[monitors] Failed to deregister {monitor.anakin_monitor_id}: {e}")
            await session.delete(monitor)
            removed += 1

    await session.commit()
    return removed


def verify_signature(body: bytes, signature: Optional[str], secret: Optional[str]) -> bool:
    """Constant-time HMAC check on a webhook delivery.

    No secret stored means we never registered a webhook for that monitor, so a
    signed delivery for it can't be authenticated — reject rather than trust.
    """
    if not secret or not signature:
        return False
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    provided = signature.strip()
    if provided.startswith("sha256="):
        provided = provided[len("sha256=") :]
    return hmac.compare_digest(expected, provided)


def summarize_change(payload: dict) -> str:
    """One human-readable line for a change payload, without inventing detail."""
    for key in ("summary", "aiSummary", "changeSummary", "description"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    changed = payload.get("changedFields") or payload.get("changes")
    if isinstance(changed, dict) and changed:
        return "Changed fields: " + ", ".join(sorted(changed)[:6])
    if isinstance(changed, list) and changed:
        return "Changed: " + ", ".join(str(c) for c in changed[:6])
    return "Page content changed."


async def record_signal(session, monitor: AnakinMonitor, payload: dict) -> MonitorSignal:
    signal = MonitorSignal(
        monitor_id=monitor.id,
        summary=summarize_change(payload),
        changed=payload.get("changedFields") or payload.get("changes"),
        source_url=monitor.url,
        raw=payload,
    )
    session.add(signal)
    await session.commit()
    await session.refresh(signal)
    return signal
