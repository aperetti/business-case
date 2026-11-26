"""End-to-end FastAPI endpoint round-trip and validation tests."""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_health_and_seeded_demo_startup(seeded_client: TestClient) -> None:
    health = seeded_client.get("/health")
    assert health.status_code == 200
    assert health.json() == {"status": "ok", "database": "ok", "catalog_count": 9}

    catalog = seeded_client.get("/api/catalog")
    assert catalog.status_code == 200
    assert len(catalog.json()) == 9

    initiatives = seeded_client.get("/api/initiatives")
    assert initiatives.status_code == 200
    init_list = initiatives.json()
    assert len(init_list) == 4
    assert all(item["item_count"] == 6 and item["npv"] > 0.0 for item in init_list)

    by_domain = {item["domain"]: item for item in init_list}
    assert set(by_domain.keys()) == {"software", "automation", "infrastructure", "energy"}

    # Verify automation example surfaces the anti-double-count guardrail warning
    auto_detail = seeded_client.get(f"/api/initiatives/{by_domain['automation']['id']}")
    assert auto_detail.status_code == 200
    assert len(auto_detail.json()["deterministic"]["guardrail_warnings"]) == 1

    # Run MC simulation against all seeded examples
    for item in init_list:
        sim = seeded_client.post(f"/api/initiatives/{item['id']}/simulate", json={"n_simulations": 2000, "seed": 99})
        assert sim.status_code == 200
        body = sim.json()
        assert body["run_id"]
        assert 0.0 <= body["monte_carlo"]["prob_npv_positive"] <= 1.0
        assert len(body["monte_carlo"]["npv_histogram"]) > 1
        assert len(body["monte_carlo"]["sensitivity_drivers"]) >= 1
        assert len(body["monte_carlo"]["value_streams"]) == 3


def test_catalog_filtering_and_custom_creation(client: TestClient) -> None:
    resp_ben = client.get("/api/catalog", params={"kind": "benefit", "domain": "automation"})
    assert resp_ben.status_code == 200
    assert all(item["kind"] == "benefit" and "automation" in item["domains"] for item in resp_ben.json())

    # Reject unsafe custom formula
    bad_custom = client.post(
        "/api/catalog",
        json={
            "id": "CUSTOM-BAD-01",
            "kind": "benefit",
            "name": "Malicious Template",
            "description": "Should fail",
            "domains": ["software"],
            "parameters": [{"key": "units", "label": "Units", "unit": "count", "default_value": 10.0, "min_value": 0.0}],
            "formula_type": "expr:__import__('os').system('ls')",
        },
    )
    assert bad_custom.status_code == 422

    # Create valid custom catalog entry
    custom = client.post(
        "/api/catalog",
        json={
            "id": "BEN-CUSTOM-01",
            "kind": "benefit",
            "name": "API Latency Conversion Uplift",
            "description": "Custom safe expression template",
            "domains": ["software", "ecommerce"],
            "value_stream_stage": "Optimize",
            "parameters": [
                {"key": "monthly_sessions", "label": "Monthly Sessions", "unit": "sessions", "default_value": 10000.0, "min_value": 0.0},
                {"key": "uplift_per_session", "label": "Uplift per Session", "unit": "$", "default_value": 0.5, "min_value": 0.0},
            ],
            "formula_type": "expr:monthly_sessions * 12 * uplift_per_session",
            "guardrail_notes": "Verify against A/B test holdout.",
        },
    )
    assert custom.status_code == 201
    assert custom.json()["id"] == "BEN-CUSTOM-01"

    # Duplicate ID rejected with 409
    dup = client.post(
        "/api/catalog",
        json={
            "id": "BEN-CUSTOM-01",
            "kind": "benefit",
            "name": "Duplicate",
            "domains": ["software"],
            "parameters": [{"key": "x", "label": "X", "unit": "", "default_value": 1.0}],
            "formula_type": "expr:x",
        },
    )
    assert dup.status_code == 409


def test_initiative_crud_validation_and_simulation_runs_roundtrip(client: TestClient) -> None:
    created = client.post(
        "/api/initiatives",
        json={
            "name": "Grid Inspection Robotics",
            "description": "Automated drone + CV inspection workflow",
            "domain": "automation",
            "horizon_years": 5,
            "discount_rate": 0.06,
        },
    )
    assert created.status_code == 201
    init_id = created.json()["id"]

    # Invalid start_year > end_year rejected
    bad_range = client.post(
        f"/api/initiatives/{init_id}/items",
        json={
            "catalog_id": "COST-BUILD-01",
            "label": "Build",
            "value_stream": "Robotics",
            "start_year": 4,
            "end_year": 2,
            "ramp_profile": "immediate",
            "param_values": {"hours": 100, "hourly_rate": 100, "vendor_cost": 0},
        },
    )
    assert bad_range.status_code == 422

    # Invalid end_year > horizon_years rejected
    over_horizon = client.post(
        f"/api/initiatives/{init_id}/items",
        json={
            "catalog_id": "COST-BUILD-01",
            "label": "Build",
            "value_stream": "Robotics",
            "start_year": 1,
            "end_year": 6,
            "ramp_profile": "immediate",
            "param_values": {"hours": 100, "hourly_rate": 100, "vendor_cost": 0},
        },
    )
    assert over_horizon.status_code == 422

    # Invalid custom_weights length rejected
    bad_weights = client.post(
        f"/api/initiatives/{init_id}/items",
        json={
            "catalog_id": "COST-BUILD-01",
            "label": "Build",
            "value_stream": "Robotics",
            "start_year": 1,
            "end_year": 3,
            "ramp_profile": "custom_weights",
            "ramp_weights": [1.0, 0.5],
            "param_values": {"hours": 100, "hourly_rate": 100, "vendor_cost": 0},
        },
    )
    assert bad_weights.status_code == 422

    # Out-of-bounds parameter rejected (adoption_rate > 1.0)
    bad_param = client.post(
        f"/api/initiatives/{init_id}/items",
        json={
            "catalog_id": "BEN-TOIL-01",
            "label": "Bad Adoption",
            "value_stream": "Inspection",
            "start_year": 2,
            "end_year": 5,
            "ramp_profile": "linear",
            "param_values": {
                "events_per_year": 1000,
                "minutes_saved_per_event": 20,
                "hourly_rate": 100,
                "adoption_rate": 1.5,
                "realization_factor": 0.8,
            },
        },
    )
    assert bad_param.status_code == 422

    # Add valid cost & benefit items
    c_item = client.post(
        f"/api/initiatives/{init_id}/items",
        json={
            "catalog_id": "COST-BUILD-01",
            "label": "Platform Integration",
            "value_stream": "Robotics",
            "start_year": 1,
            "end_year": 1,
            "ramp_profile": "immediate",
            "param_values": {"hours": 800, "hourly_rate": 150, "vendor_cost": 30000},
            "uncertainty_spec": {"parameters": {"hours": {"distribution": "pert", "low": 600, "mode": 800, "high": 1100}}},
        },
    )
    assert c_item.status_code == 201
    c_item_id = c_item.json()["id"]

    b_item = client.post(
        f"/api/initiatives/{init_id}/items",
        json={
            "catalog_id": "BEN-TOIL-01",
            "label": "Automated Inspection Hours",
            "value_stream": "Field Ops",
            "start_year": 2,
            "end_year": 5,
            "ramp_profile": "s_curve",
            "param_values": {
                "events_per_year": 4000,
                "minutes_saved_per_event": 25,
                "hourly_rate": 95,
                "adoption_rate": 0.85,
                "realization_factor": 0.75,
            },
            "uncertainty_spec": {
                "parameters": {
                    "adoption_rate": {"distribution": "triangular", "low": 0.6, "mode": 0.85, "high": 0.95},
                }
            },
        },
    )
    assert b_item.status_code == 201
    b_item_id = b_item.json()["id"]

    # Reject shrinking horizon below existing item end_year=5
    shrink = client.patch(f"/api/initiatives/{init_id}", json={"horizon_years": 3})
    assert shrink.status_code == 422

    # Patch item & initiative
    patched_item = client.patch(f"/api/items/{c_item_id}", json={"label": "Updated Build Cost"})
    assert patched_item.status_code == 200
    assert patched_item.json()["label"] == "Updated Build Cost"

    patched_init = client.patch(f"/api/initiatives/{init_id}", json={"discount_rate": 0.08})
    assert patched_init.status_code == 200
    assert patched_init.json()["discount_rate"] == 0.08

    # Run Monte Carlo simulation twice with fixed seed -> persisted in runs history
    sim1 = client.post(f"/api/initiatives/{init_id}/simulate", json={"n_simulations": 2500, "seed": 2026})
    assert sim1.status_code == 200
    sim2 = client.post(f"/api/initiatives/{init_id}/simulate", json={"n_simulations": 2500, "seed": 2026})
    assert sim2.status_code == 200
    assert sim1.json()["monte_carlo"]["npv_stats"] == sim2.json()["monte_carlo"]["npv_stats"]

    runs = client.get(f"/api/initiatives/{init_id}/runs")
    assert runs.status_code == 200
    assert len(runs.json()) == 2

    # Delete item and verify initiative updates
    del_item = client.delete(f"/api/items/{b_item_id}")
    assert del_item.status_code == 204
    detail = client.get(f"/api/initiatives/{init_id}")
    assert len(detail.json()["items"]) == 1

    # Delete initiative
    del_init = client.delete(f"/api/initiatives/{init_id}")
    assert del_init.status_code == 204
    assert client.get(f"/api/initiatives/{init_id}").status_code == 404


def test_initiative_cost_start_year_and_external_resource_url(client: TestClient) -> None:
    sharepoint_url = "https://contoso.sharepoint.com/sites/bca/Shared%20Documents/init-1"
    created = client.post(
        "/api/initiatives",
        json={
            "name": "ERP Cloud Consolidation",
            "description": "Finance ERP replatforming",
            "domain": "software",
            "horizon_years": 6,
            "discount_rate": 0.07,
            "cost_start_year": 2027,
            "external_resource_url": sharepoint_url,
        },
    )
    assert created.status_code == 201
    created_body = created.json()
    init_id = created_body["id"]
    assert created_body["cost_start_year"] == 2027
    assert created_body["external_resource_url"] == sharepoint_url

    listed = client.get("/api/initiatives")
    assert listed.status_code == 200
    assert listed.json()[0]["cost_start_year"] == 2027
    assert listed.json()[0]["external_resource_url"] == sharepoint_url

    # Omitting cost_start_year on PATCH preserves it
    patched_name = client.patch(f"/api/initiatives/{init_id}", json={"name": "ERP Cloud Phase 1"})
    assert patched_name.status_code == 200
    assert patched_name.json()["cost_start_year"] == 2027
    assert patched_name.json()["external_resource_url"] == sharepoint_url

    # Updating cost_start_year to 2028
    patched_year = client.patch(f"/api/initiatives/{init_id}", json={"cost_start_year": 2028})
    assert patched_year.status_code == 200
    assert patched_year.json()["cost_start_year"] == 2028

    # Explicitly clearing cost_start_year and external_resource_url
    cleared = client.patch(
        f"/api/initiatives/{init_id}",
        json={"cost_start_year": None, "external_resource_url": ""},
    )
    assert cleared.status_code == 200
    assert cleared.json()["cost_start_year"] is None
    assert cleared.json()["external_resource_url"] == ""

    # Reject unsafe/invalid URL schemes and out-of-range years
    for bad_url in ("javascript:alert(1)", "ftp://example.com/file", "not-a-url"):
        bad_resp = client.patch(f"/api/initiatives/{init_id}", json={"external_resource_url": bad_url})
        assert bad_resp.status_code == 422

    for bad_year in (1999, 2101):
        bad_resp = client.patch(f"/api/initiatives/{init_id}", json={"cost_start_year": bad_year})
        assert bad_resp.status_code == 422


def test_legacy_initiatives_schema_migration(tmp_path) -> None:
    import sqlite3
    from app.db.database import get_connection, init_db
    from app.db.repository import list_initiatives

    db_file = tmp_path / "legacy.db"
    with sqlite3.connect(str(db_file)) as conn:
        conn.executescript(
            """
            CREATE TABLE initiatives (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                domain TEXT NOT NULL,
                horizon_years INTEGER NOT NULL,
                discount_rate REAL NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            INSERT INTO initiatives (id, name, description, domain, horizon_years, discount_rate, created_at, updated_at)
            VALUES ('legacy-1', 'Legacy Portfolio Case', 'Pre-migration row', 'software', 5, 0.06, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z');
            """
        )

    init_db(db_file, seed_demo=False)

    with get_connection(db_file) as conn:
        cols = {row["name"] for row in conn.execute("PRAGMA table_info(initiatives)").fetchall()}
    assert "cost_start_year" in cols
    assert "external_resource_url" in cols

    summaries = list_initiatives(db_file)
    assert len(summaries) == 1
    assert summaries[0].id == "legacy-1"
    assert summaries[0].cost_start_year is None
    assert summaries[0].external_resource_url == ""

