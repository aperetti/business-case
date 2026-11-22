"""End-to-end tests for multi-BCA management and paired Monte Carlo comparisons."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.db.database import init_db
from app.db.repository import get_initiative_detail, list_initiatives, list_simulation_runs


def test_seeded_initiative_has_two_comparable_bcas(seeded_client: TestClient) -> None:
    inits = seeded_client.get("/api/initiatives")
    assert inits.status_code == 200
    items = inits.json()
    by_domain = {item["domain"]: item for item in items}

    sw = by_domain["software"]
    assert sw["bca_count"] == 2
    assert len(sw["bcas"]) == 2
    assert sw["bcas"][0]["is_baseline"] is True
    assert sw["bcas"][0]["name"] == "Baseline BCA"
    assert sw["bcas"][1]["is_baseline"] is False
    assert sw["bcas"][1]["name"] == "Accelerated Cloud-Native BCA"
    assert sw["bcas"][0]["item_count"] == 6
    assert sw["bcas"][1]["item_count"] == 6

    # Other initiatives start with 1 Baseline BCA
    assert by_domain["automation"]["bca_count"] == 1
    assert by_domain["infrastructure"]["bca_count"] == 1

    # Compare the two seeded software BCAs via Monte Carlo
    comp = seeded_client.post(
        f"/api/initiatives/{sw['id']}/bcas/compare",
        json={
            "bca_a_id": sw["bcas"][0]["id"],
            "bca_b_id": sw["bcas"][1]["id"],
            "n_simulations": 2000,
            "seed": 42,
            "persist": True,
        },
    )
    assert comp.status_code == 200
    body = comp.json()
    assert body["comparison_id"]
    assert body["bca_a_name"] == "Baseline BCA"
    assert body["bca_b_name"] == "Accelerated Cloud-Native BCA"
    paired = body["paired"]
    assert 0.0 <= paired["prob_b_beats_a_npv"] <= 1.0
    assert 0.0 <= paired["prob_a_beats_b_npv"] <= 1.0
    assert paired["prob_b_beats_a_npv"] + paired["prob_a_beats_b_npv"] <= 1.000001
    assert len(paired["aligned_npv_distribution"]) == 32
    assert len(paired["yearly_comparison"]) == 7
    assert len(paired["value_stream_comparison"]) == 3


def test_multi_bca_crud_clone_baseline_switch_and_validation(client: TestClient) -> None:
    created = client.post(
        "/api/initiatives",
        json={
            "name": "Zero-Trust Network Rollout",
            "description": "Phased IAM & micro-segmentation program",
            "domain": "infrastructure",
            "horizon_years": 5,
            "discount_rate": 0.06,
            "cost_start_year": 2026,
        },
    )
    assert created.status_code == 201
    init_body = created.json()
    init_id = init_body["id"]
    baseline_id = init_body["active_bca_id"]
    assert baseline_id is not None
    assert len(init_body["bcas"]) == 1
    assert init_body["bcas"][0]["is_baseline"] is True

    # Cannot delete the sole BCA
    del_only = client.delete(f"/api/initiatives/{init_id}/bcas/{baseline_id}")
    assert del_only.status_code == 422

    # Add cost and benefit items to baseline BCA
    c1 = client.post(
        f"/api/initiatives/{init_id}/items",
        params={"bca_id": baseline_id},
        json={
            "catalog_id": "COST-BUILD-01",
            "label": "In-House Build",
            "value_stream": "Security",
            "start_year": 1,
            "end_year": 1,
            "ramp_profile": "immediate",
            "param_values": {"hours": 1000, "hourly_rate": 140, "vendor_cost": 20000},
            "uncertainty_spec": {"parameters": {"hours": {"distribution": "pert", "low": 800, "mode": 1000, "high": 1400}}},
        },
    )
    assert c1.status_code == 201

    b1 = client.post(
        f"/api/initiatives/{init_id}/items",
        params={"bca_id": baseline_id},
        json={
            "catalog_id": "BEN-QUAL-01",
            "label": "Breach Incident Avoidance",
            "value_stream": "Security",
            "start_year": 2,
            "end_year": 5,
            "ramp_profile": "linear",
            "param_values": {"baseline_events_per_year": 20, "risk_reduction_pct": 0.45, "cost_per_event": 12000},
            "uncertainty_spec": {"parameters": {"risk_reduction_pct": {"distribution": "pert", "low": 0.25, "mode": 0.45, "high": 0.65}}},
        },
    )
    assert b1.status_code == 201

    # Clone baseline into Option B with modified horizon and name
    cloned = client.post(
        f"/api/initiatives/{init_id}/bcas",
        json={
            "name": "Managed SaaS Vendor Option",
            "description": "Turnkey vendor SaaS with higher run rate and faster payback",
            "horizon_years": 6,
            "discount_rate": 0.08,
            "clone_from_bca_id": baseline_id,
        },
    )
    assert cloned.status_code == 201
    bca_b = cloned.json()
    bca_b_id = bca_b["id"]
    assert bca_b["is_baseline"] is False
    assert bca_b["horizon_years"] == 6
    assert bca_b["discount_rate"] == pytest.approx(0.08)
    assert len(bca_b["items"]) == 2
    assert {it["id"] for it in bca_b["items"]}.isdisjoint({c1.json()["id"], b1.json()["id"]})

    # Adding a new value-stream item to Option B does not touch Baseline BCA
    b2 = client.post(
        f"/api/initiatives/{init_id}/items",
        params={"bca_id": bca_b_id},
        json={
            "catalog_id": "BEN-COMP-01",
            "label": "Compliance Evidence Automation",
            "value_stream": "Compliance",
            "start_year": 2,
            "end_year": 6,
            "ramp_profile": "immediate",
            "param_values": {"audit_hours_saved": 250, "hourly_rate": 130, "avoided_penalty_expected": 30000},
        },
    )
    assert b2.status_code == 201

    base_detail = client.get(f"/api/initiatives/{init_id}", params={"bca_id": baseline_id}).json()
    opt_detail = client.get(f"/api/initiatives/{init_id}", params={"bca_id": bca_b_id}).json()
    assert len(base_detail["items"]) == 2
    assert len(opt_detail["items"]) == 3
    assert len(base_detail["bcas"]) == 2

    # Reject shrinking Option B horizon below its items (end_year = 6)
    shrink_b = client.patch(
        f"/api/initiatives/{init_id}/bcas/{bca_b_id}",
        json={"horizon_years": 4},
    )
    assert shrink_b.status_code == 422

    # Create a third blank BCA, then promote it or delete it cleanly
    blank = client.post(
        f"/api/initiatives/{init_id}/bcas",
        json={"name": "Minimal Pilot BCA"},
    )
    assert blank.status_code == 201
    blank_id = blank.json()["id"]
    assert len(blank.json()["items"]) == 0

    # Promote Option B to baseline -> initiative summary tracks Option B
    promoted = client.patch(
        f"/api/initiatives/{init_id}/bcas/{bca_b_id}",
        json={"is_baseline": True},
    )
    assert promoted.status_code == 200
    assert promoted.json()["is_baseline"] is True
    listed = client.get("/api/initiatives").json()
    assert listed[0]["baseline_bca_id"] == bca_b_id
    assert listed[0]["horizon_years"] == 6
    assert listed[0]["bca_count"] == 3

    # Delete the blank third BCA
    del_blank = client.delete(f"/api/initiatives/{init_id}/bcas/{blank_id}")
    assert del_blank.status_code == 204
    assert len(client.get(f"/api/initiatives/{init_id}/bcas").json()) == 2


def test_paired_monte_carlo_comparison_math_reproducibility_and_history(client: TestClient) -> None:
    created = client.post(
        "/api/initiatives",
        json={
            "name": "API Gateway Consolidation",
            "domain": "software",
            "horizon_years": 5,
            "discount_rate": 0.06,
        },
    )
    init_id = created.json()["id"]
    bca_a_id = created.json()["active_bca_id"]

    # Option A: modest savings, 5yr horizon
    client.post(
        f"/api/initiatives/{init_id}/items",
        params={"bca_id": bca_a_id},
        json={
            "catalog_id": "COST-BUILD-01",
            "label": "Gateway Setup",
            "value_stream": "Platform",
            "start_year": 1,
            "end_year": 1,
            "ramp_profile": "immediate",
            "param_values": {"hours": 600, "hourly_rate": 140, "vendor_cost": 15000},
            "uncertainty_spec": {"parameters": {"hours": {"distribution": "normal", "std_pct": 0.15}}},
        },
    )
    client.post(
        f"/api/initiatives/{init_id}/items",
        params={"bca_id": bca_a_id},
        json={
            "catalog_id": "BEN-FLOW-01",
            "label": "Faster Onboarding",
            "value_stream": "Platform",
            "start_year": 2,
            "end_year": 5,
            "ramp_profile": "immediate",
            "param_values": {"accelerated_items_per_year": 60, "value_per_item": 900, "adoption_rate": 0.8},
            "uncertainty_spec": {"parameters": {"adoption_rate": {"distribution": "triangular", "low": 0.6, "mode": 0.8, "high": 0.95}}},
        },
    )

    # Option B: different horizon (7 yrs) & extra value stream
    bca_b_id = client.post(
        f"/api/initiatives/{init_id}/bcas",
        json={"name": "Enterprise Mesh BCA", "horizon_years": 7, "discount_rate": 0.07},
    ).json()["id"]
    client.post(
        f"/api/initiatives/{init_id}/items",
        params={"bca_id": bca_b_id},
        json={
            "catalog_id": "COST-BUILD-01",
            "label": "Mesh Engineering",
            "value_stream": "Platform",
            "start_year": 1,
            "end_year": 2,
            "ramp_profile": "custom_weights",
            "ramp_weights": [1.0, 0.4],
            "param_values": {"hours": 1100, "hourly_rate": 140, "vendor_cost": 40000},
            "uncertainty_spec": {"parameters": {"hours": {"distribution": "pert", "low": 900, "mode": 1100, "high": 1500}}},
        },
    )
    client.post(
        f"/api/initiatives/{init_id}/items",
        params={"bca_id": bca_b_id},
        json={
            "catalog_id": "BEN-CAP-01",
            "label": "Cross-Org Reuse",
            "value_stream": "Reuse",
            "start_year": 2,
            "end_year": 7,
            "ramp_profile": "s_curve",
            "param_values": {"downstream_initiatives": 4, "avoided_setup_cost": 65000, "reuse_probability": 0.75},
            "uncertainty_spec": {"parameters": {"reuse_probability": {"distribution": "pert", "low": 0.5, "mode": 0.75, "high": 0.9}}},
        },
    )

    # Comparing a BCA to itself must return 422
    same_err = client.post(
        f"/api/initiatives/{init_id}/bcas/compare",
        json={"bca_a_id": bca_a_id, "bca_b_id": bca_a_id, "n_simulations": 1000},
    )
    assert same_err.status_code == 422

    # Run paired Monte Carlo twice with identical seed
    c_res1 = client.post(
        f"/api/initiatives/{init_id}/bcas/compare",
        json={"bca_a_id": bca_a_id, "bca_b_id": bca_b_id, "n_simulations": 2500, "seed": 123, "persist": True},
    )
    assert c_res1.status_code == 200
    comp1 = c_res1.json()

    c_res2 = client.post(
        f"/api/initiatives/{init_id}/bcas/compare",
        json={"bca_a_id": bca_a_id, "bca_b_id": bca_b_id, "n_simulations": 2500, "seed": 123, "persist": False},
    )
    assert c_res2.status_code == 200
    comp2 = c_res2.json()

    assert comp1["paired"]["delta_npv_stats"] == comp2["paired"]["delta_npv_stats"]
    assert comp1["paired"]["prob_b_beats_a_npv"] == comp2["paired"]["prob_b_beats_a_npv"]

    # Check mathematical consistency
    mean_a = comp1["result_a"]["monte_carlo"]["npv_stats"]["mean"]
    mean_b = comp1["result_b"]["monte_carlo"]["npv_stats"]["mean"]
    assert comp1["paired"]["delta_npv_stats"]["mean"] == pytest.approx(mean_b - mean_a, rel=1e-6)

    aligned = comp1["paired"]["aligned_npv_distribution"]
    assert sum(b["count_a"] for b in aligned) == 2500
    assert sum(b["count_b"] for b in aligned) == 2500
    assert aligned[-1]["cdf_a"] == pytest.approx(1.0)
    assert aligned[-1]["cdf_b"] == pytest.approx(1.0)

    # Horizon 5 vs 7 -> years 1..5 have both + deltas, years 6..7 have a_*=None and delta_*=None
    yearly = comp1["paired"]["yearly_comparison"]
    assert len(yearly) == 7
    assert yearly[4]["a_p50"] is not None and yearly[4]["delta_p50"] is not None
    assert yearly[5]["a_p50"] is None and yearly[5]["b_p50"] is not None and yearly[5]["delta_p50"] is None

    # Value streams include union ("Platform", "Reuse")
    vs_names = [v["value_stream"] for v in comp1["paired"]["value_stream_comparison"]]
    assert vs_names == ["Platform", "Reuse"]

    # Individual runs persisted for each BCA + comparison history persisted
    runs_a = client.get(f"/api/initiatives/{init_id}/runs", params={"bca_id": bca_a_id}).json()
    runs_b = client.get(f"/api/initiatives/{init_id}/runs", params={"bca_id": bca_b_id}).json()
    assert len(runs_a) == 1
    assert len(runs_b) == 1
    assert runs_a[0]["bca_id"] == bca_a_id
    assert runs_b[0]["bca_id"] == bca_b_id

    history = client.get(f"/api/initiatives/{init_id}/bcas/comparisons").json()
    assert len(history) == 1
    assert history[0]["id"] == comp1["comparison_id"]

    # Initiative summary & detail expose latest MC metrics per BCA
    detail_a = client.get(f"/api/initiatives/{init_id}", params={"bca_id": bca_a_id}).json()
    assert detail_a["bcas"][0]["latest_run_id"] == runs_a[0]["id"]
    assert detail_a["bcas"][1]["latest_run_id"] == runs_b[0]["id"]


def test_legacy_items_and_runs_migrated_to_baseline_bca(tmp_path: Path) -> None:
    db_file = tmp_path / "legacy_full.db"
    init_id = "legacy-init-1"
    item_id = "legacy-item-1"
    run_id = "legacy-run-1"
    now = "2025-05-01T00:00:00+00:00"

    sample_sim_result = {
        "run_id": run_id,
        "initiative_id": init_id,
        "created_at": now,
        "n_simulations": 1000,
        "discount_rate": 0.06,
        "horizon_years": 4,
        "seed": 42,
        "uncertainty_scale": 1.0,
        "benefit_scale": 1.0,
        "cost_scale": 1.0,
        "duration_ms": 5.0,
        "deterministic": {
            "pv_costs": 10000.0,
            "pv_benefits": 20000.0,
            "npv": 10000.0,
            "bcr": 2.0,
            "discounted_payback_year": 1.5,
            "yearly_cash_flows": [],
            "value_streams": [],
            "guardrail_warnings": [],
        },
        "monte_carlo": {
            "n_simulations": 1000,
            "seed": 42,
            "prob_npv_positive": 0.9,
            "prob_bcr_ge_one": 0.9,
            "npv_stats": {
                "mean": 10000.0,
                "std": 1500.0,
                "min": 5000.0,
                "max": 15000.0,
                "p5": 7000.0,
                "p10": 8000.0,
                "p25": 9000.0,
                "p50": 10000.0,
                "p75": 11000.0,
                "p90": 12000.0,
                "p95": 13000.0,
            },
            "bcr_stats": None,
            "npv_histogram": [],
            "yearly_cumulative_npv_bands": [],
            "sensitivity_drivers": [],
            "value_streams": [],
        },
    }

    with sqlite3.connect(str(db_file)) as conn:
        conn.executescript(
            """
            CREATE TABLE catalog_entries (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                domains_json TEXT NOT NULL,
                value_stream_stage TEXT,
                parameters_json TEXT NOT NULL,
                formula_type TEXT NOT NULL,
                guardrail_notes TEXT NOT NULL DEFAULT '',
                is_builtin INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
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
            CREATE TABLE initiative_items (
                id TEXT PRIMARY KEY,
                initiative_id TEXT NOT NULL,
                catalog_id TEXT NOT NULL,
                label TEXT NOT NULL,
                value_stream TEXT NOT NULL,
                start_year INTEGER NOT NULL,
                end_year INTEGER NOT NULL,
                ramp_profile TEXT NOT NULL,
                ramp_weights_json TEXT,
                param_values_json TEXT NOT NULL,
                uncertainty_spec_json TEXT NOT NULL,
                anti_double_count_tag TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE simulation_runs (
                id TEXT PRIMARY KEY,
                initiative_id TEXT NOT NULL,
                n_simulations INTEGER NOT NULL,
                discount_rate REAL NOT NULL,
                horizon_years INTEGER NOT NULL,
                seed INTEGER,
                summary_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            """
        )
        conn.execute(
            "INSERT INTO initiatives (id, name, description, domain, horizon_years, discount_rate, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (init_id, "Legacy Initiative", "Migrated", "software", 4, 0.06, now, now),
        )
        conn.execute(
            "INSERT INTO initiative_items (id, initiative_id, catalog_id, label, value_stream, start_year, end_year, ramp_profile, ramp_weights_json, param_values_json, uncertainty_spec_json, anti_double_count_tag, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?)",
            (
                item_id,
                init_id,
                "COST-BUILD-01",
                "Legacy Cost",
                "Core",
                1,
                1,
                "immediate",
                json.dumps({"hours": 100.0, "hourly_rate": 100.0, "vendor_cost": 0.0}),
                json.dumps({"parameters": {}}),
                now,
                now,
            ),
        )
        conn.execute(
            "INSERT INTO simulation_runs (id, initiative_id, n_simulations, discount_rate, horizon_years, seed, summary_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (run_id, init_id, 1000, 0.06, 4, 42, json.dumps(sample_sim_result), now),
        )

    init_db(db_file, seed_demo=False)

    summaries = list_initiatives(db_file)
    assert len(summaries) == 1
    assert summaries[0].bca_count == 1
    assert summaries[0].item_count == 1
    baseline_id = summaries[0].baseline_bca_id
    assert baseline_id is not None
    assert summaries[0].bcas[0].latest_run_id == run_id

    detail = get_initiative_detail(db_file, init_id)
    assert detail.active_bca_id == baseline_id
    assert len(detail.items) == 1
    assert detail.items[0].bca_id == baseline_id

    runs = list_simulation_runs(db_file, init_id, bca_id=baseline_id)
    assert len(runs) == 1
    assert runs[0].bca_id == baseline_id
    assert runs[0].bca_name == "Baseline BCA"
