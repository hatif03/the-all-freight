import os
import json
from openai import OpenAI

# Default Featherless model to use
FEATHERLESS_MODEL = os.getenv("FEATHERLESS_MODEL", "Qwen/Qwen2.5-1.5B-Instruct")

def classify_event(event: dict) -> dict:
    """
    Classifies a vessel/port disruption event using a specialist open-source model on Featherless.

    Input:
        event (dict): A dictionary containing normalized disruption details:
            - vessel (str): Name or ID of the vessel.
            - port (str): Name or ID of the port.
            - dwell_minutes (int, optional): Dwell minutes or delay duration.
            - eta_slip_hours (int, optional): ETA slip in hours.
            - vessel_type (str): Type of vessel (e.g., Container, Tanker).

    Output:
        dict: A dictionary containing:
            - severity (float/str): Severity score between 0.0 and 1.0 (or equivalent rating).
            - entities (dict): Extracted entities (e.g., vessel, port, delay, vessel_type).
    """
    api_key = os.getenv("FEATHERLESS_KEY")
    if not api_key:
        # Fallback to OPENAI_API_KEY for local testing/mocking
        api_key = os.getenv("OPENAI_API_KEY")

    base_url = os.getenv("FEATHERLESS_BASE_URL", "https://api.featherless.ai/v1")

    # If no api_key is available, return a mock response for fallback/safety
    if not api_key:
        print("[Classifier] [MOCK FALLBACK] FEATHERLESS_KEY (and fallback OPENAI_API_KEY) not set. Returning mock classification response.")
        return get_mock_response(event)

    client = OpenAI(
        api_key=api_key,
        base_url=base_url
    )

    prompt = f"""You are a specialized port and maritime event-severity classifier.
Analyze the following disruption event and classify its severity on a scale from 0.0 (negligible) to 1.0 (critical), and extract relevant entities.

Disruption Event Details:
{json.dumps(event, indent=2)}

Respond ONLY with a valid JSON object in the following format:
{{
  "severity": <float between 0.0 and 1.0>,
  "entities": {{
    "vessel": "<vessel name>",
    "port": "<port name>",
    "delay_duration": "<duration with units>",
    "vessel_type": "<vessel type>",
    "impact_summary": "<brief summary of impact>"
  }}
}}
"""

    try:
        print(f"[Classifier] [LIVE] Querying Featherless API at {base_url} with model {FEATHERLESS_MODEL}...")
        response = client.chat.completions.create(
            model=FEATHERLESS_MODEL,
            messages=[
                {"role": "system", "content": "You are a precise JSON classifier. Output ONLY JSON, nothing else."},
                {"role": "user", "content": prompt}
            ],
            temperature=0.0,
            response_format={"type": "json_object"}
        )

        content = response.choices[0].message.content.strip()
        result = json.loads(content)
        print(f"[Classifier] [LIVE] Successfully received classification: {result}")
        return result
    except Exception as e:
        print(f"[Classifier] [MOCK FALLBACK] Error calling Featherless classifier: {e}. Falling back to mock.")
        # Fall back to mock response in case of API failure during demo/test
        return get_mock_response(event)

def get_mock_response(event: dict) -> dict:
    """Helper to return a structured mock response when API key or connection fails."""
    # Simple rule-based severity calculation for mock fallback
    dwell = event.get("dwell_minutes", 0) or 0
    slip = event.get("eta_slip_hours", 0) or 0

    if dwell > 1440 or slip > 48: # >24 hours dwell or >2 days slip
        severity = 0.8
    elif dwell > 480 or slip > 12: # >8 hours dwell or >12h slip
        severity = 0.5
    else:
        severity = 0.2

    return {
        "severity": severity,
        "entities": {
            "vessel": event.get("vessel", "Unknown"),
            "port": event.get("port", "Unknown"),
            "delay_duration": f"{dwell} min / {slip} hours",
            "vessel_type": event.get("vessel_type", "Unknown"),
            "impact_summary": f"Fallback classification for {event.get('vessel', 'vessel')} at {event.get('port', 'port')}."
        }
    }
