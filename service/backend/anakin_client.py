"""Thin async client for the Anakin API.

Two capabilities are used elsewhere in this service:
  - URL Scraper (sync inline variant): scrape one page against a JSON-Schema
    `outputSchema` and get structured rows back directly in the response —
    simpler than polling an async job, and good enough for a scheduled/CLI
    tariff refresh (tariff_fetcher.py) or an on-demand BoL lookup
    (bol_live_lookup.py).
  - Wire catalog: look up (and resolve) a pre-built site action, so a lookup
    can prefer a maintained integration over an ad hoc scrape when one exists.
"""

from __future__ import annotations

import asyncio
from typing import Any, Optional

import httpx

from config import settings

ANAKIN_BASE_URL = "https://api.anakin.io/v1"

POLL_INTERVAL_SECONDS = 5.0
POLL_MAX_ATTEMPTS = 24  # ~2 min ceiling for a slow PDF extraction


def extract_generated(response: Any) -> dict[str, Any]:
    """Unwrap an AI-extraction response down to the schema-shaped payload.

    The scraper nests it as `{"generatedJson": {"data": {...}, "status": "success"}}`
    alongside `markdown`/`html`/`cleanedHtml`. Unwrapping here, in the one place
    every caller goes through, is why callers can just read their own schema's
    keys off the return value.
    """
    if not isinstance(response, dict):
        return {}
    generated = response.get("generatedJson")
    if not isinstance(generated, dict):
        return {}
    data = generated.get("data")
    return data if isinstance(data, dict) else {}


class AnakinClient:
    def __init__(self, api_key: Optional[str] = None, base_url: str = ANAKIN_BASE_URL, timeout: float = 60.0):
        self.api_key = api_key if api_key is not None else settings.ANAKIN_API_KEY
        self._client = httpx.AsyncClient(
            base_url=base_url,
            headers={"X-API-Key": self.api_key} if self.api_key else {},
            timeout=timeout,
        )

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    async def scrape_url(self, url: str, output_schema: dict[str, Any], *, prompt: Optional[str] = None) -> Any:
        """Sync inline URL-scraper call: returns data shaped by `output_schema`.

        `generateJson` is what actually turns on AI extraction — it defaults to
        false, so without it the response carries markdown/html but no
        `generatedJson` at all, and every caller silently gets nothing.
        """
        payload: dict[str, Any] = {
            "url": url,
            "generateJson": True,
            "outputSchema": output_schema,
        }
        if prompt:
            payload["prompt"] = prompt
        response = await self._client.post("/url-scraper/scrape", json=payload)
        response.raise_for_status()
        body = response.json()

        # The "inline" endpoint only stays inline while the scrape finishes
        # inside its own window; a slow page (large PDFs, mostly) comes back
        # `processing` with just an id, and the result has to be polled for.
        job_id = body.get("id") if isinstance(body, dict) else None
        for _ in range(POLL_MAX_ATTEMPTS):
            if not isinstance(body, dict) or body.get("status") not in ("processing", "pending"):
                break
            if not job_id:
                break
            await asyncio.sleep(POLL_INTERVAL_SECONDS)
            polled = await self._client.get(f"/url-scraper/{job_id}")
            polled.raise_for_status()
            body = polled.json()

        return extract_generated(body)

    async def wire_catalog(self, query: Optional[str] = None) -> Any:
        """List available Wire site actions, optionally filtered by `query`."""
        params = {"query": query} if query else None
        response = await self._client.get("/wire/catalog", params=params)
        response.raise_for_status()
        return response.json()

    async def wire_resolve(self, action_id: str, inputs: dict[str, Any]) -> Any:
        """Run a resolved Wire action by id with the given inputs."""
        response = await self._client.get("/wire/resolve", params={"action_id": action_id, **inputs})
        response.raise_for_status()
        return response.json()

    async def aclose(self) -> None:
        await self._client.aclose()
