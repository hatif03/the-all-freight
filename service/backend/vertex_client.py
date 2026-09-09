"""Vertex AI Gemini client for the backend's own use (the planning-flow proxy
endpoints below `/llm/*` in main.py) — separate from agents/model_router.py
because backend/ and agents/ are independent uv projects.

Same design as model_router.py: Application Default Credentials (no API key —
the attached service account on the deployed VM provides these automatically;
locally, `gcloud auth application-default login`), refreshed fresh on every
call since Vertex tokens expire after ~1 hour and this process runs for days.
"""

import google.auth
import google.auth.transport.requests
from openai import OpenAI

from config import settings

VERTEX_BASE_URL = (
    f"https://{settings.GCP_LOCATION}-aiplatform.googleapis.com/v1beta1/"
    f"projects/{settings.GCP_PROJECT_ID}/locations/{settings.GCP_LOCATION}/endpoints/openapi"
)
DEFAULT_MODEL = settings.GEMINI_MODEL

_credentials = None


def _vertex_access_token() -> str:
    global _credentials
    if _credentials is None:
        _credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    if not _credentials.valid:
        _credentials.refresh(google.auth.transport.requests.Request())
    return _credentials.token


def client() -> OpenAI:
    return OpenAI(api_key=_vertex_access_token(), base_url=VERTEX_BASE_URL)
