"""Per-agent-role model router.

Rather than one model for every agent, each role gets an LLM matched to its
job (see docs/MODEL_ROUTING.md for the rationale) via one OpenAI-compatible
gateway (AI/ML API), so swapping a role's model is a config change, not code.
"""

import os

from openai import OpenAI

ROLE_MODELS = {
    "logistics": "gpt-4o",
    "finance": "mistral-nemo",
    "carrier": "claude-sonnet-4-6",
    "dissent": "google/gemma-3-4b-it",  # different model = genuine adversary
    "procurement": "gpt-4o",
    "customer_impact": "gpt-4o-mini",
}


def client_for(role: str):
    """Given an agent role, return a configured OpenAI-compatible client
    pointing at the AI/ML API, along with the corresponding model id.
    """
    if role not in ROLE_MODELS:
        raise ValueError(f"Unknown agent role: {role}. Must be one of {list(ROLE_MODELS.keys())}")

    # Retrieve API key, falling back to OPENAI_API_KEY if AIMLAPI_KEY is not set
    api_key = os.getenv("AIMLAPI_KEY") or os.getenv("OPENAI_API_KEY")
    base_url = os.getenv("AIMLAPI_BASE_URL", "https://api.aimlapi.com/v1")

    client = OpenAI(api_key=api_key or "", base_url=base_url)
    return client, ROLE_MODELS[role]
