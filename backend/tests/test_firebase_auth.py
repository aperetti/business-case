"""End-to-end tests for Firebase ID token RS256 verification and RBAC enforcement."""

from __future__ import annotations

import time
from typing import Any

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from jwt.algorithms import RSAAlgorithm

import app.core.auth as auth_mod


@pytest.fixture(autouse=True)
def _reset_jwks_cache() -> None:
    auth_mod.clear_jwks_cache()
    yield
    auth_mod.clear_jwks_cache()


def _make_rsa_keypair(kid: str = "test-firebase-kid-1") -> tuple[Any, dict[str, Any]]:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk_dict = RSAAlgorithm.to_jwk(private_key.public_key(), as_dict=True)
    jwk_dict.update({"kid": kid, "use": "sig", "alg": "RS256"})
    return private_key, {"keys": [jwk_dict]}


def _install_mock_jwks(monkeypatch: pytest.MonkeyPatch, jwks_payload: dict[str, Any]) -> None:
    real_async_client = httpx.AsyncClient
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            headers={"Cache-Control": "public, max-age=300"},
            json=jwks_payload,
        )
    )

    def _patched_async_client(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return real_async_client(*args, **kwargs)

    monkeypatch.setattr(auth_mod.httpx, "AsyncClient", _patched_async_client)


def _sign_firebase_token(
    private_key: Any,
    *,
    kid: str = "test-firebase-kid-1",
    project_id: str = "valuestream-bca",
    sub: str = "uid-12345",
    email: str = "adam.peretti@gmail.com",
    email_verified: bool = True,
    name: str = "Adam Peretti",
    aud: str | None = None,
    iss: str | None = None,
    exp_offset: int = 3600,
) -> str:
    now = int(time.time())
    payload = {
        "iss": iss if iss is not None else f"https://securetoken.google.com/{project_id}",
        "aud": aud if aud is not None else project_id,
        "auth_time": now - 10,
        "user_id": sub,
        "sub": sub,
        "iat": now - 10,
        "exp": now + exp_offset,
        "email": email,
        "email_verified": email_verified,
        "name": name,
        "picture": "https://example.com/avatar.png",
    }
    return jwt.encode(payload, private_key, algorithm="RS256", headers={"kid": kid})


def _enable_enforced_firebase_env(
    monkeypatch: pytest.MonkeyPatch,
    *,
    admin_emails: str = "adam.peretti@gmail.com",
    allowed_domains: str | None = None,
) -> None:
    monkeypatch.setenv("SSO_ENABLED", "true")
    monkeypatch.setenv("SSO_PROVIDER", "firebase")
    monkeypatch.setenv("SSO_ENFORCE", "true")
    monkeypatch.setenv("FIREBASE_PROJECT_ID", "valuestream-bca")
    monkeypatch.setenv("FIREBASE_AUTH_DOMAIN", "valuestream-bca.firebaseapp.com")
    monkeypatch.setenv("FIREBASE_API_KEY", "AIzaSyTestKey123")
    if admin_emails:
        monkeypatch.setenv("SSO_ADMIN_EMAILS", admin_emails)
    else:
        monkeypatch.delenv("SSO_ADMIN_EMAILS", raising=False)
    if allowed_domains:
        monkeypatch.setenv("SSO_ALLOWED_DOMAINS", allowed_domains)
    else:
        monkeypatch.delenv("SSO_ALLOWED_DOMAINS", raising=False)


def test_open_mode_when_sso_disabled(seeded_client: TestClient) -> None:
    assert seeded_client.get("/api/initiatives").status_code == 200
    me = seeded_client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json() == {
        "authenticated": False,
        "auth_required": False,
        "sso_enabled": False,
        "provider": "firebase",
        "user": None,
    }


def test_firebase_enforced_auth_rbac_provisioning_and_exemptions(
    seeded_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    private_key, jwks_payload = _make_rsa_keypair()
    _install_mock_jwks(monkeypatch, jwks_payload)
    _enable_enforced_firebase_env(monkeypatch, admin_emails="adam.peretti@gmail.com")

    # Public endpoints remain reachable without Firebase Bearer token
    assert seeded_client.get("/health").status_code == 200
    assert seeded_client.get("/api/auth/sso/public").status_code == 200

    # With SSO enforced, the OData BI feed and /v1 gateway expose the same data as the
    # UI, so they are no longer anonymously readable even when no API keys exist yet.
    assert seeded_client.get("/odata/v4/Initiatives").status_code == 401
    assert seeded_client.get("/odata/$metadata").status_code == 401
    assert seeded_client.get("/v1/models").status_code == 401
    monkeypatch.setenv("BCA_API_KEYS", "bca-static-test-key")
    keyed = {"Authorization": "Bearer bca-static-test-key"}
    assert seeded_client.get("/odata/v4/Initiatives", headers=keyed).status_code == 200
    assert seeded_client.get("/v1/models", headers=keyed).status_code == 200
    monkeypatch.delenv("BCA_API_KEYS")

    # Protected routes reject unauthenticated calls cleanly with 401
    assert seeded_client.get("/api/initiatives").status_code == 401
    assert seeded_client.get("/api/admin/sso").status_code == 401
    assert seeded_client.get("/api/auth/me").status_code == 401

    # Invalid token variants (expired, wrong aud, wrong iss, unverified email) -> 401
    expired = _sign_firebase_token(private_key, exp_offset=-120)
    wrong_aud = _sign_firebase_token(private_key, aud="other-project")
    wrong_iss = _sign_firebase_token(private_key, iss="https://securetoken.google.com/other-project")
    unverified = _sign_firebase_token(private_key, email_verified=False)

    for bad_token in (expired, wrong_aud, wrong_iss, unverified, "not-a-jwt"):
        res = seeded_client.get(
            "/api/initiatives", headers={"Authorization": f"Bearer {bad_token}"}
        )
        assert res.status_code == 401

    # Configured admin auto-provisions as Administrator with full access
    admin_tok = _sign_firebase_token(
        private_key, sub="uid-adam", email="Adam.Peretti@gmail.com", name="Adam Peretti"
    )
    admin_headers = {"Authorization": f"Bearer {admin_tok}"}

    me_admin = seeded_client.get("/api/auth/me", headers=admin_headers)
    assert me_admin.status_code == 200
    me_body = me_admin.json()
    assert me_body["authenticated"] is True
    assert me_body["auth_required"] is True
    assert me_body["user"]["email"] == "adam.peretti@gmail.com"
    assert me_body["user"]["role_id"] == "role-admin"
    assert me_body["user"]["is_admin"] is True

    assert seeded_client.get("/api/initiatives", headers=admin_headers).status_code == 200
    users_res = seeded_client.get("/api/admin/users", headers=admin_headers)
    assert users_res.status_code == 200
    assert any(u["email"] == "adam.peretti@gmail.com" for u in users_res.json())

    # Uninvited stranger blocked (403) because SSO_ALLOWED_DOMAINS is empty and SSO_ADMIN_EMAILS is set
    stranger_tok = _sign_firebase_token(
        private_key, sub="uid-stranger", email="stranger@gmail.com", name="Random User"
    )
    assert (
        seeded_client.get("/api/auth/me", headers={"Authorization": f"Bearer {stranger_tok}"}).status_code
        == 403
    )
    assert (
        seeded_client.get(
            "/api/initiatives", headers={"Authorization": f"Bearer {stranger_tok}"}
        ).status_code
        == 403
    )

    # Admin invites colleague as Executive Reviewer -> activates on login with read-only RBAC
    invite_res = seeded_client.post(
        "/api/admin/users",
        headers=admin_headers,
        json={
            "email": "colleague@example.com",
            "display_name": "Invited Reviewer",
            "role_id": "role-reviewer",
            "status": "invited",
            "auth_provider": "firebase",
        },
    )
    assert invite_res.status_code == 201
    colleague_id = invite_res.json()["id"]

    colleague_tok = _sign_firebase_token(
        private_key, sub="uid-colleague", email="colleague@example.com", name="Colleague"
    )
    colleague_headers = {"Authorization": f"Bearer {colleague_tok}"}

    colleague_me = seeded_client.get("/api/auth/me", headers=colleague_headers)
    assert colleague_me.status_code == 200
    assert colleague_me.json()["user"]["role_id"] == "role-reviewer"
    assert colleague_me.json()["user"]["is_admin"] is False

    # Reviewer can read initiatives & Docs Agent status, cannot write initiatives or access admin routes
    assert seeded_client.get("/api/initiatives", headers=colleague_headers).status_code == 200
    assert seeded_client.get("/api/docs-agent/status", headers=colleague_headers).status_code == 200
    assert (
        seeded_client.post(
            "/api/initiatives",
            headers=colleague_headers,
            json={"name": "Blocked Create", "domain": "software", "horizon_years": 5, "discount_rate": 0.08},
        ).status_code
        == 403
    )
    assert seeded_client.get("/api/admin/users", headers=colleague_headers).status_code == 403
    assert seeded_client.get("/api/admin/llm", headers=colleague_headers).status_code == 403

    # Disabled user immediately loses access
    disable_res = seeded_client.patch(
        f"/api/admin/users/{colleague_id}",
        headers=admin_headers,
        json={"status": "disabled"},
    )
    assert disable_res.status_code == 200
    assert seeded_client.get("/api/initiatives", headers=colleague_headers).status_code == 403


def test_firebase_allowed_domains_auto_provisions_analyst(
    seeded_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    private_key, jwks_payload = _make_rsa_keypair()
    _install_mock_jwks(monkeypatch, jwks_payload)
    _enable_enforced_firebase_env(
        monkeypatch,
        admin_emails="adam.peretti@gmail.com",
        allowed_domains="acme.com",
    )

    analyst_tok = _sign_firebase_token(
        private_key, sub="uid-acme", email="analyst@acme.com", name="Acme Analyst"
    )
    analyst_headers = {"Authorization": f"Bearer {analyst_tok}"}

    me = seeded_client.get("/api/auth/me", headers=analyst_headers)
    assert me.status_code == 200
    assert me.json()["user"]["role_id"] == "role-analyst"
    assert me.json()["user"]["is_admin"] is False

    created = seeded_client.post(
        "/api/initiatives",
        headers=analyst_headers,
        json={"name": "Acme Cloud Cutover", "domain": "software", "horizon_years": 5, "discount_rate": 0.08},
    )
    assert created.status_code == 201
    assert seeded_client.get("/api/admin/users", headers=analyst_headers).status_code == 403


def test_admin_routes_require_auth_when_sso_active_but_not_enforced(
    seeded_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    private_key, jwks_payload = _make_rsa_keypair()
    _install_mock_jwks(monkeypatch, jwks_payload)
    _enable_enforced_firebase_env(monkeypatch, admin_emails="adam.peretti@gmail.com")
    monkeypatch.setenv("SSO_ENFORCE", "false")

    # General workspace stays open when SSO is optional
    assert seeded_client.get("/api/initiatives").status_code == 200

    # Admin surface is never anonymous once SSO is active
    for method, path in (
        ("GET", "/api/admin/sso"),
        ("GET", "/api/admin/users"),
        ("GET", "/api/admin/llm"),
        ("POST", "/api/admin/api-keys"),
    ):
        res = seeded_client.request(method, path, json={"name": "x"})
        assert res.status_code == 401, (method, path, res.status_code)

    # Authenticated non-admin is rejected; listed admin is allowed
    analyst = _sign_firebase_token(private_key, sub="uid-analyst", email="someone@other.org")
    res = seeded_client.get("/api/admin/sso", headers={"Authorization": f"Bearer {analyst}"})
    assert res.status_code in (403,)

    admin = _sign_firebase_token(private_key)
    res = seeded_client.get("/api/admin/sso", headers={"Authorization": f"Bearer {admin}"})
    assert res.status_code == 200
