"""Tests for Admin Role Management and Users Management APIs."""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_system_roles_seeded_and_custom_role_lifecycle(client: TestClient) -> None:
    roles_res = client.get("/api/admin/roles")
    assert roles_res.status_code == 200
    roles = roles_res.json()
    role_ids = {r["id"] for r in roles}
    assert {"role-admin", "role-analyst", "role-reviewer", "role-ai-ops"}.issubset(role_ids)
    assert all(r["is_system"] is True for r in roles if r["id"] in role_ids)

    # Cannot delete a system role
    del_sys = client.delete("/api/admin/roles/role-analyst")
    assert del_sys.status_code == 409

    # Admin role cannot drop admin:roles or admin:users
    drop_admin = client.patch(
        "/api/admin/roles/role-admin",
        json={"permissions": ["initiatives:read"]},
    )
    assert drop_admin.status_code == 422

    # Create custom role
    created = client.post(
        "/api/admin/roles",
        json={
            "name": "Portfolio Sponsor",
            "description": "Approves executive portfolios and reads simulation reports.",
            "permissions": ["initiatives:read", "docs:ask", "simulations:run"],
        },
    )
    assert created.status_code == 201
    role_id = created.json()["id"]
    assert created.json()["is_system"] is False
    assert created.json()["user_count"] == 0

    # Duplicate name rejected
    dup = client.post(
        "/api/admin/roles",
        json={
            "name": "portfolio sponsor",
            "permissions": ["initiatives:read"],
        },
    )
    assert dup.status_code == 409

    # Assign user to custom role -> blocks role deletion
    user = client.post(
        "/api/admin/users",
        json={
            "email": "Sponsor.Lead@Company.com",
            "display_name": "Sponsor Lead",
            "role_id": role_id,
            "status": "active",
            "auth_provider": "firebase",
        },
    )
    assert user.status_code == 201
    user_id = user.json()["id"]
    assert user.json()["email"] == "sponsor.lead@company.com"

    blocked_del = client.delete(f"/api/admin/roles/{role_id}")
    assert blocked_del.status_code == 409

    # Remove user then delete custom role
    assert client.delete(f"/api/admin/users/{user_id}").status_code == 204
    assert client.delete(f"/api/admin/roles/{role_id}").status_code == 204


def test_users_crud_filtering_and_seeded_demo_users(seeded_client: TestClient) -> None:
    users_res = seeded_client.get("/api/admin/users")
    assert users_res.status_code == 200
    demo_users = users_res.json()
    assert len(demo_users) == 3
    emails = {u["email"] for u in demo_users}
    assert "admin@valuestream.local" in emails

    # Filter by provider/search/status
    invited = seeded_client.get("/api/admin/users", params={"status_filter": "invited"})
    assert invited.status_code == 200
    assert len(invited.json()) == 1
    assert invited.json()[0]["auth_provider"] == "entra"

    # Reject unknown role_id
    bad_role = seeded_client.post(
        "/api/admin/users",
        json={
            "email": "unknown@company.com",
            "display_name": "Bad Role",
            "role_id": "role-does-not-exist",
            "status": "active",
            "auth_provider": "firebase",
        },
    )
    assert bad_role.status_code == 422

    # Create, reject duplicate email, update role/status, delete
    created = seeded_client.post(
        "/api/admin/users",
        json={
            "email": "elena.vance@company.com",
            "display_name": "Elena Vance",
            "role_id": "role-analyst",
            "status": "invited",
            "auth_provider": "entra",
        },
    )
    assert created.status_code == 201
    uid = created.json()["id"]
    assert created.json()["role_name"] == "BCA Analyst"

    dup_email = seeded_client.post(
        "/api/admin/users",
        json={
            "email": "ELENA.VANCE@company.com",
            "display_name": "Elena Duplicate",
            "role_id": "role-reviewer",
            "status": "active",
            "auth_provider": "firebase",
        },
    )
    assert dup_email.status_code == 409

    patched = seeded_client.patch(
        f"/api/admin/users/{uid}",
        json={"role_id": "role-ai-ops", "status": "active"},
    )
    assert patched.status_code == 200
    assert patched.json()["role_name"] == "AI & Integration Ops"
    assert patched.json()["status"] == "active"

    assert seeded_client.delete(f"/api/admin/users/{uid}").status_code == 204
    assert seeded_client.delete(f"/api/admin/users/{uid}").status_code == 404
