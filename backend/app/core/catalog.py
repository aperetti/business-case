"""Built-in reusable cost & benefit catalog definitions and safe formula evaluators."""

from __future__ import annotations

import ast
import functools
import operator
from typing import Any, Callable, Mapping

import numpy as np

NumericValue = float | int | np.ndarray

_SAFE_BINOPS: dict[type[ast.operator], Callable[[Any, Any], Any]] = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
}

_SAFE_UNARYOPS: dict[type[ast.unaryop], Callable[[Any], Any]] = {
    ast.UAdd: operator.pos,
    ast.USub: operator.neg,
}

_SAFE_FUNCTIONS: dict[str, tuple[Callable[..., Any], int, int | None]] = {
    "abs": (lambda x: np.abs(x) if isinstance(x, np.ndarray) else abs(x), 1, 1),
    "min": (
        lambda *args: (
            functools.reduce(np.minimum, args)
            if any(isinstance(a, np.ndarray) for a in args)
            else min(args)
        ),
        2,
        None,
    ),
    "max": (
        lambda *args: (
            functools.reduce(np.maximum, args)
            if any(isinstance(a, np.ndarray) for a in args)
            else max(args)
        ),
        2,
        None,
    ),
}


def _safe_div(num: NumericValue, denom: NumericValue) -> NumericValue:
    if isinstance(num, np.ndarray) or isinstance(denom, np.ndarray):
        num_arr = np.asarray(num, dtype=np.float64)
        denom_arr = np.asarray(denom, dtype=np.float64)
        return np.where(denom_arr == 0.0, 0.0, np.divide(num_arr, denom_arr, out=np.zeros_like(np.broadcast_to(num_arr, np.broadcast_shapes(num_arr.shape, denom_arr.shape)), dtype=np.float64), where=denom_arr != 0.0))
    denom_f = float(denom)
    if denom_f == 0.0:
        return 0.0
    return float(num) / denom_f


def _extract_pow_exponent(node: ast.AST) -> float | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
        return float(node.value)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
        inner = _extract_pow_exponent(node.operand)
        if inner is None:
            return None
        return -inner if isinstance(node.op, ast.USub) else inner
    return None


def _validate_ast(node: ast.AST, allowed_keys: set[str] | None, used_keys: set[str]) -> None:
    if isinstance(node, ast.Expression):
        _validate_ast(node.body, allowed_keys, used_keys)
        return

    if isinstance(node, ast.Constant):
        if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
            raise ValueError("Only numeric constants are allowed in formulas.")
        return

    if isinstance(node, ast.Name):
        if allowed_keys is not None and node.id not in allowed_keys:
            raise ValueError(f"Unknown parameter '{node.id}' referenced in formula.")
        used_keys.add(node.id)
        return

    if isinstance(node, ast.UnaryOp) and type(node.op) in _SAFE_UNARYOPS:
        _validate_ast(node.operand, allowed_keys, used_keys)
        return

    if isinstance(node, ast.BinOp):
        if isinstance(node.op, ast.Pow):
            exp = _extract_pow_exponent(node.right)
            if exp is None or exp < -10.0 or exp > 10.0:
                raise ValueError("Exponentiation requires a numeric constant exponent between -10 and 10.")
            _validate_ast(node.left, allowed_keys, used_keys)
            return
        if type(node.op) in (*_SAFE_BINOPS.keys(), ast.Div):
            _validate_ast(node.left, allowed_keys, used_keys)
            _validate_ast(node.right, allowed_keys, used_keys)
            return
        raise ValueError(f"Unsupported binary operator '{type(node.op).__name__}' in formula.")

    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name) or node.func.id not in _SAFE_FUNCTIONS:
            raise ValueError("Only min(), max(), and abs() calls are allowed in formulas.")
        if node.keywords:
            raise ValueError("Keyword arguments are not allowed in formula function calls.")
        _, min_args, max_args = _SAFE_FUNCTIONS[node.func.id]
        if len(node.args) < min_args or (max_args is not None and len(node.args) > max_args):
            raise ValueError(f"Invalid argument count for '{node.func.id}()' in formula.")
        for arg in node.args:
            _validate_ast(arg, allowed_keys, used_keys)
        return

    raise ValueError(f"Disallowed syntax '{type(node).__name__}' in formula expression.")


def validate_safe_expression(expr: str, allowed_keys: set[str] | None = None) -> set[str]:
    """Parse and validate an arithmetic formula expression via AST whitelisting."""
    cleaned = expr.strip()
    if not cleaned:
        raise ValueError("Formula expression cannot be empty.")
    try:
        tree = ast.parse(cleaned, mode="eval")
    except SyntaxError as exc:
        raise ValueError(f"Invalid formula syntax: {exc.msg}") from exc
    used_keys: set[str] = set()
    _validate_ast(tree, allowed_keys, used_keys)
    return used_keys


def _eval_ast_node(node: ast.AST, values: Mapping[str, NumericValue]) -> NumericValue:
    if isinstance(node, ast.Expression):
        return _eval_ast_node(node.body, values)
    if isinstance(node, ast.Constant):
        return float(node.value)
    if isinstance(node, ast.Name):
        return values[node.id]
    if isinstance(node, ast.UnaryOp):
        return _SAFE_UNARYOPS[type(node.op)](_eval_ast_node(node.operand, values))
    if isinstance(node, ast.BinOp):
        left = _eval_ast_node(node.left, values)
        if isinstance(node.op, ast.Pow):
            exp = _extract_pow_exponent(node.right)
            assert exp is not None
            return np.power(left, exp) if isinstance(left, np.ndarray) else float(left) ** exp
        right = _eval_ast_node(node.right, values)
        if isinstance(node.op, ast.Div):
            return _safe_div(left, right)
        return _SAFE_BINOPS[type(node.op)](left, right)
    if isinstance(node, ast.Call):
        assert isinstance(node.func, ast.Name)
        fn, _, _ = _SAFE_FUNCTIONS[node.func.id]
        eval_args = [_eval_ast_node(arg, values) for arg in node.args]
        return fn(*eval_args)
    raise ValueError(f"Unsupported AST node '{type(node).__name__}'.")


def evaluate_safe_expression(expr: str, values: Mapping[str, NumericValue]) -> NumericValue:
    """Safely evaluate a whitelisted arithmetic expression on scalars or NumPy arrays."""
    allowed = set(values.keys())
    validate_safe_expression(expr, allowed)
    tree = ast.parse(expr.strip(), mode="eval")
    return _eval_ast_node(tree, values)


def _formula_cost_build(p: Mapping[str, NumericValue]) -> NumericValue:
    return p["hours"] * p["hourly_rate"] + p["vendor_cost"]


def _formula_cost_run(p: Mapping[str, NumericValue]) -> NumericValue:
    return p["annual_infra_cost"] + p["annual_license_cost"] + p["support_hours_per_year"] * p["hourly_rate"]


def _formula_cost_enablement(p: Mapping[str, NumericValue]) -> NumericValue:
    return p["training_hours"] * p["affected_staff"] * p["hourly_rate"] + p["transition_cost"]


def _formula_cost_lifecycle(p: Mapping[str, NumericValue]) -> NumericValue:
    interval = p["refresh_interval_years"]
    denom = np.maximum(interval, 1.0) if isinstance(interval, np.ndarray) else max(float(interval), 1.0)
    return _safe_div(p["refresh_cost"], denom)


def _formula_ben_toil(p: Mapping[str, NumericValue]) -> NumericValue:
    return (
        p["events_per_year"]
        * (p["minutes_saved_per_event"] / 60.0)
        * p["hourly_rate"]
        * p["adoption_rate"]
        * p["realization_factor"]
    )


def _formula_ben_flow(p: Mapping[str, NumericValue]) -> NumericValue:
    return p["accelerated_items_per_year"] * p["value_per_item"] * p["adoption_rate"]


def _formula_ben_quality(p: Mapping[str, NumericValue]) -> NumericValue:
    return p["baseline_events_per_year"] * p["risk_reduction_pct"] * p["cost_per_event"]


def _formula_ben_capability(p: Mapping[str, NumericValue]) -> NumericValue:
    return p["downstream_initiatives"] * p["avoided_setup_cost"] * p["reuse_probability"]


def _formula_ben_compliance(p: Mapping[str, NumericValue]) -> NumericValue:
    return p["audit_hours_saved"] * p["hourly_rate"] + p["avoided_penalty_expected"]


FORMULA_REGISTRY: dict[str, Callable[[Mapping[str, NumericValue]], NumericValue]] = {
    "cost_build": _formula_cost_build,
    "cost_run": _formula_cost_run,
    "cost_enablement": _formula_cost_enablement,
    "cost_lifecycle": _formula_cost_lifecycle,
    "ben_toil": _formula_ben_toil,
    "ben_flow": _formula_ben_flow,
    "ben_quality": _formula_ben_quality,
    "ben_capability": _formula_ben_capability,
    "ben_compliance": _formula_ben_compliance,
}

FORMULA_REQUIRED_KEYS: dict[str, set[str]] = {
    "cost_build": {"hours", "hourly_rate", "vendor_cost"},
    "cost_run": {"annual_infra_cost", "annual_license_cost", "support_hours_per_year", "hourly_rate"},
    "cost_enablement": {"training_hours", "affected_staff", "hourly_rate", "transition_cost"},
    "cost_lifecycle": {"refresh_cost", "refresh_interval_years"},
    "ben_toil": {"events_per_year", "minutes_saved_per_event", "hourly_rate", "adoption_rate", "realization_factor"},
    "ben_flow": {"accelerated_items_per_year", "value_per_item", "adoption_rate"},
    "ben_quality": {"baseline_events_per_year", "risk_reduction_pct", "cost_per_event"},
    "ben_capability": {"downstream_initiatives", "avoided_setup_cost", "reuse_probability"},
    "ben_compliance": {"audit_hours_saved", "hourly_rate", "avoided_penalty_expected"},
}

FORMULA_DESCRIPTIONS: dict[str, str] = {
    "cost_build": "hours * hourly_rate + vendor_cost",
    "cost_run": "annual_infra_cost + annual_license_cost + support_hours_per_year * hourly_rate",
    "cost_enablement": "training_hours * affected_staff * hourly_rate + transition_cost",
    "cost_lifecycle": "refresh_cost / max(refresh_interval_years, 1)",
    "ben_toil": "events_per_year * (minutes_saved_per_event / 60) * hourly_rate * adoption_rate * realization_factor",
    "ben_flow": "accelerated_items_per_year * value_per_item * adoption_rate",
    "ben_quality": "baseline_events_per_year * risk_reduction_pct * cost_per_event",
    "ben_capability": "downstream_initiatives * avoided_setup_cost * reuse_probability",
    "ben_compliance": "audit_hours_saved * hourly_rate + avoided_penalty_expected",
}


def is_valid_formula_type(formula_type: str, declared_keys: set[str] | None = None) -> tuple[bool, str | None]:
    """Verify that formula_type is a registered formula or a safe AST expr referencing declared keys."""
    if formula_type in FORMULA_REGISTRY:
        if declared_keys is not None:
            missing = FORMULA_REQUIRED_KEYS[formula_type] - declared_keys
            if missing:
                return False, f"Formula '{formula_type}' requires parameter keys: {sorted(missing)}"
        return True, None

    if formula_type.startswith("expr:"):
        expr_body = formula_type[5:].strip()
        try:
            validate_safe_expression(expr_body, declared_keys)
            return True, None
        except ValueError as exc:
            return False, str(exc)

    return False, f"Unknown formula_type '{formula_type}'. Must be a registered key or start with 'expr:'."


def describe_formula(formula_type: str) -> str:
    """Return human-readable equation text for a catalog formula."""
    if formula_type in FORMULA_DESCRIPTIONS:
        return FORMULA_DESCRIPTIONS[formula_type]
    if formula_type.startswith("expr:"):
        return formula_type[5:].strip()
    return formula_type


def evaluate_formula(formula_type: str, values: Mapping[str, NumericValue]) -> NumericValue:
    """Evaluate either a registered formula or a safe 'expr:...' expression."""
    if formula_type in FORMULA_REGISTRY:
        fn = FORMULA_REGISTRY[formula_type]
        result = fn(values)
        return result if isinstance(result, np.ndarray) else float(result)

    if formula_type.startswith("expr:"):
        result = evaluate_safe_expression(formula_type[5:], values)
        return result if isinstance(result, np.ndarray) else float(result)

    raise ValueError(f"Unsupported formula_type '{formula_type}'.")


BASELINE_CATALOG: list[dict[str, Any]] = [
    {
        "id": "COST-BUILD-01",
        "kind": "cost",
        "name": "Build, Integration & Deployment",
        "description": "Upfront engineering, integration, architecture, and external vendor delivery effort.",
        "domains": ["software", "automation", "capability", "infrastructure"],
        "value_stream_stage": "Build",
        "formula_type": "cost_build",
        "guardrail_notes": "Keep initial build scoped to active implementation years; avoid duplicating ongoing run support here.",
        "parameters": [
            {"key": "hours", "label": "Engineering & Integration Hours", "unit": "hrs/yr", "default_value": 1600.0, "min_value": 0.0, "max_value": None, "required": True},
            {"key": "hourly_rate", "label": "Blended Hourly Labor Rate", "unit": "$/hr", "default_value": 145.0, "min_value": 0.0, "max_value": None, "required": True},
            {"key": "vendor_cost", "label": "External Vendor / Implementation Fee", "unit": "$/yr", "default_value": 45000.0, "min_value": 0.0, "max_value": None, "required": True},
        ],
    },
    {
        "id": "COST-RUN-01",
        "kind": "cost",
        "name": "Recurring Hosting, Licensing & Support",
        "description": "Annual cloud/on-prem hosting, software subscriptions, and operational support labor.",
        "domains": ["software", "automation", "capability", "infrastructure", "operations"],
        "value_stream_stage": "Operate",
        "formula_type": "cost_run",
        "guardrail_notes": "Ensure support_hours_per_year reflects steady-state Tier-2/3 operations rather than initial build labor.",
        "parameters": [
            {"key": "annual_infra_cost", "label": "Annual Infrastructure / Cloud Cost", "unit": "$/yr", "default_value": 36000.0, "min_value": 0.0, "max_value": None, "required": True},
            {"key": "annual_license_cost", "label": "Annual Software & SaaS Licensing", "unit": "$/yr", "default_value": 24000.0, "min_value": 0.0, "max_value": None, "required": True},
            {"key": "support_hours_per_year", "label": "Ongoing Support & SRE Hours", "unit": "hrs/yr", "default_value": 480.0, "min_value": 0.0, "max_value": None, "required": True},
            {"key": "hourly_rate", "label": "Support Blended Hourly Rate", "unit": "$/hr", "default_value": 135.0, "min_value": 0.0, "max_value": None, "required": True},
        ],
    },
    {
        "id": "COST-ENAB-01",
        "kind": "cost",
        "name": "Enablement, Training & Change Management",
        "description": "Staff upskilling, workflow transition, documentation, and organizational adoption costs.",
        "domains": ["software", "automation", "capability", "operations"],
        "value_stream_stage": "Enable",
        "formula_type": "cost_enablement",
        "guardrail_notes": "Include realistic change management hours whenever benefit items assume high adoption_rate (>0.75).",
        "parameters": [
            {"key": "training_hours", "label": "Training Hours per Staff Member", "unit": "hrs/person", "default_value": 12.0, "min_value": 0.0, "max_value": None, "required": True},
            {"key": "affected_staff", "label": "Affected Staff Count", "unit": "people", "default_value": 65.0, "min_value": 0.0, "max_value": None, "required": True},
            {"key": "hourly_rate", "label": "Participant Opportunity Cost Rate", "unit": "$/hr", "default_value": 95.0, "min_value": 0.0, "max_value": None, "required": True},
            {"key": "transition_cost", "label": "Change Program & Materials Cost", "unit": "$/yr", "default_value": 15000.0, "min_value": 0.0, "max_value": None, "required": True},
        ],
    },
    {
        "id": "COST-LIFE-01",
        "kind": "cost",
        "name": "Lifecycle Refresh & Decommissioning",
        "description": "Amortized periodic hardware/platform modernization, tech-debt remediation, or retirement cost.",
        "domains": ["infrastructure", "software", "capability", "operations"],
        "value_stream_stage": "Operate",
        "formula_type": "cost_lifecycle",
        "guardrail_notes": "Model amortized refresh_cost / refresh_interval_years across active operating years or schedule a one-year spike.",
        "parameters": [
            {"key": "refresh_cost", "label": "Cycle Refresh / Decommission Cost", "unit": "$", "default_value": 90000.0, "min_value": 0.0, "max_value": None, "required": True},
            {"key": "refresh_interval_years", "label": "Refresh Interval", "unit": "years", "default_value": 3.0, "min_value": 1.0, "max_value": 30.0, "required": True},
        ],
    },
    {
        "id": "BEN-TOIL-01",
        "kind": "benefit",
        "name": "Automated Toil Elimination",
        "description": "Labor capacity recovered from automating repetitive manual tasks, handoffs, or data entry.",
        "domains": ["automation", "software", "operations"],
        "value_stream_stage": "Automate",
        "formula_type": "ben_toil",
        "guardrail_notes": "Apply realization_factor (<1.0, e.g., 0.70) to reflect that recovered minutes do not convert 100% into cashable capacity. Do not double-count with Cycle-Time Acceleration for the same hours.",
        "parameters": [
            {"key": "events_per_year", "label": "Manual Events per Year", "unit": "events/yr", "default_value": 6000.0, "min_value": 0.0, "max_value": None, "required": True},
            {"key": "minutes_saved_per_event", "label": "Minutes Saved per Event", "unit": "min", "default_value": 18.0, "min_value": 0.0, "max_value": None, "required": True},
            {"key": "hourly_rate", "label": "Loaded Staff Hourly Rate", "unit": "$/hr", "default_value": 110.0, "min_value": 0.0, "max_value": None, "required": True},
            {"key": "adoption_rate", "label": "Adoption Rate", "unit": "ratio", "default_value": 0.85, "min_value": 0.0, "max_value": 1.0, "required": True},
            {"key": "realization_factor", "label": "Capacity Realization Factor", "unit": "ratio", "default_value": 0.75, "min_value": 0.0, "max_value": 1.0, "required": True},
        ],
    },
    {
        "id": "BEN-FLOW-01",
        "kind": "benefit",
        "name": "Cycle-Time & Throughput Acceleration",
        "description": "Economic value from delivering more work items, releases, or customer orders sooner.",
        "domains": ["software", "automation", "capability", "operations"],
        "value_stream_stage": "Build",
        "formula_type": "ben_flow",
        "guardrail_notes": "Value should represent net incremental throughput or cost-of-delay reduction; tag overlapping items to avoid double-counting labor hours saved in BEN-TOIL-01.",
        "parameters": [
            {"key": "accelerated_items_per_year", "label": "Accelerated Deliveries / Items", "unit": "items/yr", "default_value": 140.0, "min_value": 0.0, "max_value": None, "required": True},
            {"key": "value_per_item", "label": "Net Value per Accelerated Item", "unit": "$/item", "default_value": 1200.0, "min_value": 0.0, "max_value": None, "required": True},
            {"key": "adoption_rate", "label": "Workflow Adoption Rate", "unit": "ratio", "default_value": 0.80, "min_value": 0.0, "max_value": 1.0, "required": True},
        ],
    },
    {
        "id": "BEN-QUAL-01",
        "kind": "benefit",
        "name": "Defect, Rework & Incident Avoidance",
        "description": "Expected annual cost avoided by preventing outages, production defects, or operational incidents.",
        "domains": ["software", "automation", "infrastructure", "operations"],
        "value_stream_stage": "Operate",
        "formula_type": "ben_quality",
        "guardrail_notes": "Verify baseline_events_per_year against historical incident logs; risk_reduction_pct must remain in [0, 1].",
        "parameters": [
            {"key": "baseline_events_per_year", "label": "Baseline Incidents / Defects", "unit": "events/yr", "default_value": 48.0, "min_value": 0.0, "max_value": None, "required": True},
            {"key": "risk_reduction_pct", "label": "Incident Reduction Ratio", "unit": "ratio", "default_value": 0.45, "min_value": 0.0, "max_value": 1.0, "required": True},
            {"key": "cost_per_event", "label": "Average Cost per Incident", "unit": "$/event", "default_value": 6500.0, "min_value": 0.0, "max_value": None, "required": True},
        ],
    },
    {
        "id": "BEN-CAP-01",
        "kind": "benefit",
        "name": "Shared Capability & Reuse Leverage",
        "description": "Avoided duplicate setup and integration costs across downstream programs reusing a shared platform.",
        "domains": ["capability", "software", "infrastructure"],
        "value_stream_stage": "Enable",
        "formula_type": "ben_capability",
        "guardrail_notes": "Only claim downstream_initiatives that are committed on the portfolio roadmap and weight by reuse_probability.",
        "parameters": [
            {"key": "downstream_initiatives", "label": "Downstream Reusing Initiatives", "unit": "initiatives/yr", "default_value": 3.0, "min_value": 0.0, "max_value": None, "required": True},
            {"key": "avoided_setup_cost", "label": "Avoided Setup Cost per Initiative", "unit": "$/initiative", "default_value": 55000.0, "min_value": 0.0, "max_value": None, "required": True},
            {"key": "reuse_probability", "label": "Reuse Probability", "unit": "ratio", "default_value": 0.70, "min_value": 0.0, "max_value": 1.0, "required": True},
        ],
    },
    {
        "id": "BEN-COMP-01",
        "kind": "benefit",
        "name": "Compliance, Audit & Risk Reduction",
        "description": "Audit preparation labor savings plus expected annual reduction in regulatory or SLA penalties.",
        "domains": ["operations", "capability", "infrastructure", "software"],
        "value_stream_stage": "Operate",
        "formula_type": "ben_compliance",
        "guardrail_notes": "Separate direct audit hours saved from probabilistic penalty reduction; avoid double-counting incident SLA penalties with BEN-QUAL-01.",
        "parameters": [
            {"key": "audit_hours_saved", "label": "Annual Audit Prep Hours Saved", "unit": "hrs/yr", "default_value": 320.0, "min_value": 0.0, "max_value": None, "required": True},
            {"key": "hourly_rate", "label": "Compliance & Engineering Rate", "unit": "$/hr", "default_value": 130.0, "min_value": 0.0, "max_value": None, "required": True},
            {"key": "avoided_penalty_expected", "label": "Expected Avoided Penalty / Fine", "unit": "$/yr", "default_value": 35000.0, "min_value": 0.0, "max_value": None, "required": True},
        ],
    },
]
