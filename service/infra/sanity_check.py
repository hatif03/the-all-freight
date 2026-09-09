import asyncio
import asyncpg
import redis.asyncio as redis
import os
import sys
from dotenv import load_dotenv

load_dotenv()

async def sanity_check():
    try:
        # Neon Postgres Check
        db_url = os.getenv("DATABASE_URL")
        # asyncpg needs postgresql:// not postgresql+asyncpg://
        pg_url = db_url.replace("postgresql+asyncpg://", "postgresql://")
        conn = await asyncpg.connect(pg_url)
        await conn.execute("SELECT 1")
        await conn.close()
        print("✅ Neon Postgres: Connected")

        # Upstash Redis Check
        redis_url = os.getenv("REDIS_URL")
        r = redis.from_url(redis_url)
        await r.ping()
        await r.aclose()
        print("✅ Upstash Redis: Connected")
        
        print("\nAll infrastructure systems GO.")
        sys.exit(0)
    except Exception as e:
        print(f"❌ Sanity Check Failed: {e}")
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(sanity_check())
