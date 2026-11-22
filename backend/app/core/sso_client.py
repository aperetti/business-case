"""Live OpenID Connect discovery verifier for Firebase Auth and Microsoft Entra ID SSO."""

from __future__ import annotations

import time

import httpx

from app.db.repository import build_sso_discovery_url
from app.models import SSOProvider, SSOTestResponse


async def test_sso_discovery(
    *,
    provider: SSOProvider,
    firebase_project_id: str,
    entra_tenant_id: str,
    entra_client_id: str,
    entra_authority_host: str,
    timeout_seconds: int = 15,
) -> SSOTestResponse:
    """Fetch .well-known/openid-configuration for the selected SSO provider and validate metadata."""
    if provider == "firebase" and not firebase_project_id.strip():
        return SSOTestResponse(
            ok=False,
            provider=provider,
            latency_ms=0.0,
            error="Firebase Project ID is required before testing OpenID Connect discovery.",
        )

    if provider == "entra" and (not entra_tenant_id.strip() or not entra_client_id.strip()):
        return SSOTestResponse(
            ok=False,
            provider=provider,
            latency_ms=0.0,
            error="Both Directory (Tenant) ID and Application (Client) ID are required before testing Microsoft Entra ID discovery.",
        )

    discovery_url = build_sso_discovery_url(
        provider,
        firebase_project_id,
        entra_tenant_id,
        entra_authority_host,
    )

    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=float(timeout_seconds)) as client:
            resp = await client.get(discovery_url)
        elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 1)
    except httpx.TimeoutException:
        elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 1)
        return SSOTestResponse(
            ok=False,
            provider=provider,
            latency_ms=elapsed_ms,
            discovery_url=discovery_url,
            error=f"Timed out after {timeout_seconds}s requesting {discovery_url}.",
        )
    except httpx.HTTPError as exc:
        elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 1)
        return SSOTestResponse(
            ok=False,
            provider=provider,
            latency_ms=elapsed_ms,
            discovery_url=discovery_url,
            error=f"HTTP error fetching discovery metadata: {exc}",
        )

    if resp.status_code >= 400:
        return SSOTestResponse(
            ok=False,
            provider=provider,
            latency_ms=elapsed_ms,
            discovery_url=discovery_url,
            error=f"Discovery endpoint returned HTTP {resp.status_code}. Check the project/tenant ID.",
        )

    try:
        meta = resp.json()
    except Exception as exc:
        return SSOTestResponse(
            ok=False,
            provider=provider,
            latency_ms=elapsed_ms,
            discovery_url=discovery_url,
            error=f"Discovery endpoint returned invalid JSON: {exc}",
        )

    issuer = str(meta.get("issuer") or "").strip()
    jwks_uri = str(meta.get("jwks_uri") or "").strip()
    auth_endpoint = str(meta.get("authorization_endpoint") or "").strip()

    if not issuer or not jwks_uri:
        return SSOTestResponse(
            ok=False,
            provider=provider,
            latency_ms=elapsed_ms,
            discovery_url=discovery_url,
            error="Discovery JSON is missing required 'issuer' or 'jwks_uri' fields.",
        )

    if provider == "entra" and not auth_endpoint:
        return SSOTestResponse(
            ok=False,
            provider=provider,
            latency_ms=elapsed_ms,
            discovery_url=discovery_url,
            issuer=issuer,
            jwks_uri=jwks_uri,
            error="Microsoft Entra ID discovery metadata is missing 'authorization_endpoint'.",
        )

    return SSOTestResponse(
        ok=True,
        provider=provider,
        latency_ms=elapsed_ms,
        discovery_url=discovery_url,
        issuer=issuer,
        jwks_uri=jwks_uri,
        authorization_endpoint=auth_endpoint,
    )
