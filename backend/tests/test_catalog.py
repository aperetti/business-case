"""Tests for baseline catalog formulas and safe AST expression evaluation."""

from __future__ import annotations

import numpy as np
import pytest

from app.core.catalog import (
    BASELINE_CATALOG,
    evaluate_formula,
    evaluate_safe_expression,
    is_valid_formula_type,
    validate_safe_expression,
)


def test_all_nine_baseline_formulas_scalar_math() -> None:
    assert len(BASELINE_CATALOG) == 9

    assert evaluate_formula("cost_build", {"hours": 100.0, "hourly_rate": 150.0, "vendor_cost": 5000.0}) == pytest.approx(20000.0)
    assert evaluate_formula(
        "cost_run",
        {"annual_infra_cost": 12000.0, "annual_license_cost": 8000.0, "support_hours_per_year": 100.0, "hourly_rate": 100.0},
    ) == pytest.approx(30000.0)
    assert evaluate_formula(
        "cost_enablement",
        {"training_hours": 10.0, "affected_staff": 20.0, "hourly_rate": 80.0, "transition_cost": 4000.0},
    ) == pytest.approx(20000.0)
    assert evaluate_formula("cost_lifecycle", {"refresh_cost": 90000.0, "refresh_interval_years": 3.0}) == pytest.approx(30000.0)
    assert evaluate_formula(
        "ben_toil",
        {
            "events_per_year": 1200.0,
            "minutes_saved_per_event": 30.0,
            "hourly_rate": 100.0,
            "adoption_rate": 0.8,
            "realization_factor": 0.5,
        },
    ) == pytest.approx(24000.0)
    assert evaluate_formula(
        "ben_flow",
        {"accelerated_items_per_year": 50.0, "value_per_item": 1000.0, "adoption_rate": 0.6},
    ) == pytest.approx(30000.0)
    assert evaluate_formula(
        "ben_quality",
        {"baseline_events_per_year": 20.0, "risk_reduction_pct": 0.5, "cost_per_event": 2500.0},
    ) == pytest.approx(25000.0)
    assert evaluate_formula(
        "ben_capability",
        {"downstream_initiatives": 4.0, "avoided_setup_cost": 50000.0, "reuse_probability": 0.75},
    ) == pytest.approx(150000.0)
    assert evaluate_formula(
        "ben_compliance",
        {"audit_hours_saved": 200.0, "hourly_rate": 125.0, "avoided_penalty_expected": 15000.0},
    ) == pytest.approx(40000.0)


def test_safe_expression_scalar_and_vector_evaluation() -> None:
    expr = "max(hours * rate - discount, 0) + min(bonus, 5000) / 2"
    scalar = evaluate_safe_expression(expr, {"hours": 100.0, "rate": 100.0, "discount": 2000.0, "bonus": 4000.0})
    assert scalar == pytest.approx(10000.0)

    vec = evaluate_safe_expression(
        expr,
        {
            "hours": np.array([100.0, 10.0]),
            "rate": np.array([100.0, 50.0]),
            "discount": np.array([2000.0, 1000.0]),
            "bonus": np.array([4000.0, 8000.0]),
        },
    )
    assert isinstance(vec, np.ndarray)
    np.testing.assert_allclose(vec, np.array([10000.0, 2500.0]))


def test_safe_expression_guards_zero_division() -> None:
    assert evaluate_safe_expression("a / b", {"a": 100.0, "b": 0.0}) == pytest.approx(0.0)
    arr = evaluate_safe_expression("a / b", {"a": np.array([100.0, 50.0]), "b": np.array([0.0, 2.0])})
    np.testing.assert_allclose(arr, np.array([0.0, 25.0]))


@pytest.mark.parametrize(
    "bad_expr",
    [
        "",
        "__import__('os').system('echo pwned')",
        "open('/etc/passwd').read()",
        "(1).__class__.__base__",
        "eval('1 + 1')",
        "lambda x: x + 1",
        "hours ** other_var",
        "hours ** 100",
        "unknown_param * 2",
        "sum([1, 2, 3])",
    ],
)
def test_unsafe_expressions_are_rejected(bad_expr: str) -> None:
    with pytest.raises(ValueError):
        validate_safe_expression(bad_expr, {"hours", "rate", "other_var"})

    ok, err = is_valid_formula_type(f"expr:{bad_expr}", {"hours", "rate", "other_var"})
    assert not ok
    assert err
