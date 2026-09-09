import os
import sys
import json
import asyncio
from dotenv import load_dotenv

if sys.platform.startswith("win"):
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

# Ensure backend and agents directories are in sys.path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "../../backend")))
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

# Load environment variables
load_dotenv(dotenv_path=os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.env")))

# Configure OpenAI client to use AIMLAPI endpoint as fallback if no standard OPENAI_API_KEY
aiml_key = os.getenv("AIMLAPI_KEY")
if aiml_key and not os.getenv("OPENAI_API_KEY"):
    os.environ["OPENAI_API_KEY"] = aiml_key
    os.environ["OPENAI_BASE_URL"] = "https://api.aimlapi.com/v1"
    print("[Finance] Configured OpenAI client to use AIMLAPI endpoint as fallback.")
elif not os.getenv("OPENAI_API_KEY"):
    os.environ["OPENAI_API_KEY"] = "mock-key-for-startup"
    print("[Finance] Dummy OPENAI_API_KEY configured for startup.")

from database import SessionLocal
from models import Incident, RecoveryOption, DisruptionEvent, Vessel, BolRecord
from cost import compute_dd_exposure
from sqlalchemy import select

from model_router import client_for

import room_bus
import protocol

ROLE = "finance"

# Global instances
llm_client = None
model_name = None


async def process_logistics_option(room_id: int, content: str):
    print(f"[Finance Agent] Processing message in room {room_id}")

    # Parse proposed option from the message
    opt_msg = protocol.parse_option(content)
    if not opt_msg:
        print("[Finance Agent] Message did not contain a valid RecoveryOptionMsg JSON block. Ignoring.")
        return

    if opt_msg.proposer not in ["logistics", "procurement"]:
        print(f"[Finance Agent] Ignoring option from non-logistics/procurement proposer: {opt_msg.proposer}")
        return

    print(f"[Finance Agent] Extracted option of type: {opt_msg.type}, ETA delta: {opt_msg.eta_delta_hours} hours")

    # 1. Resolve room context (carrier, port, equipment type, and baseline delay)
    carrier_name = "Maersk"
    port_name = "Port of Los Angeles"
    equipment_type = "Dry 40ft"
    baseline_days = 5.0

    async with SessionLocal() as session:
        stmt = select(Incident).where(Incident.id == room_id)
        res = await session.execute(stmt)
        incident = res.scalar_one_or_none()
        if incident:
            event_stmt = select(DisruptionEvent).where(DisruptionEvent.id == incident.event_id)
            event_res = await session.execute(event_stmt)
            event = event_res.scalar_one_or_none()
            if event:
                port_name = event.port or port_name
                vessel_stmt = select(Vessel).where(Vessel.mmsi == event.mmsi)
                vessel_res = await session.execute(vessel_stmt)
                vessel = vessel_res.scalar_one_or_none()
                if vessel:
                    bol_stmt = select(BolRecord).where(BolRecord.vessel_name == vessel.name).limit(1)
                    bol_res = await session.execute(bol_stmt)
                    bol = bol_res.scalar_one_or_none()
                    if bol:
                        carrier_name = bol.carrier or carrier_name
                        if bol.cargo_desc and "reefer" in bol.cargo_desc.lower():
                            equipment_type = "Reefer 40ft"

        # 2. Compute D&D costs
        option_eta_delta = opt_msg.eta_delta_hours or 0.0
        option_days = max(0.0, baseline_days + (option_eta_delta / 24.0))

        print(f"[Finance Agent] Calculating D&D for Carrier: {carrier_name}, Port: {port_name}, Equip: {equipment_type}")
        baseline_cost_data = await compute_dd_exposure(session, carrier_name, port_name, equipment_type, int(baseline_days))
        option_cost_data = await compute_dd_exposure(session, carrier_name, port_name, equipment_type, int(option_days))

        if baseline_cost_data.get("available") and option_cost_data.get("available"):
            baseline_amount = baseline_cost_data["amount"]
            option_amount = option_cost_data["amount"]
            cost_delta = option_amount - baseline_amount
            free_days = option_cost_data["free_days"]
            source_url = option_cost_data["source_url"]
            delta_label = f"${cost_delta:.2f}"
            rationale_text = (
                f"D&D cost delta of {delta_label} calculated using {carrier_name} tariff rules "
                f"({free_days} free days). Source: {source_url}"
            )
        else:
            baseline_amount = 0.0
            option_amount = 0.0
            cost_delta = None
            free_days = option_cost_data.get("free_days", 0)
            source_url = option_cost_data.get("source_url") or "No cited tariff source matched"
            delta_label = "unavailable"
            rationale_text = (
                "D&D tariff unavailable for this carrier/port/equipment combination; "
                f"{option_cost_data.get('basis') or baseline_cost_data.get('basis')}"
            )

        print(f"[Finance Agent] Baseline D&D: ${baseline_amount:.2f}, Option D&D: ${option_amount:.2f}, Delta: {delta_label}")

        # 3. Request LLM financial rationale citing source_url
        prompt = f"""You are the Finance Agent in a logistics war room.
Annotate the proposed logistics recovery option with a professional financial rationale.

Option details:
- Type: {opt_msg.type}
- ETA Delta: {opt_msg.eta_delta_hours} hours
- Risk: {opt_msg.risk}

Cost calculation parameters:
- Carrier: {carrier_name}
- Port: {port_name}
- Equipment: {equipment_type}
- Baseline Days: {baseline_days} days (Baseline D&D Cost: ${baseline_amount:.2f})
- Option Days: {option_days:.1f} days (Option D&D Cost: ${option_amount:.2f})
- Cost Delta: {delta_label}
- Free Days: {free_days} days
- Source URL: {source_url}

Respond ONLY with a JSON object in this format:
{{
  "rationale": "A 1-2 sentence explanation of the demurrage/detention costs, mentioning the free days ({free_days}), the cost delta ({delta_label}), and explicitly citing the source url: {source_url}."
}}
"""

        try:
            if cost_delta is None:
                raise ValueError("No cited tariff matched this option; skipping LLM cost rationale.")
            response = llm_client.chat.completions.create(
                model=model_name,
                messages=[
                    {"role": "system", "content": "You are a precise finance advisor. Output ONLY JSON, nothing else."},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.0,
                response_format={"type": "json_object"}
            )
            llm_content = response.choices[0].message.content.strip()
            parsed_llm = json.loads(llm_content)
            rationale_text = parsed_llm.get("rationale", rationale_text)
        except Exception as e:
            print(f"[Finance Agent] LLM rationale generation failed: {e}. Using fallback.")

        # 4. DB Persistence: Update options row
        if incident:
            opt_row_stmt = select(RecoveryOption).where(
                RecoveryOption.room_id == incident.id,
                RecoveryOption.proposer == opt_msg.proposer,
                RecoveryOption.type == opt_msg.type
            ).order_by(RecoveryOption.created_at.desc()).limit(1)
            opt_row_res = await session.execute(opt_row_stmt)
            opt_row = opt_row_res.scalar_one_or_none()
            if opt_row:
                opt_row.cost_delta = cost_delta
                opt_row.rationale = f"{opt_row.rationale or ''}\n\n[Finance Rationale]: {rationale_text}".strip()
                await session.commit()
                print(f"[Finance Agent] Updated RecoveryOption in DB: {opt_row.id} with cost_delta={cost_delta}")
            else:
                print(f"[Finance Agent] WARNING: RecoveryOption for room {room_id}, proposer={opt_msg.proposer}, type={opt_msg.type} not found in DB.")

    # 5. Format and post response back to room
    annotated_opt = protocol.RecoveryOptionMsg(
        proposer="finance",
        type=opt_msg.type,
        feasibility=opt_msg.feasibility,
        eta_delta_hours=opt_msg.eta_delta_hours,
        cost_delta=cost_delta,
        risk=opt_msg.risk,
        rationale=rationale_text
    )

    text = f"Finance agent has annotated the proposed '{opt_msg.type}' option with calculated D&D tariffs."
    formatted_message = protocol.format_message(text, annotated_opt, mentions=[{"handle": "sentinel"}])

    print(f"[Finance Agent] Sending cost-annotated option to room and mentioning sentinel...")
    async with SessionLocal() as session:
        await room_bus.send(session, room_id, ROLE, formatted_message, mentions=["sentinel"])


async def on_room_message(data: dict):
    room_id = int(data["room_id"])
    content = data.get("text") or ""
    print(f"[Finance Agent] Wake word detected in room {room_id}! Running D&D evaluation...")
    try:
        await process_logistics_option(room_id, content)
    except Exception as e:
        print(f"[Finance Agent Error] {e}")
        import traceback
        traceback.print_exc()


async def main():
    global llm_client, model_name

    print("Starting Finance Agent")
    llm_client, model_name = client_for("finance")

    print("\nFinance Agent is online and listening. Press Ctrl+C to exit.")
    try:
        await room_bus.subscribe(ROLE, on_room_message)
    except KeyboardInterrupt:
        print("Shutting down Finance Agent...")


if __name__ == "__main__":
    asyncio.run(main())
