"""Tests for Admin Single Sign-On (SSO) configuration (Firebase default + Microsoft Entra ID)."""

from __future__ import annotations

from typing import Any

import httpx
from fastapi.testclient import TestClient

import app.core.sso_client as sso_client_mod


def _install_mock_sso_httpx(monkeypatch, handler) -> None:
    real_async_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)

    def _patched_async_client(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return real_async_client(*args, **kwargs)

    monkeypatch.setattr(sso_client_mod.httpx, "AsyncClient", _patched_async_client)


def test_sso_defaults_to_firebase_and_validates_required_fields(client: TestClient) -> None:
    res = client.get("/api/admin/sso")
    assert res.status_code == 200
    body = res.json()
    assert body["provider"] == "firebase"
    assert body["enabled"] is False
    assert body["firebase_sign_in_methods"] == ["google"]
    assert body["entra_authority_host"] == "https://login.microsoftonline.com"
    assert body["entra_client_secret_set"] is False

    # Cannot enable Firebase without project ID, auth domain, API key
    bad_fb = client.put(
        "/api/admin/sso",
        json={"enabled": True, "provider": "firebase", "firebase_project_id": "proj-1"},
    )
    assert bad_fb.status_code == 422

    # Cannot enable Entra without tenant ID & client ID
    bad_entra = client.put(
        "/api/admin/sso",
        json={"enabled": True, "provider": "entra", "entra_tenant_id": "tenant-1"},
    )
    assert bad_entra.status_code == 422

    # Invalid redirect URI scheme rejected
    bad_uri = client.put(
        "/api/admin/sso",
        json={"enabled": False, "provider": "entra", "entra_redirect_uri": "javascript:alert(1)"},
    )
    assert bad_uri.status_code == 422


def test_sso_firebase_and_entra_persistence_secret_masking_and_public_config(client: TestClient) -> None:
    # Configure Firebase SSO
    fb_saved = client.put(
        "/api/admin/sso",
        json={
            "enabled": True,
            "provider": "firebase",
            "enforce_sso": True,
            "allowed_domains": ["@Acme.com", "Partner.org", "acme.com"],
            "admin_emails": ["Admin@Acme.com"],
            "firebase_project_id": "valuestream-prod",
            "firebase_auth_domain": "valuestream-prod.firebaseapp.com",
            "firebase_api_key": "AIzaSyExampleKey123",
            "firebase_app_id": "1:999:web:abc",
            "firebase_sign_in_methods": ["google", "microsoft", "google"],
        },
    )
    assert fb_saved.status_code == 200
    fb = fb_saved.json()
    assert fb["provider"] == "firebase"
    assert fb["enabled"] is True
    assert fb["configured"] is True
    assert fb["allowed_domains"] == ["acme.com", "partner.org"]
    assert fb["admin_emails"] == ["admin@acme.com"]
    assert fb["firebase_sign_in_methods"] == ["google", "microsoft"]
    assert fb["oidc_discovery_url"] == "https://securetoken.google.com/valuestream-prod/.well-known/openid-configuration"

    # Switch to Microsoft Entra ID and verify client secret masking, preserve, and clear
    entra_saved = client.put(
        "/api/admin/sso",
        json={
            "enabled": True,
            "provider": "entra",
            "enforce_sso": False,
            "admin_emails": ["secops@contoso.com"],
            "entra_tenant_id": "contoso-tenant-guid",
            "entra_client_id": "app-client-guid",
            "entra_client_secret": "entra-super-secret-5678",
            "entra_authority_host": "https://login.microsoftonline.com/",
            "entra_redirect_uri": "https://bca.contoso.com/auth/callback",
            "entra_scopes": "openid profile email",
        },
    )
    assert entra_saved.status_code == 200
    entra = entra_saved.json()
    assert entra["provider"] == "entra"
    assert entra["configured"] is True
    assert entra["entra_client_secret_set"] is True
    assert entra["entra_client_secret_masked"] == "entr••••5678"
    assert entra["oidc_discovery_url"] == "https://login.microsoftonline.com/contoso-tenant-guid/v2.0/.well-known/openid-configuration"

    # Public config omits client secret and admin_emails
    pub = client.get("/api/auth/sso/public")
    assert pub.status_code == 200
    pub_json = pub.json()
    assert pub_json["provider"] == "entra"
    assert pub_json["entra_client_id"] == "app-client-guid"
    assert "entra_client_secret" not in pub_json
    assert "entra_client_secret_masked" not in pub_json
    assert "admin_emails" not in pub_json
    assert "5678" not in pub.text

    # Omitting secret preserves stored secret
    preserved = client.put(
        "/api/admin/sso",
        json={
            "enabled": True,
            "provider": "entra",
            "entra_tenant_id": "contoso-tenant-guid",
            "entra_client_id": "app-client-guid",
            "entra_client_secret": None,
        },
    )
    assert preserved.status_code == 200
    assert preserved.json()["entra_client_secret_set"] is True
    assert preserved.json()["entra_client_secret_masked"] == "entr••••5678"

    # Clearing secret removes it cleanly
    cleared = client.put(
        "/api/admin/sso",
        json={
            "enabled": True,
            "provider": "entra",
            "entra_tenant_id": "contoso-tenant-guid",
            "entra_client_id": "app-client-guid",
            "clear_entra_client_secret": True,
        },
    )
    assert cleared.status_code == 200
    assert cleared.json()["entra_client_secret_set"] is False
    assert cleared.json()["entra_client_secret_masked"] == ""


def test_sso_oidc_discovery_testing_for_firebase_and_entra(client: TestClient, monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        url_str = str(request.url)
        if "securetoken.google.com/valid-fb" in url_str:
            return httpx.Response(
                200,
                json={
                    "issuer": "https://securetoken.google.com/valid-fb",
                    "jwks_uri": "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
                },
            )
        if "login.microsoftonline.com/valid-tenant/v2.0" in url_str:
            return httpx.Response(
                200,
                json={
                    "issuer": "https://login.microsoftonline.com/valid-tenant/v2.0",
                    "jwks_uri": "https://login.microsoftonline.com/valid-tenant/discovery/v2.0/keys",
                    "authorization_endpoint": "https://login.microsoftonline.com/valid-tenant/oauth2/v2.0/authorize",
                },
            )
        return httpx.Response(404, text="Not found")

    _install_mock_sso_httpx(monkeypatch, handler)

    fb_ok = client.post(
        "/api/admin/sso/test",
        json={"provider": "firebase", "firebase_project_id": "valid-fb"},
    )
    assert fb_ok.status_code == 200
    assert fb_ok.json()["ok"] is True
    assert "valid-fb" in fb_ok.json()["issuer"]

    entra_ok = client.post(
        "/api/admin/sso/test",
        json={
            "provider": "entra",
            "entra_tenant_id": "valid-tenant",
            "entra_client_id": "client-123",
            "entra_authority_host": "https://login.microsoftonline.com",
        },
    )
    assert entra_ok.status_code == 200
    assert entra_ok.json()["ok"] is True
    assert "oauth2/v2.0/authorize" in entra_ok.json()["authorization_endpoint"]

    bad_tenant = client.post(
        "/api/admin/sso/test",
        json={
            "provider": "entra",
            "entra_tenant_id": "missing-tenant",
            "entra_client_id": "client-123",
        },
    )
    assert bad_tenant.status_code == 200
    assert bad_tenant.json()["ok"] is False
    assert "404" in (bad_tenant.json()["error"] or "")
