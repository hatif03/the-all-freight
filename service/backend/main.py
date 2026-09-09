import asyncio
import os
import sys

if sys.platform == 'win32':
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, BackgroundTasks, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from database import engine, SessionLocal, get_db
from redis_client import get_redis_client
import subprocess
import json
import datetime
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from models import Incident, DisruptionEvent, RecoveryOption, AffectedParty, Participant, Vote, Dissent, Decision, Vessel
from events import publish_room_event
from dossier import build_dossier
from ports import PORTS
from typing import Optional
from pydantic import BaseModel
# Real, cited tariff source used only for options that carry a Finance-computed
# D&D cost (those costs are derived from the real Maersk US import demurrage
# tariff). Options without a computed cost get no source link (C1: no fake data).
# Defined once in tariff_fetcher.py (the live-fetch module) and reused here.
from tariff_fetcher import MAERSK_IMPORT_TARIFF_URL, refresh_tariffs

app = FastAPI(title="Ops Room Backend")

# Enable CORS for frontend cross-origin requests (includes the unified
# Next.js app's local dev origin alongside the existing wildcard).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        print(f"WebSocket client connected. Total connections: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
        print(f"WebSocket client disconnected. Total connections: {len(self.active_connections)}")

    async def broadcast(self, message: str):
        for connection in self.active_connections:
            try:
                await connection.send_text(message)
            except Exception as e:
                print(f"Error broadcasting to WebSocket client: {e}")

manager = ConnectionManager()
redis_listener_task = None

async def redis_broadcast_listener():
    print("Started background listener for Redis 'room_events' channel")
    while True:
        redis_client = get_redis_client(for_pubsub=True)
        pubsub = redis_client.pubsub()
        try:
            await pubsub.subscribe("room_events")
            # Poll with a short timeout instead of a blocking listen(). A blocking
            # pubsub.listen() against Upstash raises "Timeout reading" on every idle
            # gap (no room_events), tearing the subscription down and dropping
            # messages on reconnect. get_message(timeout=...) returns None on idle
            # instead — the same pattern the Sentinel's listeners use successfully.
            while True:
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if message and message.get("type") == "message":
                    # Forward structured events to all connected dashboard WebSockets
                    await manager.broadcast(message["data"])
                await asyncio.sleep(0.01)
        except asyncio.CancelledError:
            print("Redis broadcast listener cancelled")
            break
        except Exception as e:
            print(f"Error in Redis broadcast listener: {e}. Retrying in 5 seconds...")
            await asyncio.sleep(5)
        finally:
            try:
                await pubsub.unsubscribe("room_events")
            except Exception:
                pass
            try:
                await redis_client.aclose()
            except Exception:
                pass

@app.on_event("startup")
async def startup():
    global redis_listener_task
    # Verify DB connection
    try:
        from sqlalchemy import text
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        print("Successfully connected to Neon Postgres")
    except Exception as e:
        print(f"Failed to connect to Neon Postgres: {e}")

    redis_listener_task = asyncio.create_task(redis_broadcast_listener())

@app.on_event("shutdown")
async def shutdown():
    global redis_listener_task
    if redis_listener_task:
        redis_listener_task.cancel()
        try:
            await redis_listener_task
        except asyncio.CancelledError:
            pass

@app.get("/health")
async def health():
    return {"status": "healthy", "service": "ops-room-backend"}

# Curated showcase transcript (written by seed_demo.py). Replayed to each
# dashboard on connect so the room feed is populated even without a live
# agent run. Live room_events still stream on top of it.
DEMO_FEED_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "demo_feed.json")


async def replay_demo_feed(websocket: WebSocket):
    try:
        if not os.path.exists(DEMO_FEED_PATH):
            return
        with open(DEMO_FEED_PATH, "r", encoding="utf-8") as f:
            events = json.load(f)
        for evt in events:
            await websocket.send_text(json.dumps(evt))
            await asyncio.sleep(0.6)
    except Exception as e:
        print(f"demo feed replay ended: {e}")

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    # Populate the feed with the curated showcase conversation on connect.
    asyncio.create_task(replay_demo_feed(websocket))
    try:
        while True:
            # Keep the WebSocket connection open and accept messages/pings from client
            data = await websocket.receive_text()
            print(f"Received WebSocket message from client: {data}")
    except WebSocketDisconnect:
        manager.disconnect(websocket)

@app.post("/demo/replay")
async def trigger_replay(background_tasks: BackgroundTasks, file_path: str = None, speed: int = 20):
    backend_dir = os.path.dirname(os.path.abspath(__file__))
    replay_script = os.path.join(backend_dir, "replay.py")

    if not os.path.exists(replay_script):
        return {"status": "error", "message": f"replay.py not found at {replay_script}"}

    if not file_path:
        return {"status": "error", "message": "file_path is required (a real data/captures/*.jsonl window)."}
    if not os.path.exists(file_path):
        return {"status": "error", "message": f"Capture file not found: {file_path}"}

    def run_replay():
        cmd = ["uv", "run", "python", replay_script, file_path, "--speed", str(speed)]
        print(f"Running replay command: {' '.join(cmd)}")
        subprocess.run(cmd, capture_output=True, text=True)

    background_tasks.add_task(run_replay)
    return {"status": "triggered", "message": f"Kicked off replay of {file_path} (speed={speed})"}

# Helper to format incident payload
async def format_incident_payload(incident: Incident) -> dict:
    event = incident.event
    vessel_name = event.vessel.name if (event and event.vessel) else ""
    mmsi = event.mmsi if event else 999999999

    event_data = {
        "vessel": vessel_name,
        "mmsi": mmsi,
        "port": event.port if event else "",
        "type": event.type if event else "",
        "severity": event.severity if event else "",
        "detected_at": event.detected_at.isoformat() if (event and event.detected_at) else ""
    }

    affected_parties = []
    if event and event.affected_parties:
        for p in event.affected_parties:
            affected_parties.append({
                "importer_name": p.importer_name,
                "cargo_desc": p.cargo_desc,
                "bol_ref": p.bol_ref or "",
                "inferred": p.inferred,
                "basis": p.basis,
                "source_url": p.source_url or ""
            })

    options = []
    for o in incident.options:
        options.append({
            "id": o.id,
            "proposer": o.proposer,
            "type": o.type,
            "feasibility": o.feasibility,
            "eta_delta_hours": o.eta_delta_hours,
            "cost_delta": float(o.cost_delta) if o.cost_delta is not None else None,
            "risk": o.risk or "",
            "rationale": o.rationale,
            # Only options with a real Finance-computed D&D cost get the cited
            # tariff link; uncosted options have no source (C1: no fabricated provenance).
            "source_url": MAERSK_IMPORT_TARIFF_URL if o.cost_delta is not None else None
        })

    participants = []
    for p in incident.participants:
        participants.append({
            "role": p.role,
            "framework": p.framework,
            "status": p.status
        })

    dissent = incident.dissents[-1] if incident.dissents else None

    # Recommendation = the winner of the agents' quorum vote (highest summed
    # confidence across Vote rows), not a hardcoded "prefer logistics" heuristic.
    # Until the evaluation pipeline has tallied votes there is no recommendation yet.
    recommendation = None
    if incident.options and incident.votes:
        score_by_option: dict[int, float] = {}
        for v in incident.votes:
            score_by_option[v.option_id] = score_by_option.get(v.option_id, 0.0) + (v.confidence or 0.0)
        if score_by_option:
            leading_id = max(score_by_option, key=score_by_option.get)
            best_opt = next((o for o in incident.options if o.id == leading_id), None)
            if best_opt:
                recommendation = {
                    "option_id": best_opt.id,
                    "proposer": best_opt.proposer,
                    "type": best_opt.type,
                    "feasibility": best_opt.feasibility,
                    "eta_delta_hours": best_opt.eta_delta_hours,
                    "cost_delta": float(best_opt.cost_delta) if best_opt.cost_delta is not None else None,
                    "rationale": best_opt.rationale,
                    "vote_score": round(score_by_option[leading_id], 3),
                    "contested": bool(dissent and dissent.material and dissent.target_option_id == best_opt.id),
                    "source_url": MAERSK_IMPORT_TARIFF_URL if best_opt.cost_delta is not None else None
                }

    dissent_data = None
    if dissent:
        dissent_data = {
            "objection": dissent.objection,
            "material": dissent.material,
            "target_option_id": dissent.target_option_id
        }

    return {
        "incident": {
            "id": incident.id,
            "room_id": incident.id,
            "phase": incident.phase
        },
        "event": event_data,
        "affected_parties": affected_parties,
        "options": options,
        "participants": participants,
        "recommendation": recommendation,
        "dissent": dissent_data
    }

@app.get("/incidents/active")
async def get_active_incident(db=Depends(get_db)):
    # Find the latest open incident (not approved, rejected, or completed)
    stmt = (
        select(Incident)
        .where(Incident.phase.notin_(["approved", "rejected", "completed"]))
        .order_by(Incident.id.desc())
        .limit(1)
        .options(
            selectinload(Incident.event).selectinload(DisruptionEvent.vessel),
            selectinload(Incident.event).selectinload(DisruptionEvent.affected_parties),
            selectinload(Incident.options),
            selectinload(Incident.participants),
            selectinload(Incident.votes),
            selectinload(Incident.dissents),
        )
    )
    res = await db.execute(stmt)
    incident = res.scalar_one_or_none()

    # If no open incident, fallback to the absolute latest incident overall
    if not incident:
        stmt_latest = (
            select(Incident)
            .order_by(Incident.id.desc())
            .limit(1)
            .options(
                selectinload(Incident.event).selectinload(DisruptionEvent.vessel),
                selectinload(Incident.event).selectinload(DisruptionEvent.affected_parties),
                selectinload(Incident.options),
                selectinload(Incident.participants),
                selectinload(Incident.votes),
                selectinload(Incident.dissents),
            )
        )
        res_latest = await db.execute(stmt_latest)
        incident = res_latest.scalar_one_or_none()

    if not incident:
        raise HTTPException(status_code=404, detail="No active or completed incidents found")

    payload = await format_incident_payload(incident)
    return payload

@app.get("/incidents/{id}")
async def get_incident_by_id(id: int, db=Depends(get_db)):
    stmt = (
        select(Incident)
        .where(Incident.id == id)
        .options(
            selectinload(Incident.event).selectinload(DisruptionEvent.vessel),
            selectinload(Incident.event).selectinload(DisruptionEvent.affected_parties),
            selectinload(Incident.options),
            selectinload(Incident.participants),
            selectinload(Incident.votes),
            selectinload(Incident.dissents),
        )
    )
    res = await db.execute(stmt)
    incident = res.scalar_one_or_none()

    if not incident:
        raise HTTPException(status_code=404, detail=f"Incident #{id} not found")

    payload = await format_incident_payload(incident)
    return payload

class DecisionRequest(BaseModel):
    action: str  # "approve" or "reject"
    actor: str
    reason: Optional[str] = None
    option_id: Optional[int] = None

@app.post("/incidents/{id}/decision")
async def record_decision(id: int, req: DecisionRequest, db=Depends(get_db)):
    stmt = (
        select(Incident)
        .where(Incident.id == id)
        .options(
            selectinload(Incident.event).selectinload(DisruptionEvent.vessel),
            selectinload(Incident.event).selectinload(DisruptionEvent.affected_parties),
            selectinload(Incident.options),
            selectinload(Incident.participants),
            selectinload(Incident.votes),
            selectinload(Incident.dissents),
        )
    )
    res = await db.execute(stmt)
    incident = res.scalar_one_or_none()

    if not incident:
        raise HTTPException(status_code=404, detail=f"Incident #{id} not found")

    # Write a Decision row
    decision_row = Decision(
        room_id=incident.id,
        option_id=req.option_id,
        human_action=req.action,
        actor=req.actor,
        reason=req.reason
    )
    db.add(decision_row)

    # Update incident phase directly to keep local state in sync
    new_phase = "approved" if req.action.lower() == "approve" else "rejected"
    incident.phase = new_phase
    await db.commit()
    await db.refresh(incident)

    # Publish 'decision' room_event to Redis room_events channel (Contract B)
    # AND publish to Redis decisions channel for the Sentinel loop
    redis_client = get_redis_client()
    try:
        import datetime
        ts_now = datetime.datetime.now(datetime.UTC).isoformat()
        await publish_room_event(
            kind="decision",
            room_id=str(incident.id),
            ts=ts_now,
            payload={
                "action": req.action,
                "actor": req.actor,
                "reason": req.reason,
                "option_id": req.option_id
            },
            redis_client=redis_client
        )
        await publish_room_event(
            kind="phase_change",
            room_id=str(incident.id),
            ts=ts_now,
            payload={
                "phase": new_phase,
                "old_phase": "awaiting_approval",
                "new_phase": new_phase
            },
            redis_client=redis_client
        )

        decisions_payload = {
            "incident_id": incident.id,
            "action": req.action,
            "actor": req.actor,
            "reason": req.reason,
            "option_id": req.option_id
        }
        await redis_client.publish("decisions", json.dumps(decisions_payload))
        print(f"Published decision to decisions channel: {decisions_payload}")
    finally:
        await redis_client.aclose()

    # Refresh updated incident state and return payload
    stmt_updated = (
        select(Incident)
        .where(Incident.id == id)
        .options(
            selectinload(Incident.event).selectinload(DisruptionEvent.vessel),
            selectinload(Incident.event).selectinload(DisruptionEvent.affected_parties),
            selectinload(Incident.options),
            selectinload(Incident.participants),
            selectinload(Incident.votes),
            selectinload(Incident.dissents),
        )
    )
    res_updated = await db.execute(stmt_updated)
    incident_updated = res_updated.scalar_one()

    payload = await format_incident_payload(incident_updated)
    return payload

@app.get("/incidents/{id}/dossier")
async def get_incident_dossier(id: int, format: str = "html", db=Depends(get_db)):
    """Generate and return the one-page audit decision record for an incident.

    `?format=json` returns the structured record; default returns printable HTML.
    """
    result = await build_dossier(db, id)
    if result is None:
        raise HTTPException(status_code=404, detail=f"Incident #{id} not found")
    if format == "json":
        return JSONResponse(result["record"])
    return HTMLResponse(result["html"])

@app.get("/vessels/positions")
async def get_vessels_positions(db=Depends(get_db)):
    # 1. Get active disrupted MMSIs
    active_incidents_stmt = (
        select(Incident)
        .where(Incident.phase.notin_(["approved", "rejected", "completed"]))
        .options(selectinload(Incident.event))
    )
    result = await db.execute(active_incidents_stmt)
    active_incidents = result.scalars().all()
    active_mmsis = {inc.event.mmsi for inc in active_incidents if inc.event}

    # Also mark vessels with a recent DisruptionEvent: detection fires before the
    # Sentinel opens an Incident, so the map should highlight the disrupted vessel
    # the moment the detector triggers (this is the raw AIS disruption signal).
    recent_cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=24)
    de_stmt = select(DisruptionEvent.mmsi).where(DisruptionEvent.detected_at >= recent_cutoff)
    de_res = await db.execute(de_stmt)
    active_mmsis |= {row[0] for row in de_res}

    # 2. Get latest vessel positions
    vessels_stmt = select(Vessel).where(Vessel.last_lat.isnot(None), Vessel.last_lon.isnot(None))
    result = await db.execute(vessels_stmt)
    vessels = result.scalars().all()

    positions = [
        {
            "mmsi": v.mmsi,
            "name": v.name or f"MMSI {v.mmsi}",
            "lat": v.last_lat,
            "lon": v.last_lon,
            "sog": v.last_sog or 0.0,
            "cog": v.last_cog or 0.0,
            "type": v.type or "Cargo",
            "destination": v.destination or "",
            "nav_status": v.last_nav_status or "unknown",
            "is_disrupted": v.mmsi in active_mmsis
        }
        for v in vessels
    ]

    # Expose only the real monitored-port anchorages from ports.py (C1: no fake data).
    anchorages = []
    for port in PORTS:
        anchorages.append({
            "port_code": port.code,
            "port_name": port.name,
            "polygon": port.anchorage
        })

    return {
        "vessels": positions,
        "anchorages": anchorages
    }

@app.get("/ports/geo")
async def get_ports_geo():
    return [
        {
            "code": p.code,
            "name": p.name,
            "bbox": p.bbox,
            "anchorage": p.anchorage
        }
        for p in PORTS
    ]

@app.post("/admin/tariffs/refresh")
async def refresh_tariffs_endpoint():
    """Live-fetch the published carrier tariff page via Anakin and upsert it.

    Returns loaded=0 (not an error) when ANAKIN_API_KEY is unset or the page
    yields no recognizable rows — this never fabricates tariff data.
    """
    loaded = await refresh_tariffs()
    return {"loaded": loaded, "source_url": MAERSK_IMPORT_TARIFF_URL}
