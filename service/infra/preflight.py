"""Pre-run readiness check.

Verifies everything the full 6-agent run needs BEFORE you launch `make run-all`,
so config gaps surface in seconds instead of as confusing runtime failures:

  - Postgres reachable
  - Redis reachable (the room bus's transport)
  - all recruitable roles are present in the static registry
  - partner / data keys present (optionally probed with a 1-token call)

Read-only. Never prints API keys.

Run:  cd backend && uv run python ../infra/preflight.py [--probe-models]
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "agents"))

import registry  # noqa: E402

ROLES = ["sentinel", "logistics", "carrier", "finance", "procurement", "customer_impact", "dissent"]

OK, WARN, BAD = "[ OK ]", "[WARN]", "[FAIL]"


async def check_db() -> bool:
    try:
        from sqlalchemy import text
        from database import engine  # config-normalized URL (handles hosted-Postgres ssl)
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        print(f"{OK} Postgres: connected")
        return True
    except Exception as e:
        print(f"{BAD} Postgres: {e}")
        return False


async def check_redis() -> bool:
    try:
        from redis_client import get_redis_client
        r = get_redis_client()
        await r.ping()
        await r.aclose()
        print(f"{OK} Redis: connected")
        return True
    except Exception as e:
        print(f"{BAD} Redis: {e}")
        return False


def check_registry() -> bool:
    print("\nRoom bus roles (no external credentials required — see agents/registry.py):")
    all_good = True
    for role in ROLES:
        name = registry.ROLES.get(role)
        if name:
            print(f"  {OK} {role:<16} {name}")
        else:
            print(f"  {BAD} {role:<16} not present in registry")
            all_good = False
    return all_good


def check_keys(probe: bool) -> bool:
    print("\nData / partner keys:")
    required = {
        "AISSTREAM_API_KEY": "live AIS",
        "GCP_PROJECT_ID": "Vertex AI Gemini (logistics/finance/procurement/customer_impact)",
        "K2THINK_API_KEY": "K2 Think (carrier/dissent reasoning)",
        "FEATHERLESS_KEY": "Featherless (classifier)",
        "ANAKIN_API_KEY": "Anakin (tariff fetch + BoL live lookup)",
    }
    ok = True
    for var, label in required.items():
        if os.getenv(var):
            print(f"  {OK} {var:<20} present  ({label})")
        else:
            print(f"  {BAD} {var:<20} MISSING  ({label})")
            ok = False
    if probe and os.getenv("GCP_PROJECT_ID"):
        ok = _probe_vertex() and ok
    if probe and os.getenv("K2THINK_API_KEY"):
        ok = _probe_openai_compatible(
            "K2 Think", os.getenv("K2THINK_API_KEY"),
            "https://api.k2think.ai/v1", "MBZUAI-IFM/K2-Think-v2",
        ) and ok
    if probe and os.getenv("FEATHERLESS_KEY"):
        ok = _probe_openai_compatible(
            "Featherless", os.getenv("FEATHERLESS_KEY"),
            os.getenv("FEATHERLESS_BASE_URL", "https://api.featherless.ai/v1"),
            os.getenv("FEATHERLESS_MODEL", "Qwen/Qwen2.5-1.5B-Instruct"),
        ) and ok
    return ok


def _probe_openai_compatible(label: str, key: str, base_url: str, model: str) -> bool:
    try:
        from openai import OpenAI
        client = OpenAI(api_key=key, base_url=base_url)
        client.chat.completions.create(
            model=model, messages=[{"role": "user", "content": "ping"}], max_tokens=1
        )
        print(f"  {OK} {label} live ({model})")
        return True
    except Exception as e:
        print(f"  {WARN} {label} probe failed ({model}): {str(e)[:120]}")
        return False


def _probe_vertex() -> bool:
    # Vertex AI takes an OAuth2 access token (via Application Default
    # Credentials), not a static key, so this can't reuse _probe_openai_compatible.
    try:
        sys.path.insert(0, str(ROOT / "agents"))
        from model_router import client_for
        client, model = client_for("logistics")
        client.chat.completions.create(
            model=model, messages=[{"role": "user", "content": "ping"}], max_tokens=1
        )
        print(f"  {OK} Vertex AI (Gemini) live ({model})")
        return True
    except Exception as e:
        print(f"  {WARN} Vertex AI (Gemini) probe failed: {str(e)[:160]}")
        return False


async def main() -> None:
    parser = argparse.ArgumentParser(description="Ops-room readiness preflight check.")
    parser.add_argument("--probe-models", action="store_true",
                        help="Make a 1-token call to Vertex AI (Gemini), K2 Think, and Featherless to verify credentials work.")
    args = parser.parse_args()

    print("=" * 60)
    print("OPS ROOM PREFLIGHT")
    print("=" * 60)
    db = await check_db()
    redis = await check_redis()
    reg = check_registry()
    keys = check_keys(args.probe_models)

    print("\n" + "=" * 60)
    if db and redis and reg and keys:
        print(f"{OK} ALL CHECKS PASSED — clear to run `make run-all`.")
        sys.exit(0)
    print(f"{BAD} Not ready. Fix the items marked [FAIL] above, then re-run.")
    sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
