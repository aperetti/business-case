"""Shared pytest fixtures."""

from __future__ import annotations

from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from app.config import ALL_AUTH_ENV_VAR_NAMES
from app.db.repository import clear_llm_verified_cache
from app.main import create_app


@pytest.fixture(autouse=True)
def _isolate_auth_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Prevent host process environment or local .env files from leaking into tests."""
    clear_llm_verified_cache()
    for name in ALL_AUTH_ENV_VAR_NAMES:
        monkeypatch.delenv(name, raising=False)


@pytest.fixture()
def client(tmp_path: Path) -> Iterator[TestClient]:
    """Fresh FastAPI TestClient backed by an isolated temporary SQLite database."""
    db_file = tmp_path / "test_bca.db"
    application = create_app(db_path=db_file, seed_demo=False, load_env=False)
    with TestClient(application) as test_client:
        yield test_client


@pytest.fixture()
def seeded_client(tmp_path: Path) -> Iterator[TestClient]:
    """TestClient with baseline catalog AND demo initiative seeded."""
    db_file = tmp_path / "seeded_bca.db"
    application = create_app(db_path=db_file, seed_demo=True, load_env=False)
    with TestClient(application) as test_client:
        yield test_client
