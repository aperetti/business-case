"""Application configuration loaded from environment variables."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path


def _parse_cors_origins(raw: str | None) -> list[str]:
    if not raw or not raw.strip():
        return ["http://localhost:5173", "http://127.0.0.1:5173"]
    stripped = raw.strip()
    if stripped.startswith("["):
        try:
            parsed = json.loads(stripped)
            if isinstance(parsed, list):
                return [str(item).strip() for item in parsed if str(item).strip()]
        except json.JSONDecodeError:
            pass
    return [part.strip() for part in stripped.split(",") if part.strip()]


@dataclass(frozen=True)
class Settings:
    """Runtime settings for the local-first BCA platform."""

    database_path: Path
    cors_origins: list[str]
    max_simulations: int = 50_000
    default_simulations: int = 10_000


def get_settings() -> Settings:
    """Resolve runtime settings from the environment with safe local defaults."""
    backend_root = Path(__file__).resolve().parent.parent
    default_db = backend_root / "data" / "bca.db"
    raw_db = os.getenv("DATABASE_PATH", "").strip()
    db_path = Path(raw_db).expanduser() if raw_db else default_db
    cors_origins = _parse_cors_origins(os.getenv("CORS_ORIGINS"))
    return Settings(database_path=db_path, cors_origins=cors_origins)
