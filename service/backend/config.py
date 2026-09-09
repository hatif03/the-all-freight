from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import field_validator
from typing import Optional
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

class Settings(BaseSettings):
    # Data
    AISSTREAM_API_KEY: Optional[str] = None

    # Models / partners
    AIMLAPI_KEY: Optional[str] = None
    FEATHERLESS_KEY: Optional[str] = None
    OPENAI_API_KEY: Optional[str] = None
    ANAKIN_API_KEY: Optional[str] = None

    # Infra
    DATABASE_URL: str = "postgresql+asyncpg://postgres@localhost/ops_room"
    REDIS_URL: str = "redis://localhost:6379"
    SQL_ECHO: bool = False

    @field_validator("DATABASE_URL", mode="before")
    @classmethod
    def fix_postgres_scheme(cls, v: str) -> str:
        if v.startswith("postgres://"):
            v = v.replace("postgres://", "postgresql+asyncpg://", 1)
        elif v.startswith("postgresql://") and "+asyncpg" not in v:
            v = v.replace("postgresql://", "postgresql+asyncpg://", 1)
        if v.startswith("postgresql+asyncpg://"):
            parts = urlsplit(v)
            query = dict(parse_qsl(parts.query, keep_blank_values=True))
            if "sslmode" in query and "ssl" not in query:
                query["ssl"] = query["sslmode"]
            query.pop("sslmode", None)
            query.pop("channel_binding", None)
            v = urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))
        return v

    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

settings = Settings()
