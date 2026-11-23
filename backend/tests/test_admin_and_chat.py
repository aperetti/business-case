"""End-to-end tests for Admin LLM configuration, API keys, and OpenAI-compatible Docs Agent endpoints."""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import unquote

import httpx
from fastapi.testclient import TestClient

import app.core.llm_client as llm_client_mod


def _install_mock_httpx(monkeypatch, handler) -> None:
    real_async_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)

    def _patched_async_client(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return real_async_client(*args, **kwargs)

    monkeypatch.setattr(llm_client_mod.httpx, "AsyncClient", _patched_async_client)


def test_admin_llm_settings_masking_preserve_clear_and_validation(client: TestClient) -> None:
    initial = client.get("/api/admin/llm")
    assert initial.status_code == 200
    body = initial.json()
    assert body["configured"] is False
    assert body["api_key_set"] is False
    assert body["api_key_masked"] == ""

    # Reject invalid URL scheme
    bad_url = client.put(
        "/api/admin/llm",
        json={"base_url": "ftp://invalid.local/v1", "model": "gpt-4o-mini"},
    )
    assert bad_url.status_code == 422

    # Save valid endpoint, key, and model
    saved = client.put(
        "/api/admin/llm",
        json={
            "base_url": "https://api.example.com/v1/",
            "api_key": "sk-test-secret-123456abcd",
            "model": "gpt-4o-mini",
            "temperature": 0.35,
            "max_tokens": 1500,
            "timeout_seconds": 30,
            "system_prompt": "Always cite PV formulas.",
        },
    )
    assert saved.status_code == 200
    s = saved.json()
    assert s["base_url"] == "https://api.example.com/v1"
    assert s["model"] == "gpt-4o-mini"
    assert s["configured"] is True
    assert s["api_key_set"] is True
    assert s["api_key_masked"] == "sk-t••••abcd"
    assert "123456" not in json.dumps(s)

    # Updating other fields with api_key=None preserves stored secret
    preserved = client.put(
        "/api/admin/llm",
        json={
            "base_url": "https://api.example.com/v1",
            "api_key": None,
            "model": "gpt-4o",
            "temperature": 0.2,
            "max_tokens": 1024,
            "timeout_seconds": 45,
            "system_prompt": "",
        },
    )
    assert preserved.status_code == 200
    assert preserved.json()["api_key_set"] is True
    assert preserved.json()["api_key_masked"] == "sk-t••••abcd"

    # Explicit clear removes secret
    cleared = client.put(
        "/api/admin/llm",
        json={
            "base_url": "http://localhost:11434/v1",
            "clear_api_key": True,
            "model": "llama3.2",
            "temperature": 0.2,
            "max_tokens": 1024,
            "timeout_seconds": 45,
            "system_prompt": "",
        },
    )
    assert cleared.status_code == 200
    assert cleared.json()["api_key_set"] is False
    assert cleared.json()["api_key_masked"] == ""


def test_admin_test_and_models_fetch_with_mock_upstream(client: TestClient, monkeypatch) -> None:
    captured_auth: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured_auth.append(request.headers.get("authorization"))
        if request.headers.get("authorization") == "Bearer bad-key":
            return httpx.Response(401, json={"error": {"message": "Invalid upstream API key"}})
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": [{"id": "gpt-4o"}, {"id": "gpt-4o-mini"}]})
        if request.url.path.endswith("/chat/completions"):
            return httpx.Response(
                200,
                json={
                    "id": "chatcmpl-test",
                    "model": "gpt-4o-mini",
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": "OK"}, "finish_reason": "stop"}],
                },
            )
        return httpx.Response(404)

    _install_mock_httpx(monkeypatch, handler)

    # Fetch models using transient form settings before saving
    models_res = client.post(
        "/api/admin/llm/models",
        json={"base_url": "https://api.example.com/v1", "api_key": "sk-good-9999"},
    )
    assert models_res.status_code == 200
    assert models_res.json() == {"models": ["gpt-4o", "gpt-4o-mini"], "error": None}
    assert captured_auth[-1] == "Bearer sk-good-9999"

    # Test connection success & upstream failure propagation
    ok_ping = client.post(
        "/api/admin/llm/test",
        json={"base_url": "https://api.example.com/v1", "api_key": "sk-good-9999", "model": "gpt-4o-mini"},
    )
    assert ok_ping.status_code == 200
    assert ok_ping.json()["ok"] is True
    assert ok_ping.json()["reply_preview"] == "OK"

    bad_ping = client.post(
        "/api/admin/llm/test",
        json={"base_url": "https://api.example.com/v1", "api_key": "bad-key", "model": "gpt-4o-mini"},
    )
    assert bad_ping.status_code == 200
    assert bad_ping.json()["ok"] is False
    assert "401" in (bad_ping.json()["error"] or "")


def test_openai_gateway_auth_kb_context_json_and_streaming(client: TestClient, monkeypatch) -> None:
    # Unconfigured chat returns 503 cleanly
    unconf = client.post(
        "/api/docs-agent/chat/completions",
        json={"model": "bca-docs-agent", "messages": [{"role": "user", "content": "Hello"}]},
    )
    assert unconf.status_code == 503

    # Create a custom catalog entry and an initiative to verify live KB injection
    custom_cat = client.post(
        "/api/catalog",
        json={
            "id": "BEN-SLA-CUSTOM",
            "kind": "benefit",
            "name": "Custom SLA Latency Credit Savings",
            "description": "Custom uptime formula for gateway testing",
            "domains": ["software"],
            "value_stream_stage": "Operate",
            "parameters": [{"key": "saved_credits", "label": "Saved Credits", "unit": "$/yr", "default_value": 40000.0}],
            "formula_type": "expr:saved_credits",
        },
    )
    assert custom_cat.status_code == 201

    created_init = client.post(
        "/api/initiatives",
        json={
            "name": "Chat Context Demo Program",
            "description": "Demo for gateway context injection",
            "domain": "software",
            "horizon_years": 5,
            "discount_rate": 0.07,
        },
    )
    assert created_init.status_code == 201
    target_init_id = created_init.json()["id"]

    # Configure provider
    client.put(
        "/api/admin/llm",
        json={
            "base_url": "https://llm.local/v1",
            "api_key": "upstream-secret-token-xyz",
            "model": "qwen2.5-32b",
            "temperature": 0.1,
            "max_tokens": 900,
        },
    )

    # Open access when 0 inbound keys exist
    open_models = client.get("/v1/models")
    assert open_models.status_code == 200
    model_ids = [m["id"] for m in open_models.json()["data"]]
    assert "bca-docs-agent" in model_ids
    assert "qwen2.5-32b" in model_ids

    # Issue inbound API key -> enforces Bearer auth on /v1/*
    key_res = client.post("/api/admin/api-keys", json={"name": "External OpenAI Client"})
    assert key_res.status_code == 201
    secret_key = key_res.json()["secret_key"]
    key_id = key_res.json()["id"]
    assert secret_key.startswith("bca-")

    # Listed keys never expose secret_key
    listed_keys = client.get("/api/admin/api-keys").json()
    assert len(listed_keys) == 1
    assert "secret_key" not in listed_keys[0]

    assert client.get("/v1/models").status_code == 401
    assert client.get("/v1/models", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.get("/v1/models", headers={"Authorization": f"Bearer {secret_key}"}).status_code == 200

    # Mock upstream non-streaming and SSE streaming responses
    captured_payloads: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers.get("authorization") == "Bearer upstream-secret-token-xyz"
        body = json.loads(request.content.decode())
        captured_payloads.append(body)
        if body.get("stream"):
            sse = (
                b'data: {"id":"cmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Use BEN-TOIL-01 "},"finish_reason":null}]}\n\n'
                b'data: {"id":"cmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"for manual work."},"finish_reason":"stop"}]}\n\n'
                b"data: [DONE]\n\n"
            )
            return httpx.Response(200, headers={"Content-Type": "text/event-stream"}, content=sse)
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-999",
                "object": "chat.completion",
                "created": 1700000000,
                "model": body["model"],
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "BEN-TOIL-01 uses realization_factor."},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 120, "completion_tokens": 12, "total_tokens": 132},
            },
        )

    _install_mock_httpx(monkeypatch, handler)

    # Non-streaming OpenAI /v1/chat/completions call with multipart text content & initiative context
    comp_res = client.post(
        "/v1/chat/completions",
        headers={"Authorization": f"Bearer {secret_key}"},
        json={
            "model": "bca-docs-agent",
            "messages": [
                {"role": "user", "content": [{"type": "text", "text": "Explain BEN-TOIL-01 vs custom BEN-SLA-CUSTOM"}]},
            ],
            "doc_slug": "BEN-TOIL-01",
            "initiative_id": target_init_id,
            "include_initiative_context": True,
            "stream": False,
        },
    )
    assert comp_res.status_code == 200
    comp_body = comp_res.json()
    assert comp_body["model"] == "qwen2.5-32b"
    assert comp_body["choices"][0]["message"]["content"] == "BEN-TOIL-01 uses realization_factor."
    cit_slugs = [c["slug"] for c in comp_body["citations"]]
    assert "BEN-TOIL-01" in cit_slugs

    sent_sys = captured_payloads[-1]["messages"][0]["content"]
    assert "BEN-TOIL-01" in sent_sys
    assert "BEN-SLA-CUSTOM" in sent_sys
    assert "Active Initiative Context" in sent_sys

    # Streaming SSE UI endpoint
    with client.stream(
        "POST",
        "/api/docs-agent/chat/completions",
        json={
            "model": "bca-docs-agent",
            "messages": [{"role": "user", "content": "How does BEN-TOIL-01 work?"}],
            "stream": True,
        },
    ) as stream_res:
        assert stream_res.status_code == 200
        assert "X-Docs-Citations" in stream_res.headers
        raw_cit = json.loads(unquote(stream_res.headers["X-Docs-Citations"]))
        assert len(raw_cit) >= 1
        stream_text = "".join(stream_res.iter_text())
        assert "Use BEN-TOIL-01 " in stream_text
        assert "data: [DONE]" in stream_text

    # Verify KB status reflects keys & custom template
    kb = client.get("/api/admin/kb-status").json()
    assert kb["guide_count"] == 5
    assert kb["builtin_catalog_count"] == 9
    assert kb["custom_catalog_count"] == 1
    assert kb["inbound_key_count"] == 1
    assert kb["configured"] is True

    # Revoke key and verify /v1 opens cleanly when 0 keys remain
    assert client.delete(f"/api/admin/api-keys/{key_id}").status_code == 204
    assert client.get("/v1/models").status_code == 200


def test_inbound_api_keys_env_override_and_lock(client: TestClient, monkeypatch) -> None:
    # Create a SQLite-backed API key first
    db_key_res = client.post("/api/admin/api-keys", json={"name": "DB Local Key"})
    assert db_key_res.status_code == 201
    db_secret = db_key_res.json()["secret_key"]

    # Configure BCA_API_KEYS -> overrides DB keys and locks Admin API key mutations
    monkeypatch.setenv("BCA_API_KEYS", "bca-env-prod-123456,short")

    listed = client.get("/api/admin/api-keys")
    assert listed.status_code == 200
    items = listed.json()
    assert len(items) == 2
    assert all(item["managed_by_env"] is True for item in items)
    assert items[0]["key_prefix"] == "bca-"
    assert items[0]["key_last4"] == "3456"
    assert items[1]["key_prefix"] == ""
    assert items[1]["key_last4"] == ""
    assert "123456" not in listed.text
    assert "short" not in listed.text

    # Unauthenticated and old DB key requests are rejected; both env keys succeed on /v1 & /odata
    assert client.get("/v1/models").status_code == 401
    assert client.get("/v1/models", headers={"Authorization": f"Bearer {db_secret}"}).status_code == 401
    assert client.get("/odata/v4/Initiatives", headers={"Authorization": f"Bearer {db_secret}"}).status_code == 401

    assert client.get("/v1/models", headers={"Authorization": "Bearer bca-env-prod-123456"}).status_code == 200
    assert client.get("/v1/models", headers={"Authorization": "Bearer short"}).status_code == 200
    assert (
        client.get("/odata/v4/Initiatives", headers={"X-API-Key": "bca-env-prod-123456"}).status_code == 200
    )

    odata_status = client.get("/api/admin/odata/status").json()
    assert odata_status["auth_mode"] == "api_key_required"
    assert odata_status["inbound_key_count"] == 2

    # Admin create/delete endpoints return 409 Conflict when locked
    assert client.post("/api/admin/api-keys", json={"name": "Blocked"}).status_code == 409
    assert client.delete("/api/admin/api-keys/env-key-1").status_code == 409
