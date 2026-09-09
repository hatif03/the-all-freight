import json
import re
from pydantic import BaseModel

class RecoveryOptionMsg(BaseModel):
    """
    Structured message representation of a recovery option proposed by an agent.
    """
    proposer: str
    type: str
    feasibility: str
    eta_delta_hours: float | None = None
    cost_delta: float | None = None
    risk: str | None = None
    rationale: str | None = None

def parse_option(text: str) -> RecoveryOptionMsg | None:
    """
    Parses a fenced json block from the message text and returns a RecoveryOptionMsg.
    Returns None if no valid json block is found or parsing fails.
    """
    pattern = r"```json\s*([\s\S]*?)\s*```"
    match = re.search(pattern, text)
    if not match:
        # Try parsing raw text if no code blocks are present
        try:
            data = json.loads(text.strip())
            return RecoveryOptionMsg(**data)
        except Exception:
            return None
            
    json_str = match.group(1)
    try:
        data = json.loads(json_str)
        return RecoveryOptionMsg(**data)
    except Exception:
        return None

def format_message(text: str, option: RecoveryOptionMsg, mentions: list[dict] = None) -> str:
    """
    Formats a message with human-readable text, @mentions, and a fenced json block containing the option.
    """
    mention_prefix = ""
    if mentions:
        # mentions should be a list of participant dictionaries: {"handle": "..."}
        mention_prefix = " ".join([f"@{m['handle']}" for m in mentions if m.get("handle")])
        if mention_prefix:
            mention_prefix += " "
            
    option_json = option.model_dump_json(indent=2)
    return f"{mention_prefix}{text}\n\n```json\n{option_json}\n```"
