"""Unit tests for deterministic Polars math, ramp curves, clamping, reproducibility, and MC speed."""

from __future__ import annotations

import numpy as np
import pytest

from app.core.catalog import BASELINE_CATALOG
from app.core.engine import compute_ramp_multipliers, run_deterministic, run_monte_carlo
from app.models import CatalogEntry, SimulationRequest


def _catalog_map() -> dict[str, CatalogEntry]:
    out: dict[str, CatalogEntry] = {}
    for raw in BASELINE_CATALOG:
        out[raw["id"]] = CatalogEntry(
            **raw,
            formula_description="",
            is_builtin=True,
            created_at="2026-01-01T00:00:00+00:00",
        )
    return out


def test_ramp_profiles() -> None:
    imm = compute_ramp_multipliers(5, 2, 4, "immediate")
    np.testing.assert_allclose(imm, np.array([0.0, 1.0, 1.0, 1.0, 0.0]))

    lin = compute_ramp_multipliers(5, 2, 5, "linear")
    np.testing.assert_allclose(lin, np.array([0.0, 0.25, 0.5, 0.75, 1.0]))

    sc = compute_ramp_multipliers(5, 1, 5, "s_curve")
    assert sc[-1] == pytest.approx(1.0)
    assert np.all(np.diff(sc) > 0.0)

    cw_exact = compute_ramp_multipliers(4, 1, 3, "custom_weights", [0.2, 0.6, 1.0])
    np.testing.assert_allclose(cw_exact, np.array([0.2, 0.6, 1.0, 0.0]))

    cw_norm = compute_ramp_multipliers(4, 1, 3, "custom_weights", [1.0, 2.0, 4.0])
    np.testing.assert_allclose(cw_norm, np.array([0.25, 0.5, 1.0, 0.0]))


def test_deterministic_pv_npv_bcr_payback_exact_hand_math() -> None:
    catalog_map = _catalog_map()
    initiative = {"id": "init-1", "horizon_years": 3, "discount_rate": 0.10}
    items = [
        {
            "id": "c1",
            "catalog_id": "COST-BUILD-01",
            "label": "Initial Build",
            "value_stream": "Core",
            "start_year": 1,
            "end_year": 1,
            "ramp_profile": "immediate",
            "ramp_weights": None,
            "param_values": {"hours": 100.0, "hourly_rate": 100.0, "vendor_cost": 1000.0},  # 11,000 in Y1
            "uncertainty_spec": {},
            "anti_double_count_tag": None,
        },
        {
            "id": "b1",
            "catalog_id": "BEN-FLOW-01",
            "label": "Throughput",
            "value_stream": "Core",
            "start_year": 2,
            "end_year": 3,
            "ramp_profile": "immediate",
            "ramp_weights": None,
            "param_values": {"accelerated_items_per_year": 10.0, "value_per_item": 1000.0, "adoption_rate": 1.0},  # 10,000/yr
            "uncertainty_spec": {},
            "anti_double_count_tag": None,
        },
    ]
    det, _, _ = run_deterministic(initiative, items, catalog_map)

    expected_pv_cost = 11000.0 / 1.1
    expected_pv_ben = 10000.0 / (1.1**2) + 10000.0 / (1.1**3)
    expected_npv = expected_pv_ben - expected_pv_cost
    expected_bcr = expected_pv_ben / expected_pv_cost

    assert det.pv_costs == pytest.approx(expected_pv_cost)
    assert det.pv_benefits == pytest.approx(expected_pv_ben)
    assert det.npv == pytest.approx(expected_npv)
    assert det.bcr == pytest.approx(expected_bcr)

    # Cum Y1 = -10,000.0; Y2 PV benefit = 8,264.4628 -> Cum Y2 = -1,735.5372;
    # Y3 PV benefit = 7,513.1480 -> Payback = 2 + (1735.5372 / 7513.1480) = 2.2310
    y2_pv = 10000.0 / (1.1**2)
    y3_pv = 10000.0 / (1.1**3)
    expected_payback = 2.0 + (expected_pv_cost - y2_pv) / y3_pv
    assert det.discounted_payback_year == pytest.approx(expected_payback, abs=1e-3)


def test_deterministic_zero_cost_and_negative_payback_edge_cases() -> None:
    catalog_map = _catalog_map()
    initiative = {"id": "init-edge", "horizon_years": 2, "discount_rate": 0.05}
    benefit_only = [
        {
            "id": "b1",
            "catalog_id": "BEN-COMP-01",
            "label": "Compliance",
            "value_stream": "Risk",
            "start_year": 1,
            "end_year": 2,
            "ramp_profile": "immediate",
            "ramp_weights": None,
            "param_values": {"audit_hours_saved": 100.0, "hourly_rate": 100.0, "avoided_penalty_expected": 0.0},
            "uncertainty_spec": {},
            "anti_double_count_tag": None,
        }
    ]
    det_b, _, _ = run_deterministic(initiative, benefit_only, catalog_map)
    assert det_b.bcr is None
    assert det_b.discounted_payback_year == 0.0

    cost_only = [
        {
            "id": "c1",
            "catalog_id": "COST-BUILD-01",
            "label": "Cost Only",
            "value_stream": "Risk",
            "start_year": 1,
            "end_year": 2,
            "ramp_profile": "immediate",
            "ramp_weights": None,
            "param_values": {"hours": 100.0, "hourly_rate": 100.0, "vendor_cost": 0.0},
            "uncertainty_spec": {},
            "anti_double_count_tag": None,
        }
    ]
    det_c, _, _ = run_deterministic(initiative, cost_only, catalog_map)
    assert det_c.npv < 0.0
    assert det_c.discounted_payback_year is None


def test_monte_carlo_clamping_and_fixed_seed_reproducibility() -> None:
    catalog_map = _catalog_map()
    initiative = {"id": "init-mc", "horizon_years": 5, "discount_rate": 0.06}
    items = [
        {
            "id": "c1",
            "catalog_id": "COST-BUILD-01",
            "label": "Build",
            "value_stream": "Delivery",
            "start_year": 1,
            "end_year": 1,
            "ramp_profile": "immediate",
            "ramp_weights": None,
            "param_values": {"hours": 500.0, "hourly_rate": 120.0, "vendor_cost": 10000.0},
            "uncertainty_spec": {
                "parameters": {
                    # Extreme std_pct to force samples below 0 before clamping
                    "hours": {"distribution": "normal", "std_pct": 2.0},
                }
            },
            "anti_double_count_tag": None,
        },
        {
            "id": "b1",
            "catalog_id": "BEN-TOIL-01",
            "label": "Toil 1",
            "value_stream": "Delivery",
            "start_year": 1,
            "end_year": 5,
            "ramp_profile": "linear",
            "ramp_weights": None,
            "param_values": {
                "events_per_year": 3000.0,
                "minutes_saved_per_event": 15.0,
                "hourly_rate": 100.0,
                "adoption_rate": 0.8,
                "realization_factor": 0.7,
            },
            "uncertainty_spec": {
                "parameters": {
                    # Extreme std_pct to verify clamping inside [0, 1]
                    "adoption_rate": {"distribution": "normal", "std_pct": 2.5},
                    "realization_factor": {"distribution": "pert", "low": 0.4, "mode": 0.7, "high": 0.95},
                }
            },
            "anti_double_count_tag": "overlap-tag",
        },
        {
            "id": "b2",
            "catalog_id": "BEN-FLOW-01",
            "label": "Flow 2",
            "value_stream": "Delivery",
            "start_year": 2,
            "end_year": 5,
            "ramp_profile": "s_curve",
            "ramp_weights": None,
            "param_values": {"accelerated_items_per_year": 60.0, "value_per_item": 500.0, "adoption_rate": 0.8},
            "uncertainty_spec": {
                "item_multiplier": {"distribution": "triangular", "low": 0.7, "mode": 1.0, "high": 1.3}
            },
            "anti_double_count_tag": "overlap-tag",
        },
    ]

    req = SimulationRequest(n_simulations=3000, seed=42, persist=False)
    res1 = run_monte_carlo(initiative, items, catalog_map, req)
    res2 = run_monte_carlo(initiative, items, catalog_map, req)

    assert res1.monte_carlo.npv_stats == res2.monte_carlo.npv_stats
    assert res1.monte_carlo.bcr_stats == res2.monte_carlo.bcr_stats
    assert res1.monte_carlo.npv_histogram == res2.monte_carlo.npv_histogram
    assert res1.monte_carlo.sensitivity_drivers == res2.monte_carlo.sensitivity_drivers

    # Costs and benefits clamped non-negative, so min BCR >= 0 and max yearly benefit bounded by adoption_rate <= 1
    assert res1.monte_carlo.bcr_stats is not None
    assert res1.monte_carlo.bcr_stats.min >= 0.0
    # Guardrail warning detected for shared anti_double_count_tag on b1 & b2
    assert len(res1.deterministic.guardrail_warnings) == 1
    assert res1.deterministic.guardrail_warnings[0].tag == "overlap-tag"


def test_correlation_group_increases_portfolio_variance() -> None:
    catalog_map = _catalog_map()
    initiative = {"id": "init-corr", "horizon_years": 5, "discount_rate": 0.05}

    def make_items(group: str | None) -> list[dict]:
        return [
            {
                "id": "b1",
                "catalog_id": "BEN-FLOW-01",
                "label": "Stream A",
                "value_stream": "A",
                "start_year": 1,
                "end_year": 5,
                "ramp_profile": "immediate",
                "ramp_weights": None,
                "param_values": {"accelerated_items_per_year": 100.0, "value_per_item": 1000.0, "adoption_rate": 1.0},
                "uncertainty_spec": {
                    "correlation_group": group,
                    "correlation_rho": 0.9,
                    "parameters": {"value_per_item": {"distribution": "normal", "std_pct": 0.25}},
                },
                "anti_double_count_tag": None,
            },
            {
                "id": "b2",
                "catalog_id": "BEN-FLOW-01",
                "label": "Stream B",
                "value_stream": "B",
                "start_year": 1,
                "end_year": 5,
                "ramp_profile": "immediate",
                "ramp_weights": None,
                "param_values": {"accelerated_items_per_year": 100.0, "value_per_item": 1000.0, "adoption_rate": 1.0},
                "uncertainty_spec": {
                    "correlation_group": group,
                    "correlation_rho": 0.9,
                    "parameters": {"value_per_item": {"distribution": "normal", "std_pct": 0.25}},
                },
                "anti_double_count_tag": None,
            },
        ]

    uncorr = run_monte_carlo(initiative, make_items(None), catalog_map, SimulationRequest(n_simulations=5000, seed=7, persist=False))
    corr = run_monte_carlo(initiative, make_items("shared_macro"), catalog_map, SimulationRequest(n_simulations=5000, seed=7, persist=False))

    assert corr.monte_carlo.npv_stats.std > uncorr.monte_carlo.npv_stats.std * 1.2


def test_monte_carlo_10k_15_items_10_years_under_one_second() -> None:
    catalog_map = _catalog_map()
    initiative = {"id": "init-perf", "horizon_years": 10, "discount_rate": 0.06}
    catalog_ids = [c["id"] for c in BASELINE_CATALOG]
    items: list[dict] = []
    for idx in range(15):
        cid = catalog_ids[idx % len(catalog_ids)]
        entry = catalog_map[cid]
        first_param = entry.parameters[0].key
        items.append(
            {
                "id": f"item-{idx}",
                "catalog_id": cid,
                "label": f"Item {idx}",
                "value_stream": f"Stream {idx % 3}",
                "start_year": 1,
                "end_year": 10,
                "ramp_profile": "s_curve" if idx % 2 == 0 else "linear",
                "ramp_weights": None,
                "param_values": {p.key: p.default_value for p in entry.parameters},
                "uncertainty_spec": {
                    "correlation_group": "macro" if idx % 3 == 0 else None,
                    "correlation_rho": 0.7,
                    "item_multiplier": {"distribution": "triangular", "low": 0.85, "mode": 1.0, "high": 1.2},
                    "parameters": {
                        first_param: {"distribution": "pert", "low_pct": -0.2, "high_pct": 0.3},
                    },
                },
                "anti_double_count_tag": None,
            }
        )

    res = run_monte_carlo(
        initiative,
        items,
        catalog_map,
        SimulationRequest(n_simulations=10_000, seed=123, persist=False),
    )
    assert res.n_simulations == 10_000
    assert res.duration_ms < 1000.0
