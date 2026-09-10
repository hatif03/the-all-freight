# The All Freight

**Plan a shipment before it moves. Watch it — and act — once it does.**

A supply-chain risk platform built on [Anakin](https://anakin.io) as its live-web layer. Three moves, joined by one object — the tracked shipment:

1. **Plan** — describe a shipment and a pipeline of agents researches it against the live web: freight rates, tariffs and duty, port congestion, weather, geopolitical and supplier risk. You get a risk score, a cost and delay forecast, a recommended entry port and a dated action plan, every figure carrying its source.
2. **Track** — keep the shipment and the pages that decide what a disruption would cost *on that lane* go under scheduled monitoring: the port's advisories, the carrier's demurrage tariff, the FMC billing rule. Changes land on the shipment as web signals.
3. **Act** — when a vessel is actually disrupted at a monitored port, a room opens. Seven agents across three frameworks negotiate recovery options costed against the carrier's real published tariff rows, vote to a quorum, and an adversarial Dissent agent argues against the front-runner. Then a human approves or rejects, and the exchange becomes an audit dossier.

Anakin is what makes all three live: search behind the research, AI structured extraction that turns a published tariff PDF into actual per-day rates the agents can negotiate over, deep research for synthesis, and scheduled monitoring that turns a one-off report into something continuous.

**Live**: [the-all-freight.vercel.app](https://the-all-freight.vercel.app) · backend at `https://136-119-139-202.nip.io`.

📄 **[docs/PRODUCT.md](docs/PRODUCT.md)** — the problem, who it hurts, and exactly where Anakin sits. Start there.

---

## Architecture

```mermaid
flowchart LR
  subgraph PLAN[Planning flow — Next.js]
    FORM[Shipment form] --> AGENTS[Product / Commodity / Freight / Port /\nWeather / Geopolitical / Supplier / Regulatory agents]
    AGENTS -->|search + scrape| ANAKIN1[Anakin]
    AGENTS --> REPORT[Risk report]
  end

  subgraph OPS[Ops Room — service/]
    AIS[Live AIS feed] --> DET[Detector]
    DET -- "disruptions" --> SEN[Sentinel]
    TAR[(Carrier tariff)] -.->|live fetch| ANAKIN2[Anakin]
    BOL[(Importer / BoL records)] -.->|live lookup, labeled inferred| ANAKIN2

    subgraph BUS[Self-hosted room bus — Postgres + Redis]
      SEN -->|create room + recruit| LOG[Logistics - LangGraph]
      SEN --> CAR[Carrier - PydanticAI]
      SEN --> FIN[Finance - PydanticAI]
      SEN --> PRO[Procurement - CrewAI]
      SEN --> CUS[Customer-Impact - PydanticAI]
      SEN --> DIS[Dissent - PydanticAI]
      LOG <-->|room messages, @mentions| FIN
      CAR <--> FIN
    end

    ANAKIN2 --> FIN
    BUS -- "room_events" --> BE[FastAPI /ws]
    BE -- WebSocket --> UI[Ops console]
    UI -- "POST /decision" --> BE
    BE -- "decisions" --> SEN
    UI --> DOS[Audit dossier]
  end
```

The room bus is a deliberate simplification: rather than a hosted coordination service, room state is just a Postgres table (`RoomMessage`) plus a Redis pub/sub channel. Each agent process subscribes and only reacts to messages that `@mention` its role — the negotiation, the quorum vote, and the audit trail all work the same way, with one fewer external dependency.

## No fabricated data

Every number in the Ops Room is either live (AIS positions) or cited (Maersk's published tariff, U.S. Customs bills of lading). When a live BoL/importer lookup can't be confirmed against a primary source, it's labeled `inferred` rather than presented as fact. When no tariff row matches, the cost is reported as unavailable rather than guessed.

## Project structure

```text
src/
  app/page.tsx           Watchlist — tracked shipments and what's happening to them
  app/plan/              Planning flow, ending in "Track this shipment"
  app/shipments/[id]/    One shipment: live activity, then its full analysis
  app/ops/               Incident index (empty state doubles as the explanation)
  app/ops/[id]/          The incident room: vessel map, feed, options, approve/reject, dossier
  app/how-it-works/      What this is and why (server-rendered, no client JS)
  components/ui.tsx      Shared primitives — Panel, Badge, Button, Modal, EmptyState, SourceLink
  lib/anakin.ts          Live web layer: search, structured extraction, deep research
  lib/agents.ts          The planning-flow research agents
  lib/motion.ts          Motion tokens; reduced-motion is handled app-wide

service/                 Python system — ops backend + agent swarm
  backend/               FastAPI, AIS detector, cost/tariff engine, dossier, event relay
  backend/monitors.py    Anakin page monitors + HMAC-verified webhook receiver
  backend/shipment_matcher.py, ports.py   Incident → tracked-shipment attribution
  backend/anakin_client.py, tariff_fetcher.py, bol_live_lookup.py   Anakin integrations
  agents/room_bus/       Self-hosted room bus (Postgres + Redis)
  agents/{sentinel,logistics,carrier,finance,customer_impact,dissent,procurement}/
```

## Development setup

**Planning flow** (Node 20+):

```bash
npm install
cp .env.example .env.local   # add ANAKIN_API_KEY and point NEXT_PUBLIC_API_URL at a running backend
npm run dev                  # http://localhost:3000
```

Runs end-to-end with no keys at all, using a built-in mock dataset for the web-search layer — add `ANAKIN_API_KEY` for live web intelligence. Agent reasoning is proxied through the ops-room backend's `/llm/complete` (Vertex AI) — no GCP credentials needed in this app itself, but a backend needs to be running (see below) for real (non-fallback) reasoning.

**Ops Room** (Python 3.12+, [uv](https://docs.astral.sh/uv/); local Postgres + Redis via Docker by default):

```bash
cd service
docker compose up -d   # local Postgres + Redis
cp .env.example .env   # DATABASE_URL/REDIS_URL already point at the containers above;
                        # add AISSTREAM_API_KEY, GCP_PROJECT_ID, K2THINK_API_KEY, ANAKIN_API_KEY, ...
uv sync
(cd backend && uv run alembic upgrade head)
make run-backend        # FastAPI on :8000
make run-detector        # AIS disruption detector, separate shell
make run-agents          # all 7 agents, separate shell (or `make run-all` with overmind/honcho/foreman)
```

Trigger a demo disruption from a captured AIS window (from inside `service/`): `python backend/replay.py data/captures/<port>_<date>.jsonl --speed 20`, or `POST /demo/replay {"file_path": "..."}`.

Live-fetch the carrier tariff via Anakin at any time: `POST /admin/tariffs/refresh` (or the "Refresh live tariff" button in the ops console).

## Environment variables

Root `.env.local`: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL`, `ANAKIN_API_KEY`. No GCP credentials of any kind — the Vertex AI call happens server-side in the backend, not in this app.

`service/.env`: `DATABASE_URL` (Supabase in production, local Docker Postgres for dev), `REDIS_URL`, `AISSTREAM_API_KEY`, `GCP_PROJECT_ID`, `GCP_LOCATION`, `K2THINK_API_KEY`, `FEATHERLESS_KEY`, `ANAKIN_API_KEY`.

## Deployment

Frontend on Vercel; backend + all 7 agents on a single GCE VM (systemd services, local Redis, Supabase Postgres) — see `CLAUDE.md`'s "Deployment" section for the exact setup and redeploy steps, and `.agent/records/production-deployment.md` for why it's shaped this way.

## Tech stack

Next.js · React · TypeScript · Tailwind CSS · MapLibre GL · Recharts · Vertex AI (Gemini) · K2 Think · **Anakin** · FastAPI · Supabase (Postgres) · Redis · Docker · LangGraph · PydanticAI · CrewAI · Google Cloud · Vercel.

## Documentation

Architectural decisions are recorded as ADRs in [`.agent/records/`](.agent/records/); `CLAUDE.md` at the repo root tracks the current architecture, integration points, and environment variables with per-section audit dates.

## License

MIT
