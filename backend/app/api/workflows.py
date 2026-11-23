"""Approval workflow admin endpoints, SMTP settings, and initiative approval actions."""

from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Request, Response, status

from app.core import mailer, workflows
from app.core.auth import AuthError, authenticate_request
from app.core.workflows import Actor
from app.db.repository import ConflictError, ForbiddenError, NotFoundError, ValidationError, get_sso_settings
from app.models import (
    ApprovalCommentRequest,
    ApprovalDecisionRequest,
    ApprovalSubmitRequest,
    EmailLogOut,
    EmailSettingsOut,
    EmailSettingsUpdate,
    EmailTestRequest,
    EmailTestResponse,
    InitiativeApprovalOut,
    PendingApprovalOut,
    WorkflowCreate,
    WorkflowOut,
    WorkflowSummaryOut,
    WorkflowUpdate,
)

admin_router = APIRouter(prefix="/api/admin", tags=["admin-workflows"])
router = APIRouter(prefix="/api", tags=["approvals"])


def _raise_http(exc: Exception) -> None:
    if isinstance(exc, NotFoundError):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    if isinstance(exc, ConflictError):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    if isinstance(exc, ValidationError):
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if isinstance(exc, ForbiddenError):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
    raise exc


async def resolve_actor(request: Request) -> Actor:
    """Identify who is acting on an approval.

    When Firebase SSO is active the caller must present a verified token, and approver
    eligibility is enforced. Without verifiable sign-in the workspace is open-access, so
    actions are allowed and attributed to a generic workspace user.
    """
    db_path = request.app.state.db_path
    user = getattr(request.state, "auth_user", None)
    if user is None:
        try:
            user, _, _, _ = await authenticate_request(request, db_path)
        except AuthError as exc:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=str(exc),
                headers={"WWW-Authenticate": "Bearer"},
            ) from exc
        except ForbiddenError as exc:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc

    if user is not None:
        return Actor(
            email=user.email.lower(),
            name=user.display_name,
            role_id=user.role_id,
            permissions=frozenset(user.permissions),
            verified=True,
        )

    sso = get_sso_settings(db_path)
    if sso.enabled and sso.configured and sso.provider == "firebase":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Sign in to view or take approval actions.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return Actor.anonymous()


# --- Admin: workflow definitions -------------------------------------------------


@admin_router.get("/workflows", response_model=list[WorkflowOut])
def admin_list_workflows(request: Request) -> list[WorkflowOut]:
    return workflows.list_workflows(request.app.state.db_path)


@admin_router.post("/workflows", response_model=WorkflowOut, status_code=status.HTTP_201_CREATED)
def admin_create_workflow(request: Request, payload: WorkflowCreate) -> WorkflowOut:
    try:
        return workflows.create_workflow(request.app.state.db_path, payload)
    except (ConflictError, ValidationError) as exc:
        _raise_http(exc)
        raise


@admin_router.patch("/workflows/{workflow_id}", response_model=WorkflowOut)
def admin_update_workflow(request: Request, workflow_id: str, payload: WorkflowUpdate) -> WorkflowOut:
    try:
        return workflows.update_workflow(request.app.state.db_path, workflow_id, payload)
    except (NotFoundError, ConflictError, ValidationError) as exc:
        _raise_http(exc)
        raise


@admin_router.delete("/workflows/{workflow_id}", status_code=status.HTTP_204_NO_CONTENT)
def admin_delete_workflow(request: Request, workflow_id: str) -> Response:
    try:
        workflows.delete_workflow(request.app.state.db_path, workflow_id)
    except NotFoundError as exc:
        _raise_http(exc)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- Admin: email notifications --------------------------------------------------


@admin_router.get("/email", response_model=EmailSettingsOut)
def admin_get_email_settings(request: Request) -> EmailSettingsOut:
    return mailer.get_email_settings(request.app.state.db_path)


@admin_router.put("/email", response_model=EmailSettingsOut)
def admin_update_email_settings(request: Request, payload: EmailSettingsUpdate) -> EmailSettingsOut:
    return mailer.update_email_settings(request.app.state.db_path, payload)


@admin_router.post("/email/test", response_model=EmailTestResponse)
def admin_send_test_email(request: Request, payload: EmailTestRequest) -> EmailTestResponse:
    return mailer.send_test_email(request.app.state.db_path, payload.to)


@admin_router.get("/email/log", response_model=list[EmailLogOut])
def admin_email_log(request: Request, limit: int = Query(default=50, ge=1, le=200)) -> list[EmailLogOut]:
    return mailer.list_email_log(request.app.state.db_path, limit)


# --- Workspace: approvals ----------------------------------------------------------


@router.get("/workflows", response_model=list[WorkflowSummaryOut])
def list_active_workflows(request: Request) -> list[WorkflowSummaryOut]:
    return workflows.list_active_workflows(request.app.state.db_path)


@router.get("/approvals/pending", response_model=list[PendingApprovalOut])
async def list_my_pending_approvals(request: Request) -> list[PendingApprovalOut]:
    actor = await resolve_actor(request)
    return workflows.list_pending_for_actor(request.app.state.db_path, actor)


@router.get("/initiatives/{initiative_id}/approval", response_model=InitiativeApprovalOut)
async def get_initiative_approval(request: Request, initiative_id: str) -> InitiativeApprovalOut:
    actor = await resolve_actor(request)
    try:
        return workflows.get_initiative_approval(request.app.state.db_path, initiative_id, actor)
    except NotFoundError as exc:
        _raise_http(exc)
        raise


@router.post("/initiatives/{initiative_id}/approval/submit", response_model=InitiativeApprovalOut)
async def submit_initiative_for_approval(
    request: Request, initiative_id: str, payload: ApprovalSubmitRequest, background: BackgroundTasks
) -> InitiativeApprovalOut:
    actor = await resolve_actor(request)
    db_path = request.app.state.db_path
    try:
        emails = workflows.submit_for_approval(
            db_path, initiative_id, actor, workflow_id=payload.workflow_id, comment=payload.comment
        )
    except (NotFoundError, ConflictError, ValidationError, ForbiddenError) as exc:
        _raise_http(exc)
        raise
    background.add_task(mailer.deliver, db_path, emails)
    return workflows.get_initiative_approval(db_path, initiative_id, actor)


@router.post("/initiatives/{initiative_id}/approval/decision", response_model=InitiativeApprovalOut)
async def decide_initiative_approval(
    request: Request, initiative_id: str, payload: ApprovalDecisionRequest, background: BackgroundTasks
) -> InitiativeApprovalOut:
    actor = await resolve_actor(request)
    db_path = request.app.state.db_path
    try:
        emails = workflows.decide(
            db_path, initiative_id, actor, decision=payload.decision, comment=payload.comment
        )
    except (NotFoundError, ConflictError, ValidationError, ForbiddenError) as exc:
        _raise_http(exc)
        raise
    background.add_task(mailer.deliver, db_path, emails)
    return workflows.get_initiative_approval(db_path, initiative_id, actor)


@router.post("/initiatives/{initiative_id}/approval/withdraw", response_model=InitiativeApprovalOut)
async def withdraw_initiative_approval(
    request: Request, initiative_id: str, payload: ApprovalCommentRequest
) -> InitiativeApprovalOut:
    actor = await resolve_actor(request)
    db_path = request.app.state.db_path
    try:
        workflows.withdraw(db_path, initiative_id, actor, comment=payload.comment)
    except (NotFoundError, ConflictError, ForbiddenError) as exc:
        _raise_http(exc)
        raise
    return workflows.get_initiative_approval(db_path, initiative_id, actor)


@router.post("/initiatives/{initiative_id}/approval/reopen", response_model=InitiativeApprovalOut)
async def reopen_initiative(
    request: Request, initiative_id: str, payload: ApprovalCommentRequest
) -> InitiativeApprovalOut:
    actor = await resolve_actor(request)
    db_path = request.app.state.db_path
    try:
        workflows.reopen(db_path, initiative_id, actor, comment=payload.comment)
    except (NotFoundError, ConflictError, ForbiddenError) as exc:
        _raise_http(exc)
        raise
    return workflows.get_initiative_approval(db_path, initiative_id, actor)
