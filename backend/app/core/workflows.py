"""Approval workflow definitions and the initiative approval state machine.

Lifecycle of an initiative:

    draft ──submit──▶ in_review ──(all steps approved)──▶ approved ──reopen──▶ draft
      ▲                   │  └──reject──▶ rejected ──submit──▶ in_review
      └─────withdraw──────┘                  └──reopen──▶ draft

A submission snapshots the workflow's steps, so later edits to the workflow never change
an in-flight request. Steps run in order; each needs ``required_approvals`` distinct
approvers, and any rejection ends the request. Initiatives are locked for editing while
in review or approved (see ``repository._assert_initiative_editable``).
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from app.core.mailer import OutboundEmail, get_email_settings_raw
from app.db.database import get_connection
from app.db.repository import ConflictError, ForbiddenError, NotFoundError, ValidationError
from app.models import (
    ApprovalActionOut,
    ApprovalRequestOut,
    ApprovalStepProgress,
    InitiativeApprovalOut,
    PendingApprovalOut,
    WorkflowCreate,
    WorkflowOut,
    WorkflowStep,
    WorkflowSummaryOut,
    WorkflowUpdate,
)


@dataclass(frozen=True)
class Actor:
    """Who is taking an approval action.

    ``verified`` is False when the workspace has no verifiable sign-in (SSO off). The app is
    open-access in that mode, so anyone may act, and actions are attributed to a generic name.
    """

    email: str
    name: str
    role_id: str | None
    permissions: frozenset[str]
    verified: bool

    @classmethod
    def anonymous(cls) -> "Actor":
        return cls(email="", name="Workspace user", role_id=None, permissions=frozenset(), verified=False)

    def can(self, permission: str) -> bool:
        return not self.verified or permission in self.permissions


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _begin_immediate(conn: sqlite3.Connection) -> None:
    """Take the write lock up front so concurrent approvals cannot double-advance a step."""
    if not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")


# --- Workflow definitions ---------------------------------------------------------


def _parse_steps(raw: str | None) -> list[WorkflowStep]:
    try:
        data = json.loads(raw or "[]")
    except json.JSONDecodeError:
        return []
    steps: list[WorkflowStep] = []
    for item in data if isinstance(data, list) else []:
        try:
            steps.append(WorkflowStep.model_validate(item))
        except Exception:
            continue
    return steps


def _row_to_workflow(row: sqlite3.Row, in_use: int = 0) -> WorkflowOut:
    return WorkflowOut(
        id=row["id"],
        name=row["name"],
        description=row["description"] or "",
        is_active=bool(row["is_active"]),
        is_default=bool(row["is_default"]),
        notify_submitter=bool(row["notify_submitter"]),
        steps=_parse_steps(row["steps_json"]),
        in_use_count=in_use,
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _in_use_counts(conn: sqlite3.Connection) -> dict[str, int]:
    rows = conn.execute(
        """
        SELECT workflow_id, COUNT(*) AS cnt FROM approval_requests
        WHERE status = 'pending' AND workflow_id IS NOT NULL
        GROUP BY workflow_id
        """
    ).fetchall()
    return {r["workflow_id"]: int(r["cnt"]) for r in rows}


def list_workflows(db_path: Path) -> list[WorkflowOut]:
    with get_connection(db_path) as conn:
        rows = conn.execute(
            "SELECT * FROM workflows ORDER BY is_default DESC, is_active DESC, name COLLATE NOCASE ASC"
        ).fetchall()
        counts = _in_use_counts(conn)
    return [_row_to_workflow(r, counts.get(r["id"], 0)) for r in rows]


def list_active_workflows(db_path: Path) -> list[WorkflowSummaryOut]:
    return [
        WorkflowSummaryOut(
            id=w.id,
            name=w.name,
            description=w.description,
            is_default=w.is_default,
            step_names=[s.name for s in w.steps],
        )
        for w in list_workflows(db_path)
        if w.is_active
    ]


def _normalize_steps(conn: sqlite3.Connection, steps: list[WorkflowStep]) -> list[dict[str, Any]]:
    role_ids = {r["id"] for r in conn.execute("SELECT id FROM roles").fetchall()}
    out: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for step in steps:
        unknown = [r for r in step.approver_role_ids if r not in role_ids]
        if unknown:
            raise ValidationError(f"Step '{step.name}' references unknown role(s): {', '.join(unknown)}.")
        step_id = step.id.strip() or f"step-{uuid4().hex[:12]}"
        if step_id in seen_ids:
            step_id = f"step-{uuid4().hex[:12]}"
        seen_ids.add(step_id)
        data = step.model_dump()
        data["id"] = step_id
        out.append(data)
    return out


def _apply_default_flag(conn: sqlite3.Connection, workflow_id: str, is_default: bool, is_active: bool) -> None:
    if is_default and is_active:
        conn.execute("UPDATE workflows SET is_default = 0 WHERE id != ?", (workflow_id,))
        conn.execute("UPDATE workflows SET is_default = 1 WHERE id = ?", (workflow_id,))
    else:
        conn.execute("UPDATE workflows SET is_default = 0 WHERE id = ?", (workflow_id,))


def _get_workflow(conn: sqlite3.Connection, workflow_id: str) -> WorkflowOut:
    row = conn.execute("SELECT * FROM workflows WHERE id = ?", (workflow_id,)).fetchone()
    if row is None:
        raise NotFoundError(f"Workflow '{workflow_id}' not found.")
    return _row_to_workflow(row, _in_use_counts(conn).get(workflow_id, 0))


def create_workflow(db_path: Path, payload: WorkflowCreate) -> WorkflowOut:
    now = _now_iso()
    wf_id = f"wf-{uuid4().hex[:12]}"
    with get_connection(db_path) as conn:
        steps = _normalize_steps(conn, payload.steps)
        try:
            conn.execute(
                """
                INSERT INTO workflows (
                    id, name, description, is_active, is_default, notify_submitter, steps_json,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
                """,
                (
                    wf_id,
                    payload.name,
                    payload.description.strip(),
                    1 if payload.is_active else 0,
                    1 if payload.notify_submitter else 0,
                    json.dumps(steps),
                    now,
                    now,
                ),
            )
        except sqlite3.IntegrityError as exc:
            raise ConflictError(f"A workflow named '{payload.name}' already exists.") from exc
        has_default = conn.execute(
            "SELECT 1 FROM workflows WHERE is_default = 1 AND is_active = 1 AND id != ?", (wf_id,)
        ).fetchone()
        _apply_default_flag(conn, wf_id, payload.is_default or not has_default, payload.is_active)
        return _get_workflow(conn, wf_id)


def update_workflow(db_path: Path, workflow_id: str, payload: WorkflowUpdate) -> WorkflowOut:
    now = _now_iso()
    with get_connection(db_path) as conn:
        current = _get_workflow(conn, workflow_id)
        steps = (
            _normalize_steps(conn, payload.steps)
            if payload.steps is not None
            else [s.model_dump() for s in current.steps]
        )
        is_active = current.is_active if payload.is_active is None else payload.is_active
        is_default = current.is_default if payload.is_default is None else payload.is_default
        try:
            conn.execute(
                """
                UPDATE workflows SET name = ?, description = ?, is_active = ?, notify_submitter = ?,
                    steps_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    payload.name if payload.name is not None else current.name,
                    payload.description.strip() if payload.description is not None else current.description,
                    1 if is_active else 0,
                    1
                    if (current.notify_submitter if payload.notify_submitter is None else payload.notify_submitter)
                    else 0,
                    json.dumps(steps),
                    now,
                    workflow_id,
                ),
            )
        except sqlite3.IntegrityError as exc:
            raise ConflictError(f"A workflow named '{payload.name}' already exists.") from exc
        _apply_default_flag(conn, workflow_id, is_default, is_active)
        return _get_workflow(conn, workflow_id)


def delete_workflow(db_path: Path, workflow_id: str) -> None:
    """Delete a definition. In-flight requests keep running on their snapshot of its steps."""
    with get_connection(db_path) as conn:
        cur = conn.execute("DELETE FROM workflows WHERE id = ?", (workflow_id,))
        if cur.rowcount == 0:
            raise NotFoundError(f"Workflow '{workflow_id}' not found.")


# --- Approval engine ----------------------------------------------------------------


def _load_initiative(conn: sqlite3.Connection, initiative_id: str) -> sqlite3.Row:
    row = conn.execute("SELECT id, name, status FROM initiatives WHERE id = ?", (initiative_id,)).fetchone()
    if row is None:
        raise NotFoundError(f"Initiative '{initiative_id}' not found.")
    return row


def _pending_request(conn: sqlite3.Connection, initiative_id: str) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT * FROM approval_requests
        WHERE initiative_id = ? AND status = 'pending'
        ORDER BY submitted_at DESC LIMIT 1
        """,
        (initiative_id,),
    ).fetchone()


def _latest_request(conn: sqlite3.Connection, initiative_id: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM approval_requests WHERE initiative_id = ? ORDER BY submitted_at DESC LIMIT 1",
        (initiative_id,),
    ).fetchone()


def _record_action(
    conn: sqlite3.Connection,
    *,
    request_id: str | None,
    initiative_id: str,
    action: str,
    actor: Actor,
    comment: str = "",
    step_index: int | None = None,
    step_name: str | None = None,
) -> None:
    conn.execute(
        """
        INSERT INTO approval_actions (
            id, request_id, initiative_id, action, step_index, step_name, actor_email, actor_name,
            comment, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(uuid4()),
            request_id,
            initiative_id,
            action,
            step_index,
            step_name,
            actor.email,
            actor.name,
            comment.strip(),
            _now_iso(),
        ),
    )


def _set_initiative_status(conn: sqlite3.Connection, initiative_id: str, status: str) -> None:
    conn.execute(
        "UPDATE initiatives SET status = ?, updated_at = ? WHERE id = ?",
        (status, _now_iso(), initiative_id),
    )


def _step_approvers(conn: sqlite3.Connection, step: WorkflowStep) -> list[str]:
    """Resolve a step's approver emails: explicit addresses plus members of approver roles."""
    emails = list(step.approver_emails)
    if step.approver_role_ids:
        placeholders = ",".join("?" for _ in step.approver_role_ids)
        rows = conn.execute(
            f"SELECT email FROM users WHERE status != 'disabled' AND role_id IN ({placeholders})",
            tuple(step.approver_role_ids),
        ).fetchall()
        emails.extend(str(r["email"]).lower() for r in rows)
    return sorted(set(emails))


def _is_eligible(actor: Actor, step: WorkflowStep) -> bool:
    if not actor.verified:
        return True
    return (actor.role_id is not None and actor.role_id in step.approver_role_ids) or (
        actor.email.lower() in step.approver_emails
    )


def _step_approver_emails_so_far(conn: sqlite3.Connection, request_id: str, step_index: int) -> list[str]:
    rows = conn.execute(
        """
        SELECT actor_email, actor_name FROM approval_actions
        WHERE request_id = ? AND step_index = ? AND action = 'approve'
        """,
        (request_id, step_index),
    ).fetchall()
    # Anonymous approvals (SSO off) have no email; count each one separately.
    return [r["actor_email"] or f"anon:{i}" for i, r in enumerate(rows)]


def _initiative_link(base_url: str, initiative_id: str) -> str:
    return f"{base_url}/#initiative/{initiative_id}" if base_url else ""


def _approval_needed_email(
    conn: sqlite3.Connection,
    *,
    base_url: str,
    initiative: sqlite3.Row,
    workflow_name: str,
    step: WorkflowStep,
    step_index: int,
    step_count: int,
    submitted_by: str,
) -> OutboundEmail | None:
    if not step.notify_approvers:
        return None
    link = _initiative_link(base_url, initiative["id"])
    lines = [
        f"Your approval is requested for the initiative \"{initiative['name']}\".",
        "",
        f"Workflow: {workflow_name}",
        f"Step {step_index + 1} of {step_count}: {step.name}",
        f"Submitted by: {submitted_by}",
    ]
    if step.required_approvals > 1:
        lines.append(f"Approvals needed for this step: {step.required_approvals}")
    lines += ["", f"Review it here: {link}" if link else "Open ValueStream BCA to review it."]
    return OutboundEmail(
        recipients=_step_approvers(conn, step),
        subject=f"Approval required: {initiative['name']} ({step.name})",
        body="\n".join(lines),
        initiative_id=initiative["id"],
    )


def _outcome_email(
    *,
    base_url: str,
    initiative: sqlite3.Row,
    request: sqlite3.Row,
    outcome: str,
    actor: Actor,
    comment: str,
) -> OutboundEmail | None:
    if not request["notify_submitter"] or not request["submitted_by_email"]:
        return None
    link = _initiative_link(base_url, initiative["id"])
    verb = "approved" if outcome == "approved" else "rejected"
    lines = [
        f"Your initiative \"{initiative['name']}\" was {verb}.",
        "",
        f"Workflow: {request['workflow_name']}",
        f"Final decision by: {actor.name}",
    ]
    if comment.strip():
        lines += ["", "Comment:", comment.strip()]
    if link:
        lines += ["", f"View it here: {link}"]
    return OutboundEmail(
        recipients=[request["submitted_by_email"]],
        subject=f"Initiative {verb}: {initiative['name']}",
        body="\n".join(lines),
        initiative_id=initiative["id"],
    )


def _resolve_workflow_for_submit(conn: sqlite3.Connection, workflow_id: str | None) -> sqlite3.Row:
    if workflow_id:
        row = conn.execute("SELECT * FROM workflows WHERE id = ?", (workflow_id,)).fetchone()
        if row is None:
            raise NotFoundError(f"Workflow '{workflow_id}' not found.")
        if not row["is_active"]:
            raise ValidationError(f"Workflow '{row['name']}' is inactive.")
        return row
    active = conn.execute("SELECT * FROM workflows WHERE is_active = 1").fetchall()
    if not active:
        raise ValidationError("No active approval workflow is defined. Ask an admin to create one.")
    defaults = [r for r in active if r["is_default"]]
    if defaults:
        return defaults[0]
    if len(active) == 1:
        return active[0]
    raise ValidationError("Choose an approval workflow; no default is set.")


def submit_for_approval(
    db_path: Path, initiative_id: str, actor: Actor, *, workflow_id: str | None, comment: str
) -> list[OutboundEmail]:
    if not actor.can("initiatives:write"):
        raise ForbiddenError("You need initiative edit access to submit for approval.")
    base_url = get_email_settings_raw(db_path)["app_base_url"]
    with get_connection(db_path) as conn:
        _begin_immediate(conn)
        initiative = _load_initiative(conn, initiative_id)
        if initiative["status"] not in ("draft", "rejected"):
            raise ConflictError(
                "Only draft or rejected initiatives can be submitted "
                f"(current status: {initiative['status'].replace('_', ' ')})."
            )
        if _pending_request(conn, initiative_id) is not None:
            raise ConflictError("This initiative already has a pending approval request.")
        wf = _resolve_workflow_for_submit(conn, workflow_id)
        steps = _parse_steps(wf["steps_json"])
        if not steps:
            raise ValidationError(f"Workflow '{wf['name']}' has no steps.")

        request_id = str(uuid4())
        now = _now_iso()
        conn.execute(
            """
            INSERT INTO approval_requests (
                id, initiative_id, workflow_id, workflow_name, steps_json, notify_submitter, status,
                current_step_index, submitted_by_email, submitted_by_name, submitted_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
            """,
            (
                request_id,
                initiative_id,
                wf["id"],
                wf["name"],
                json.dumps([s.model_dump() for s in steps]),
                int(wf["notify_submitter"]),
                actor.email,
                actor.name,
                now,
            ),
        )
        _record_action(
            conn, request_id=request_id, initiative_id=initiative_id, action="submit", actor=actor, comment=comment
        )
        _set_initiative_status(conn, initiative_id, "in_review")
        email = _approval_needed_email(
            conn,
            base_url=base_url,
            initiative=initiative,
            workflow_name=wf["name"],
            step=steps[0],
            step_index=0,
            step_count=len(steps),
            submitted_by=actor.name,
        )
    return [email] if email else []


def decide(
    db_path: Path, initiative_id: str, actor: Actor, *, decision: str, comment: str
) -> list[OutboundEmail]:
    base_url = get_email_settings_raw(db_path)["app_base_url"]
    emails: list[OutboundEmail] = []
    with get_connection(db_path) as conn:
        _begin_immediate(conn)
        initiative = _load_initiative(conn, initiative_id)
        req = _pending_request(conn, initiative_id)
        if req is None:
            raise ConflictError("There is no pending approval request for this initiative.")
        steps = _parse_steps(req["steps_json"])
        idx = int(req["current_step_index"] or 0)
        step = steps[idx]

        blocked = _decide_blocked_reason(conn, req, step, idx, actor)
        if blocked:
            raise ForbiddenError(blocked)

        _record_action(
            conn,
            request_id=req["id"],
            initiative_id=initiative_id,
            action=decision,
            actor=actor,
            comment=comment,
            step_index=idx,
            step_name=step.name,
        )
        now = _now_iso()

        if decision == "reject":
            conn.execute(
                "UPDATE approval_requests SET status = 'rejected', completed_at = ? WHERE id = ?",
                (now, req["id"]),
            )
            _set_initiative_status(conn, initiative_id, "rejected")
            email = _outcome_email(
                base_url=base_url, initiative=initiative, request=req, outcome="rejected", actor=actor, comment=comment
            )
            return [email] if email else []

        approvals = len(_step_approver_emails_so_far(conn, req["id"], idx))
        if approvals < step.required_approvals:
            return []

        next_idx = idx + 1
        if next_idx >= len(steps):
            conn.execute(
                """
                UPDATE approval_requests SET status = 'approved', current_step_index = NULL, completed_at = ?
                WHERE id = ?
                """,
                (now, req["id"]),
            )
            _set_initiative_status(conn, initiative_id, "approved")
            email = _outcome_email(
                base_url=base_url, initiative=initiative, request=req, outcome="approved", actor=actor, comment=comment
            )
        else:
            conn.execute(
                "UPDATE approval_requests SET current_step_index = ? WHERE id = ?", (next_idx, req["id"])
            )
            email = _approval_needed_email(
                conn,
                base_url=base_url,
                initiative=initiative,
                workflow_name=req["workflow_name"],
                step=steps[next_idx],
                step_index=next_idx,
                step_count=len(steps),
                submitted_by=req["submitted_by_name"] or "Workspace user",
            )
        if email:
            emails.append(email)
    return emails


def _decide_blocked_reason(
    conn: sqlite3.Connection, req: sqlite3.Row, step: WorkflowStep, idx: int, actor: Actor
) -> str | None:
    if not _is_eligible(actor, step):
        return f"You are not an approver for the '{step.name}' step."
    if actor.verified:
        if req["submitted_by_email"] and actor.email.lower() == str(req["submitted_by_email"]).lower():
            return "You cannot approve or reject an initiative you submitted."
        if actor.email.lower() in _step_approver_emails_so_far(conn, req["id"], idx):
            return f"You have already approved the '{step.name}' step."
    return None


def withdraw(db_path: Path, initiative_id: str, actor: Actor, *, comment: str) -> None:
    with get_connection(db_path) as conn:
        _begin_immediate(conn)
        _load_initiative(conn, initiative_id)
        req = _pending_request(conn, initiative_id)
        if req is None:
            raise ConflictError("There is no pending approval request to withdraw.")
        if not _can_withdraw(req, actor):
            raise ForbiddenError("Only the submitter or an editor can withdraw this request.")
        conn.execute(
            "UPDATE approval_requests SET status = 'withdrawn', completed_at = ? WHERE id = ?",
            (_now_iso(), req["id"]),
        )
        _record_action(
            conn, request_id=req["id"], initiative_id=initiative_id, action="withdraw", actor=actor, comment=comment
        )
        _set_initiative_status(conn, initiative_id, "draft")


def _can_withdraw(req: sqlite3.Row, actor: Actor) -> bool:
    if actor.can("initiatives:write"):
        return True
    return bool(actor.email) and actor.email.lower() == str(req["submitted_by_email"] or "").lower()


def reopen(db_path: Path, initiative_id: str, actor: Actor, *, comment: str) -> None:
    if not actor.can("initiatives:write"):
        raise ForbiddenError("You need initiative edit access to reopen an initiative.")
    with get_connection(db_path) as conn:
        _begin_immediate(conn)
        initiative = _load_initiative(conn, initiative_id)
        if initiative["status"] not in ("approved", "rejected"):
            raise ConflictError("Only approved or rejected initiatives can be reopened as a draft.")
        latest = _latest_request(conn, initiative_id)
        _record_action(
            conn,
            request_id=latest["id"] if latest else None,
            initiative_id=initiative_id,
            action="reopen",
            actor=actor,
            comment=comment,
        )
        _set_initiative_status(conn, initiative_id, "draft")


# --- Read models ----------------------------------------------------------------------


def _row_to_action(row: sqlite3.Row) -> ApprovalActionOut:
    return ApprovalActionOut(
        id=row["id"],
        action=row["action"],
        step_index=row["step_index"],
        step_name=row["step_name"],
        actor_email=row["actor_email"] or "",
        actor_name=row["actor_name"] or "",
        comment=row["comment"] or "",
        created_at=row["created_at"],
    )


def _build_request_out(conn: sqlite3.Connection, req: sqlite3.Row) -> ApprovalRequestOut:
    steps = _parse_steps(req["steps_json"])
    action_rows = conn.execute(
        "SELECT * FROM approval_actions WHERE request_id = ? ORDER BY created_at ASC", (req["id"],)
    ).fetchall()
    approvals_by_step: dict[int, int] = {}
    rejected_step: int | None = None
    for a in action_rows:
        if a["step_index"] is None:
            continue
        if a["action"] == "approve":
            approvals_by_step[a["step_index"]] = approvals_by_step.get(a["step_index"], 0) + 1
        elif a["action"] == "reject":
            rejected_step = a["step_index"]

    current = req["current_step_index"]
    progress: list[ApprovalStepProgress] = []
    for i, step in enumerate(steps):
        approvals = approvals_by_step.get(i, 0)
        if rejected_step == i:
            state = "rejected"
        elif req["status"] == "approved" or approvals >= step.required_approvals:
            state = "approved"
        elif req["status"] == "pending" and current == i:
            state = "active"
        elif req["status"] in ("rejected", "withdrawn"):
            state = "skipped"
        else:
            state = "pending"
        labels = list(step.approver_emails)
        if step.approver_role_ids:
            placeholders = ",".join("?" for _ in step.approver_role_ids)
            role_rows = conn.execute(
                f"SELECT name FROM roles WHERE id IN ({placeholders})", tuple(step.approver_role_ids)
            ).fetchall()
            labels = [f"Role: {r['name']}" for r in role_rows] + labels
        progress.append(
            ApprovalStepProgress(
                index=i,
                name=step.name,
                required_approvals=step.required_approvals,
                approvals=approvals,
                state=state,
                approvers=labels,
            )
        )
    return ApprovalRequestOut(
        id=req["id"],
        initiative_id=req["initiative_id"],
        workflow_id=req["workflow_id"],
        workflow_name=req["workflow_name"],
        status=req["status"],
        current_step_index=current,
        submitted_by_email=req["submitted_by_email"] or "",
        submitted_by_name=req["submitted_by_name"] or "",
        submitted_at=req["submitted_at"],
        completed_at=req["completed_at"],
        steps=progress,
        actions=[_row_to_action(a) for a in action_rows],
    )


def get_initiative_approval(db_path: Path, initiative_id: str, actor: Actor) -> InitiativeApprovalOut:
    with get_connection(db_path) as conn:
        initiative = _load_initiative(conn, initiative_id)
        status_val = initiative["status"] or "draft"
        latest = _latest_request(conn, initiative_id)
        history_rows = conn.execute(
            "SELECT * FROM approval_actions WHERE initiative_id = ? ORDER BY created_at DESC LIMIT 100",
            (initiative_id,),
        ).fetchall()
        has_active_workflow = conn.execute("SELECT 1 FROM workflows WHERE is_active = 1").fetchone() is not None

        current_out = _build_request_out(conn, latest) if latest else None
        can_decide = False
        blocked: str | None = None
        can_withdraw = False
        if latest is not None and latest["status"] == "pending":
            steps = _parse_steps(latest["steps_json"])
            idx = int(latest["current_step_index"] or 0)
            blocked = _decide_blocked_reason(conn, latest, steps[idx], idx, actor)
            can_decide = blocked is None
            can_withdraw = _can_withdraw(latest, actor)

    return InitiativeApprovalOut(
        initiative_id=initiative_id,
        status=status_val,
        current_request=current_out,
        history=[_row_to_action(r) for r in history_rows],
        can_submit=status_val in ("draft", "rejected") and has_active_workflow and actor.can("initiatives:write"),
        can_decide=can_decide,
        can_withdraw=can_withdraw,
        can_reopen=status_val in ("approved", "rejected") and actor.can("initiatives:write"),
        decide_blocked_reason=blocked,
    )


def list_pending_for_actor(db_path: Path, actor: Actor) -> list[PendingApprovalOut]:
    """Pending approval steps the caller can act on right now."""
    out: list[PendingApprovalOut] = []
    with get_connection(db_path) as conn:
        rows = conn.execute(
            """
            SELECT r.*, i.name AS initiative_name FROM approval_requests r
            JOIN initiatives i ON i.id = r.initiative_id
            WHERE r.status = 'pending'
            ORDER BY r.submitted_at ASC
            """
        ).fetchall()
        for r in rows:
            steps = _parse_steps(r["steps_json"])
            idx = int(r["current_step_index"] or 0)
            if idx >= len(steps):
                continue
            if _decide_blocked_reason(conn, r, steps[idx], idx, actor) is not None:
                continue
            out.append(
                PendingApprovalOut(
                    request_id=r["id"],
                    initiative_id=r["initiative_id"],
                    initiative_name=r["initiative_name"],
                    workflow_name=r["workflow_name"],
                    step_name=steps[idx].name,
                    submitted_by_name=r["submitted_by_name"] or "Workspace user",
                    submitted_at=r["submitted_at"],
                )
            )
    return out
