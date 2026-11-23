"""Firebase ID token verification via Google JWKS and RBAC permission mapping."""

from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import jwt
from fastapi import Request
from jwt.algorithms import RSAAlgorithm
from jwt.exceptions import ExpiredSignatureError, PyJWTError

from app.db.repository import (
    ForbiddenError,
    get_sso_settings,
    resolve_or_provision_sso_user,
)
from app.models import AuthUserOut, SSOProvider

FIREBASE_JWKS_URL = (
    "https://www.googleapis.com/service_accounts/v1/jwk/"
    "securetoken@system.gserviceaccount.com"
)

_MAX_AGE_RE = re.compile(r"max-age=(\d+)", re.IGNORECASE)
_JWKS_LOCK = asyncio.Lock()
_jwks_keys: dict[str, dict[str, Any]] = {}
_jwks_expires_at: float = 0.0
_jwks_last_fetched_at: float = 0.0

_MUTATING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


class AuthError(Exception):
    """Raised when Bearer authentication is missing or cannot be cryptographically verified."""


@dataclass(frozen=True)
class VerifiedIdentity:
    """Verified identity claims extracted from an upstream OIDC ID token."""

    uid: str
    email: str
    display_name: str
    photo_url: str
    email_verified: bool
    provider: SSOProvider


def clear_jwks_cache() -> None:
    """Clear the cached Firebase public signing keys (useful for tests)."""
    global _jwks_keys, _jwks_expires_at, _jwks_last_fetched_at
    _jwks_keys = {}
    _jwks_expires_at = 0.0
    _jwks_last_fetched_at = 0.0


def _parse_max_age(cache_control: str) -> float:
    match = _MAX_AGE_RE.search(cache_control or "")
    if not match:
        return 300.0
    seconds = int(match.group(1))
    return float(max(60, min(seconds, 3600)))


async def _get_jwks_key(kid: str) -> dict[str, Any] | None:
    global _jwks_keys, _jwks_expires_at, _jwks_last_fetched_at

    now = time.monotonic()
    if now < _jwks_expires_at and kid in _jwks_keys:
        return _jwks_keys[kid]

    async with _JWKS_LOCK:
        now = time.monotonic()
        if now < _jwks_expires_at and kid in _jwks_keys:
            return _jwks_keys[kid]

        should_refresh = (
            not _jwks_keys
            or now >= _jwks_expires_at
            or (now - _jwks_last_fetched_at) >= 10.0
        )
        if should_refresh:
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    resp = await client.get(FIREBASE_JWKS_URL)
            except httpx.HTTPError as exc:
                if kid in _jwks_keys:
                    return _jwks_keys[kid]
                raise AuthError(f"Unable to reach identity signing keys: {exc}") from exc

            if resp.status_code >= 400:
                if kid in _jwks_keys:
                    return _jwks_keys[kid]
                raise AuthError(f"Identity JWKS endpoint returned HTTP {resp.status_code}.")

            try:
                payload = resp.json()
            except Exception as exc:
                raise AuthError(f"Invalid JSON from identity JWKS endpoint: {exc}") from exc

            keys_raw = payload.get("keys") if isinstance(payload, dict) else None
            if not isinstance(keys_raw, list):
                raise AuthError("Identity JWKS response is missing a keys array.")

            parsed: dict[str, dict[str, Any]] = {}
            for item in keys_raw:
                if isinstance(item, dict) and item.get("kid"):
                    parsed[str(item["kid"])] = item

            _jwks_keys = parsed
            fetched_at = time.monotonic()
            _jwks_last_fetched_at = fetched_at
            _jwks_expires_at = fetched_at + _parse_max_age(resp.headers.get("cache-control", ""))

        return _jwks_keys.get(kid)


async def verify_firebase_id_token(token: str, project_id: str) -> VerifiedIdentity:
    """Verify a Firebase Auth ID token against Google's public RS256 JWKS keys."""
    clean_project = project_id.strip()
    if not clean_project:
        raise AuthError("Firebase project ID is not configured.")

    try:
        header = jwt.get_unverified_header(token)
    except PyJWTError as exc:
        raise AuthError("Malformed authentication token.") from exc

    if header.get("alg") != "RS256":
        raise AuthError("Unsupported token signing algorithm.")

    kid = str(header.get("kid") or "").strip()
    if not kid:
        raise AuthError("Authentication token is missing key identifier.")

    jwk_dict = await _get_jwks_key(kid)
    if jwk_dict is None:
        raise AuthError("Unrecognized token signing key.")

    try:
        public_key = RSAAlgorithm.from_jwk(json.dumps(jwk_dict))
        issuer = f"https://securetoken.google.com/{clean_project}"
        claims = jwt.decode(
            token,
            key=public_key,
            algorithms=["RS256"],
            audience=clean_project,
            issuer=issuer,
            leeway=30,
            options={"require": ["exp", "iat", "sub", "aud", "iss"]},
        )
    except ExpiredSignatureError as exc:
        raise AuthError("Session token has expired. Please sign in again.") from exc
    except PyJWTError as exc:
        raise AuthError(f"Invalid authentication token: {exc}") from exc

    sub = str(claims.get("sub") or "").strip()
    if not sub or len(sub) > 128:
        raise AuthError("Authentication token has an invalid subject.")

    email = str(claims.get("email") or "").strip().lower()
    if "@" not in email or claims.get("email_verified") is not True:
        raise AuthError("A verified email address is required to access this workspace.")

    display_name = str(claims.get("name") or email.split("@", 1)[0]).strip() or email
    photo_url = str(claims.get("picture") or "").strip()
    return VerifiedIdentity(
        uid=sub,
        email=email,
        display_name=display_name,
        photo_url=photo_url,
        email_verified=True,
        provider="firebase",
    )


def extract_bearer_token(request: Request) -> str | None:
    """Extract a Bearer token from the Authorization header if present."""
    auth_header = (request.headers.get("authorization") or "").strip()
    if not auth_header:
        return None
    parts = auth_header.split(None, 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip() or None
    return None


def required_permission_for_request(method: str, path: str) -> str | None:
    """Map an API HTTP method and path to its required RBAC permission key."""
    norm_method = method.upper()
    norm_path = path.rstrip("/") or "/"

    if norm_path == "/api/admin/users" or norm_path.startswith("/api/admin/users/"):
        return "admin:users"
    if norm_path == "/api/admin/roles" or norm_path.startswith("/api/admin/roles/"):
        return "admin:roles"
    if norm_path == "/api/admin/sso" or norm_path.startswith("/api/admin/sso/"):
        return "admin:sso"
    if (
        norm_path == "/api/admin/llm"
        or norm_path.startswith("/api/admin/llm/")
        or norm_path == "/api/admin/api-keys"
        or norm_path.startswith("/api/admin/api-keys/")
        or norm_path == "/api/admin/kb-status"
        or norm_path == "/api/admin/odata"
        or norm_path.startswith("/api/admin/odata/")
    ):
        return "admin:ai"
    if (
        norm_path == "/api/admin/workflows"
        or norm_path.startswith("/api/admin/workflows/")
        or norm_path == "/api/admin/email"
        or norm_path.startswith("/api/admin/email/")
    ):
        return "admin:workflows"
    if norm_path.startswith("/api/admin"):
        return "admin:sso"
    if norm_path.startswith("/api/docs-agent"):
        return "docs:ask"
    if norm_path == "/api/catalog" or norm_path.startswith("/api/catalog/"):
        return "catalog:manage" if norm_method in _MUTATING_METHODS else "initiatives:read"
    if norm_path.startswith("/api/approvals") or norm_path == "/api/workflows":
        return "initiatives:read"
    if norm_path.startswith("/api/initiatives/") and (
        norm_path.endswith("/approval") or "/approval/" in norm_path
    ):
        # Approvers are often read-only reviewers; the workflow engine enforces who may
        # submit, decide, withdraw, or reopen.
        return "initiatives:read"
    if norm_path == "/api/initiatives" or norm_path.startswith("/api/initiatives/"):
        if norm_method == "POST" and (
            norm_path.endswith("/simulate") or norm_path.endswith("/bcas/compare")
        ):
            return "simulations:run"
        return "initiatives:write" if norm_method in _MUTATING_METHODS else "initiatives:read"
    if norm_path.startswith("/api/items"):
        return "initiatives:write" if norm_method in _MUTATING_METHODS else "initiatives:read"
    return None


async def authenticate_request(
    request: Request, db_path: Path
) -> tuple[AuthUserOut | None, bool, bool, SSOProvider]:
    """Authenticate an incoming request against the active SSO configuration."""
    settings = get_sso_settings(db_path)
    sso_active = settings.enabled and settings.configured
    auth_required = sso_active and settings.enforce_sso
    token = extract_bearer_token(request)

    if not token:
        if auth_required:
            raise AuthError("Authentication required. Please sign in.")
        return None, auth_required, sso_active, settings.provider

    if settings.provider != "firebase":
        if auth_required:
            raise AuthError("Bearer token verification is currently supported for Firebase SSO.")
        return None, auth_required, sso_active, settings.provider

    if not settings.firebase_project_id:
        raise AuthError("Firebase project ID is not configured.")

    identity = await verify_firebase_id_token(token, settings.firebase_project_id)
    user = resolve_or_provision_sso_user(
        db_path,
        email=identity.email,
        display_name=identity.display_name,
        photo_url=identity.photo_url,
        provider="firebase",
        allowed_domains=settings.allowed_domains,
        admin_emails=settings.admin_emails,
    )
    return user, auth_required, sso_active, settings.provider
