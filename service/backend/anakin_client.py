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

from typing import Any, Optional

import httpx

from config import settings

ANAKIN_BASE_URL = "https://api.anakin.io/v1"


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
        """Sync inline URL-scraper call: returns data shaped by `output_schema`."""
        payload: dict[str, Any] = {"url": url, "outputSchema": output_schema}
        if prompt:
            payload["prompt"] = prompt
        response = await self._client.post("/url-scraper/scrape", json=payload)
        response.raise_for_status()
        return response.json()

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
