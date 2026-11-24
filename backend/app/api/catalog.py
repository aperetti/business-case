"""Catalog endpoints."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request, status

from app.db import repository
from app.models import CatalogDocUpdate, CatalogEntry, CatalogEntryCreate, CatalogEntryUpdate, CatalogKind

router = APIRouter(prefix="/api/catalog", tags=["catalog"])


def _actor_email(request: Request) -> str:
    user = getattr(request.state, "auth_user", None)
    return user.email if user is not None else ""


def _http_error(exc: Exception) -> HTTPException:
    if isinstance(exc, repository.NotFoundError):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    if isinstance(exc, repository.LockedError):
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    return HTTPException(status_code=422, detail=str(exc))


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
        return repository.create_catalog_entry(
            request.app.state.db_path, payload, created_by=_actor_email(request)
        )
    except repository.ConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc


@router.get("/{entry_id}", response_model=CatalogEntry)
def get_catalog_entry(request: Request, entry_id: str) -> CatalogEntry:
    try:
        return repository.get_catalog_entry(request.app.state.db_path, entry_id)
    except repository.NotFoundError as exc:
        raise _http_error(exc) from exc


@router.patch("/{entry_id}", response_model=CatalogEntry)
def update_catalog_entry(request: Request, entry_id: str, payload: CatalogEntryUpdate) -> CatalogEntry:
    try:
        return repository.update_catalog_entry(request.app.state.db_path, entry_id, payload)
    except (repository.NotFoundError, repository.ValidationError, repository.LockedError) as exc:
        raise _http_error(exc) from exc


@router.put("/{entry_id}/doc", response_model=CatalogEntry)
def save_catalog_doc(request: Request, entry_id: str, payload: CatalogDocUpdate) -> CatalogEntry:
    try:
        return repository.save_catalog_doc(
            request.app.state.db_path, entry_id, payload, updated_by=_actor_email(request)
        )
    except repository.NotFoundError as exc:
        raise _http_error(exc) from exc


@router.delete("/{entry_id}/doc", response_model=CatalogEntry)
def reset_catalog_doc(request: Request, entry_id: str) -> CatalogEntry:
    try:
        return repository.reset_catalog_doc(request.app.state.db_path, entry_id)
    except (repository.NotFoundError, repository.ValidationError) as exc:
        raise _http_error(exc) from exc
