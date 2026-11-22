"""Async OpenAI-compatible HTTP client supporting non-streaming and SSE streaming responses."""

from __future__ import annotations

import time
from collections.abc import AsyncIterator
from typing import Any
from uuid import uuid4

import httpx

from app.models import (
    ChatMessage,
    DocCitation,
    LLMTestResponse,
    OpenAIChatChoice,
    OpenAIChatChoiceMessage,
    OpenAIChatCompletionResponse,
    OpenAIUsage,
)


class UpstreamLLMError(Exception):
    """Raised when an upstream OpenAI-compatible API request fails."""

    def __init__(self, message: str, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


def normalize_base_url(raw: str) -> str:
    """Normalize an OpenAI-compatible base URL (stripping trailing /chat/completions or /models)."""
    url = raw.strip().rstrip("/")
    for suffix in ("/chat/completions", "/models"):
        if url.endswith(suffix):
            url = url[: -len(suffix)].rstrip("/")
    return url


def build_auth_headers(api_key: str) -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    cleaned = api_key.strip()
    if cleaned:
        headers["Authorization"] = f"Bearer {cleaned}"
    return headers


def _extract_error_detail(resp: httpx.Response) -> str:
    try:
        data = resp.json()
        if isinstance(data, dict):
            err = data.get("error")
            if isinstance(err, dict) and err.get("message"):
                return f"HTTP {resp.status_code}: {err['message']}"
            if isinstance(err, str) and err:
                return f"HTTP {resp.status_code}: {err}"
            if data.get("detail"):
                return f"HTTP {resp.status_code}: {data['detail']}"
    except Exception:
        pass
    snippet = resp.text.strip()[:240]
    return f"HTTP {resp.status_code}" + (f": {snippet}" if snippet else "")


def _prepare_messages(system_prompt: str, messages: list[ChatMessage]) -> list[dict[str, str]]:
    prepared: list[dict[str, str]] = [{"role": "system", "content": system_prompt}]
    for msg in messages:
        prepared.append({"role": msg.role, "content": msg.content})
    return prepared


async def fetch_upstream_models(
    base_url: str,
    api_key: str,
    timeout_seconds: int = 20,
) -> list[str]:
    base = normalize_base_url(base_url)
    if not base:
        raise UpstreamLLMError("Endpoint Base URL is required before fetching models.", status_code=400)

    url = f"{base}/models"
    async with httpx.AsyncClient(timeout=float(timeout_seconds)) as client:
        try:
            resp = await client.get(url, headers=build_auth_headers(api_key))
        except httpx.TimeoutException as exc:
            raise UpstreamLLMError(f"Timed out querying {url}.", status_code=504) from exc
        except httpx.HTTPError as exc:
            raise UpstreamLLMError(f"Connection failed for {url}: {exc}", status_code=502) from exc

    if resp.status_code >= 400:
        raise UpstreamLLMError(_extract_error_detail(resp), status_code=502)

    try:
        payload = resp.json()
    except Exception as exc:
        raise UpstreamLLMError("Upstream /models returned non-JSON output.", status_code=502) from exc

    raw_items: list[Any] = []
    if isinstance(payload, dict) and isinstance(payload.get("data"), list):
        raw_items = payload["data"]
    elif isinstance(payload, dict) and isinstance(payload.get("models"), list):
        raw_items = payload["models"]
    elif isinstance(payload, list):
        raw_items = payload

    names: list[str] = []
    for item in raw_items:
        if isinstance(item, str) and item.strip():
            names.append(item.strip())
        elif isinstance(item, dict):
            mid = item.get("id") or item.get("name") or item.get("model")
            if mid and str(mid).strip():
                names.append(str(mid).strip())
    return sorted(set(names))


async def test_upstream_connection(
    base_url: str,
    api_key: str,
    model: str,
    timeout_seconds: int = 20,
) -> LLMTestResponse:
    base = normalize_base_url(base_url)
    if not base or not model.strip():
        return LLMTestResponse(
            ok=False,
            latency_ms=0.0,
            model=model.strip(),
            error="Both Endpoint Base URL and Model ID are required to test the connection.",
        )

    url = f"{base}/chat/completions"
    body = {
        "model": model.strip(),
        "messages": [{"role": "user", "content": "Reply with OK."}],
        "max_tokens": 16,
        "temperature": 0.0,
        "stream": False,
    }
    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=float(timeout_seconds)) as client:
            resp = await client.post(url, headers=build_auth_headers(api_key), json=body)
        elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 1)
    except httpx.TimeoutException:
        elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 1)
        return LLMTestResponse(
            ok=False,
            latency_ms=elapsed_ms,
            model=model.strip(),
            error=f"Request timed out after {timeout_seconds}s contacting {url}.",
        )
    except httpx.HTTPError as exc:
        elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 1)
        return LLMTestResponse(
            ok=False,
            latency_ms=elapsed_ms,
            model=model.strip(),
            error=f"Network error contacting {url}: {exc}",
        )

    if resp.status_code >= 400:
        return LLMTestResponse(
            ok=False,
            latency_ms=elapsed_ms,
            model=model.strip(),
            error=_extract_error_detail(resp),
        )

    try:
        data = resp.json()
        choices = data.get("choices") or []
        content = ""
        if choices and isinstance(choices[0], dict):
            msg = choices[0].get("message") or {}
            content = str(msg.get("content") or choices[0].get("text") or "").strip()
        resolved_model = str(data.get("model") or model.strip())
        return LLMTestResponse(
            ok=True,
            latency_ms=elapsed_ms,
            model=resolved_model,
            reply_preview=content[:120] or "(empty response, HTTP 200)",
        )
    except Exception as exc:
        return LLMTestResponse(
            ok=False,
            latency_ms=elapsed_ms,
            model=model.strip(),
            error=f"Invalid JSON completion response from upstream: {exc}",
        )


async def complete_chat_upstream(
    *,
    base_url: str,
    api_key: str,
    model: str,
    system_prompt: str,
    messages: list[ChatMessage],
    temperature: float,
    max_tokens: int,
    timeout_seconds: int,
    citations: list[DocCitation],
) -> OpenAIChatCompletionResponse:
    base = normalize_base_url(base_url)
    url = f"{base}/chat/completions"
    body = {
        "model": model,
        "messages": _prepare_messages(system_prompt, messages),
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }

    async with httpx.AsyncClient(timeout=float(timeout_seconds)) as client:
        try:
            resp = await client.post(url, headers=build_auth_headers(api_key), json=body)
        except httpx.TimeoutException as exc:
            raise UpstreamLLMError(f"Upstream LLM timed out after {timeout_seconds}s.", status_code=504) from exc
        except httpx.HTTPError as exc:
            raise UpstreamLLMError(f"Upstream LLM connection failed: {exc}", status_code=502) from exc

    if resp.status_code >= 400:
        raise UpstreamLLMError(_extract_error_detail(resp), status_code=502)

    try:
        raw = resp.json()
    except Exception as exc:
        raise UpstreamLLMError("Upstream LLM returned invalid JSON.", status_code=502) from exc

    raw_choices = raw.get("choices") or []
    content = ""
    finish_reason = "stop"
    if raw_choices and isinstance(raw_choices[0], dict):
        first = raw_choices[0]
        finish_reason = str(first.get("finish_reason") or "stop")
        msg = first.get("message") or {}
        if isinstance(msg, dict):
            content = str(msg.get("content") or "")
        elif first.get("text"):
            content = str(first["text"])

    usage_raw = raw.get("usage") or {}
    usage = OpenAIUsage(
        prompt_tokens=int(usage_raw.get("prompt_tokens") or 0),
        completion_tokens=int(usage_raw.get("completion_tokens") or 0),
        total_tokens=int(usage_raw.get("total_tokens") or 0),
    )

    return OpenAIChatCompletionResponse(
        id=str(raw.get("id") or f"chatcmpl-{uuid4().hex[:16]}"),
        created=int(raw.get("created") or int(time.time())),
        model=str(raw.get("model") or model),
        choices=[
            OpenAIChatChoice(
                index=0,
                message=OpenAIChatChoiceMessage(content=content),
                finish_reason=finish_reason,
            )
        ],
        usage=usage,
        citations=citations,
    )


async def open_chat_stream_upstream(
    *,
    base_url: str,
    api_key: str,
    model: str,
    system_prompt: str,
    messages: list[ChatMessage],
    temperature: float,
    max_tokens: int,
    timeout_seconds: int,
) -> AsyncIterator[bytes]:
    """Open an upstream SSE chat completion stream and validate HTTP status before yielding chunks."""
    base = normalize_base_url(base_url)
    url = f"{base}/chat/completions"
    body = {
        "model": model,
        "messages": _prepare_messages(system_prompt, messages),
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": True,
    }

    client = httpx.AsyncClient(timeout=float(timeout_seconds))
    req = client.build_request("POST", url, headers=build_auth_headers(api_key), json=body)
    try:
        resp = await client.send(req, stream=True)
    except httpx.TimeoutException as exc:
        await client.aclose()
        raise UpstreamLLMError(f"Upstream LLM timed out after {timeout_seconds}s.", status_code=504) from exc
    except httpx.HTTPError as exc:
        await client.aclose()
        raise UpstreamLLMError(f"Upstream LLM connection failed: {exc}", status_code=502) from exc

    if resp.status_code >= 400:
        try:
            await resp.aread()
            err = _extract_error_detail(resp)
        finally:
            await resp.aclose()
            await client.aclose()
        raise UpstreamLLMError(err, status_code=502)

    async def _sse_generator() -> AsyncIterator[bytes]:
        saw_done = False
        try:
            async for line in resp.aiter_lines():
                stripped = line.strip()
                if not stripped or stripped.startswith(":"):
                    continue
                if stripped.startswith("data:"):
                    data_part = stripped[5:].strip()
                    if data_part == "[DONE]":
                        saw_done = True
                    yield f"data: {data_part}\n\n".encode("utf-8")
            if not saw_done:
                yield b"data: [DONE]\n\n"
        finally:
            await resp.aclose()
            await client.aclose()

    return _sse_generator()
