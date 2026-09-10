# The All Freight — agent instructions

## Documentation protocol (standing instruction — follow for every change)

- Each section below starts with `Last audited: <date>`. When you touch the area a section describes, update that line and the content together in the same change — never leave it stale.
- Before starting a non-trivial chunk of work, write a short plan to `.agent/plans/<slug>.md` (what's about to change, why). Once done, move it to `.agent/done/`.
- For every architectural pivot (not routine feature work — a change to *how* something fundamentally works), write a short ADR to `.agent/records/<slug>.md` with `Context` / `Decision` / `Consequences` sections.
- Commits: conventional-commit format (`feat:`, `fix:`, `refactor:`, `docs:`, ...); call out breaking changes and new env vars in the body.
- Never reference prior/reference projects by name in anything tracked by this repo (README, this file, code comments, UI copy, commit messages). The two source projects this was originally built from were kept on disk as gitignored reference material during that build and have since been deleted (their purpose served, and backed up elsewhere) — nothing in this repo should assume they still exist.

## Architecture

Last audited: 2026-09-10

Two halves joined by one object — the **tracked shipment**. Planning produces one; monitors watch its lane; an incident at its entry port attaches to it. See `docs/PRODUCT.md` for the narrative and `.agent/records/tracked-shipment-spine.md` for why it's shaped this way.

- **Planning flow** (`src/app/plan/`) — describe a shipment, get a live-web-researched risk report (freight rates, tariffs, port congestion, weather, geopolitical risk). Every live-web call goes through `src/lib/anakin.ts`. Ends in "Track this shipment".
- **Watchlist** (`src/app/page.tsx` + `src/app/shipments/[id]/`) — the home page. Tracked shipments, their monitoring coverage, and their activity. A shipment page rehydrates the full dashboard from the stored `AnalysisResult`, which is why `Dashboard` must keep taking a single `result: AnalysisResult` prop.
- **Ops room** (`src/app/ops/` index + `src/app/ops/[id]/` room, backed by `service/`) — a Sentinel agent watches a live AIS feed for vessel disruptions, opens a room, recruits agents across three frameworks (LangGraph, PydanticAI, CrewAI) who negotiate a recovery option via a self-hosted room bus, down to a quorum vote, an adversarial dissent step, and a human approve/reject gate, producing an audit dossier.

`/shipments/{id}/ops` deliberately doesn't exist: the console is built around exactly one incident snapshot, incidents are global objects discovered independently of any shipment, and `Incident.id` doubling as the room id is load-bearing for six tables. The cross-half connection is the link row rendered on both ends, not a nested route.

Port matching (`ports.py::resolve_port_code` + `shipment_matcher.py`) resolves a free-text port name to a monitored port code **once, at track time**, persisting the matched alias and a human-readable basis; incident-time matching is then exact code equality. Don't reintroduce fuzzy scoring, geographic proximity, or an LLM here — that's the fabrication vector C1 exists to prevent, and most real lanes correctly resolve to nothing (shown as "not AIS-monitored" rather than attached to a nearby port).

## Room bus (`service/agents/room_bus/`)

Last audited: 2026-09-09

Self-hosted replacement for a third-party coordination SaaS: Postgres (`RoomMessage` table — `room_id`, `sender_role`, `text`, `mentions: JSON list[str]`, `created_at`) for the durable message log, Redis pub/sub (`room_messages` channel) for real-time fanout to agent processes and the dashboard WebSocket (coexists with the pre-existing `room_events` channel `backend/main.py` already relays to the dashboard — different audiences, both published from the room bus/agents). Interface: `create_room`, `recruit` (idempotent per role), `send` (with `mentions: list[str]`), `get_context`, `subscribe(role, on_message)`. There's no separate room id: one room per incident, and the room id *is* `Incident.id` (see ADR `.agent/records/self-hosted-room-bus.md`). Each negotiating agent process calls `subscribe()` and only reacts to messages that mention its role (or `"all"`); the Sentinel coordinator subscribes with `role=None` to see every message, since it tallies options and drives phase transitions regardless of who a message was addressed to.

## Anakin integration points

Last audited: 2026-09-10

**Verified contracts** — tested live against the API; trust these over the published docs, which are thin in places. Each of these was previously wrong in the code and failed *silently*:

- `POST /v1/search` takes **`prompt`**, not `query`. Sending `query` returns HTTP 400 "Prompt is required". `limit` defaults to 5, max 20.
- `POST /v1/url-scraper/scrape` needs **`generateJson: true`** to run AI extraction at all (it defaults to false), and nests the result at **`generatedJson.data`**. A slow page (large PDFs) returns `processing` plus a job id to poll rather than an inline result.
- `POST /v1/agentic-search` → `{job_id}`, then poll `GET /v1/agentic-search/{id}`; ~35s. Returns a prose summary and structured data but **no citations**, so it may only ever be presented as uncited synthesis — never as the basis for a figure the product asserts.
- Monitors live at **`/v1/monitors`**, not `/v1/monitoring` (which 404s, despite the API-reference index listing it).
- **Wire is unusable for this domain.** `/v1/wire/catalog` ignores its `query` param and returns ~940 consumer/business sites with no bill-of-lading, customs or trade-data action. Removed; see the update in `.agent/records/anakin-tariff-and-bol.md`.

1. `src/lib/anakin.ts` — the planning flow's live web layer: `anakinSearch` (`/v1/search`), `anakinExtract` (structured extraction against a JSON Schema) and `anakinDeepResearch` (agentic search). Mock fallback when `ANAKIN_API_KEY` is unset, and mock sources deliberately carry no URL so a fallback can never render as a real citation.
1b. `service/backend/monitors.py` — scheduled page monitors per tracked-shipment lane (port advisories, carrier tariff, FMC billing rule), with an HMAC-verified receiver at `POST /webhooks/anakin/monitor`. Monitors are keyed by URL, so credit cost scales with distinct pages rather than with shipments, and one is deregistered when the last shipment watching it goes. A detected page change never becomes a `DisruptionEvent` (that table needs a real vessel MMSI) — it's a `monitor_signals` row surfaced as a web signal.
2. `service/backend/tariff_fetcher.py` (+ `service/backend/anakin_client.py`) — live carrier demurrage/detention tariff fetch (sync-inline URL Scraper + `outputSchema`), augmenting the manual CSV loader (`tariff_loader.py`); both paths share one `upsert_tariff_rows()` helper. Exposed as a CLI script and `POST /admin/tariffs/refresh`.
3. `service/backend/bol_live_lookup.py` — live bill-of-lading/importer lookup via AI extraction against a public BoL search page. Wired into `affected_party_resolver.py` as a fallback used only when the local DB has no match; always labels results `inferred=True`, and returns an empty list rather than fabricating when nothing real resolves. (An earlier version tried Wire first — see the "Verified contracts" note above for why that branch was unreachable and has been removed.)

## Model providers

Last audited: 2026-09-09

No OpenAI, AI/ML API, or Gemini Developer API usage anywhere — everything speaks the OpenAI-*compatible* chat-completions shape against two providers instead:

- **Vertex AI Gemini** (`https://{GCP_LOCATION}-aiplatform.googleapis.com/v1beta1/projects/{GCP_PROJECT_ID}/locations/{GCP_LOCATION}/endpoints/openapi`, model `google/gemini-2.5-flash`) — four ops-room roles doing structured extraction/annotation (Logistics, Finance, Procurement, Customer-Impact) via `agents/model_router.py`, plus the planning flow, but **not directly** — see the next bullet. Billed through standard Cloud Billing, **not** the separate Gemini Developer API prepay wallet (that wallet being empty is what blocked this project initially — Vertex AI bypasses it entirely). Authenticated with Application Default Credentials — no API key: `gcloud auth application-default login` locally (Python: `google-auth`), or the attached service account automatically on the deployed VM.
- **The planning flow (`src/lib/openai.ts`) does not call Vertex AI directly.** It's deployed on Vercel, which has no Application Default Credentials, and this GCP project has an org policy blocking service-account key creation — so instead it calls `POST {NEXT_PUBLIC_API_URL}/llm/complete` on the ops-room backend (`backend/vertex_client.py` + the endpoint in `backend/main.py`), which already has clean ADC via the GCE VM's attached service account. Zero GCP credentials of any kind live in Vercel. See ADR `.agent/records/production-deployment.md`.
  - **Vertex access tokens expire after ~1 hour.** Every call site (Python `agents/model_router.py::client_for()`, TS `src/lib/openai.ts`) fetches a fresh token on every LLM call rather than caching a client at startup — agent processes run for days, so a client built once at boot would start failing an hour in. Don't reintroduce a "build once in `main()`, reuse forever" pattern for the Vertex-routed roles.
  - Model note: `gemini-3.6-flash` (current on the Gemini Developer API as of this build) returned 404 on Vertex in this project/region — Vertex's model availability lags the Developer API. `google/gemini-2.5-flash` (note the `google/` prefix Vertex requires) is confirmed live.
- **K2 Think** (MBZUAI/IFM, `https://api.k2think.ai/v1`, model `MBZUAI-IFM/K2-Think-v2`) — the two ops-room roles that most need to reason carefully rather than pattern-match: Carrier's tariff-grounded negotiation, Dissent's adversarial critique. Deliberately a different model than the Vertex-routed roles so Dissent isn't the same model arguing with itself. Plain static API key, no OAuth — much faster to verify but noticeably slower per-call (Carrier took ~40s in testing; it's a reasoning model working through a complex 6-field structured extraction). See `service/docs/MODEL_ROUTING.md`.

Both providers are fully verified live end-to-end (not just curled in isolation): a real simulated disruption ran the entire negotiation — Logistics, Finance, Procurement (CrewAI), Customer-Impact all producing genuine Vertex-generated output, Carrier and Dissent producing genuine K2-Think-generated output citing real FMC regulation — through to a contested recommendation at `awaiting_approval`.

## Environment variables

Last audited: 2026-09-10

Root `.env.local`: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL` (the ops-room backend — also where `/llm/complete` lives), `ANAKIN_API_KEY`. No GCP credentials of any kind in this app. See `.env.example` at repo root.
`service/.env`: `DATABASE_URL` (Supabase in production, local Docker Postgres for dev), `REDIS_URL` (local Docker/VM-local Redis), `PUBLIC_BASE_URL` (this service's public HTTPS origin, used to register Anakin monitor webhooks — leave unset locally, since Anakin can't call back to a loopback address), `AISSTREAM_API_KEY`, `GCP_PROJECT_ID`, `GCP_LOCATION`, `GEMINI_MODEL` (optional), `K2THINK_API_KEY`, `FEATHERLESS_KEY`, `ANAKIN_API_KEY`.

## Deployment

Last audited: 2026-09-10

- **Frontend**: Vercel, production URL `https://the-all-freight.vercel.app`. Env vars set via `vercel env add ... production`.
- **Backend + agents**: a single GCE VM (`the-all-freight-ops`, `us-central1-a`, `e2-medium`, static IP `136.119.139.202`) running the FastAPI backend, the AIS detector, and all 7 agents as systemd services (`ops-backend`, `ops-detector`, `ops-agent@<role>` — a templated unit; `sudo systemctl status ops-agent@carrier` etc.), plus a local Redis container (`docker run -d --name redis ... redis:7`). Code lives at `~/app/service` on the VM, copied via `gcloud compute scp` rather than git-cloned (the repo *does* have a remote — `origin` at `github.com/hatif03/the-all-freight` — but the VM was never wired to pull from it). To redeploy code changes: re-package (`tar --exclude='.venv' --exclude='__pycache__' --exclude='data' -czf service.tar.gz service/`), `gcloud compute scp` it over, extract, re-run `uv sync` in both `service/` and `service/backend/`, **run `cd backend && uv run alembic upgrade head` if the schema changed**, then `sudo systemctl restart ops-backend ops-detector 'ops-agent@*'` and verify with `curl https://136-119-139-202.nip.io/health`.
- **HTTPS in front of the backend is required, not optional.** The Vercel site is served over HTTPS; browsers block/fail plain `http://` and `ws://` requests from an HTTPS page ("mixed content"), which is exactly why `/ops` initially failed to load in production. Fixed with **Caddy** on the VM (`/etc/caddy/Caddyfile`, `sudo systemctl status caddy`) reverse-proxying port 8000, serving on `https://136-119-139-202.nip.io` (a [nip.io](https://nip.io) hostname that resolves to the VM's static IP — lets Caddy obtain a real Let's Encrypt cert with no owned domain) — firewall rule `allow-ops-room-https` opens 80/443. `NEXT_PUBLIC_API_URL`/`NEXT_PUBLIC_WS_URL` in Vercel point at this HTTPS/WSS URL, not the raw `:8000` port. If the VM's static IP ever changes, the Caddyfile's hostname and Vercel's env vars both need updating to match.
- **Database**: Supabase (`the-all-freight` project, us-east-1 free tier), reached via the session pooler, not a direct connection.
- **Started as `e2-micro` (free tier) — it ran out of memory under 9 concurrent Python processes and made SSH itself unresponsive.** Resized to `e2-medium`. Don't downsize this without re-testing memory headroom (`free -h` on the VM) with all 9 services running.
- **A fresh `uv sync` on a machine with no prior Python resolves the newest available interpreter — that broke things once already** (Python 3.14 + CrewAI's `chromadb` dependency, see `.agent/records/production-deployment.md`). Both `service/.python-version` and `service/backend/.python-version` pin `3.12` — don't remove them.

## Local process hygiene (Windows)

Last audited: 2026-09-09

`uv run python <script>` on this Windows setup produces two `python.exe` entries per logical process (a launcher + the interpreter) — that's normal, not a duplicate. What *isn't* normal: git-bash's `kill <pid>` against a backgrounded `uv run ...` job frequently fails to actually terminate the process (MSYS PID virtualization doesn't map cleanly to the real Windows PID uv spawns), leaving zombies that keep subscribing to the room bus and double-process every disruption. If a disruption run shows two `[room_bus] Room opened` lines for one event, or a room number ahead of what you expect, check for zombies before debugging the pipeline:
```
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*the-all-freight*" -and $_.Name -eq "python.exe" }
```
Kill by the real `ProcessId` this returns (`Stop-Process -Id <id> -Force`), not the PID bash reports from `$!`. Also: `agents/__pycache__/` breaks every subsequent `uv run` in this workspace (see `pyproject.toml`'s `[tool.uv.workspace] exclude`) — if you ever see "Workspace member ... is missing a pyproject.toml", `rm -rf agents/__pycache__` and retry; that exclude should already prevent it, but bash-tool cwd can drift across separate tool calls in ways that bypass the intended launch commands and land you in the wrong directory (verify with `pwd` before trusting a relative path in a background launch).

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
