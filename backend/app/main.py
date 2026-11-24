"""FastAPI application entrypoint for the Cross-Domain Value Stream & Monte Carlo BCA Platform."""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.admin import public_auth_router, router as admin_router
from app.api.catalog import router as catalog_router
from app.api.chat import router as chat_router
from app.api.initiatives import router as initiatives_router
from app.api.odata import router_alias as odata_alias_router, router_v4 as odata_v4_router
from app.api.reports import router as reports_router
from app.api.simulations import router as simulations_router
from app.api.workflows import admin_router as workflows_admin_router, router as approvals_router
from app.config import get_settings, load_dotenv_files
from app.core.auth import AuthError, authenticate_request, required_permission_for_request
from app.db.database import init_db
from app.db.repository import ForbiddenError, LockedError, check_health, get_sso_settings
from app.models import HealthResponse


def create_app(*, db_path: Path | None = None, seed_demo: bool = True, load_env: bool = True) -> FastAPI:
    """Create and configure a FastAPI instance backed by SQLite."""
    if load_env:
        load_dotenv_files()
    settings = get_settings()
    resolved_db = db_path or settings.database_path

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        init_db(application.state.db_path, seed_demo=application.state.seed_demo)
        yield

    application = FastAPI(
        title="Cross-Domain Value Stream & Monte Carlo BCA Platform",
        version="0.1.0",
        lifespan=lifespan,
    )
    application.state.db_path = resolved_db
    application.state.seed_demo = seed_demo

    @application.middleware("http")
    async def sso_enforcement_middleware(request: Request, call_next):
        path = request.url.path
        if (
            request.method == "OPTIONS"
            or not path.startswith("/api/")
            or path in ("/api/auth/sso/public", "/api/auth/me")
        ):
            return await call_next(request)

        sso = get_sso_settings(request.app.state.db_path)
        sso_active = sso.enabled and sso.configured
        # Admin routes control SSO, users, roles, API keys, and LLM secrets. Once SSO is
        # active they always require an authenticated admin, even when general access is
        # not enforced; otherwise an anonymous caller could rewrite SSO settings (e.g. add
        # their own email to admin_emails) and take over the workspace.
        # Only Firebase ID tokens can be verified server-side today, so the admin lock
        # applies to the Firebase provider (Entra would otherwise lock every admin out).
        is_admin_path = sso.provider == "firebase" and (
            path == "/api/admin" or path.startswith("/api/admin/")
        )
        if not (sso_active and (sso.enforce_sso or is_admin_path)):
            return await call_next(request)

        try:
            user, _, _, _ = await authenticate_request(request, request.app.state.db_path)
        except AuthError as exc:
            return JSONResponse(
                status_code=status.HTTP_401_UNAUTHORIZED,
                content={"detail": str(exc)},
                headers={"WWW-Authenticate": "Bearer"},
            )
        except ForbiddenError as exc:
            return JSONResponse(
                status_code=status.HTTP_403_FORBIDDEN,
                content={"detail": str(exc)},
            )

        if user is None:
            return JSONResponse(
                status_code=status.HTTP_401_UNAUTHORIZED,
                content={"detail": "Authentication required. Please sign in."},
                headers={"WWW-Authenticate": "Bearer"},
            )

        req_perm = required_permission_for_request(request.method, path)
        if req_perm and req_perm not in user.permissions:
            return JSONResponse(
                status_code=status.HTTP_403_FORBIDDEN,
                content={"detail": f"Missing required permission: {req_perm}"},
            )

        request.state.auth_user = user
        return await call_next(request)

    application.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        # Lets the browser read report download filenames on cross-origin deployments.
        expose_headers=["Content-Disposition"],
    )

    @application.exception_handler(LockedError)
    async def locked_error_handler(_: Request, exc: LockedError) -> JSONResponse:
        return JSONResponse(status_code=status.HTTP_409_CONFLICT, content={"detail": str(exc)})

    @application.get("/health", response_model=HealthResponse, tags=["system"])
    def health_check(request: Request) -> HealthResponse:
        try:
            catalog_count = check_health(request.app.state.db_path)
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"Database health check failed: {exc}",
            ) from exc
        return HealthResponse(status="ok", database="ok", catalog_count=catalog_count)

    application.include_router(catalog_router)
    application.include_router(reports_router)
    application.include_router(simulations_router)
    application.include_router(initiatives_router)
    application.include_router(admin_router)
    application.include_router(workflows_admin_router)
    application.include_router(approvals_router)
    application.include_router(public_auth_router)
    application.include_router(chat_router)
    application.include_router(odata_v4_router)
    application.include_router(odata_alias_router)
    return application


app = create_app()
