"""Admin endpoints for LLM endpoint configuration, testing, API keys, and KB readiness."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request, status

from app.core.auth import AuthError, authenticate_request
from app.core.docs_kb import GUIDE_KB_ENTRIES
from app.core.llm_client import UpstreamLLMError, fetch_upstream_models, test_upstream_connection
from app.core.odata import ODataError, execute_odata_query, get_odata_entity_summaries
from app.core.sso_client import test_sso_discovery
from app.db.repository import (
    ConflictError,
    ForbiddenError,
    NotFoundError,
    ValidationError,
    count_inbound_api_keys,
    count_kb_entities,
    create_api_key,
    create_role,
    create_user,
    delete_api_key,
    delete_role,
    delete_user,
    get_llm_settings,
    get_llm_settings_raw,
    get_sso_public_config,
    get_sso_settings,
    get_sso_settings_raw,
    list_api_keys,
    list_roles,
    list_users,
    update_llm_settings,
    update_role,
    update_sso_settings,
    update_user,
)
from app.models import (
    ApiKeyCreate,
    ApiKeyCreatedOut,
    ApiKeyOut,
    AuthMeOut,
    KBStatusOut,
    LLMModelsFetchRequest,
    LLMModelsFetchResponse,
    LLMSettingsOut,
    LLMSettingsUpdate,
    LLMTestRequest,
    LLMTestResponse,
    ODataEntitySetSummary,
    ODataStatusOut,
    RoleCreate,
    RoleOut,
    RoleUpdate,
    SSOPublicConfigOut,
    SSOProvider,
    SSOSettingsOut,
    SSOSettingsUpdate,
    SSOTestRequest,
    SSOTestResponse,
    UserCreate,
    UserOut,
    UserStatus,
    UserUpdate,
)

router = APIRouter(prefix="/api/admin", tags=["admin"])
public_auth_router = APIRouter(prefix="/api/auth", tags=["auth"])


def _resolve_effective_connection(
    raw_saved: dict,
    *,
    base_url: str | None,
    api_key: str | None,
    clear_api_key: bool,
    timeout_seconds: int | None,
) -> tuple[str, str, int]:
    eff_base = base_url if base_url is not None else str(raw_saved.get("base_url") or "")
    if clear_api_key:
        eff_key = ""
    elif api_key is not None and api_key.strip():
        eff_key = api_key.strip()
    else:
        eff_key = str(raw_saved.get("api_key") or "")
    eff_timeout = (
        int(timeout_seconds)
        if timeout_seconds is not None
        else int(raw_saved.get("timeout_seconds") or 45)
    )
    return eff_base, eff_key, eff_timeout


@router.get("/llm", response_model=LLMSettingsOut)
def get_admin_llm_settings(request: Request) -> LLMSettingsOut:
    """Return masked OpenAI-compatible provider settings."""
    return get_llm_settings(request.app.state.db_path)


@router.put("/llm", response_model=LLMSettingsOut)
def put_admin_llm_settings(payload: LLMSettingsUpdate, request: Request) -> LLMSettingsOut:
    """Persist OpenAI-compatible endpoint, secret key (or preserve existing), model, and tuning defaults."""
    return update_llm_settings(request.app.state.db_path, payload)


@router.post("/llm/test", response_model=LLMTestResponse)
async def post_admin_llm_test(payload: LLMTestRequest, request: Request) -> LLMTestResponse:
    """Send a minimal chat completion ping against candidate or persisted LLM provider settings."""
    raw = get_llm_settings_raw(request.app.state.db_path)
    eff_base, eff_key, eff_timeout = _resolve_effective_connection(
        raw,
        base_url=payload.base_url,
        api_key=payload.api_key,
        clear_api_key=payload.clear_api_key,
        timeout_seconds=payload.timeout_seconds,
    )
    eff_model = payload.model.strip() if payload.model is not None else str(raw.get("model") or "")
    return await test_upstream_connection(eff_base, eff_key, eff_model, eff_timeout)


@router.post("/llm/models", response_model=LLMModelsFetchResponse)
async def post_admin_llm_models(payload: LLMModelsFetchRequest, request: Request) -> LLMModelsFetchResponse:
    """Fetch available model IDs from the configured OpenAI-compatible /models endpoint."""
    raw = get_llm_settings_raw(request.app.state.db_path)
    eff_base, eff_key, eff_timeout = _resolve_effective_connection(
        raw,
        base_url=payload.base_url,
        api_key=payload.api_key,
        clear_api_key=payload.clear_api_key,
        timeout_seconds=payload.timeout_seconds,
    )
    try:
        models = await fetch_upstream_models(eff_base, eff_key, eff_timeout)
        return LLMModelsFetchResponse(models=models, error=None)
    except UpstreamLLMError as exc:
        return LLMModelsFetchResponse(models=[], error=str(exc))


@router.get("/api-keys", response_model=list[ApiKeyOut])
def get_admin_api_keys(request: Request) -> list[ApiKeyOut]:
    """List issued inbound API keys for /v1/* consumers."""
    return list_api_keys(request.app.state.db_path)


@router.post("/api-keys", response_model=ApiKeyCreatedOut, status_code=status.HTTP_201_CREATED)
def post_admin_api_key(payload: ApiKeyCreate, request: Request) -> ApiKeyCreatedOut:
    """Create and hash a new inbound API key, returning the secret once."""
    try:
        return create_api_key(request.app.state.db_path, payload.name)
    except ConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc


@router.delete("/api-keys/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_admin_api_key(key_id: str, request: Request) -> None:
    """Revoke an inbound API key."""
    try:
        delete_api_key(request.app.state.db_path, key_id)
    except ConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


@router.get("/kb-status", response_model=KBStatusOut)
def get_admin_kb_status(request: Request) -> KBStatusOut:
    """Return current Docs Agent knowledge base counts and provider readiness."""
    db_path = request.app.state.db_path
    builtin_cnt, custom_cnt, init_cnt = count_kb_entities(db_path)
    settings = get_llm_settings(db_path)
    key_cnt = count_inbound_api_keys(db_path)
    return KBStatusOut(
        guide_count=len(GUIDE_KB_ENTRIES),
        builtin_catalog_count=builtin_cnt,
        custom_catalog_count=custom_cnt,
        initiative_count=init_cnt,
        configured=settings.configured,
        active_model=settings.model,
        inbound_key_count=key_cnt,
    )


@router.get("/sso", response_model=SSOSettingsOut)
def get_admin_sso_settings(request: Request) -> SSOSettingsOut:
    """Return Single Sign-On settings with masked Entra client secret."""
    return get_sso_settings(request.app.state.db_path)


@router.put("/sso", response_model=SSOSettingsOut)
def put_admin_sso_settings(payload: SSOSettingsUpdate, request: Request) -> SSOSettingsOut:
    """Save Single Sign-On provider configuration (Firebase default or Microsoft Entra ID)."""
    try:
        return update_sso_settings(request.app.state.db_path, payload)
    except ConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc


@router.post("/sso/test", response_model=SSOTestResponse)
async def post_admin_sso_test(payload: SSOTestRequest, request: Request) -> SSOTestResponse:
    """Verify OIDC discovery document reachability for Firebase or Microsoft Entra ID."""
    raw = get_sso_settings_raw(request.app.state.db_path)
    if raw.get("managed_by_env"):
        eff_provider: SSOProvider = "entra" if raw.get("provider") == "entra" else "firebase"
        eff_fb_project = str(raw.get("firebase_project_id") or "").strip()
        eff_entra_tenant = str(raw.get("entra_tenant_id") or "").strip()
        eff_entra_client = str(raw.get("entra_client_id") or "").strip()
        eff_entra_host = str(raw.get("entra_authority_host") or "https://login.microsoftonline.com")
    else:
        eff_provider = payload.provider or ("entra" if raw.get("provider") == "entra" else "firebase")
        eff_fb_project = (
            payload.firebase_project_id.strip()
            if payload.firebase_project_id is not None
            else str(raw.get("firebase_project_id") or "")
        )
        eff_entra_tenant = (
            payload.entra_tenant_id.strip()
            if payload.entra_tenant_id is not None
            else str(raw.get("entra_tenant_id") or "")
        )
        eff_entra_client = (
            payload.entra_client_id.strip()
            if payload.entra_client_id is not None
            else str(raw.get("entra_client_id") or "")
        )
        eff_entra_host = (
            payload.entra_authority_host
            if payload.entra_authority_host is not None
            else str(raw.get("entra_authority_host") or "https://login.microsoftonline.com")
        )
    return await test_sso_discovery(
        provider=eff_provider,
        firebase_project_id=eff_fb_project,
        entra_tenant_id=eff_entra_tenant,
        entra_client_id=eff_entra_client,
        entra_authority_host=eff_entra_host,
        timeout_seconds=payload.timeout_seconds,
    )


@public_auth_router.get("/sso/public", response_model=SSOPublicConfigOut)
def get_public_sso_config(request: Request) -> SSOPublicConfigOut:
    """Public client-safe SSO configuration for frontend authentication initialization."""
    return get_sso_public_config(request.app.state.db_path)


@public_auth_router.get("/me", response_model=AuthMeOut)
async def get_auth_me(request: Request) -> AuthMeOut:
    """Validate the current Bearer token (when supplied) and return RBAC session metadata."""
    try:
        user, auth_required, sso_active, provider = await authenticate_request(
            request, request.app.state.db_path
        )
    except AuthError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    except ForbiddenError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(exc),
        ) from exc

    return AuthMeOut(
        authenticated=user is not None,
        auth_required=auth_required,
        sso_enabled=sso_active,
        provider=provider,
        user=user,
    )


# --- Roles & Users Management ---


@router.get("/roles", response_model=list[RoleOut])
def get_admin_roles(request: Request) -> list[RoleOut]:
    """List RBAC roles with assigned user counts."""
    return list_roles(request.app.state.db_path)


@router.post("/roles", response_model=RoleOut, status_code=status.HTTP_201_CREATED)
def post_admin_role(payload: RoleCreate, request: Request) -> RoleOut:
    """Create a custom RBAC role."""
    try:
        return create_role(request.app.state.db_path, payload)
    except ConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc


@router.patch("/roles/{role_id}", response_model=RoleOut)
def patch_admin_role(role_id: str, payload: RoleUpdate, request: Request) -> RoleOut:
    """Update a role name, description, or permission set."""
    try:
        return update_role(request.app.state.db_path, role_id, payload)
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc


@router.delete("/roles/{role_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_admin_role(role_id: str, request: Request) -> None:
    """Delete a custom role that has no assigned users."""
    try:
        delete_role(request.app.state.db_path, role_id)
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc


@router.get("/users", response_model=list[UserOut])
def get_admin_users(
    request: Request,
    search: str | None = None,
    role_id: str | None = None,
    status_filter: UserStatus | None = None,
) -> list[UserOut]:
    """List application users filtered by search query, role, or status."""
    return list_users(
        request.app.state.db_path,
        search=search,
        role_id=role_id,
        status_filter=status_filter,
    )


@router.post("/users", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def post_admin_user(payload: UserCreate, request: Request) -> UserOut:
    """Create or invite a managed user."""
    try:
        return create_user(request.app.state.db_path, payload)
    except ConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc


@router.patch("/users/{user_id}", response_model=UserOut)
def patch_admin_user(user_id: str, payload: UserUpdate, request: Request) -> UserOut:
    """Update a user's display name, email, role assignment, status, or identity provider."""
    try:
        return update_user(request.app.state.db_path, user_id, payload)
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_admin_user(user_id: str, request: Request) -> None:
    """Remove a managed user."""
    try:
        delete_user(request.app.state.db_path, user_id)
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


# --- OData v4 BI Feed Status & Query Preview ---


@router.get("/odata/status", response_model=ODataStatusOut)
def get_admin_odata_status(request: Request) -> ODataStatusOut:
    """Return OData v4 service metadata, authentication mode, and live row counts per entity set."""
    db_path = request.app.state.db_path
    key_cnt = count_inbound_api_keys(db_path)
    summaries = [ODataEntitySetSummary(**item) for item in get_odata_entity_summaries(db_path)]
    return ODataStatusOut(
        service_root_path="/odata/v4",
        alias_path="/odata",
        metadata_path="/odata/v4/$metadata",
        odata_version="4.0",
        auth_mode="api_key_required" if key_cnt > 0 else "open",
        inbound_key_count=key_cnt,
        entity_sets=summaries,
    )


@router.get("/odata/preview")
def get_admin_odata_preview(
    request: Request,
    entity_set: str = Query(default="Initiatives", min_length=1, max_length=64),
    filter: str | None = Query(default=None, alias="filter", max_length=2000),
    select: str | None = Query(default=None, max_length=1000),
    orderby: str | None = Query(default=None, max_length=500),
    expand: str | None = Query(default=None, max_length=1000),
    top: int = Query(default=25, ge=1, le=200),
    skip: int = Query(default=0, ge=0, le=100000),
    count: bool = Query(default=True),
) -> dict:
    """Execute an OData v4 query for the Admin Portal Explorer without requiring Basic/Bearer headers."""
    fwd_proto = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip()
    fwd_host = (request.headers.get("x-forwarded-host") or "").split(",")[0].strip()
    scheme = fwd_proto or request.url.scheme or "http"
    host = fwd_host or (request.headers.get("host") or "").strip()
    origin = f"{scheme}://{host}" if host else str(request.base_url).rstrip("/")
    service_root = f"{origin}/odata/v4"

    q_params: dict[str, str] = {
        "$top": str(top),
        "$skip": str(skip),
        "$count": "true" if count else "false",
    }
    if filter and filter.strip():
        q_params["$filter"] = filter.strip()
    if select and select.strip():
        q_params["$select"] = select.strip()
    if orderby and orderby.strip():
        q_params["$orderby"] = orderby.strip()
    if expand and expand.strip():
        q_params["$expand"] = expand.strip()

    try:
        payload, _ = execute_odata_query(
            request.app.state.db_path,
            resource_path=entity_set,
            query_params=q_params,
            service_root=service_root,
        )
    except ODataError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST if exc.status_code < 500 else exc.status_code,
            detail=exc.message,
        ) from exc
    return payload
