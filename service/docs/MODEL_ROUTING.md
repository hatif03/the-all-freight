# Model routing: per-agent-role router & specialist classifier

Rationale for how LLMs are assigned across the ops-room agents. Implemented in
`agents/model_router.py` (`client_for(role)`) and `backend/classifier.py`.

## The model mapping

| Agent Role | Model ID | Provider | Framework | Rationale for selection |
|---|---|---|---|---|
| **Logistics** | `google/gemini-2.5-flash` | Vertex AI | LangGraph | Fast, capable model for structured-output parsing to propose rerouting/holding/expedite options. |
| **Finance** | `google/gemini-2.5-flash` | Vertex AI | plain OpenAI-SDK client | Cost-effective, adequate for structured text and the basic numeric reasoning needed to annotate demurrage/detention cost deltas. |
| **Carrier** | `MBZUAI-IFM/K2-Think-v2` | K2 Think | PydanticAI | A reasoning-focused model for a carrier counter-position that has to stay grounded in tariff + FMC facts rather than pattern-match a plausible-sounding answer. |
| **Dissent** | `MBZUAI-IFM/K2-Think-v2` | K2 Think | plain OpenAI-SDK client | Same reasoning model as Carrier but a genuinely different model family than the negotiating agents (Logistics/Finance/Procurement/Customer-Impact) it's attacking — a same-model dissent is closer to sampling noise than a genuine second opinion. |
| **Procurement** | `google/gemini-2.5-flash` | Vertex AI | CrewAI | Proposes alternate-supply/substitution options for at-risk cargo; CrewAI's task-role structure fits a specialist sourcing role. |
| **Customer-Impact** | `google/gemini-2.5-flash` | Vertex AI | plain OpenAI-SDK client | Fast, cheap model for structured SLA-impact assessments and stakeholder-comms drafts — doesn't need frontier capability. |
| **Event-severity classifier** | `Qwen2.5-1.5B-Instruct` | Featherless | standalone | Small OSS model dedicated to one narrow job: scoring `DisruptionEvent.severity` and extracting entities from a detector event, at low latency/cost. |

## Why Vertex AI instead of the Gemini Developer API

The Gemini Developer API (`generativelanguage.googleapis.com`) metering runs on a separate "prepay credits" wallet from standard GCP Cloud Billing — a project can have a fully funded, enabled billing account and still get `429 RESOURCE_EXHAUSTED` from Gemini specifically until that wallet is topped up at ai.studio. Vertex AI's identical Gemini models, reached via its own OpenAI-compatible endpoint, bill through the same standard Cloud Billing account instead — no separate wallet. The tradeoff: Vertex requires an OAuth2 access token (via Application Default Credentials), not a static API key, and that token expires hourly — see `agents/model_router.py`'s docstring for how every call site handles that for a multi-day-running agent process.

## Why route per role instead of one model for everything

- `client_for(role)` returns an OpenAI-compatible client + model id from one config table (`ROLE_PROVIDER`/`ROLE_MODELS`), so swapping a role's model or provider is a one-line change, not a code change.
- The two roles that most need to reason carefully rather than pattern-match — Carrier's tariff-grounded negotiation and Dissent's adversarial critique — route to K2 Think, a reasoning-focused model; the four roles doing more mechanical structured extraction/annotation route to Vertex AI Gemini.
- The Dissent agent deliberately runs a different model than the agents whose proposal it's attacking (Vertex Gemini), even though it shares K2 Think with Carrier — the point is that Dissent isn't the same model arguing with itself.
- The event-severity classifier runs on a small, separately-hosted OSS model (Featherless) rather than a frontier LLM, since it's a narrow, high-frequency, low-stakes classification task.

All three providers speak the OpenAI-compatible chat-completions API, so `model_router.py` and `classifier.py` only need a base-URL/auth switch — no separate SDKs per provider.
