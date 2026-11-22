"""Initiative and line-item CRUD endpoints."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request, Response, status

from app.db import repository
from app.models import (
    BCACreate,
    BCADetail,
    BCASummary,
    BCAUpdate,
    InitiativeCreate,
    InitiativeDetail,
    InitiativeItemCreate,
    InitiativeItemOut,
    InitiativeItemUpdate,
    InitiativeSummary,
    InitiativeUpdate,
)

router = APIRouter(prefix="/api", tags=["initiatives"])


@router.get("/initiatives", response_model=list[InitiativeSummary])
def list_initiatives(request: Request) -> list[InitiativeSummary]:
    return repository.list_initiatives(request.app.state.db_path)


@router.post("/initiatives", response_model=InitiativeDetail, status_code=status.HTTP_201_CREATED)
def create_initiative(request: Request, payload: InitiativeCreate) -> InitiativeDetail:
    return repository.create_initiative(request.app.state.db_path, payload)


@router.get("/initiatives/{initiative_id}", response_model=InitiativeDetail)
def get_initiative(
    request: Request,
    initiative_id: str,
    bca_id: str | None = Query(default=None),
) -> InitiativeDetail:
    try:
        return repository.get_initiative_detail(request.app.state.db_path, initiative_id, bca_id=bca_id)
    except repository.NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


@router.patch("/initiatives/{initiative_id}", response_model=InitiativeDetail)
def update_initiative(request: Request, initiative_id: str, payload: InitiativeUpdate) -> InitiativeDetail:
    try:
        return repository.update_initiative(request.app.state.db_path, initiative_id, payload)
    except repository.NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except repository.ValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.delete("/initiatives/{initiative_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_initiative(request: Request, initiative_id: str) -> Response:
    try:
        repository.delete_initiative(request.app.state.db_path, initiative_id)
    except repository.NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/initiatives/{initiative_id}/bcas", response_model=list[BCASummary])
def list_initiative_bcas(request: Request, initiative_id: str) -> list[BCASummary]:
    try:
        return repository.list_bcas(request.app.state.db_path, initiative_id)
    except repository.NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


@router.post(
    "/initiatives/{initiative_id}/bcas",
    response_model=BCADetail,
    status_code=status.HTTP_201_CREATED,
)
def create_initiative_bca(request: Request, initiative_id: str, payload: BCACreate) -> BCADetail:
    try:
        return repository.create_bca(request.app.state.db_path, initiative_id, payload)
    except repository.NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except repository.ValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/initiatives/{initiative_id}/bcas/{bca_id}", response_model=BCADetail)
def get_initiative_bca(request: Request, initiative_id: str, bca_id: str) -> BCADetail:
    try:
        return repository.get_bca_detail(request.app.state.db_path, initiative_id, bca_id)
    except repository.NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


@router.patch("/initiatives/{initiative_id}/bcas/{bca_id}", response_model=BCADetail)
def update_initiative_bca(
    request: Request, initiative_id: str, bca_id: str, payload: BCAUpdate
) -> BCADetail:
    try:
        return repository.update_bca(request.app.state.db_path, initiative_id, bca_id, payload)
    except repository.NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except repository.ValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.delete("/initiatives/{initiative_id}/bcas/{bca_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_initiative_bca(request: Request, initiative_id: str, bca_id: str) -> Response:
    try:
        repository.delete_bca(request.app.state.db_path, initiative_id, bca_id)
    except repository.NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except repository.ValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/initiatives/{initiative_id}/items",
    response_model=InitiativeItemOut,
    status_code=status.HTTP_201_CREATED,
)
def add_initiative_item(
    request: Request,
    initiative_id: str,
    payload: InitiativeItemCreate,
    bca_id: str | None = Query(default=None),
) -> InitiativeItemOut:
    try:
        return repository.create_item(request.app.state.db_path, initiative_id, payload, bca_id=bca_id)
    except repository.NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except repository.ValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.patch("/items/{item_id}", response_model=InitiativeItemOut)
def update_initiative_item(
    request: Request, item_id: str, payload: InitiativeItemUpdate
) -> InitiativeItemOut:
    try:
        return repository.update_item(request.app.state.db_path, item_id, payload)
    except repository.NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except repository.ValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.delete("/items/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_initiative_item(request: Request, item_id: str) -> Response:
    try:
        repository.delete_item(request.app.state.db_path, item_id)
    except repository.NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)
