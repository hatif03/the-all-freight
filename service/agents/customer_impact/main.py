import os
import sys
import asyncio
from dotenv import load_dotenv

# Ensure backend and agents directories are in sys.path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "../../backend")))
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

# Load environment variables
load_dotenv(dotenv_path=os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.env")))

from database import SessionLocal
from models import Incident, RecoveryOption, DisruptionEvent, AffectedParty
from sqlalchemy import select

from model_router import client_for

import room_bus
import protocol

ROLE = "customer_impact"


async def process_customer_impact(room_id: int):
    print(f"[Customer-Impact Agent] Assessing customer impact in room {room_id}...")

    # Built fresh on every call, not cached: Vertex AI access tokens expire
    # after ~1 hour, and this agent process runs indefinitely.
    llm_client, model_name = client_for("customer_impact")

    # 1. Resolve room context (affected parties / importers)
    affected_importers_text = ""
    async with SessionLocal() as session:
        stmt = select(Incident).where(Incident.id == room_id)
        res = await session.execute(stmt)
        incident = res.scalar_one_or_none()
        if incident:
            event_stmt = select(DisruptionEvent).where(DisruptionEvent.id == incident.event_id)
            event_res = await session.execute(event_stmt)
            event = event_res.scalar_one_or_none()
            if event:
                party_stmt = select(AffectedParty).where(AffectedParty.event_id == event.id)
                party_res = await session.execute(party_stmt)
                parties = party_res.scalars().all()
                if parties:
                    affected_importers_text = "\n".join([
                        f"- Importer: {p.importer_name}, Cargo: {p.cargo_desc or 'General Cargo'}"
                        for p in parties
                    ])

    # 2. Prepare LLM prompt
    prompt = f"""You are the Customer-Impact Agent in a supply chain war room.
Analyze these affected importers/cargo and assess the downstream order and SLA (Service Level Agreement) impact.
Draft a professional, concise stakeholder communication update to inform them of the disruption.

Affected Cargo List:
{affected_importers_text or '- No importer records found.'}

Determine:
- Downstream SLA/order risks and penalties.
- A stakeholder comms note draft summarizing the delay and cargo impact, explicitly addressing the importers listed above (e.g. Costco, Target, or whoever is in the cargo list).

Respond ONLY with a valid JSON block inside a Markdown code block like this:
```json
{{
  "proposer": "customer_impact",
  "type": "sla_assessment",
  "feasibility": "High",
  "eta_delta_hours": 0.0,
  "cost_delta": null,
  "risk": "<summary of SLA/order risks and penalties>",
  "rationale": "<draft of the stakeholder communication update>"
}}
```
"""

    try:
        response = llm_client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": "You are a customer relationship and logistics expert. Output ONLY JSON, nothing else."},
                {"role": "user", "content": prompt}
            ],
            temperature=0.0,
            response_format={"type": "json_object"}
        )
        llm_content = response.choices[0].message.content.strip()
        opt = protocol.parse_option(llm_content)
        if opt:
            # 3. Persist option to DB
            async with SessionLocal() as session:
                stmt = select(Incident).where(Incident.id == room_id)
                res = await session.execute(stmt)
                incident = res.scalar_one_or_none()
                if incident:
                    option_row = RecoveryOption(
                        room_id=incident.id,
                        proposer="customer_impact",
                        type=opt.type,
                        feasibility=opt.feasibility,
                        eta_delta_hours=opt.eta_delta_hours,
                        cost_delta=None,
                        risk=opt.risk,
                        rationale=opt.rationale
                    )
                    session.add(option_row)
                    await session.commit()
                    print(f"[Customer-Impact] Persisted customer impact assessment to DB.")

            # 4. Format and post response back to room, mentioning sentinel
            text = "Customer-Impact agent has assessed SLA exposure and drafted stakeholder communications."
            formatted_message = protocol.format_message(text, opt, mentions=[{"handle": "sentinel"}])

            async with SessionLocal() as session:
                await room_bus.send(session, room_id, ROLE, formatted_message, mentions=["sentinel"])
    except Exception as e:
        print(f"[Customer-Impact Agent] Failed to process customer impact: {e}")


async def on_room_message(data: dict):
    room_id = int(data["room_id"])
    print(f"[Customer-Impact Agent] Wake word detected in room {room_id}! Generating SLA/comms assessment...")
    try:
        await process_customer_impact(room_id)
    except Exception as e:
        print(f"[Customer-Impact Agent Error] {e}")
        import traceback
        traceback.print_exc()


async def main():
    print("Starting Customer-Impact Agent")

    print("\nCustomer-Impact Agent is online and listening. Press Ctrl+C to exit.")
    try:
        await room_bus.subscribe(ROLE, on_room_message)
    except KeyboardInterrupt:
        print("Shutting down Customer-Impact Agent...")


if __name__ == "__main__":
    asyncio.run(main())
