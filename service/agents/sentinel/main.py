import os
import sys
import json
import asyncio
from datetime import datetime, timezone
from dotenv import load_dotenv

# Set Selector event loop policy on Windows to avoid TLS timeout bugs
if sys.platform.startswith("win"):
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

# Ensure backend and agents directories are in sys.path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "../../backend")))
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

# Load environment variables
load_dotenv(dotenv_path=os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.env")))

from sqlalchemy import select, desc  # noqa: E402
from sqlalchemy.orm import selectinload  # noqa: E402
from database import SessionLocal  # noqa: E402
from redis_client import get_redis_client  # noqa: E402
from affected_party_resolver import resolve_affected_parties  # noqa: E402
from models import Incident, RecoveryOption, Dissent, Vote, Decision, AffectedParty  # noqa: E402
from events import publish_room_event  # noqa: E402

import room_bus  # noqa: E402
import registry  # noqa: E402

ROLE = "sentinel"

# Framework label shown on the dashboard's participant chips (Participant.framework).
FRAMEWORK_BY_ROLE = {
    "logistics": "LangGraph",
    "carrier": "PydanticAI",
    "finance": "PydanticAI",
    "procurement": "CrewAI",
    "customer_impact": "PydanticAI",
}


async def run_evaluation_pipeline(incident_id: int, redis_client) -> None:
    try:
        print(f"[Sentinel Pipeline] Beginning evaluation for Incident #{incident_id}")

        # 1. Transition phase to 'evaluating'
        async with SessionLocal() as session:
            stmt = select(Incident).where(Incident.id == incident_id)
            res = await session.execute(stmt)
            incident = res.scalar_one_or_none()
            if not incident:
                print(f"[Sentinel Pipeline] Incident #{incident_id} not found.")
                return

            incident.phase = "evaluating"
            await session.commit()
            print(f"[Sentinel Pipeline] Advanced Incident #{incident_id} to evaluating.")

            await publish_room_event(
                kind="phase_change",
                room_id=str(incident_id),
                ts=datetime.now(timezone.utc),
                payload={"phase": "evaluating", "old_phase": "options_collected", "new_phase": "evaluating"},
                redis_client=redis_client,
            )

            await room_bus.send(
                session, incident_id, ROLE,
                "Evaluation pipeline initialized. Analyzing viability of collected options and tallying votes.",
                mentions=[],
            )

        # 2. Tally/quorum voting
        async with SessionLocal() as session:
            stmt = (
                select(Incident)
                .options(selectinload(Incident.options))
                .where(Incident.id == incident_id)
            )
            res = await session.execute(stmt)
            incident = res.scalar_one_or_none()

            if not incident or not incident.options:
                print(f"[Sentinel Pipeline] No options found for Incident #{incident_id}")
                if incident:
                    await room_bus.send(
                        session, incident_id, ROLE,
                        "No recovery options collected to evaluate. Advancing phase to awaiting_approval.",
                        mentions=[],
                    )
                    incident.phase = "awaiting_approval"
                    await session.commit()
                return

            print(f"[Sentinel Pipeline] Found {len(incident.options)} options to evaluate.")

            roles = ["logistics", "carrier", "finance", "procurement", "customer_impact"]
            scores: dict[int, float] = {}

            for opt in incident.options:
                opt_id = opt.id
                scores[opt_id] = 0.0

                for role in roles:
                    confidence = 0.5
                    rationale = f"Synthetic evaluation for {role} based on option features."

                    if role == "logistics":
                        feas = opt.feasibility.lower() if opt.feasibility else "medium"
                        confidence = 1.0 if feas == "high" else (0.6 if feas == "medium" else 0.2)
                        if opt.eta_delta_hours and opt.eta_delta_hours > 48:
                            confidence = max(0.1, confidence - 0.2)
                            rationale = f"Logistics prefers {feas} feasibility, but notes significant delay of {opt.eta_delta_hours}h."
                        else:
                            rationale = f"Logistics supports option with {feas} feasibility."

                    elif role == "carrier":
                        feas = opt.feasibility.lower() if opt.feasibility else "medium"
                        confidence = 1.0 if feas == "high" else (0.6 if feas == "medium" else 0.3)
                        if opt.risk and len(opt.risk) > 10:
                            confidence = max(0.1, confidence - 0.2)
                            rationale = f"Carrier supports option but is cautious about stated risks: {opt.risk}."
                        else:
                            rationale = f"Carrier supports option with {feas} feasibility."

                    elif role == "finance":
                        cost = float(opt.cost_delta) if opt.cost_delta else 0.0
                        if cost <= 0.0:
                            confidence = 1.0
                            rationale = "Finance strongly supports this option as it introduces no additional cost exposure."
                        else:
                            confidence = max(0.1, 1.0 - (cost / 10000.0))
                            rationale = f"Finance confidence adjusted based on cost delta of ${cost:.2f}."

                    elif role == "procurement":
                        feas = opt.feasibility.lower() if opt.feasibility else "medium"
                        cost = float(opt.cost_delta) if opt.cost_delta else 0.0
                        confidence = 0.8 if feas in ["high", "medium"] else 0.4
                        if cost > 5000.0:
                            confidence = max(0.1, confidence - 0.2)
                        rationale = f"Procurement values feasibility ({feas}) and moderate costs."

                    elif role == "customer_impact":
                        delay = float(opt.eta_delta_hours) if opt.eta_delta_hours else 0.0
                        if delay <= 0.0:
                            confidence = 1.0
                            rationale = "Customer Impact strongly supports as there is no cargo delivery delay."
                        else:
                            confidence = max(0.1, 1.0 - (delay / 72.0))
                            rationale = f"Customer Impact confidence adjusted for ETA delay of {delay} hours."

                    vote_row = Vote(
                        room_id=incident_id,
                        agent_id=f"agent-{role}",
                        option_id=opt_id,
                        confidence=confidence,
                        rationale=rationale,
                    )
                    session.add(vote_row)
                    scores[opt_id] += confidence

            await session.commit()
            print("[Sentinel Pipeline] Synthetic votes successfully created.")

            leading_opt_id = max(scores, key=scores.get)
            leading_option = next(o for o in incident.options if o.id == leading_opt_id)
            print(f"[Sentinel Pipeline] Leading option selected: ID #{leading_opt_id} ({leading_option.type}) with score {scores[leading_opt_id]:.2f}")

            # 3. Recruit & trigger Dissent
            await room_bus.recruit(session, incident_id, "dissent", framework="PydanticAI")

            dissent_summon_msg = (
                f"@dissent Please evaluate option #{leading_option.id} "
                f"({leading_option.type} option proposed by {leading_option.proposer})."
            )
            await room_bus.send(session, incident_id, ROLE, dissent_summon_msg, mentions=["dissent"])
            print(f"[Sentinel Pipeline] Dissent agent summoned for option #{leading_option.id}")

    except Exception as e:
        print(f"Error in run_evaluation_pipeline: {e}")
        import traceback
        traceback.print_exc()


async def on_room_message(data: dict, redis_client) -> None:
    """Sentinel sees every room message (subscribed with role=None), not just
    ones that @mention it — it's the coordinator that tallies options and
    drives phase transitions regardless of who a message was addressed to.
    """
    try:
        room_id = int(data["room_id"])
        sender_role = data.get("sender_role") or "agent"
        content = data.get("text") or ""
        mentions = data.get("mentions") or []

        if not content:
            return

        # Publish message to room_events Redis channel so the dashboard displays it
        await publish_room_event(
            kind="message",
            room_id=str(room_id),
            ts=datetime.now(timezone.utc),
            payload={"sender": sender_role, "text": content},
            redis_client=redis_client,
        )

        # Skip Sentinel's own messages to prevent infinite loops/duplicate processing
        if sender_role == ROLE:
            return

        # Handle Dissent response to transition phase to awaiting_approval
        is_dissent_msg = (sender_role == "dissent") or ("Objection recorded for Option" in content)
        if is_dissent_msg:
            print("[Sentinel] Dissent response received. Transitioning to awaiting_approval.")
            async with SessionLocal() as session:
                stmt = select(Incident).where(Incident.id == room_id)
                res = await session.execute(stmt)
                incident = res.scalar_one_or_none()

                if incident and incident.phase == "evaluating":
                    stmt_dissent = select(Dissent).where(Dissent.room_id == incident.id).order_by(desc(Dissent.created_at)).limit(1)
                    res_dissent = await session.execute(stmt_dissent)
                    dissent_row = res_dissent.scalar_one_or_none()

                    leading_option = None
                    if dissent_row:
                        stmt_opt = select(RecoveryOption).where(RecoveryOption.id == dissent_row.target_option_id)
                        res_opt = await session.execute(stmt_opt)
                        leading_option = res_opt.scalar_one_or_none()

                    incident.phase = "awaiting_approval"
                    await session.commit()

                    await publish_room_event(
                        kind="phase_change",
                        room_id=str(room_id),
                        ts=datetime.now(timezone.utc),
                        payload={"phase": "awaiting_approval", "old_phase": "evaluating", "new_phase": "awaiting_approval"},
                        redis_client=redis_client,
                    )

                    if dissent_row and leading_option:
                        status_label = "CONTESTED" if dissent_row.material else "UNCONTESTED"
                        recommendation_msg = (
                            f"Sentinel has completed evaluation.\n\n"
                            f"Recommendation: Option #{leading_option.id} ({leading_option.type} option proposed by {leading_option.proposer})\n"
                            f"Status: {status_label}\n"
                            f"Recorded Objection: \"{dissent_row.objection}\"\n"
                            f"Basis: {dissent_row.basis}\n\n"
                            f"Transitioning incident to 'awaiting_approval' phase for Ops Manager review."
                        )
                    else:
                        recommendation_msg = (
                            "Sentinel has completed evaluation and transitioned to 'awaiting_approval' phase. "
                            "Awaiting Ops Manager decision."
                        )
                    await room_bus.send(session, room_id, ROLE, recommendation_msg, mentions=[])
            return

        # Every proposing/annotating agent (logistics, carrier, procurement,
        # customer_impact, finance) already persists its own RecoveryOption row
        # directly and publishes its own "option_added" room_event right after —
        # Sentinel used to *also* blindly re-parse any message's fenced-JSON
        # option block and insert another row here, which duplicated every single
        # proposal (and tripled it for Finance's re-annotated repost) since every
        # proposing message's JSON is a copy of data already saved. Removed
        # rather than deduped: there's no case where an agent posts a parseable
        # option without having already persisted it itself, so this block was
        # pure duplication, not a useful fallback.

        # Check if Sentinel is mentioned to drive the phase change
        if ROLE in mentions:
            print("Sentinel mentioned. Advancing phase.")
            async with SessionLocal() as session:
                stmt = select(Incident).where(Incident.id == room_id)
                res = await session.execute(stmt)
                incident = res.scalar_one_or_none()
                if incident and incident.phase == "negotiating":
                    incident.phase = "options_collected"
                    await session.commit()
                    print(f"Advanced Incident #{incident.id} phase to options_collected.")

                    await publish_room_event(
                        kind="phase_change",
                        room_id=str(room_id),
                        ts=datetime.now(timezone.utc),
                        payload={"phase": "options_collected", "old_phase": "negotiating", "new_phase": "options_collected"},
                        redis_client=redis_client,
                    )

                    await room_bus.send(
                        session, room_id, ROLE,
                        "Sentinel has collected all recovery options. Advancing to evaluation phase.",
                        mentions=[],
                    )

                    asyncio.create_task(run_evaluation_pipeline(incident.id, redis_client))

    except Exception as e:
        print(f"Error in on_room_message: {e}")
        import traceback
        traceback.print_exc()


async def listen_disruptions(redis_client) -> None:
    print("Sentinel background listener for Redis 'disruptions' channel started")
    while True:
        listener_client = get_redis_client()
        pubsub = listener_client.pubsub()
        try:
            await pubsub.subscribe("disruptions")
            print("Sentinel successfully subscribed to Redis 'disruptions'")
            while True:
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if message and message["type"] == "message":
                    try:
                        data = json.loads(message["data"])
                        print(f"\n[Sentinel] Received disruption event: {data}")

                        event_id = data.get("event_id")
                        vessel = data.get("vessel")
                        port = data.get("port")
                        disruption_type = data.get("type")
                        severity = data.get("severity")

                        if not event_id:
                            print("Warning: Received disruption message without event_id. Skipping.")
                            continue

                        async with SessionLocal() as session:
                            # 1. Insert Incident row (its id doubles as the room id)
                            incident = Incident(event_id=event_id, phase="detected")
                            session.add(incident)
                            await session.commit()
                            await session.refresh(incident)
                            room_id = await room_bus.create_room(session, incident.id, title=f"Incident #{event_id} — {vessel} @ {port}")
                            print(f"Opened room for Incident #{incident.id}.")

                            # 2. Resolve affected parties
                            parties = await resolve_affected_parties(session, vessel=vessel, arrival_port=port)
                            print(f"Resolved {len(parties)} affected party matches.")

                            for p in parties:
                                party = AffectedParty(
                                    event_id=event_id,
                                    importer_name=p.importer_name,
                                    cargo_desc=p.cargo_desc,
                                    bol_ref=p.bol_ref,
                                    inferred=p.inferred,
                                    basis=p.basis,
                                    source=p.source,
                                    source_url=p.source_url,
                                )
                                session.add(party)
                            await session.commit()
                            print("Saved AffectedParty rows to DB.")

                            # 3. Recruit the negotiating agents (idempotent Participant insert)
                            recruits = registry.all_recruitable()
                            for role in recruits:
                                await room_bus.recruit(session, room_id, role, framework=FRAMEWORK_BY_ROLE.get(role))
                            print("Recruited all agents into the room.")

                            # 4. Publish room_created and agent_recruited events
                            await publish_room_event(
                                kind="room_created",
                                room_id=str(room_id),
                                ts=datetime.now(timezone.utc),
                                payload={
                                    "incident_id": incident.id,
                                    "vessel": vessel,
                                    "port": port,
                                    "detected_at": incident.created_at.isoformat() if incident.created_at else datetime.now(timezone.utc).isoformat(),
                                },
                                redis_client=redis_client,
                            )
                            for role in recruits:
                                await publish_room_event(
                                    kind="agent_recruited",
                                    room_id=str(room_id),
                                    ts=datetime.now(timezone.utc),
                                    payload={
                                        "role": role,
                                        "agent_id": f"agent-{role}",
                                        "framework": FRAMEWORK_BY_ROLE.get(role, "AI/ML API"),
                                        "status": "active",
                                    },
                                    redis_client=redis_client,
                                )

                            # 5. Seed context and mention Logistics, Procurement, Customer-Impact
                            context_text = f"Incident Manifest:\n- Vessel: {vessel}\n- Port: {port}\n- Disruption: {disruption_type} ({severity})\n\nAffected Importers:\n"
                            for p in parties:
                                label = "[INFERRED]" if p.inferred else "[FACT]"
                                context_text += f"- {p.importer_name} ({p.cargo_desc or 'General Cargo'}) - {label}\n"
                            context_text += "\nBaseline D&D Exposure: [Pending Finance Calculation]\n"

                            targets = ["logistics", "procurement", "customer_impact"]
                            mention_prefix = " ".join(f"@{r}" for r in targets)
                            msg_content = f"{mention_prefix} Please evaluate recovery options for this incident.\n\n{context_text}"
                            await room_bus.send(session, room_id, ROLE, msg_content, mentions=targets)

                            # 6. Advance phase to negotiating
                            incident.phase = "negotiating"
                            await session.commit()

                            await publish_room_event(
                                kind="phase_change",
                                room_id=str(room_id),
                                ts=datetime.now(timezone.utc),
                                payload={"phase": "negotiating", "old_phase": "detected", "new_phase": "negotiating"},
                                redis_client=redis_client,
                            )
                            print("Room seeded and handoff driven to Logistics.")

                    except Exception as ex:
                        print(f"Error processing disruption message: {ex}")
                        import traceback
                        traceback.print_exc()
                await asyncio.sleep(0.1)
        except asyncio.CancelledError:
            print("Disruption listener task cancelled.")
            break
        except Exception as e:
            print(f"Error in listen_disruptions: {e}. Retrying in 5 seconds...")
            await asyncio.sleep(5)
        finally:
            try:
                await pubsub.unsubscribe("disruptions")
            except Exception:
                pass
            try:
                await listener_client.aclose()
            except Exception:
                pass


async def listen_decisions(redis_client) -> None:
    print("Sentinel background listener for Redis 'decisions' channel started")
    while True:
        listener_client = get_redis_client()
        pubsub = listener_client.pubsub()
        try:
            await pubsub.subscribe("decisions")
            print("Sentinel successfully subscribed to Redis 'decisions'")
            while True:
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if message and message["type"] == "message":
                    try:
                        data = json.loads(message["data"])
                        print(f"\n[Sentinel Decisions] Received human decision event: {data}")

                        incident_id = data.get("incident_id")
                        action = data.get("action")
                        actor = data.get("actor")
                        reason = data.get("reason")
                        option_id = data.get("option_id")

                        if not incident_id or not action:
                            continue

                        async with SessionLocal() as session:
                            stmt = select(Incident).where(Incident.id == incident_id)
                            res = await session.execute(stmt)
                            incident = res.scalar_one_or_none()

                            if incident:
                                room_id = incident.id
                                old_phase = incident.phase

                                decision_row = Decision(
                                    room_id=incident_id,
                                    option_id=option_id,
                                    human_action=action,
                                    actor=actor,
                                    reason=reason,
                                )
                                session.add(decision_row)

                                # Trust the phase the REST decision endpoint already computed
                                # and committed (see backend/main.py::record_decision) instead
                                # of re-deriving it here — two independent derivations of the
                                # same value previously used different string conventions
                                # ("approve" vs "approved") and raced with each other.
                                new_phase = data.get("new_phase") or ("approved" if action == "approved" else "rejected")
                                incident.phase = new_phase
                                await session.commit()
                                print(f"[Sentinel Decisions] Incident #{incident_id} phase updated to {incident.phase}")

                                await publish_room_event(
                                    kind="phase_change",
                                    room_id=str(room_id),
                                    ts=datetime.now(timezone.utc),
                                    payload={"phase": new_phase, "old_phase": old_phase, "new_phase": new_phase},
                                    redis_client=redis_client,
                                )

                                await publish_room_event(
                                    kind="decision",
                                    room_id=str(room_id),
                                    ts=datetime.now(timezone.utc),
                                    payload={"action": action, "actor": actor, "option_id": option_id, "reason": reason},
                                    redis_client=redis_client,
                                )

                                post_content = (
                                    f"Ops Manager @here {actor} {action.upper()} option #{option_id} — proceeding.\n"
                                    f"Reason: {reason}"
                                )
                                await room_bus.send(session, room_id, ROLE, post_content, mentions=[])

                    except Exception as ex:
                        print(f"Error processing decision message: {ex}")
                        import traceback
                        traceback.print_exc()
                await asyncio.sleep(0.1)
        except asyncio.CancelledError:
            print("Decisions listener task cancelled.")
            break
        except Exception as e:
            print(f"Error in listen_decisions: {e}. Retrying in 5 seconds...")
            await asyncio.sleep(5)
        finally:
            try:
                await pubsub.unsubscribe("decisions")
            except Exception:
                pass
            try:
                await listener_client.aclose()
            except Exception:
                pass


async def main():
    print("Starting Sentinel Agent (room coordinator)")

    redis_client = get_redis_client()

    async def room_message_handler(data: dict):
        await on_room_message(data, redis_client)

    # Sentinel sees every room message (role=None), unlike the negotiating
    # agents which only wake on their own @mention.
    room_listener_task = asyncio.create_task(room_bus.subscribe(None, room_message_handler))
    disruptions_task = asyncio.create_task(listen_disruptions(redis_client))
    decisions_task = asyncio.create_task(listen_decisions(redis_client))

    print("\nSentinel is fully online, listening to room messages plus Redis 'disruptions' and 'decisions'...")
    try:
        while True:
            await asyncio.sleep(3600)
    except KeyboardInterrupt:
        print("Shutting down Sentinel...")
    finally:
        room_listener_task.cancel()
        disruptions_task.cancel()
        decisions_task.cancel()
        await redis_client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
