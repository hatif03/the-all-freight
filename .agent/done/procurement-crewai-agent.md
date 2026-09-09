# Build the Procurement (CrewAI) agent

`service/agents/procurement/` had a `pyproject.toml` but no `main.py` — the only one of the seven roles left unimplemented after the initial port.

## What changed

- `service/agents/procurement/main.py` — new. Mirrors the existing agent pattern (`room_bus.subscribe(ROLE, on_message)`, wake on `@mention`, parse/persist/re-post via `protocol.py`), but runs a single-agent, single-task CrewAI `Crew` instead of a raw chat-completion call or a LangGraph node.
  - On wake, reads the incident's disruption context + affected importers/cargo (same query shape `customer_impact/main.py` already uses), and asks the crew for one alternate-supply/substitution recovery option (JSON matching `protocol.RecoveryOptionMsg`).
  - Persists a `RecoveryOption` row (`proposer="procurement"`, `cost_delta=None`) and posts to the room mentioning `finance` — the same handoff `logistics/main.py` uses, and the one `finance/main.py` was already coded to accept (`opt_msg.proposer not in ["logistics", "procurement"]` was already a no-op guard for a proposer that didn't exist yet).
  - `LLM` (CrewAI's) is configured via the existing `model_router.client_for("procurement")` (already mapped to `gpt-4o`), with `model=f"openai/{model_name}"` so CrewAI's native OpenAI-compatible path (not litellm) is used against the AI/ML API gateway's custom `base_url` — confirmed via `LLM.provider == "openai"`, `is_litellm == False` in a local check.
- `service/agents/procurement/pyproject.toml` — description updated to match the other agents' convention.
- `service/docs/REQUIREMENTS.md`, `service/docs/MODEL_ROUTING.md` — both had explicit "stub — not yet implemented" language for Procurement; updated to describe it as built.

## Verification

- Import-level check (module exec without calling `main()`, mirroring how the other six agents were verified during the original port): clean.
- `LLM(model="openai/gpt-4o", base_url=..., api_key=...)` confirmed to resolve `provider="openai"` with the custom `base_url` intact, not silently falling back to a default OpenAI endpoint.
- No live end-to-end run: no `AIMLAPI_KEY`/`OPENAI_API_KEY` was available in this environment, so the actual CrewAI `kickoff_async()` call was not exercised against a real model. Structurally correct; worth a real run once model keys are in `service/.env`.
- Repo-wide branding grep still clean.
