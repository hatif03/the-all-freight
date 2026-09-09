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

from database import SessionLocal
from models import Incident, RecoveryOption, DisruptionEvent, Vessel, BolRecord
from cost import compute_dd_exposure
from fmc_rules import fmc_dispute_facts_text
from sqlalchemy import select

from pydantic_ai import Agent as PydanticAgent
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic import BaseModel, Field
from typing import Optional

from model_router import client_for

import room_bus
import protocol

ROLE = "carrier"


# 1. Structured output definition
class CarrierCounterPosition(BaseModel):
    type: str = Field(description="Must be one of: reroute, hold, expedite, transship")
    feasibility: str = Field(description="Carrier feasibility (e.g. High, Medium, Low)")
    eta_delta_hours: Optional[float] = Field(None, description="Expected delay delta in hours")
    cost_delta: Optional[float] = Field(None, description="Additional tariff cost or waiver amount (positive or negative float)")
    risk: str = Field(description="Risks or constraints from the carrier perspective")
    rationale: str = Field(description="Tariff reference or contract basis for this position")


# Global instance (configured in main)
pydantic_agent = None


async def run_carrier_decision(room_id: int, message_content: str):
    print(f"[Carrier Flow] Running decision for room: {room_id}")

    # 1. Resolve room context (carrier name, port name, tariffs) + room history
    carrier_name = ""
    port_name = ""
    equipment_type = "dry"
    tariff_cost = None
    tariff_info = "No published tariff on file for this carrier/port/equipment combination; no cost was inferred."
    history_logs = []

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
                        if bol.cargo_desc and any(word in bol.cargo_desc.lower() for word in ["reefer", "refrigerated", "temperature"]):
                            equipment_type = "reefer"

        if carrier_name and port_name:
            tariff_cost = await compute_dd_exposure(session, carrier_name, port_name, equipment_type, days=7)
            if tariff_cost.get("available"):
                tiers = "; ".join(
                    f"{tier['range']}: {tier['days']} day(s) at ${tier['rate']}/day"
                    for tier in tariff_cost["tier_breakdown"]
                ) or "within free time"
                tariff_info = (
                    f"Carrier={carrier_name}; Port={port_name}; Equipment={equipment_type}; "
                    f"Free days={tariff_cost['free_days']}; Seven-day exposure=${tariff_cost['amount']:.2f}; "
                    f"Current meter=${tariff_cost['per_day']:.2f}/day; Tier breakdown={tiers}; "
                    f"Source={tariff_cost['source_url']}; Basis={tariff_cost['basis']}"
                )
            else:
                tariff_info = f"{tariff_cost['basis']} Source: no cited tariff source matched."
        else:
            missing = []
            if not carrier_name:
                missing.append("carrier")
            if not port_name:
                missing.append("port")
            tariff_info = f"Missing {' and '.join(missing)} context; no tariff cost was inferred."

        # 2. Pull room history for context (used to ground the counter-position)
        try:
            ctx_rows = await room_bus.get_context(session, room_id)
            history_logs = [f"[{row.sender_role}]: {row.text}" for row in ctx_rows]
        except Exception as e:
            print(f"[Carrier Flow] Failed to fetch room context: {e}")

    print(f"[Carrier Flow] Resolved Carrier: {carrier_name or 'unknown'}, Port: {port_name or 'unknown'}")

    room_history_text = "\n".join(history_logs) if history_logs else f"[User]: {message_content}"

    # 3. Formulate Prompt
    prompt = f"""
You are the Carrier-Counterpart agent representing carrier '{carrier_name}'.
A disruption has been detected at port '{port_name}'.

Active Demurrage / Detention Tariff Terms:
{tariff_info}

FMC Detention/Demurrage Dispute Facts:
{fmc_dispute_facts_text()}

Here is the conversation history in the room:
{room_history_text}

Logistics has proposed recovery options. As the Carrier:
1. Formulate a structured counter-position.
2. Select one of the logistics option types that is most feasible/acceptable for the carrier (or suggest a modified hold/reroute/expedite/transship).
3. Determine carrier feasibility (e.g. High, Medium, Low), eta_delta_hours, and carrier's proposed cost_delta only if the tariff terms above include a cited available tariff amount.
4. If no cited tariff is on file, set cost_delta to null and state that no published tariff is on file for this lane.
5. Provide risk details and a clear rationale referencing the specific tariff/free-time terms when available, plus the FMC dispute facts.

Ground your response only in the provided tariff rows and FMC facts. Do not invent carrier names, free days, per-day rates, or waiver amounts.
"""
    print(f"[Carrier Flow] Invoking PydanticAI model...")
    result = await pydantic_agent.run(prompt)
    print(f"[Carrier Flow] Model returned counter-position: {result.output}")
    if not tariff_cost or not tariff_cost.get("available"):
        result.output.cost_delta = None
        result.output.rationale = (
            f"{result.output.rationale}\n\n"
            f"No published tariff on file matched carrier={carrier_name or 'unknown'}, "
            f"port={port_name or 'unknown'}, equipment={equipment_type}; no tariff amount was inferred. "
            "Carrier position is grounded in FMC billing/dispute rules instead."
        ).strip()

    # 4. DB Persistence
    async with SessionLocal() as session:
        stmt = select(Incident).where(Incident.id == room_id)
        res = await session.execute(stmt)
        incident = res.scalar_one_or_none()

        if incident:
            option_row = RecoveryOption(
                room_id=incident.id,
                proposer="carrier",
                type=result.output.type,
                feasibility=result.output.feasibility,
                eta_delta_hours=result.output.eta_delta_hours,
                cost_delta=result.output.cost_delta,
                risk=result.output.risk,
                rationale=result.output.rationale,
                source="published_tariff" if tariff_cost and tariff_cost.get("available") else "fmc_rule",
                basis=tariff_info,
            )
            session.add(option_row)
            await session.commit()
            print(f"[Carrier Flow] Saved counter-position to DB.")
        else:
            print(f"[Carrier Flow] WARNING: Incident not found in DB. Counter-position will not be saved.")

    # 5. Post response to room, mentioning Sentinel
    await post_carrier_reply(room_id, result.output)


async def post_carrier_reply(room_id: int, data: CarrierCounterPosition):
    opt_msg = protocol.RecoveryOptionMsg(
        proposer="carrier",
        type=data.type,
        feasibility=data.feasibility,
        eta_delta_hours=data.eta_delta_hours,
        cost_delta=data.cost_delta,
        risk=data.risk,
        rationale=data.rationale,
    )

    text = "Carrier counterpart has posted a tariff-grounded counter-position."
    formatted_message = protocol.format_message(text, opt_msg, mentions=[{"handle": "sentinel"}])

    print(f"[Carrier Flow] Sending counter-position to room and mentioning sentinel...")
    async with SessionLocal() as session:
        await room_bus.send(session, room_id, ROLE, formatted_message, mentions=["sentinel"])


async def on_room_message(data: dict):
    room_id = int(data["room_id"])
    content = data.get("text") or ""
    print(f"[Carrier] Wake word detected in room {room_id}! Running Carrier decision flow...")
    try:
        await run_carrier_decision(room_id, content)
    except Exception as e:
        print(f"[Carrier Flow Error] Exception during carrier decision: {e}")
        import traceback
        traceback.print_exc()


async def main():
    global pydantic_agent

    print("Starting Carrier Agent")

    # Configure PydanticAI model via the per-role model router (K2 Think for Carrier).
    openai_client, model_name = client_for("carrier")
    model = OpenAIChatModel(
        model_name,
        provider=OpenAIProvider(api_key=openai_client.api_key, base_url=str(openai_client.base_url)),
    )
    pydantic_agent = PydanticAgent(
        model,
        output_type=CarrierCounterPosition,
        system_prompt="You are a professional ocean carrier representative negotiating supply chain disruptions.",
    )

    print("\nCarrier Agent is online and listening. Press Ctrl+C to exit.")
    try:
        await room_bus.subscribe(ROLE, on_room_message)
    except KeyboardInterrupt:
        print("Shutting down Carrier Agent...")


if __name__ == "__main__":
    asyncio.run(main())
