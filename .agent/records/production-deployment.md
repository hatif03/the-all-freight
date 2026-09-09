---
name: production-deployment
---

# Deploy to production: Vercel + GCE VM + Supabase

## Context

The user wants everything cost-consciously on GCP, with the frontend on Vercel and Supabase for Postgres (to avoid Cloud SQL's cost). Two prior architectural decisions constrain this: Vertex AI needs Application Default Credentials (no static key), and the ops-room agents are long-running persistent processes, not request/response.

## Decision

- **Database**: new Supabase project (`the-all-freight`, us-east-1, free tier), reached via its session pooler (`aws-0-us-east-1.pooler.supabase.com:5432`, user `postgres.<project-ref>`) rather than a direct connection — Supabase's IPv4 direct-connect path is deprecated for new projects. Migrations applied and verified against it directly.
- **Compute**: a single GCE VM (`the-all-freight-ops`, `us-central1-a`) runs the FastAPI backend, the AIS detector, all 7 agents, and a local Redis container — the same shape already built and tested locally, as 9 systemd services (`ops-backend`, `ops-detector`, `ops-agent@<role>` templated) each with `Restart=always`. Started as a free-tier `e2-micro`; **that ran out of memory under 9 concurrent Python processes and made even SSH unresponsive** — resized to `e2-medium` (a real, non-free cost, ~$25-30/mo) for stability. A reserved static external IP (`the-all-freight-ops-ip`) replaces the VM's ephemeral IP so a reboot doesn't change the address the frontend depends on.
- **A real, unrelated bug surfaced during first deploy**: a fresh `uv sync` on the VM (no pinned Python) resolved Python 3.14, and CrewAI's transitive `chromadb` dependency fails to import under 3.14 (a `pydantic.v1` type-inference error in `chromadb/config.py`, unrelated to anything this app uses chromadb for). Fixed by pinning `.python-version` to `3.12` in both `service/` and `service/backend/` — not a code bug, a "which Python did the fresh environment happen to pick" bug that only appears on a machine that never had Python installed before.
- **Frontend**: deployed to Vercel. Vercel has no GCP Application Default Credentials and (separately) this GCP project has an org policy blocking service-account key creation — so rather than solve credential distribution to Vercel, **the Vertex AI call was moved server-side to the already-ADC-equipped GCE VM**: a new `POST /llm/complete` endpoint on the FastAPI backend (`backend/vertex_client.py`, mirroring `agents/model_router.py`'s token-refresh pattern) that the Next.js app's `src/lib/openai.ts` calls instead of building its own Vertex client. Net result: zero GCP credentials of any kind live in Vercel.
- `next.config.ts` had `output: "standalone"` (leftover from an earlier assumption the frontend would deploy via a self-built Docker image) — this actively broke the Vercel build (`ENOENT: .next/next-server.js.nft.json`, because standalone mode changes where build artifacts land and Vercel's own bundler doesn't expect that). Removed it, and deleted the now-dead `Dockerfile`/`.dockerignore` that depended on it, since Vercel is the actual deploy target now.

## Consequences

- **Fully verified live in production, not just deployed**: triggered a real disruption on the deployed VM (`simulate_disruption.py` over SSH) and polled the public API until it reached `awaiting_approval` with a real recommendation and material dissent — confirmed via the VM's public IP, not a local test. Separately, hit the live Vercel URL's `/api/analyze` endpoint with a real shipment and got back genuine Vertex-AI-generated analysis (e.g. "Plastic Chairs: Polypropylene 98%, Colorants/Additives 2%") streamed all the way from Vercel → GCE VM's `/llm/complete` → Vertex AI and back.
- Recurring cost going forward: `e2-medium` (~$25-30/mo) + the static IP (free while attached to a running instance, billed if ever reserved-but-unattached) + Supabase free tier (until its usage limits) + Vertex AI usage. No Cloud SQL, no Memorystore.
- `service/.env` and `.env.local` both contain the real Supabase DB password and other secrets — never committed (gitignored), but note they now exist in two places (this machine, and the VM at `~/app/service/.env`) — rotate the DB password if either machine's disk is ever considered compromised.
- Backend CORS (`allow_origins=["*", ...]`) already permits any origin including the Vercel domain — no change needed there for the `/ops` page's client-side calls (REST + WebSocket) to reach the VM directly.
