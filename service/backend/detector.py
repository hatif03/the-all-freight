import os
import sys
import asyncio
import logging
import datetime as dt
from dotenv import load_dotenv
from sqlalchemy import select, and_, desc
from sqlalchemy.ext.asyncio import AsyncSession

# Ensure backend directory is in path
sys.path.append(os.path.abspath(os.path.dirname(__file__)))

from database import SessionLocal
from models import DisruptionEvent, PositionReport, Vessel, utcnow
from ports import PORTS, port_for
from classifier import classify_event
from events import publish_disruption

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
logger = logging.getLogger("backend.detector")

# Thresholds/Config
DWELL_THRESHOLD_MINUTES = int(os.getenv("DWELL_THRESHOLD_MINUTES", "45"))
ETA_SLIP_THRESHOLD_HOURS = int(os.getenv("ETA_SLIP_THRESHOLD_HOURS", "6"))
POLL_INTERVAL_S = int(os.getenv("DETECTOR_POLL_INTERVAL_S", "10"))

# Baseline ETAs cache: mmsi -> baseline_eta (datetime)
baseline_etas = {}

async def emit(event: DisruptionEvent, vessel_name: str):
    """Publish a new event to the Redis `disruptions` channel via the shared
    Contract-B helper (events.publish_disruption) so the Sentinel receives the
    locked {event_id, mmsi, vessel, port, type, severity, detected_at} shape."""
    try:
        await publish_disruption(
            event_id=event.id,
            mmsi=event.mmsi,
            vessel=vessel_name,
            port=event.port or "Unknown",
            type=event.type,
            severity=str(event.severity),
            detected_at=event.detected_at or utcnow(),
        )
        logger.info(f"[Detector] Published event {event.id} ({event.type}) to Redis 'disruptions'.")
    except Exception as e:
        logger.error(f"[Detector] Failed to publish event {event.id} to Redis: {e}")

async def check_anchorage_dwells(session: AsyncSession):
    """
    Checks all vessels for anchorage dwell disruptions.
    A vessel is considered dwelling if it is in a port's anchorage with SOG < 0.5 continuously.
    """
    logger.info("[Detector] Checking anchorage dwells...")
    
    # Get all active vessels
    vessel_stmt = select(Vessel)
    vessel_res = await session.execute(vessel_stmt)
    vessels = vessel_res.scalars().all()
    
    for vessel in vessels:
        mmsi = vessel.mmsi
        vessel_name = vessel.name or f"MMSI {mmsi}"
        
        # Fetch recent position reports for this vessel sorted by ts desc
        pos_stmt = select(PositionReport).where(
            PositionReport.mmsi == mmsi
        ).order_by(desc(PositionReport.ts)).limit(100)
        
        pos_res = await session.execute(pos_stmt)
        reports = pos_res.scalars().all()
        
        if not reports:
            continue
            
        # Determine if the most recent position is in an anchorage
        latest_report = reports[0]
        latest_lat = latest_report.lat
        latest_lon = latest_report.lon
        
        active_port = None
        for port in PORTS:
            if port.in_anchorage(latest_lat, latest_lon):
                active_port = port
                break
                
        # If the latest position is not in any anchorage, we skip
        if not active_port:
            continue
            
        # Traverse backwards to find how long the vessel has been continuously inside the anchorage
        in_anchorage_reports = []
        for r in reports:
            if active_port.in_anchorage(r.lat, r.lon) and (r.sog or 0.0) < 0.5:
                in_anchorage_reports.append(r)
            else:
                break
                
        if not in_anchorage_reports:
            continue
            
        # Calculate dwell duration in minutes
        earliest_report = in_anchorage_reports[-1]
        latest_report = in_anchorage_reports[0]
        dwell_td = latest_report.ts - earliest_report.ts
        dwell_minutes = int(dwell_td.total_seconds() / 60)
        
        logger.info(f"[Detector] Vessel {vessel_name} inside {active_port.name} anchorage. Dwell: {dwell_minutes} min.")
        
        if dwell_minutes >= DWELL_THRESHOLD_MINUTES:
            # Check if an active anchorage dwell event already exists for this vessel/port (Debounce)
            existing_stmt = select(DisruptionEvent).where(
                and_(
                    DisruptionEvent.mmsi == mmsi,
                    DisruptionEvent.port == active_port.name,
                    DisruptionEvent.type == "anchorage_dwell"
                )
            ).order_by(desc(DisruptionEvent.detected_at)).limit(1)
            
            existing_res = await session.execute(existing_stmt)
            existing_event = existing_res.scalar_one_or_none()
            
            # Debounce: If event already exists and was detected recently (within last 12 hours), skip
            if existing_event and (utcnow() - existing_event.detected_at) < dt.timedelta(hours=12):
                logger.info(f"[Detector] Debounced: Anchorage dwell event already exists for {vessel_name} at {active_port.name}.")
                continue
                
            # Trigger disruption event
            logger.info(f"[Detector] TRIGGER: Anchorage dwell detected for {vessel_name} at {active_port.name} ({dwell_minutes} mins). Calling classifier...")
            
            classification = classify_event({
                "vessel": vessel_name,
                "port": active_port.name,
                "dwell_minutes": dwell_minutes,
                "vessel_type": vessel.type or "Container"
            })
            
            severity = str(classification.get("severity", "0.5"))
            basis = f"Vessel {vessel_name} has been at anchor in {active_port.name} since {earliest_report.ts.strftime('%H:%M')}, total dwell {dwell_minutes} mins."
            
            new_event = DisruptionEvent(
                mmsi=mmsi,
                port=active_port.name,
                type="anchorage_dwell",
                severity=severity,
                detected_at=utcnow(),
                source=vessel.source,
                basis=basis
            )
            session.add(new_event)
            await session.commit()
            await session.refresh(new_event)
            
            # Publish to Redis
            await emit(new_event, vessel_name)

async def check_eta_slips(session: AsyncSession):
    """
    Checks all vessels for ETA slip disruptions.
    Triggers if vessel.eta moves later than the baseline by >= threshold.
    """
    logger.info("[Detector] Checking ETA slips...")
    
    vessel_stmt = select(Vessel)
    vessel_res = await session.execute(vessel_stmt)
    vessels = vessel_res.scalars().all()
    
    for vessel in vessels:
        mmsi = vessel.mmsi
        vessel_name = vessel.name or f"MMSI {mmsi}"
        current_eta = vessel.eta
        
        if not current_eta:
            continue
            
        # Initialize baseline ETA if not already cached
        if mmsi not in baseline_etas:
            baseline_etas[mmsi] = current_eta
            continue
            
        baseline_eta = baseline_etas[mmsi]
        
        # Calculate slip in hours
        slip_td = current_eta - baseline_eta
        slip_hours = slip_td.total_seconds() / 3600.0
        
        if slip_hours >= ETA_SLIP_THRESHOLD_HOURS:
            # Debounce: check for existing recent eta_slip event
            existing_stmt = select(DisruptionEvent).where(
                and_(
                    DisruptionEvent.mmsi == mmsi,
                    DisruptionEvent.type == "eta_slip"
                )
            ).order_by(desc(DisruptionEvent.detected_at)).limit(1)
            
            existing_res = await session.execute(existing_stmt)
            existing_event = existing_res.scalar_one_or_none()
            
            if existing_event and (utcnow() - existing_event.detected_at) < dt.timedelta(hours=24):
                logger.info(f"[Detector] Debounced: ETA slip event already exists for {vessel_name}.")
                continue
                
            port_name = vessel.destination or "Unknown Port"
            logger.info(f"[Detector] TRIGGER: ETA slip detected for {vessel_name} (slip: {slip_hours:.1f} hours). Calling classifier...")
            
            classification = classify_event({
                "vessel": vessel_name,
                "port": port_name,
                "eta_slip_hours": int(slip_hours),
                "vessel_type": vessel.type or "Container"
            })
            
            severity = str(classification.get("severity", "0.5"))
            basis = f"Vessel {vessel_name} ETA to {port_name} slipped by {slip_hours:.1f} hours (baseline: {baseline_eta.strftime('%Y-%m-%d %H:%M')}, current: {current_eta.strftime('%Y-%m-%d %H:%M')})."
            
            new_event = DisruptionEvent(
                mmsi=mmsi,
                port=port_name,
                type="eta_slip",
                severity=severity,
                detected_at=utcnow(),
                source=vessel.source,
                basis=basis
            )
            session.add(new_event)
            await session.commit()
            await session.refresh(new_event)
            
            # Update baseline ETA to current to reset threshold anchor
            baseline_etas[mmsi] = current_eta
            
            # Publish to Redis
            await emit(new_event, vessel_name)

async def run_detector():
    """Main detector loop running periodically."""
    logger.info(f"Starting disruption detector. Polling interval: {POLL_INTERVAL_S}s.")
    while True:
        try:
            async with SessionLocal() as session:
                await check_anchorage_dwells(session)
                await check_eta_slips(session)
        except Exception as e:
            logger.error(f"[Detector] Error in detector loop: {e}", exc_info=True)
            
        await asyncio.sleep(POLL_INTERVAL_S)

if __name__ == "__main__":
    # Load env vars
    load_dotenv(dotenv_path=os.path.abspath(os.path.join(os.path.dirname(__file__), "../.env")))
    asyncio.run(run_detector())
