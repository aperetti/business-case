"""Shared pytest fixtures."""

from __future__ import annotations

from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture()
def client(tmp_path: Path) -> Iterator[TestClient]:
    """Fresh FastAPI TestClient backed by an isolated temporary SQLite database."""
    db_file = tmp_path / "test_bca.db"
    application = create_app(db_path=db_file, seed_demo=False)
    with TestClient(application) as test_client:
        yield test_client


@pytest.fixture()
def seeded_client(tmp_path: Path) -> Iterator[TestClient]:
    """TestClient with baseline catalog AND demo initiative seeded."""
    db_file = tmp_path / "seeded_bca.db"
    application = create_app(db_path=db_file, seed_demo=True)
    with TestClient(application) as test_client:
        yield test_client
