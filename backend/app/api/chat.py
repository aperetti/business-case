"""OpenAI-compatible /v1 chat & models gateway and UI docs-agent endpoints."""

from __future__ import annotations

import json
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import StreamingResponse

from app.core.docs_kb import build_agent_context
from app.core.llm_client import (
    UpstreamLLMError,
    complete_chat_upstream,
    open_chat_stream_upstream,
)
from app.db.repository import get_llm_settings, get_llm_settings_raw, verify_inbound_api_key
from app.models import (
    ChatMessage,
    DocsAgentStatusOut,
    OpenAIChatCompletionRequest,
    OpenAIChatCompletionResponse,
    OpenAIModelListResponse,
    OpenAIModelObject,
)

router = APIRouter(tags=["chat"])


def _extract_bearer_token(request: Request) -> str | None:
    auth = request.headers.get("authorization") or ""
    parts = auth.strip().split(None, 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip() or None
    return None


def _require_inbound_key(request: Request) -> None:
    token = _extract_bearer_token(request)
    if not verify_inbound_api_key(request.app.state.db_path, token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing Bearer API key.",
            headers={"WWW-Authenticate": "Bearer"},
        )


@router.get("/v1/models", response_model=OpenAIModelListResponse)
def list_openai_models(request: Request) -> OpenAIModelListResponse:
    """OpenAI-compatible GET /v1/models exposing bca-docs-agent and configured upstream model."""
    _require_inbound_key(request)
    raw = get_llm_settings_raw(request.app.state.db_path)
    models = [OpenAIModelObject(id="bca-docs-agent", owned_by="valuestream-bca")]
    upstream_model = str(raw.get("model") or "").strip()
    if upstream_model and upstream_model != "bca-docs-agent":
        models.append(OpenAIModelObject(id=upstream_model, owned_by="upstream-configured"))
    return OpenAIModelListResponse(data=models)


async def _handle_chat_completions(
    request: Request,
    payload: OpenAIChatCompletionRequest,
) -> OpenAIChatCompletionResponse | StreamingResponse:
    db_path = request.app.state.db_path
    raw = get_llm_settings_raw(db_path)
    base_url = str(raw.get("base_url") or "").strip()
    configured_model = str(raw.get("model") or "").strip()

    if not base_url or not configured_model:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Docs Agent LLM provider is not configured. Open the Admin Portal to set the Endpoint Base URL and Model.",
        )

    upstream_model = (
        configured_model
        if payload.model.strip() in ("", "bca-docs-agent", "default")
        else payload.model.strip()
    )

    caller_system_parts: list[str] = []
    conversation_messages: list[ChatMessage] = []
    latest_user_query = ""

    for msg in payload.messages:
        if msg.role == "system":
            if msg.content.strip():
                caller_system_parts.append(msg.content.strip())
        else:
            conversation_messages.append(msg)
            if msg.role == "user" and msg.content.strip():
                latest_user_query = msg.content.strip()

    if not conversation_messages:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="At least one user or assistant message is required.",
        )

    if not latest_user_query:
        latest_user_query = conversation_messages[-1].content

    extra_prompt_parts = [str(raw.get("system_prompt") or "").strip(), *caller_system_parts]
    combined_extra = "\n\n".join(p for p in extra_prompt_parts if p)

    system_prompt, citations = build_agent_context(
        db_path,
        latest_user_query,
        doc_slug=payload.doc_slug,
        initiative_id=payload.initiative_id,
        include_initiative_context=payload.include_initiative_context,
        extra_system_prompt=combined_extra,
    )

    eff_temp = payload.temperature if payload.temperature is not None else float(raw.get("temperature", 0.2))
    eff_max_tokens = payload.max_tokens if payload.max_tokens is not None else int(raw.get("max_tokens", 1024))
    eff_timeout = int(raw.get("timeout_seconds") or 45)
    api_key = str(raw.get("api_key") or "")

    if payload.stream:
        try:
            stream_iter = await open_chat_stream_upstream(
                base_url=base_url,
                api_key=api_key,
                model=upstream_model,
                system_prompt=system_prompt,
                messages=conversation_messages,
                temperature=eff_temp,
                max_tokens=eff_max_tokens,
                timeout_seconds=eff_timeout,
            )
        except UpstreamLLMError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

        encoded_citations = quote(json.dumps([c.model_dump() for c in citations]))
        return StreamingResponse(
            stream_iter,
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
                "X-Docs-Citations": encoded_citations,
            },
        )

    try:
        return await complete_chat_upstream(
            base_url=base_url,
            api_key=api_key,
            model=upstream_model,
            system_prompt=system_prompt,
            messages=conversation_messages,
            temperature=eff_temp,
            max_tokens=eff_max_tokens,
            timeout_seconds=eff_timeout,
            citations=citations,
        )
    except UpstreamLLMError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.post("/v1/chat/completions", response_model=None)
async def openai_chat_completions(
    payload: OpenAIChatCompletionRequest,
    request: Request,
) -> OpenAIChatCompletionResponse | StreamingResponse:
    """OpenAI-compatible POST /v1/chat/completions endpoint grounded in BCA documentation."""
    _require_inbound_key(request)
    return await _handle_chat_completions(request, payload)


@router.get("/api/docs-agent/status", response_model=DocsAgentStatusOut)
def get_docs_agent_status(request: Request) -> DocsAgentStatusOut:
    """Return client-safe Docs Agent availability (requires configured & verified LLM)."""
    settings = get_llm_settings(request.app.state.db_path)
    available = bool(settings.configured and settings.verified)
    return DocsAgentStatusOut(
        configured=settings.configured,
        verified=settings.verified,
        available=available,
        model=settings.model if available else "",
    )


@router.post("/api/docs-agent/chat/completions", response_model=None)
async def ui_docs_agent_chat_completions(
    payload: OpenAIChatCompletionRequest,
    request: Request,
) -> OpenAIChatCompletionResponse | StreamingResponse:
    """Built-in Docs Agent chat endpoint for web UI sessions (OpenAI chat payload & SSE format)."""
    return await _handle_chat_completions(request, payload)
