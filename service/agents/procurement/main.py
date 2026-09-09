import os
import sys
import asyncio
from dotenv import load_dotenv

if sys.platform.startswith("win"):
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

# Ensure backend and agents directories are in sys.path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "../../backend")))
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

# Load environment variables
load_dotenv(dotenv_path=os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.env")))

from datetime import datetime, timezone

from database import SessionLocal
from models import Incident, RecoveryOption, DisruptionEvent, AffectedParty
from sqlalchemy import select
from events import publish_room_event

from model_router import client_for
from crewai import Agent, Task, Crew, Process, LLM

import room_bus
import protocol

ROLE = "procurement"


async def process_procurement(room_id: int) -> None:
    print(f"[Procurement Agent] Evaluating alternate-supply options in room {room_id}...")

    # 1. Resolve room context (disruption + affected cargo/importers)
    port = disruption_type = severity = ""
    affected_text = ""
    async with SessionLocal() as session:
        stmt = select(Incident).where(Incident.id == room_id)
        res = await session.execute(stmt)
        incident = res.scalar_one_or_none()
        if incident:
            event_stmt = select(DisruptionEvent).where(DisruptionEvent.id == incident.event_id)
            event_res = await session.execute(event_stmt)
            event = event_res.scalar_one_or_none()
            if event:
                port = event.port or ""
                disruption_type = event.type or ""
                severity = event.severity or ""
                party_stmt = select(AffectedParty).where(AffectedParty.event_id == event.id)
                party_res = await session.execute(party_stmt)
                parties = party_res.scalars().all()
                if parties:
                    affected_text = "\n".join(
                        f"- {p.importer_name}: {p.cargo_desc or 'General Cargo'}" for p in parties
                    )

    # 2. Run a single-agent CrewAI crew to propose one alternate-supply option
    task_description = f"""A vessel disruption ({disruption_type or 'unspecified'}, severity {severity or 'unknown'}) is holding cargo at {port or 'the affected port'}.

Affected cargo/importers:
{affected_text or '- No importer records found.'}

Propose ONE concrete alternate-supply or substitution recovery option for the at-risk cargo
(e.g. sourcing a substitute from an alternate supplier or safety-stock warehouse, splitting the
shipment, or air-freighting a partial replacement) that reduces the importers' delivery impact.

Respond with ONLY a fenced json code block in exactly this shape:
```json
{{
  "proposer": "procurement",
  "type": "alternate_supply",
  "feasibility": "High|Medium|Low",
  "eta_delta_hours": <float; hours the affected importers gain (negative) or still lose (positive) vs. doing nothing>,
  "cost_delta": null,
  "risk": "<one sentence on supply/substitution risk>",
  "rationale": "<1-3 sentence business rationale>"
}}
```"""

    # Built fresh on every call, not cached: Vertex AI access tokens expire
    # after ~1 hour, and this agent process runs indefinitely.
    openai_client, model_name = client_for("procurement")
    llm = LLM(
        model=f"openai/{model_name}",
        api_key=openai_client.api_key,
        base_url=str(openai_client.base_url),
        temperature=0.0,
    )

    procurement_agent = Agent(
        role="Procurement Specialist",
        goal="Find alternate-supply and substitution options that reduce customer impact from a shipping disruption.",
        backstory=(
            "A veteran procurement lead who keeps a mental map of alternate suppliers, "
            "safety-stock warehouses, and expedite-shipping options for every SKU the "
            "company imports, and is always the first call when a shipment goes sideways."
        ),
        llm=llm,
        verbose=False,
    )
    task = Task(
        description=task_description,
        expected_output="A single fenced ```json``` block matching the RecoveryOptionMsg schema shown in the prompt, nothing else.",
        agent=procurement_agent,
    )
    crew = Crew(agents=[procurement_agent], tasks=[task], process=Process.sequential, verbose=False)

    try:
        result = await crew.kickoff_async()
        raw = getattr(result, "raw", None) or str(result)
    except Exception as e:
        print(f"[Procurement Agent] CrewAI kickoff failed: {e}")
        return

    opt = protocol.parse_option(raw)
    if not opt:
        print("[Procurement Agent] CrewAI output did not contain a valid RecoveryOptionMsg JSON block. Ignoring.")
        return

    # 3. Persist + post to the room, mentioning finance (same handoff Logistics uses)
    async with SessionLocal() as session:
        stmt = select(Incident).where(Incident.id == room_id)
        res = await session.execute(stmt)
        incident = res.scalar_one_or_none()
        if incident:
            option_row = RecoveryOption(
                room_id=incident.id,
                proposer="procurement",
                type=opt.type,
                feasibility=opt.feasibility,
                eta_delta_hours=opt.eta_delta_hours,
                cost_delta=None,  # Finance agent fills this in
                risk=opt.risk,
                rationale=opt.rationale,
            )
            session.add(option_row)
            await session.commit()
            print("[Procurement Agent] Persisted alternate-supply option to DB.")
            await publish_room_event(
                kind="option_added",
                room_id=str(room_id),
                ts=datetime.now(timezone.utc),
                payload={"proposer": "procurement", "count": 1},
            )
        else:
            print(f"[Procurement Agent] WARNING: Incident for room {room_id} not found in DB. Option will not be persisted.")

        text = "Procurement has identified an alternate-supply option for the at-risk cargo."
        formatted_message = protocol.format_message(text, opt, mentions=[{"handle": "finance"}])
        print("[Procurement Agent] Posting option to room and mentioning finance...")
        await room_bus.send(session, room_id, ROLE, formatted_message, mentions=["finance"])


async def on_room_message(data: dict) -> None:
    room_id = int(data["room_id"])
    print(f"[Procurement Agent] Wake word detected in room {room_id}! Running CrewAI evaluation...")
    try:
        await process_procurement(room_id)
    except Exception as e:
        print(f"[Procurement Agent Error] {e}")
        import traceback
        traceback.print_exc()


async def main():
    print("Starting Procurement Agent (CrewAI)")
    # The CrewAI LLM itself is built fresh inside process_procurement on every
    # call — see its comment. The "openai/" model prefix routes CrewAI's LLM
    # through its native OpenAI-compatible chat-completions path against our
    # custom base_url (confirmed: resolves provider="openai", not litellm).

    print("\nProcurement Agent is online and listening. Press Ctrl+C to exit.")
    try:
        await room_bus.subscribe(ROLE, on_room_message)
    except KeyboardInterrupt:
        print("Shutting down Procurement Agent...")


if __name__ == "__main__":
    asyncio.run(main())
