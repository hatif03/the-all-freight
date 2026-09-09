"""Per-agent-role model router.

Two providers, both spoken via the OpenAI-compatible chat-completions shape
so every framework (LangGraph's ChatOpenAI, PydanticAI, CrewAI's LLM, and
plain openai-SDK calls) can use the same client-construction pattern:

- Gemini (Google) for the four roles doing straightforward structured
  extraction/annotation: Logistics, Finance, Procurement, Customer-Impact.
- K2 Think (MBZUAI/IFM) for the two roles that most need strong multi-step
  reasoning: Carrier's tariff-grounded negotiation, Dissent's adversarial
  critique — deliberately a different model than the other four, so Dissent
  isn't the same model arguing with itself.
"""

import os

from openai import OpenAI

GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
K2THINK_BASE_URL = "https://api.k2think.ai/v1"

ROLE_PROVIDER = {
    "logistics": "gemini",
    "finance": "gemini",
    "procurement": "gemini",
    "customer_impact": "gemini",
    "carrier": "k2think",
    "dissent": "k2think",
}

ROLE_MODELS = {
    "logistics": "gemini-3.6-flash",
    "finance": "gemini-3.6-flash",
    "procurement": "gemini-3.6-flash",
    "customer_impact": "gemini-3.6-flash",
    "carrier": "MBZUAI-IFM/K2-Think-v2",
    "dissent": "MBZUAI-IFM/K2-Think-v2",
}


def client_for(role: str):
    """Given an agent role, return a configured OpenAI-compatible client
    (Gemini or K2 Think, per ROLE_PROVIDER) along with the corresponding
    model id.
    """
    if role not in ROLE_PROVIDER:
        raise ValueError(f"Unknown agent role: {role}. Must be one of {list(ROLE_PROVIDER.keys())}")

    if ROLE_PROVIDER[role] == "gemini":
        api_key = os.getenv("GEMINI_API_KEY", "")
        base_url = GEMINI_BASE_URL
    else:
        api_key = os.getenv("K2THINK_API_KEY", "")
        base_url = K2THINK_BASE_URL

    client = OpenAI(api_key=api_key or "", base_url=base_url)
    return client, ROLE_MODELS[role]
