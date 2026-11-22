"""Catalog endpoints."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request, status

from app.db import repository
from app.models import CatalogEntry, CatalogEntryCreate, CatalogKind

router = APIRouter(prefix="/api/catalog", tags=["catalog"])


@router.get("", response_model=list[CatalogEntry])
def list_catalog_entries(
    request: Request,
    domain: str | None = Query(default=None, description="Filter entries by domain tag"),
    kind: CatalogKind | None = Query(default=None, description="Filter by 'cost' or 'benefit'"),
    search: str | None = Query(default=None, description="Search by ID, name, or description"),
) -> list[CatalogEntry]:
    return repository.list_catalog(request.app.state.db_path, domain=domain, kind=kind, search=search)


@router.post("", response_model=CatalogEntry, status_code=status.HTTP_201_CREATED)
def create_catalog_entry(request: Request, payload: CatalogEntryCreate) -> CatalogEntry:
    try:
        return repository.create_catalog_entry(request.app.state.db_path, payload)
    except repository.ConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
