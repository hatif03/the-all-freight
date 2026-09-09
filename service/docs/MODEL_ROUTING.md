# Model routing: per-agent-role router & specialist classifier

Rationale for how LLMs are assigned across the ops-room agents. Implemented in
`agents/model_router.py` (`client_for(role)`) and `backend/classifier.py`.

## The model mapping

| Agent Role | Model ID | Provider | Framework | Rationale for selection |
|---|---|---|---|---|
| **Logistics** | `gpt-4o` | AI/ML API | LangGraph | High-quality planning and structured-output parsing to propose rerouting/holding/expedite options. |
| **Finance** | `mistral-nemo` | AI/ML API | plain OpenAI-SDK client | Cost-effective, modern 12B model, adequate for structured text and the basic numeric reasoning needed to annotate demurrage/detention cost deltas. |
| **Carrier** | `claude-sonnet-4-6` | AI/ML API | PydanticAI | Strong conversational/negotiation capability for a carrier counter-position grounded in tariff + FMC facts. |
| **Dissent** | `google/gemma-3-4b-it` | AI/ML API | plain OpenAI-SDK client | A distinct, lightweight open-weights model — a genuinely different "opinion" than the negotiating agents, not the same model arguing with itself. |
| **Procurement** | `gpt-4o` | AI/ML API | CrewAI | Reserved for multi-step reasoning over alternate-supply/substitution options; CrewAI's task-role structure fits a specialist sourcing role. |
| **Customer-Impact** | `gpt-4o-mini` | AI/ML API | plain OpenAI-SDK client | Fast, cheap model for structured SLA-impact assessments and stakeholder-comms drafts — doesn't need frontier capability. |
| **Event-severity classifier** | `Qwen2.5-1.5B-Instruct` | Featherless | standalone | Small OSS model dedicated to one narrow job: scoring `DisruptionEvent.severity` and extracting entities from a detector event, at low latency/cost. |

## Why route per role instead of one model for everything

- `client_for(role)` returns an OpenAI-compatible client + model id from one config table (`ROLE_MODELS`), so swapping a role's model is a one-line change, not a code change.
- It lets model capability track the job: a negotiation-heavy role (Carrier) gets a stronger model than a mechanical annotation role (Customer-Impact).
- The Dissent agent deliberately runs a *different* model family than the agents whose proposal it's attacking — a same-model dissent is closer to sampling noise than a genuine second opinion.
- The event-severity classifier runs on a small, separately-hosted OSS model (Featherless) rather than a frontier LLM, since it's a narrow, high-frequency, low-stakes classification task.

Both providers speak the OpenAI-compatible chat-completions API, so `model_router.py` and `classifier.py` only need a base-URL switch — no separate SDKs per provider.
