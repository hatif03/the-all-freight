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
from models import Incident, RecoveryOption
from sqlalchemy import select

from model_router import client_for
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages
from langchain_core.messages import BaseMessage, AIMessage, HumanMessage
from langchain_core.runnables import RunnableConfig
from pydantic import BaseModel, Field
from typing import Annotated, Sequence, TypedDict, List, Optional

import room_bus
import protocol

ROLE = "logistics"


# 1. State definition
class LogisticsState(TypedDict):
    messages: Annotated[Sequence[BaseMessage], add_messages]


# 2. Pydantic models for structured output
class ProposedOptionModel(BaseModel):
    type: str = Field(description="Must be one of: reroute, hold, expedite, transship")
    feasibility: str = Field(description="Feasibility level (e.g. High, Medium, Low)")
    eta_delta_hours: Optional[float] = Field(None, description="Delay change in hours (can be positive or negative float, or null)")
    risk: str = Field(description="Logistics risk details")
    rationale: str = Field(description="Detailed business rationale")


class LogisticsOptionsOutput(BaseModel):
    options: List[ProposedOptionModel] = Field(description="List of 1 to 2 concrete recovery options")


# Global instances (configured in main)
llm = None
compiled_graph = None


# 3. LangGraph node function
async def generate_options_node(state: LogisticsState, config: RunnableConfig):
    room_id = int(config["configurable"]["thread_id"])
    print(f"[Logistics Graph] generate_options_node running for room: {room_id}")

    messages = list(state["messages"])

    # We use ChatOpenAI with structured output
    structured_llm = llm.with_structured_output(LogisticsOptionsOutput)

    print(f"[Logistics Graph] Invoking LLM for structured options...")
    result = await structured_llm.ainvoke(messages)
    print(f"[Logistics Graph] LLM returned options: {result.options}")

    options_persisted = []

    # Persistence to DB
    async with SessionLocal() as session:
        stmt = select(Incident).where(Incident.id == room_id)
        res = await session.execute(stmt)
        incident = res.scalar_one_or_none()

        if incident:
            for opt in result.options:
                option_row = RecoveryOption(
                    room_id=incident.id,
                    proposer="logistics",
                    type=opt.type,
                    feasibility=opt.feasibility,
                    eta_delta_hours=opt.eta_delta_hours,
                    cost_delta=None,  # Finance agent will fill this
                    risk=opt.risk,
                    rationale=opt.rationale
                )
                session.add(option_row)
                options_persisted.append(opt)
            await session.commit()
            print(f"[Logistics Graph] Successfully persisted {len(options_persisted)} options to DB.")
        else:
            print(f"[Logistics Graph] WARNING: Incident for room {room_id} not found in DB. Options will not be persisted.")
            options_persisted = result.options

        # Format message and send to the room, mentioning finance
        for opt in options_persisted:
            opt_msg = protocol.RecoveryOptionMsg(
                proposer="logistics",
                type=opt.type,
                feasibility=opt.feasibility,
                eta_delta_hours=opt.eta_delta_hours,
                cost_delta=None,
                risk=opt.risk,
                rationale=opt.rationale
            )

            text = f"Logistics has analyzed the manifest and proposed a recovery plan."
            formatted_message = protocol.format_message(text, opt_msg, mentions=[{"handle": "finance"}])

            print(f"[Logistics Graph] Posting option to room {room_id} and mentioning finance...")
            await room_bus.send(session, room_id, ROLE, formatted_message, mentions=["finance"])

    return {"messages": [AIMessage(content="Proposed and persisted logistics recovery options.")]}


async def on_room_message(data: dict):
    room_id = data["room_id"]
    content = data.get("text") or ""
    print(f"[Logistics] Wake word detected in room {room_id}! Executing LangGraph workflow...")
    try:
        await compiled_graph.ainvoke(
            {"messages": [HumanMessage(content=content)]},
            config={"configurable": {"thread_id": room_id}},
        )
    except Exception as e:
        print(f"[Logistics Error] {e}")
        import traceback
        traceback.print_exc()


async def main():
    global llm, compiled_graph

    print("Starting Logistics Agent")

    # Configure ChatOpenAI LLM via the per-role model router (see model_router.py)
    openai_client, model_name = client_for("logistics")
    llm = ChatOpenAI(
        model=model_name,
        base_url=str(openai_client.base_url),
        api_key=openai_client.api_key
    )

    # Build the LangGraph workflow
    workflow = StateGraph(LogisticsState)
    workflow.add_node("generate_options", generate_options_node)
    workflow.add_edge(START, "generate_options")
    workflow.add_edge("generate_options", END)
    compiled_graph = workflow.compile(checkpointer=InMemorySaver())

    print("\nLogistics Agent is online and listening. Press Ctrl+C to exit.")
    try:
        await room_bus.subscribe(ROLE, on_room_message)
    except KeyboardInterrupt:
        print("Shutting down Logistics Agent...")


if __name__ == "__main__":
    asyncio.run(main())
