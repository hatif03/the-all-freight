"""Per-agent-role model router.

Two providers, both spoken via the OpenAI-compatible chat-completions shape
so every framework (LangGraph's ChatOpenAI, PydanticAI, CrewAI's LLM, and
plain openai-SDK calls) can use the same client-construction pattern:

- Vertex AI Gemini for the four roles doing straightforward structured
  extraction/annotation: Logistics, Finance, Procurement, Customer-Impact.
  Billed through standard Cloud Billing (not the separate Gemini Developer
  API prepay wallet), authenticated with Application Default Credentials —
  no API key to manage: `gcloud auth application-default login` locally, or
  the attached service account automatically when deployed on GCP.
- K2 Think (MBZUAI/IFM) for the two roles that most need strong multi-step
  reasoning: Carrier's tariff-grounded negotiation, and Dissent's adversarial
  critique — deliberately a different model than the other four, so Dissent
  isn't the same model arguing with itself. Plain static API key, no OAuth.

IMPORTANT: Vertex AI access tokens expire after about an hour, unlike a
static API key. Callers on the Vertex path MUST call `client_for(role)`
fresh for every LLM call (not once at agent startup and reused) — this
module handles the actual refresh (cheap: google-auth no-ops until the
cached token is within its expiry window), but a stale *client instance*
built long ago still carries whatever token string it was constructed with.
"""

import os

import google.auth
import google.auth.transport.requests
from openai import OpenAI

GCP_PROJECT_ID = os.getenv("GCP_PROJECT_ID", "")
GCP_LOCATION = os.getenv("GCP_LOCATION", "us-central1")
VERTEX_BASE_URL = (
    f"https://{GCP_LOCATION}-aiplatform.googleapis.com/v1beta1/"
    f"projects/{GCP_PROJECT_ID}/locations/{GCP_LOCATION}/endpoints/openapi"
)
K2THINK_BASE_URL = "https://api.k2think.ai/v1"

ROLE_PROVIDER = {
    "logistics": "vertex",
    "finance": "vertex",
    "procurement": "vertex",
    "customer_impact": "vertex",
    "carrier": "k2think",
    "dissent": "k2think",
}

ROLE_MODELS = {
    "logistics": "google/gemini-2.5-flash",
    "finance": "google/gemini-2.5-flash",
    "procurement": "google/gemini-2.5-flash",
    "customer_impact": "google/gemini-2.5-flash",
    "carrier": "MBZUAI-IFM/K2-Think-v2",
    "dissent": "MBZUAI-IFM/K2-Think-v2",
}

_credentials = None


def _vertex_access_token() -> str:
    """Return a valid OAuth2 access token, refreshing it if it's expired or
    about to expire. `google.auth.default()` picks up Application Default
    Credentials — a local `gcloud auth application-default login`, or the
    metadata-server-provided service account when running on GCP.
    """
    global _credentials
    if _credentials is None:
        _credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    if not _credentials.valid:
        _credentials.refresh(google.auth.transport.requests.Request())
    return _credentials.token


def client_for(role: str):
    """Given an agent role, return a configured OpenAI-compatible client
    (Vertex AI Gemini or K2 Think, per ROLE_PROVIDER) along with the
    corresponding model id.

    For Vertex-routed roles, call this fresh for every LLM call — see the
    module docstring.
    """
    if role not in ROLE_PROVIDER:
        raise ValueError(f"Unknown agent role: {role}. Must be one of {list(ROLE_PROVIDER.keys())}")

    if ROLE_PROVIDER[role] == "vertex":
        api_key = _vertex_access_token()
        base_url = VERTEX_BASE_URL
    else:
        api_key = os.getenv("K2THINK_API_KEY", "")
        base_url = K2THINK_BASE_URL

    client = OpenAI(api_key=api_key or "", base_url=base_url)
    return client, ROLE_MODELS[role]
