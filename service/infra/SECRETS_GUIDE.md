# Secrets Hygiene

**NEVER COMMIT REAL KEYS TO THIS REPO.**

## Where to find real keys?
Real keys are stored in [Insert Private Location: e.g., a password manager].

## How to use locally?
1. Copy `infra/.env.example` (or `service/.env.example`) to the root `.env`.
2. Get the values from the private store and fill them in.

## Shared Infrastructure
- **Postgres:** `DATABASE_URL` is shared for dev. Don't run local migrations without coordination.
- **Redis:** `REDIS_URL` is shared — it's also the room bus's transport (see `agents/room_bus/`), not just a cache.
