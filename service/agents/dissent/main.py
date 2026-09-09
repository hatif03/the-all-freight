import os
import sys
import json
import asyncio
import re
from dotenv import load_dotenv

if sys.platform.startswith("win"):
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

# Ensure backend and agents directories are in sys.path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "../../backend")))
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

# Load environment variables
load_dotenv(dotenv_path=os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.env")))

# Configure OpenAI client fallback for AIMLAPI
aiml_key = os.getenv("AIMLAPI_KEY")
if aiml_key and not os.getenv("OPENAI_API_KEY"):
    os.environ["OPENAI_API_KEY"] = aiml_key
    os.environ["OPENAI_BASE_URL"] = "https://api.aimlapi.com/v1"
    print("[Dissent] Configured OpenAI client to use AIMLAPI endpoint as fallback.")

from database import SessionLocal  # noqa: E402
from models import Incident, RecoveryOption, Dissent  # noqa: E402
from sqlalchemy import select  # noqa: E402

from model_router import client_for  # noqa: E402

import room_bus  # noqa: E402

ROLE = "dissent"

# Global instances
llm_client = None
model_name = None


async def generate_dissent(room_id: int, content: str, option_id: int):
    print(f"[Dissent Agent] Generating dissent for option {option_id} in room {room_id}")

    async with SessionLocal() as session:
        # 1. Load option & other options for comparison
        stmt_opt = select(RecoveryOption).where(RecoveryOption.id == option_id)
        res_opt = await session.execute(stmt_opt)
        target_option = res_opt.scalar_one_or_none()

        if not target_option:
            print(f"[Dissent Agent] Option #{option_id} not found in DB. Searching latest option for incident.")
            # Fallback to the latest option in this incident
            stmt_inc = select(Incident).where(Incident.id == room_id)
            res_inc = await session.execute(stmt_inc)
            incident = res_inc.scalar_one_or_none()
            if incident:
                stmt_opts = select(RecoveryOption).where(RecoveryOption.room_id == incident.id).order_by(RecoveryOption.created_at.desc())
                res_opts = await session.execute(stmt_opts)
                target_option = res_opts.scalars().first()
                if target_option:
                    option_id = target_option.id
        else:
            stmt_inc = select(Incident).where(Incident.id == target_option.room_id)
            res_inc = await session.execute(stmt_inc)
            incident = res_inc.scalar_one_or_none()

        if not target_option or not incident:
            print("[Dissent Agent] Could not resolve incident/option. Aborting.")
            return

        # Load all options for the incident to provide comparison context to the LLM
        stmt_all = select(RecoveryOption).where(RecoveryOption.room_id == incident.id)
        res_all = await session.execute(stmt_all)
        all_options = res_all.scalars().all()

        comparison_context = ""
        for opt in all_options:
            comparison_context += (
                f"- Option #{opt.id} ({opt.type}) proposed by {opt.proposer}: "
                f"feasibility={opt.feasibility}, eta_delta={opt.eta_delta_hours}h, "
                f"cost_delta=${opt.cost_delta or 0.0:.2f}, risk={opt.risk or 'N/A'}\n"
            )

        # 2. Invoke LLM to construct a critical objection
        prompt = f"""You are the Dissent Agent in a maritime supply-chain dispute war room.
Your role is to act as a critical adversary (devil's advocate). Analyze the proposed leading recovery option and construct a sharp, concrete objection.

Leading Option to Attack:
- ID: #{target_option.id}
- Proposer: {target_option.proposer}
- Type: {target_option.type}
- Feasibility: {target_option.feasibility}
- ETA Delta: {target_option.eta_delta_hours} hours
- Cost Delta: ${target_option.cost_delta or 0.0:.2f}
- Stated Risk: {target_option.risk or 'N/A'}
- Stated Rationale: {target_option.rationale or 'N/A'}

Other available options for this incident:
{comparison_context}

Construct the strongest possible objection to this leading option.
Examples of objection angles:
- For hold option: point out massive demurrage/detention (D&D) costs or port congestions.
- For reroute option: cite fuel spikes, distance, or terminal berth availability issues.
- For expedite option: mention potential port congestion or terminal overtime surcharges.
- For transship: note extra handling risk and cargo damage possibilities.

Respond ONLY with a JSON object in this format:
{{
  "objection": "A 1-2 sentence sharp, critical objection targeting the leading option's core weaknesses.",
  "material": true, // set to true if this objection is a major risk/blocker, false if minor
  "basis": "1 sentence describing the technical or commercial basis (e.g. carrier tariff, port dwell stats, or fuel cost trends)."
}}
"""

        objection_text = "demurrage and detention fees accrue rapidly under standard tariffs."
        is_material = True
        basis_text = "demurrage rates and port delays."

        try:
            response = llm_client.chat.completions.create(
                model=model_name,
                messages=[
                    {"role": "user", "content": f"System Context: You are a critical adversary. Output ONLY JSON, nothing else.\n\nUser Request:\n{prompt}"}
                ],
                temperature=0.7,
                response_format={"type": "json_object"}
            )
            llm_content = response.choices[0].message.content.strip()
            match = re.search(r"```json\s*([\s\S]*?)\s*```", llm_content)
            json_str = match.group(1) if match else llm_content

            parsed_llm = json.loads(json_str)
            objection_text = parsed_llm.get("objection", objection_text)
            is_material = parsed_llm.get("material", is_material)
            basis_text = parsed_llm.get("basis", basis_text)
        except Exception as e:
            print(f"[Dissent Agent] LLM generation failed: {e}. Using fallback objection.")

        print(f"[Dissent Agent] Dissent generated: objection='{objection_text}', material={is_material}")

        # 3. Save Dissent to DB
        dissent_row = Dissent(
            room_id=incident.id,
            target_option_id=target_option.id,
            objection=objection_text,
            material=is_material,
            basis=basis_text
        )
        session.add(dissent_row)
        await session.commit()
        await session.refresh(dissent_row)
        print(f"[Dissent Agent] Saved Dissent #{dissent_row.id} to DB.")

        # 4. Post response back to the room, mentioning sentinel
        reply_content = f"@sentinel Objection recorded for Option #{option_id}: \"{objection_text}\". Material: {is_material}. Basis: {basis_text}."
        await room_bus.send(session, incident.id, ROLE, reply_content, mentions=["sentinel"])


async def on_room_message(data: dict):
    room_id = int(data["room_id"])
    content = data.get("text") or ""
    print(f"[Dissent Agent] Wake word detected in room {room_id}! Message: {content}")

    # Parse option ID (e.g. "option #123" or "option 123" or "#123")
    option_id = None
    match = re.search(r"option\s*(?:#)?\s*(\d+)|#\s*(\d+)", content, re.IGNORECASE)
    if match:
        option_id_str = match.group(1) or match.group(2)
        if option_id_str:
            option_id = int(option_id_str)

    if option_id is None:
        print("[Dissent Agent] Could not parse option ID from message. Using fallback option analysis.")
        option_id = 0

    try:
        await generate_dissent(room_id, content, option_id)
    except Exception as e:
        print(f"[Dissent Agent Error] {e}")
        import traceback
        traceback.print_exc()


async def main():
    global llm_client, model_name

    print("Starting Dissent Agent")
    llm_client, model_name = client_for("dissent")

    print("\nDissent Agent is online and listening. Press Ctrl+C to exit.")
    try:
        await room_bus.subscribe(ROLE, on_room_message)
    except KeyboardInterrupt:
        print("Shutting down Dissent Agent...")


if __name__ == "__main__":
    asyncio.run(main())
