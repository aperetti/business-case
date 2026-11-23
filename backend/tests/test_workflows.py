"""Tests for approval workflow definitions, the approval state machine, and email notifications."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

import app.core.mailer as mailer_mod
from test_firebase_auth import (
    _enable_enforced_firebase_env,
    _install_mock_jwks,
    _make_rsa_keypair,
    _reset_jwks_cache,  # noqa: F401  (autouse fixture)
    _sign_firebase_token,
)


def _create_initiative(client: TestClient, name: str = "Grid Modernization", headers: dict | None = None) -> str:
    res = client.post("/api/initiatives", json={"name": name}, headers=headers or {})
    assert res.status_code == 201, res.text
    return res.json()["id"]


@pytest.fixture()
def sent_emails(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    captured: list[dict[str, Any]] = []

    def _fake_send(raw: dict[str, Any], recipients: list[str], subject: str, body: str) -> None:
        captured.append({"recipients": recipients, "subject": subject, "body": body, "host": raw["host"]})

    monkeypatch.setattr(mailer_mod, "_smtp_send", _fake_send)
    return captured


def _enable_email(client: TestClient, headers: dict | None = None) -> None:
    res = client.put(
        "/api/admin/email",
        json={
            "enabled": True,
            "host": "smtp.example.com",
            "port": 587,
            "security": "starttls",
            "username": "mailer",
            "password": "s3cret-pass",
            "from_address": "bca@example.com",
            "from_name": "ValueStream BCA",
            "app_base_url": "https://bca.example.com/",
        },
        headers=headers or {},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["configured"] is True
    assert body["password_set"] is True
    assert "s3cret" not in body["password_masked"]
    assert body["app_base_url"] == "https://bca.example.com"


def test_default_workflow_seeded_and_full_lifecycle_open_mode(client: TestClient) -> None:
    wfs = client.get("/api/admin/workflows").json()
    assert len(wfs) == 1 and wfs[0]["is_default"] is True and wfs[0]["is_active"] is True
    assert client.get("/api/workflows").json()[0]["step_names"] == ["Executive Review"]

    init_id = _create_initiative(client)
    assert client.get(f"/api/initiatives/{init_id}").json()["status"] == "draft"

    approval = client.get(f"/api/initiatives/{init_id}/approval").json()
    assert approval["status"] == "draft"
    assert approval["can_submit"] is True
    assert approval["current_request"] is None

    # Decisions are rejected when nothing is pending.
    assert (
        client.post(f"/api/initiatives/{init_id}/approval/decision", json={"decision": "approve"}).status_code
        == 409
    )

    submitted = client.post(f"/api/initiatives/{init_id}/approval/submit", json={"comment": "Ready for review"})
    assert submitted.status_code == 200, submitted.text
    body = submitted.json()
    assert body["status"] == "in_review"
    assert body["current_request"]["workflow_name"] == "Standard Approval"
    assert body["current_request"]["steps"][0]["state"] == "active"
    assert body["can_withdraw"] is True and body["can_decide"] is True

    # The initiative and its content are locked while in review.
    assert client.patch(f"/api/initiatives/{init_id}", json={"name": "Renamed"}).status_code == 409
    bca_res = client.post(f"/api/initiatives/{init_id}/bcas", json={"name": "Alt"})
    assert bca_res.status_code == 409
    assert client.delete(f"/api/initiatives/{init_id}").status_code == 409
    # Double submission is refused.
    assert client.post(f"/api/initiatives/{init_id}/approval/submit", json={}).status_code == 409

    # Summary list reports the status too.
    listed = {i["id"]: i for i in client.get("/api/initiatives").json()}
    assert listed[init_id]["status"] == "in_review"

    # Rejection requires a reason.
    assert (
        client.post(f"/api/initiatives/{init_id}/approval/decision", json={"decision": "reject"}).status_code
        == 422
    )

    approved = client.post(
        f"/api/initiatives/{init_id}/approval/decision", json={"decision": "approve", "comment": "LGTM"}
    )
    assert approved.status_code == 200, approved.text
    body = approved.json()
    assert body["status"] == "approved"
    assert body["current_request"]["status"] == "approved"
    assert body["current_request"]["steps"][0]["state"] == "approved"
    assert body["can_reopen"] is True
    assert [a["action"] for a in body["history"]] == ["approve", "submit"]

    assert client.patch(f"/api/initiatives/{init_id}", json={"name": "Renamed"}).status_code == 409

    reopened = client.post(f"/api/initiatives/{init_id}/approval/reopen", json={"comment": "Scope change"})
    assert reopened.status_code == 200
    assert reopened.json()["status"] == "draft"
    assert client.patch(f"/api/initiatives/{init_id}", json={"name": "Renamed"}).status_code == 200

    # Notifications were queued but skipped because SMTP is not configured.
    log = client.get("/api/admin/email/log").json()
    assert log and all(entry["status"] == "skipped" for entry in log)


def test_multi_step_quorum_rejection_and_withdraw(client: TestClient, sent_emails: list) -> None:
    _enable_email(client)
    created = client.post(
        "/api/admin/workflows",
        json={
            "name": "Capital Projects",
            "description": "Finance then executive sign-off",
            "is_default": True,
            "steps": [
                {
                    "name": "Finance",
                    "approver_emails": ["CFO@Example.com", "controller@example.com"],
                    "required_approvals": 2,
                },
                {"name": "Executive", "approver_role_ids": ["role-admin"]},
            ],
        },
    )
    assert created.status_code == 201, created.text
    wf = created.json()
    assert wf["is_default"] is True
    assert wf["steps"][0]["approver_emails"] == ["cfo@example.com", "controller@example.com"]
    assert all(s["id"] for s in wf["steps"])
    # Only one default at a time.
    defaults = [w for w in client.get("/api/admin/workflows").json() if w["is_default"]]
    assert [w["id"] for w in defaults] == [wf["id"]]

    init_id = _create_initiative(client)
    client.post(f"/api/initiatives/{init_id}/approval/submit", json={})
    assert sent_emails[-1]["recipients"] == ["cfo@example.com", "controller@example.com"]
    assert sent_emails[-1]["subject"] == "Approval required: Grid Modernization (Finance)"
    assert f"https://bca.example.com/#initiative/{init_id}" in sent_emails[-1]["body"]

    # First approval does not advance a step that needs two.
    one = client.post(f"/api/initiatives/{init_id}/approval/decision", json={"decision": "approve"}).json()
    assert one["current_request"]["current_step_index"] == 0
    assert one["current_request"]["steps"][0]["approvals"] == 1
    two = client.post(f"/api/initiatives/{init_id}/approval/decision", json={"decision": "approve"}).json()
    assert two["current_request"]["current_step_index"] == 1
    assert two["current_request"]["steps"][0]["state"] == "approved"
    assert two["current_request"]["steps"][1]["state"] == "active"
    # No users hold the Executive step's role, so that notification is logged as skipped.
    assert len(sent_emails) == 1
    skipped = client.get("/api/admin/email/log").json()[0]
    assert skipped["status"] == "skipped" and "No recipients" in skipped["error"]

    rejected = client.post(
        f"/api/initiatives/{init_id}/approval/decision",
        json={"decision": "reject", "comment": "Benefits not substantiated"},
    ).json()
    assert rejected["status"] == "rejected"
    assert rejected["current_request"]["steps"][1]["state"] == "rejected"
    # Rejected initiatives are editable and can be resubmitted.
    assert client.patch(f"/api/initiatives/{init_id}", json={"description": "Revised"}).status_code == 200
    resubmitted = client.post(f"/api/initiatives/{init_id}/approval/submit", json={}).json()
    assert resubmitted["status"] == "in_review"
    assert resubmitted["current_request"]["current_step_index"] == 0

    withdrawn = client.post(f"/api/initiatives/{init_id}/approval/withdraw", json={}).json()
    assert withdrawn["status"] == "draft"
    assert withdrawn["current_request"]["status"] == "withdrawn"

    # Editing the workflow does not affect requests already in flight.
    client.post(f"/api/initiatives/{init_id}/approval/submit", json={})
    client.patch(
        f"/api/admin/workflows/{wf['id']}",
        json={"steps": [{"name": "Only Step", "approver_role_ids": ["role-admin"]}]},
    )
    snap = client.get(f"/api/initiatives/{init_id}/approval").json()
    assert [s["name"] for s in snap["current_request"]["steps"]] == ["Finance", "Executive"]
    assert client.get("/api/admin/workflows").json()[0]["in_use_count"] == 1

    log = client.get("/api/admin/email/log").json()
    assert {e["status"] for e in log} == {"sent", "skipped"}


def test_workflow_validation_and_submit_selection(client: TestClient) -> None:
    bad_role = client.post(
        "/api/admin/workflows",
        json={"name": "Bad", "steps": [{"name": "S1", "approver_role_ids": ["role-missing"]}]},
    )
    assert bad_role.status_code == 422
    no_approvers = client.post("/api/admin/workflows", json={"name": "Empty", "steps": [{"name": "S1"}]})
    assert no_approvers.status_code == 422
    no_steps = client.post("/api/admin/workflows", json={"name": "None", "steps": []})
    assert no_steps.status_code == 422
    dup = client.post(
        "/api/admin/workflows",
        json={"name": "standard approval", "steps": [{"name": "S", "approver_emails": ["a@b.co"]}]},
    )
    assert dup.status_code == 409

    # With the default deactivated and two active workflows, submitters must choose.
    client.patch("/api/admin/workflows/wf-standard", json={"is_active": False})
    for name in ("Path A", "Path B"):
        assert (
            client.post(
                "/api/admin/workflows",
                json={"name": name, "steps": [{"name": "S", "approver_emails": ["a@b.co"]}]},
            ).status_code
            == 201
        )
    workflows = client.get("/api/admin/workflows").json()
    standard = next(w for w in workflows if w["id"] == "wf-standard")
    assert standard["is_active"] is False and standard["is_default"] is False
    # The first workflow created while no default existed became the default.
    path_a = next(w for w in workflows if w["name"] == "Path A")
    assert path_a["is_default"] is True
    client.patch(f"/api/admin/workflows/{path_a['id']}", json={"is_default": False})

    init_id = _create_initiative(client)
    no_choice = client.post(f"/api/initiatives/{init_id}/approval/submit", json={})
    assert no_choice.status_code == 422
    inactive = client.post(f"/api/initiatives/{init_id}/approval/submit", json={"workflow_id": "wf-standard"})
    assert inactive.status_code == 422
    chosen = client.post(f"/api/initiatives/{init_id}/approval/submit", json={"workflow_id": path_a["id"]})
    assert chosen.status_code == 200
    assert chosen.json()["current_request"]["workflow_name"] == "Path A"

    # Deleting a definition leaves the in-flight request intact.
    assert client.delete(f"/api/admin/workflows/{path_a['id']}").status_code == 204
    still = client.get(f"/api/initiatives/{init_id}/approval").json()
    assert still["current_request"]["workflow_id"] is None
    assert still["current_request"]["workflow_name"] == "Path A"


def test_email_password_not_reused_for_different_host(client: TestClient) -> None:
    _enable_email(client)
    moved = client.put(
        "/api/admin/email",
        json={"enabled": True, "host": "evil.example.net", "from_address": "bca@example.com"},
    ).json()
    assert moved["password_set"] is False


def test_sso_enforced_approver_eligibility(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, sent_emails: list
) -> None:
    private_key, jwks_payload = _make_rsa_keypair()
    _install_mock_jwks(monkeypatch, jwks_payload)

    def hdr(email: str, name: str) -> dict[str, str]:
        tok = _sign_firebase_token(private_key, sub=f"uid-{email}", email=email, name=name)
        return {"Authorization": f"Bearer {tok}"}

    admin = hdr("adam.peretti@gmail.com", "Admin")
    analyst = hdr("analyst@example.com", "Ana Analyst")
    reviewer = hdr("reviewer@example.com", "Rex Reviewer")
    outsider = hdr("other.analyst@example.com", "Otto Other")

    _enable_enforced_firebase_env(monkeypatch, admin_emails="adam.peretti@gmail.com")
    for email, name, role in (
        ("analyst@example.com", "Ana Analyst", "role-analyst"),
        ("reviewer@example.com", "Rex Reviewer", "role-reviewer"),
        ("other.analyst@example.com", "Otto Other", "role-analyst"),
    ):
        res = client.post(
            "/api/admin/users",
            json={"email": email, "display_name": name, "role_id": role, "auth_provider": "firebase"},
            headers=admin,
        )
        assert res.status_code == 201, res.text
    _enable_email(client, headers=admin)

    # Approval endpoints require sign-in when SSO is enforced.
    assert client.get("/api/approvals/pending").status_code == 401
    # Non-admins cannot manage workflows.
    assert client.get("/api/admin/workflows", headers=analyst).status_code == 403

    init_id = _create_initiative(client, headers=analyst)
    # Reviewers are read-only and cannot submit.
    assert client.post(f"/api/initiatives/{init_id}/approval/submit", json={}, headers=reviewer).status_code == 403

    sub = client.post(f"/api/initiatives/{init_id}/approval/submit", json={}, headers=analyst)
    assert sub.status_code == 200, sub.text
    assert sub.json()["current_request"]["submitted_by_email"] == "analyst@example.com"
    assert sub.json()["can_decide"] is False
    assert "not an approver" in sub.json()["decide_blocked_reason"]
    # Default workflow targets reviewer + admin roles; disabled users would be excluded.
    assert sent_emails[-1]["recipients"] == ["adam.peretti@gmail.com", "reviewer@example.com"]

    # Submitter cannot approve their own initiative; non-approvers are refused.
    assert (
        client.post(
            f"/api/initiatives/{init_id}/approval/decision", json={"decision": "approve"}, headers=analyst
        ).status_code
        == 403
    )
    assert (
        client.post(
            f"/api/initiatives/{init_id}/approval/decision", json={"decision": "approve"}, headers=outsider
        ).status_code
        == 403
    )

    pending = client.get("/api/approvals/pending", headers=reviewer).json()
    assert [p["initiative_id"] for p in pending] == [init_id]
    assert client.get("/api/approvals/pending", headers=outsider).json() == []

    view = client.get(f"/api/initiatives/{init_id}/approval", headers=reviewer).json()
    assert view["can_decide"] is True and view["can_submit"] is False

    done = client.post(
        f"/api/initiatives/{init_id}/approval/decision",
        json={"decision": "approve", "comment": "Approved"},
        headers=reviewer,
    )
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "approved"
    assert done.json()["history"][0]["actor_name"] == "Rex Reviewer"
    assert sent_emails[-1]["recipients"] == ["analyst@example.com"]
    assert sent_emails[-1]["subject"] == "Initiative approved: Grid Modernization"

    # An eligible approver still cannot approve their own submission.
    own_id = _create_initiative(client, name="Admin Pet Project", headers=admin)
    own = client.post(f"/api/initiatives/{own_id}/approval/submit", json={}, headers=admin).json()
    assert own["can_decide"] is False and "you submitted" in own["decide_blocked_reason"]
    assert (
        client.post(
            f"/api/initiatives/{own_id}/approval/decision", json={"decision": "approve"}, headers=admin
        ).status_code
        == 403
    )

    # Reviewers cannot reopen; analysts can.
    assert client.post(f"/api/initiatives/{init_id}/approval/reopen", json={}, headers=reviewer).status_code == 403
    assert client.post(f"/api/initiatives/{init_id}/approval/reopen", json={}, headers=outsider).status_code == 200
