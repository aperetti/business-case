"""OASIS OData v4.0 FastAPI routers (/odata/v4 and /odata alias) for BI extraction."""

from __future__ import annotations

import base64
from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse, PlainTextResponse

from app.core.odata import (
    ODATA_VERSION,
    ODataError,
    build_csdl_metadata_xml,
    build_service_document,
    execute_odata_query,
    odata_error_payload,
)
from app.db.repository import inbound_open_access_allowed, verify_inbound_api_key

ODATA_JSON_MEDIA_TYPE = "application/json; odata.metadata=minimal; charset=utf-8"
_BASE_HEADERS = {"OData-Version": ODATA_VERSION}


def _extract_candidate_keys(request: Request) -> list[str]:
    candidates: list[str] = []

    auth_header = (request.headers.get("authorization") or "").strip()
    if auth_header:
        parts = auth_header.split(None, 1)
        scheme = parts[0].lower()
        cred = parts[1].strip() if len(parts) == 2 else ""
        if scheme == "bearer" and cred:
            candidates.append(cred)
        elif scheme == "basic" and cred:
            try:
                decoded = base64.b64decode(cred).decode("utf-8", errors="ignore")
                if ":" in decoded:
                    user, password = decoded.split(":", 1)
                    if password.strip():
                        candidates.append(password.strip())
                    if user.strip():
                        candidates.append(user.strip())
                elif decoded.strip():
                    candidates.append(decoded.strip())
            except Exception:
                pass

    x_api_key = (request.headers.get("x-api-key") or "").strip()
    if x_api_key:
        candidates.append(x_api_key)

    return candidates


def _require_odata_auth(request: Request) -> JSONResponse | None:
    db_path = request.app.state.db_path
    if inbound_open_access_allowed(db_path):
        return None
    for candidate in _extract_candidate_keys(request):
        if verify_inbound_api_key(db_path, candidate):
            return None
    return JSONResponse(
        status_code=401,
        content=odata_error_payload(
            "Unauthorized",
            "Valid API key required. Supply Bearer token, Basic credentials (API key as username or password), or X-API-Key header.",
        ),
        headers={
            **_BASE_HEADERS,
            "WWW-Authenticate": 'Basic realm="ValueStream BCA OData", Bearer',
        },
        media_type=ODATA_JSON_MEDIA_TYPE,
    )


def _resolve_service_root(request: Request, prefix: str) -> str:
    fwd_proto = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip()
    fwd_host = (request.headers.get("x-forwarded-host") or "").split(",")[0].strip()
    scheme = fwd_proto or request.url.scheme or "http"
    host = fwd_host or (request.headers.get("host") or "").strip()
    if host:
        origin = f"{scheme}://{host}"
    else:
        origin = str(request.base_url).rstrip("/")
    return f"{origin}{prefix}"


def _build_odata_router(prefix: str, *, include_in_schema: bool = True) -> APIRouter:
    router = APIRouter(prefix=prefix, tags=["odata"], include_in_schema=include_in_schema)

    @router.get("", include_in_schema=include_in_schema)
    @router.get("/", include_in_schema=include_in_schema)
    def odata_service_document(request: Request) -> Response:
        """OData v4 Service Document enumerating Initiatives, CostBenefitItems, YearlyCashFlows, ValueStreams, CatalogEntries, and SimulationRuns."""
        auth_err = _require_odata_auth(request)
        if auth_err is not None:
            return auth_err
        service_root = _resolve_service_root(request, prefix)
        return JSONResponse(
            content=build_service_document(service_root),
            headers=_BASE_HEADERS,
            media_type=ODATA_JSON_MEDIA_TYPE,
        )

    @router.get("/$metadata", include_in_schema=include_in_schema)
    def odata_metadata(request: Request) -> Response:
        """OData v4 CSDL XML metadata document for Power BI, Excel, and BI schema discovery."""
        auth_err = _require_odata_auth(request)
        if auth_err is not None:
            return auth_err
        xml_body = build_csdl_metadata_xml()
        return Response(
            content=xml_body,
            media_type="application/xml; charset=utf-8",
            headers=_BASE_HEADERS,
        )

    @router.get("/{resource_path:path}", include_in_schema=include_in_schema)
    def odata_resource(resource_path: str, request: Request) -> Response:
        """Execute an OData v4 entity set, key lookup, $count, or navigation property query."""
        auth_err = _require_odata_auth(request)
        if auth_err is not None:
            return auth_err
        service_root = _resolve_service_root(request, prefix)
        query_params = {k: v for k, v in request.query_params.items()}
        try:
            payload, kind = execute_odata_query(
                request.app.state.db_path,
                resource_path=resource_path,
                query_params=query_params,
                service_root=service_root,
            )
        except ODataError as exc:
            return JSONResponse(
                status_code=exc.status_code,
                content=odata_error_payload(exc.code, exc.message),
                headers=_BASE_HEADERS,
                media_type=ODATA_JSON_MEDIA_TYPE,
            )

        if kind == "count":
            return PlainTextResponse(
                content=str(payload),
                media_type="text/plain; charset=utf-8",
                headers=_BASE_HEADERS,
            )
        return JSONResponse(
            content=payload,
            headers=_BASE_HEADERS,
            media_type=ODATA_JSON_MEDIA_TYPE,
        )

    return router


router_v4 = _build_odata_router("/odata/v4", include_in_schema=True)
router_alias = _build_odata_router("/odata", include_in_schema=False)
