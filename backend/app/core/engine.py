"""Polars cash-flow expansion, discounting, and vectorized NumPy Monte Carlo engine."""

from __future__ import annotations

import math
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import numpy as np
import polars as pl
from scipy.special import betaincinv, ndtr
from scipy.stats import rankdata

from app.core.catalog import evaluate_formula
from app.models import (
    AlignedHistogramBin,
    BCAComparisonPairedMetrics,
    BCAComparisonResult,
    BCACompareRequest,
    CatalogEntry,
    DeterministicMetrics,
    DistributionSpec,
    DistributionStats,
    GuardrailWarning,
    HistogramBin,
    InitiativeItemOut,
    MonteCarloSummary,
    RampProfile,
    SensitivityDriver,
    SimulationRequest,
    SimulationResult,
    ValueStreamBreakdown,
    ValueStreamComparisonRow,
    YearlyCashFlow,
    YearlyComparisonRow,
    YearlyPercentileBand,
)


def _safe_float(val: float, default: float = 0.0) -> float:
    f = float(val)
    return f if math.isfinite(f) else default


def compute_ramp_multipliers(
    horizon_years: int,
    start_year: int,
    end_year: int,
    ramp_profile: RampProfile,
    ramp_weights: list[float] | None = None,
) -> np.ndarray:
    """Compute normalized per-year realization multipliers across 1..horizon_years."""
    multipliers = np.zeros(horizon_years, dtype=np.float64)
    eff_start = max(1, start_year)
    eff_end = min(horizon_years, end_year)
    if eff_start > eff_end:
        return multipliers

    span = max(1, end_year - start_year + 1)
    if ramp_profile == "immediate":
        profile = np.ones(span, dtype=np.float64)
    elif ramp_profile == "linear":
        profile = np.arange(1, span + 1, dtype=np.float64) / float(span)
    elif ramp_profile == "s_curve":
        if span == 1:
            profile = np.array([1.0], dtype=np.float64)
        else:
            x = np.linspace(0.0, 1.0, span, dtype=np.float64)
            raw = 1.0 / (1.0 + np.exp(-6.0 * (x - 0.5)))
            profile = raw / raw[-1]
    elif ramp_profile == "custom_weights":
        weights = np.asarray(ramp_weights or [1.0] * span, dtype=np.float64)
        if len(weights) != span:
            padded = np.ones(span, dtype=np.float64)
            copy_n = min(len(weights), span)
            padded[:copy_n] = weights[:copy_n]
            weights = padded
        max_w = float(np.max(weights)) if len(weights) > 0 else 0.0
        profile = weights / max_w if max_w > 1.0 else weights
    else:
        profile = np.ones(span, dtype=np.float64)

    slice_start = eff_start - start_year
    slice_end = eff_end - start_year + 1
    multipliers[eff_start - 1 : eff_end] = profile[slice_start:slice_end]
    return multipliers


def _merge_item_params(item: dict[str, Any], catalog_entry: CatalogEntry) -> dict[str, float]:
    merged: dict[str, float] = {p.key: float(p.default_value) for p in catalog_entry.parameters}
    for k, v in item["param_values"].items():
        merged[k] = float(v)
    return merged


def _compute_discounted_payback(yearly_rows: list[YearlyCashFlow], pv_costs: float, pv_benefits: float) -> float | None:
    if not yearly_rows:
        return None
    if pv_costs <= 0.0:
        return 0.0 if pv_benefits > 0.0 else None
    if pv_benefits <= 0.0:
        return None

    cum = [row.cumulative_net_pv for row in yearly_rows]
    if cum[-1] < 0.0:
        return None

    # Walk backwards to find the last crossing from negative to non-negative so any
    # temporary late-stage negative dip followed by recovery is handled cleanly.
    last_neg_idx = -1
    for idx, val in enumerate(cum):
        if val < 0.0:
            last_neg_idx = idx

    if last_neg_idx == -1:
        first = yearly_rows[0]
        if first.pv_benefit > 0.0:
            ratio = first.pv_cost / first.pv_benefit
            return round(min(1.0, max(0.0, ratio)), 4)
        return 1.0

    cross_idx = last_neg_idx + 1
    if cross_idx >= len(yearly_rows):
        return None
    prev_cum = cum[last_neg_idx]
    net_pv_year = yearly_rows[cross_idx].net_pv
    if net_pv_year <= 0.0:
        return float(yearly_rows[cross_idx].year)
    fraction = -prev_cum / net_pv_year
    return round(float(last_neg_idx + 1) + min(1.0, max(0.0, fraction)), 4)


def _detect_guardrails(items: list[dict[str, Any]], catalog_map: dict[str, CatalogEntry]) -> list[GuardrailWarning]:
    tagged: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in items:
        tag = (item.get("anti_double_count_tag") or "").strip()
        if not tag:
            continue
        entry = catalog_map.get(item["catalog_id"])
        if entry and entry.kind == "benefit":
            tagged[tag.lower()].append(item)

    warnings: list[GuardrailWarning] = []
    for _, group_items in sorted(tagged.items()):
        if len(group_items) >= 2:
            raw_tag = str(group_items[0]["anti_double_count_tag"]).strip()
            labels = [it["label"] for it in group_items]
            warnings.append(
                GuardrailWarning(
                    tag=raw_tag,
                    message=(
                        f"{len(group_items)} benefit items share anti-double-count tag '{raw_tag}' "
                        f"({', '.join(labels)}). Verify their value claims do not overlap."
                    ),
                    item_ids=[it["id"] for it in group_items],
                    item_labels=labels,
                )
            )
    return warnings


def run_deterministic(
    initiative: dict[str, Any],
    items: list[dict[str, Any]],
    catalog_map: dict[str, CatalogEntry],
    *,
    discount_rate_override: float | None = None,
    horizon_years_override: int | None = None,
    benefit_scale: float = 1.0,
    cost_scale: float = 1.0,
) -> tuple[DeterministicMetrics, dict[str, float], dict[str, float]]:
    """Expand items across 1..horizon_years in Polars and compute deterministic PV/NPV/BCR/payback."""
    horizon = int(horizon_years_override if horizon_years_override is not None else initiative["horizon_years"])
    discount_rate = float(discount_rate_override if discount_rate_override is not None else initiative["discount_rate"])

    warnings = _detect_guardrails(items, catalog_map)

    if not items:
        empty_years = [
            YearlyCashFlow(
                year=y,
                undiscounted_cost=0.0,
                undiscounted_benefit=0.0,
                net_undiscounted=0.0,
                pv_cost=0.0,
                pv_benefit=0.0,
                net_pv=0.0,
                cumulative_undiscounted_net=0.0,
                cumulative_net_pv=0.0,
            )
            for y in range(1, horizon + 1)
        ]
        return (
            DeterministicMetrics(
                pv_costs=0.0,
                pv_benefits=0.0,
                npv=0.0,
                bcr=None,
                discounted_payback_year=None,
                yearly_cash_flows=empty_years,
                value_streams=[],
                guardrail_warnings=warnings,
            ),
            {},
            {},
        )

    rows: list[dict[str, Any]] = []
    per_item_base: dict[str, float] = {}

    for item in items:
        entry = catalog_map[item["catalog_id"]]
        params = _merge_item_params(item, entry)
        scale = cost_scale if entry.kind == "cost" else benefit_scale
        base_annual = _safe_float(float(evaluate_formula(entry.formula_type, params))) * scale
        per_item_base[item["id"]] = base_annual

        ramps = compute_ramp_multipliers(
            horizon_years=horizon,
            start_year=int(item["start_year"]),
            end_year=int(item["end_year"]),
            ramp_profile=item["ramp_profile"],
            ramp_weights=item.get("ramp_weights"),
        )
        for year_idx in range(horizon):
            rows.append(
                {
                    "item_id": item["id"],
                    "value_stream": item["value_stream"],
                    "kind": entry.kind,
                    "year": year_idx + 1,
                    "base_annual_value": base_annual,
                    "ramp_multiplier": float(ramps[year_idx]),
                }
            )

    df = (
        pl.DataFrame(rows)
        .with_columns(
            undiscounted_value=pl.col("base_annual_value") * pl.col("ramp_multiplier"),
            discount_factor=1.0 / ((1.0 + discount_rate) ** pl.col("year")),
        )
        .with_columns(
            pv_value=pl.col("undiscounted_value") * pl.col("discount_factor"),
        )
        .with_columns(
            undiscounted_cost=pl.when(pl.col("kind") == "cost").then(pl.col("undiscounted_value")).otherwise(0.0),
            undiscounted_benefit=pl.when(pl.col("kind") == "benefit").then(pl.col("undiscounted_value")).otherwise(0.0),
            pv_cost=pl.when(pl.col("kind") == "cost").then(pl.col("pv_value")).otherwise(0.0),
            pv_benefit=pl.when(pl.col("kind") == "benefit").then(pl.col("pv_value")).otherwise(0.0),
        )
    )

    yearly_df = (
        df.group_by("year")
        .agg(
            pl.col("undiscounted_cost").sum(),
            pl.col("undiscounted_benefit").sum(),
            pl.col("pv_cost").sum(),
            pl.col("pv_benefit").sum(),
        )
        .sort("year")
        .with_columns(
            net_undiscounted=pl.col("undiscounted_benefit") - pl.col("undiscounted_cost"),
            net_pv=pl.col("pv_benefit") - pl.col("pv_cost"),
        )
        .with_columns(
            cumulative_undiscounted_net=pl.col("net_undiscounted").cum_sum(),
            cumulative_net_pv=pl.col("net_pv").cum_sum(),
        )
    )

    yearly_cash_flows = [
        YearlyCashFlow(
            year=int(r["year"]),
            undiscounted_cost=_safe_float(r["undiscounted_cost"]),
            undiscounted_benefit=_safe_float(r["undiscounted_benefit"]),
            net_undiscounted=_safe_float(r["net_undiscounted"]),
            pv_cost=_safe_float(r["pv_cost"]),
            pv_benefit=_safe_float(r["pv_benefit"]),
            net_pv=_safe_float(r["net_pv"]),
            cumulative_undiscounted_net=_safe_float(r["cumulative_undiscounted_net"]),
            cumulative_net_pv=_safe_float(r["cumulative_net_pv"]),
        )
        for r in yearly_df.iter_rows(named=True)
    ]

    vs_df = (
        df.group_by("value_stream")
        .agg(
            pv_costs=pl.col("pv_cost").sum(),
            pv_benefits=pl.col("pv_benefit").sum(),
            item_count=pl.col("item_id").n_unique(),
        )
        .sort("value_stream")
    )

    value_streams = []
    for r in vs_df.iter_rows(named=True):
        vs_costs = _safe_float(r["pv_costs"])
        vs_benefits = _safe_float(r["pv_benefits"])
        value_streams.append(
            ValueStreamBreakdown(
                value_stream=str(r["value_stream"]),
                pv_costs=vs_costs,
                pv_benefits=vs_benefits,
                npv=vs_benefits - vs_costs,
                bcr=(vs_benefits / vs_costs) if vs_costs > 0.0 else None,
                item_count=int(r["item_count"]),
            )
        )

    item_pv_df = df.group_by("item_id").agg(pv_total=pl.col("pv_value").sum())
    per_item_pv = {str(r["item_id"]): _safe_float(r["pv_total"]) for r in item_pv_df.iter_rows(named=True)}

    pv_costs = sum(y.pv_cost for y in yearly_cash_flows)
    pv_benefits = sum(y.pv_benefit for y in yearly_cash_flows)
    npv = pv_benefits - pv_costs
    bcr = (pv_benefits / pv_costs) if pv_costs > 0.0 else None
    payback = _compute_discounted_payback(yearly_cash_flows, pv_costs, pv_benefits)

    metrics = DeterministicMetrics(
        pv_costs=pv_costs,
        pv_benefits=pv_benefits,
        npv=npv,
        bcr=bcr,
        discounted_payback_year=payback,
        yearly_cash_flows=yearly_cash_flows,
        value_streams=value_streams,
        guardrail_warnings=warnings,
    )
    return metrics, per_item_pv, per_item_base


def _clamp_array(arr: np.ndarray, min_val: float | None, max_val: float | None) -> np.ndarray:
    if min_val is not None:
        arr = np.maximum(arr, min_val)
    if max_val is not None:
        arr = np.minimum(arr, max_val)
    return arr


def _clamp_scalar(val: float, min_val: float | None, max_val: float | None) -> float:
    if min_val is not None:
        val = max(val, min_val)
    if max_val is not None:
        val = min(val, max_val)
    return val


def _sample_distribution(
    base: float,
    spec: DistributionSpec | None,
    rng: np.random.Generator,
    n_sims: int,
    group_factors: dict[str, np.ndarray],
    default_group: str | None,
    default_rho: float,
    uncertainty_scale: float,
    min_val: float | None,
    max_val: float | None,
) -> np.ndarray:
    clamped_base = _clamp_scalar(base, min_val, max_val)
    if spec is None or spec.distribution == "fixed" or uncertainty_scale <= 0.0:
        return np.full(n_sims, clamped_base, dtype=np.float64)

    group = spec.correlation_group or default_group
    rho = float(spec.correlation_rho if spec.correlation_group else default_rho)

    z_corr: np.ndarray | None = None
    if group and abs(rho) > 1e-12:
        z_group = group_factors[group]
        eps = rng.standard_normal(n_sims)
        sign_rho = 1.0 if rho >= 0.0 else -1.0
        abs_rho = min(0.99, abs(rho))
        z_corr = sign_rho * math.sqrt(abs_rho) * z_group + math.sqrt(1.0 - abs_rho) * eps

    dist = spec.distribution

    if dist == "normal":
        sigma = spec.std if spec.std is not None else abs(base) * (spec.std_pct if spec.std_pct is not None else 0.15)
        sigma *= uncertainty_scale
        if sigma <= 0.0:
            return np.full(n_sims, clamped_base, dtype=np.float64)
        z = z_corr if z_corr is not None else rng.standard_normal(n_sims)
        samples = base + sigma * z
        return _clamp_array(samples, min_val, max_val)

    if dist == "lognormal":
        sigma_target = spec.std if spec.std is not None else abs(base) * (spec.std_pct if spec.std_pct is not None else 0.20)
        sigma_target *= uncertainty_scale
        if base <= 0.0 or sigma_target <= 0.0:
            return np.full(n_sims, clamped_base, dtype=np.float64)
        cv2 = (sigma_target / base) ** 2
        sigma_ln = math.sqrt(math.log1p(cv2))
        mu_ln = math.log(base) - 0.5 * (sigma_ln ** 2)
        z = z_corr if z_corr is not None else rng.standard_normal(n_sims)
        samples = np.exp(mu_ln + sigma_ln * z)
        return _clamp_array(samples, min_val, max_val)

    # Triangular or PERT via inverse CDF on U in (0, 1)
    mode = float(spec.mode if spec.mode is not None else base)
    low_default = base * (1.0 + (spec.low_pct if spec.low_pct is not None else -0.25))
    high_default = base * (1.0 + (spec.high_pct if spec.high_pct is not None else 0.35))
    low = float(spec.low if spec.low is not None else low_default)
    high = float(spec.high if spec.high is not None else high_default)

    low = mode - (mode - low) * uncertainty_scale
    high = mode + (high - mode) * uncertainty_scale
    if low > mode:
        low = mode
    if high < mode:
        high = mode
    if high <= low:
        return np.full(n_sims, _clamp_scalar(mode, min_val, max_val), dtype=np.float64)

    if z_corr is not None:
        u = np.clip(ndtr(z_corr), 1e-9, 1.0 - 1e-9)
    else:
        u = rng.uniform(1e-9, 1.0 - 1e-9, size=n_sims)

    span = high - low
    if dist == "triangular":
        fc = (mode - low) / span
        samples = np.where(
            u < fc,
            low + np.sqrt(u * span * max(0.0, mode - low)),
            high - np.sqrt((1.0 - u) * span * max(0.0, high - mode)),
        )
        return _clamp_array(samples, min_val, max_val)

    if dist == "pert":
        alpha = 1.0 + 4.0 * (mode - low) / span
        beta = 1.0 + 4.0 * (high - mode) / span
        samples = low + betaincinv(alpha, beta, u) * span
        return _clamp_array(samples, min_val, max_val)

    return np.full(n_sims, clamped_base, dtype=np.float64)


def _compute_distribution_stats(arr: np.ndarray) -> DistributionStats:
    pcts = np.percentile(arr, [5, 10, 25, 50, 75, 90, 95])
    return DistributionStats(
        mean=_safe_float(float(np.mean(arr))),
        std=_safe_float(float(np.std(arr))),
        min=_safe_float(float(np.min(arr))),
        max=_safe_float(float(np.max(arr))),
        p5=_safe_float(float(pcts[0])),
        p10=_safe_float(float(pcts[1])),
        p25=_safe_float(float(pcts[2])),
        p50=_safe_float(float(pcts[3])),
        p75=_safe_float(float(pcts[4])),
        p90=_safe_float(float(pcts[5])),
        p95=_safe_float(float(pcts[6])),
    )


def _build_histogram(arr: np.ndarray, bins: int = 30) -> list[HistogramBin]:
    n = len(arr)
    if n == 0:
        return []
    min_v = float(np.min(arr))
    max_v = float(np.max(arr))
    if math.isclose(min_v, max_v, rel_tol=1e-12, abs_tol=1e-9):
        pad = max(1.0, abs(min_v) * 0.05)
        return [
            HistogramBin(
                bin_start=_safe_float(min_v - pad),
                bin_end=_safe_float(max_v + pad),
                bin_mid=_safe_float(min_v),
                count=n,
                density=1.0,
                cumulative_prob=1.0,
            )
        ]

    counts, edges = np.histogram(arr, bins=bins)
    cum = np.cumsum(counts) / float(n)
    out: list[HistogramBin] = []
    for idx in range(len(counts)):
        b_start = float(edges[idx])
        b_end = float(edges[idx + 1])
        c = int(counts[idx])
        out.append(
            HistogramBin(
                bin_start=_safe_float(b_start),
                bin_end=_safe_float(b_end),
                bin_mid=_safe_float(0.5 * (b_start + b_end)),
                count=c,
                density=_safe_float(c / float(n)),
                cumulative_prob=_safe_float(float(cum[idx])),
            )
        )
    return out


def _spearman_corr(x: np.ndarray, y_ranks: np.ndarray, y_centered: np.ndarray, y_norm: float) -> float:
    if y_norm <= 0.0 or float(np.std(x)) <= 1e-12:
        return 0.0
    x_ranks = rankdata(x, method="average")
    x_centered = x_ranks - float(np.mean(x_ranks))
    x_norm = float(np.linalg.norm(x_centered))
    if x_norm <= 0.0:
        return 0.0
    corr = float(np.dot(x_centered, y_centered) / (x_norm * y_norm))
    return max(-1.0, min(1.0, _safe_float(corr)))


@dataclass
class _SimulationArrays:
    sim_npv: np.ndarray
    sim_pv_costs: np.ndarray
    sim_pv_benefits: np.ndarray
    cum_yearly: np.ndarray
    valid_bcr_mask: np.ndarray
    bcr_values: np.ndarray


def _execute_monte_carlo(
    initiative: dict[str, Any],
    items: list[dict[str, Any]],
    catalog_map: dict[str, CatalogEntry],
    req: SimulationRequest,
    *,
    run_id: str | None = None,
    bca_id: str | None = None,
    bca_name: str | None = None,
) -> tuple[SimulationResult, _SimulationArrays]:
    """Run deterministic baseline plus vectorized NumPy Monte Carlo simulation and return raw arrays."""
    t0 = time.perf_counter()

    horizon = int(req.horizon_years_override if req.horizon_years_override is not None else initiative["horizon_years"])
    discount_rate = float(req.discount_rate_override if req.discount_rate_override is not None else initiative["discount_rate"])

    det_metrics, _, _ = run_deterministic(
        initiative,
        items,
        catalog_map,
        discount_rate_override=discount_rate,
        horizon_years_override=horizon,
        benefit_scale=req.benefit_scale,
        cost_scale=req.cost_scale,
    )

    n_sims = int(req.n_simulations)
    rng = np.random.default_rng(req.seed)

    # Pre-draw shared Gaussian copula factors for correlation groups.
    group_names: set[str] = set()
    for item in items:
        uspec = item.get("uncertainty_spec") or {}
        if isinstance(uspec, dict):
            top_g = (uspec.get("correlation_group") or "").strip()
            if top_g:
                group_names.add(top_g)
            mult = uspec.get("item_multiplier") or {}
            if isinstance(mult, dict) and (mult.get("correlation_group") or "").strip():
                group_names.add(mult["correlation_group"].strip())
            for p_spec in (uspec.get("parameters") or {}).values():
                if isinstance(p_spec, dict) and (p_spec.get("correlation_group") or "").strip():
                    group_names.add(p_spec["correlation_group"].strip())

    group_factors: dict[str, np.ndarray] = {g: rng.standard_normal(n_sims) for g in sorted(group_names)}

    discount_factors = 1.0 / ((1.0 + discount_rate) ** np.arange(1, horizon + 1, dtype=np.float64))
    sim_pv_costs = np.zeros(n_sims, dtype=np.float64)
    sim_pv_benefits = np.zeros(n_sims, dtype=np.float64)
    sim_yearly_net = np.zeros((n_sims, horizon), dtype=np.float64)

    vs_pv_costs: dict[str, np.ndarray] = {}
    vs_pv_benefits: dict[str, np.ndarray] = {}

    driver_samples: list[tuple[str, str, str, str, np.ndarray]] = []

    for item in items:
        entry = catalog_map[item["catalog_id"]]
        uspec_raw = item.get("uncertainty_spec") or {}
        default_group = (uspec_raw.get("correlation_group") or "").strip() or None
        default_rho = float(uspec_raw.get("correlation_rho", 0.7))

        merged_params = _merge_item_params(item, entry)
        param_specs = uspec_raw.get("parameters") or {}
        param_meta_by_key = {p.key: p for p in entry.parameters}

        eval_values: dict[str, float | np.ndarray] = {}
        for p_key, base_val in merged_params.items():
            meta = param_meta_by_key.get(p_key)
            min_v = meta.min_value if meta is not None else 0.0
            max_v = meta.max_value if meta is not None else None
            raw_pspec = param_specs.get(p_key)
            if raw_pspec:
                pspec = DistributionSpec.model_validate(raw_pspec)
                if pspec.distribution != "fixed" and req.uncertainty_scale > 0.0:
                    sampled = _sample_distribution(
                        base=base_val,
                        spec=pspec,
                        rng=rng,
                        n_sims=n_sims,
                        group_factors=group_factors,
                        default_group=default_group,
                        default_rho=default_rho,
                        uncertainty_scale=req.uncertainty_scale,
                        min_val=min_v,
                        max_val=max_v,
                    )
                    eval_values[p_key] = sampled
                    driver_samples.append((item["id"], item["label"], p_key, entry.kind, sampled))
                    continue
            eval_values[p_key] = _clamp_scalar(base_val, min_v, max_v)

        sim_annual_raw = evaluate_formula(entry.formula_type, eval_values)
        if not isinstance(sim_annual_raw, np.ndarray):
            sim_annual = np.full(n_sims, float(sim_annual_raw), dtype=np.float64)
        else:
            sim_annual = np.asarray(sim_annual_raw, dtype=np.float64)

        raw_mult = uspec_raw.get("item_multiplier")
        if raw_mult:
            mspec = DistributionSpec.model_validate(raw_mult)
            if mspec.distribution != "fixed" and req.uncertainty_scale > 0.0:
                mult_samples = _sample_distribution(
                    base=1.0,
                    spec=mspec,
                    rng=rng,
                    n_sims=n_sims,
                    group_factors=group_factors,
                    default_group=default_group,
                    default_rho=default_rho,
                    uncertainty_scale=req.uncertainty_scale,
                    min_val=0.0,
                    max_val=None,
                )
                sim_annual = sim_annual * mult_samples
                driver_samples.append((item["id"], item["label"], "item_multiplier", entry.kind, mult_samples))

        scale = req.cost_scale if entry.kind == "cost" else req.benefit_scale
        sim_annual = np.maximum(0.0, sim_annual) * scale

        ramps = compute_ramp_multipliers(
            horizon_years=horizon,
            start_year=int(item["start_year"]),
            end_year=int(item["end_year"]),
            ramp_profile=item["ramp_profile"],
            ramp_weights=item.get("ramp_weights"),
        )
        pv_weights = ramps * discount_factors
        pv_weight_sum = float(np.sum(pv_weights))
        item_pv_total = sim_annual * pv_weight_sum

        vs = item["value_stream"]
        if vs not in vs_pv_costs:
            vs_pv_costs[vs] = np.zeros(n_sims, dtype=np.float64)
            vs_pv_benefits[vs] = np.zeros(n_sims, dtype=np.float64)

        if entry.kind == "cost":
            sim_pv_costs += item_pv_total
            vs_pv_costs[vs] += item_pv_total
            sim_yearly_net -= sim_annual[:, None] * pv_weights[None, :]
        else:
            sim_pv_benefits += item_pv_total
            vs_pv_benefits[vs] += item_pv_total
            sim_yearly_net += sim_annual[:, None] * pv_weights[None, :]

    sim_npv = sim_pv_benefits - sim_pv_costs
    prob_npv_positive = _safe_float(float(np.mean(sim_npv > 0.0)))

    valid_bcr_mask = sim_pv_costs > 0.0
    bcr_values = np.zeros(n_sims, dtype=np.float64)
    if np.any(valid_bcr_mask):
        finite_bcrs = sim_pv_benefits[valid_bcr_mask] / sim_pv_costs[valid_bcr_mask]
        bcr_values[valid_bcr_mask] = finite_bcrs
        bcr_stats = _compute_distribution_stats(finite_bcrs)
        bcr_ge_one = np.where(valid_bcr_mask, sim_pv_benefits >= sim_pv_costs, sim_pv_benefits > 0.0)
        prob_bcr_ge_one = _safe_float(float(np.mean(bcr_ge_one)))
    else:
        bcr_stats = None
        prob_bcr_ge_one = 1.0 if float(np.mean(sim_pv_benefits)) > 0.0 else 0.0

    npv_stats = _compute_distribution_stats(sim_npv)
    npv_histogram = _build_histogram(sim_npv, bins=30)

    cum_yearly = np.cumsum(sim_yearly_net, axis=1)
    yearly_bands: list[YearlyPercentileBand] = []
    if horizon > 0:
        pct_matrix = np.percentile(cum_yearly, [10, 25, 50, 75, 90], axis=0)
        means = np.mean(cum_yearly, axis=0)
        for idx in range(horizon):
            yearly_bands.append(
                YearlyPercentileBand(
                    year=idx + 1,
                    p10=_safe_float(float(pct_matrix[0, idx])),
                    p25=_safe_float(float(pct_matrix[1, idx])),
                    p50=_safe_float(float(pct_matrix[2, idx])),
                    p75=_safe_float(float(pct_matrix[3, idx])),
                    p90=_safe_float(float(pct_matrix[4, idx])),
                    mean=_safe_float(float(means[idx])),
                )
            )

    # Sensitivity drivers ranked by Spearman correlation with simulated NPV
    sensitivity_drivers: list[SensitivityDriver] = []
    if float(np.std(sim_npv)) > 1e-12 and driver_samples:
        npv_ranks = rankdata(sim_npv, method="average")
        npv_centered = npv_ranks - float(np.mean(npv_ranks))
        npv_norm = float(np.linalg.norm(npv_centered))

        raw_drivers: list[tuple[str, str, str, str, float]] = []
        for item_id, item_label, param_key, kind, arr in driver_samples:
            corr = _spearman_corr(arr, npv_ranks, npv_centered, npv_norm)
            if abs(corr) > 1e-6:
                raw_drivers.append((item_id, item_label, param_key, kind, corr))

        r2_sum = sum(d[4] ** 2 for d in raw_drivers)
        raw_drivers.sort(key=lambda d: abs(d[4]), reverse=True)
        for item_id, item_label, param_key, kind, corr in raw_drivers[:10]:
            share = (corr ** 2 / r2_sum * 100.0) if r2_sum > 0.0 else 0.0
            nice_param = "Overall Multiplier" if param_key == "item_multiplier" else param_key.replace("_", " ")
            sensitivity_drivers.append(
                SensitivityDriver(
                    item_id=item_id,
                    item_label=item_label,
                    parameter_key=param_key,
                    driver_label=f"{item_label} ({nice_param})",
                    kind=kind,  # type: ignore[arg-type]
                    spearman_corr=round(corr, 4),
                    variance_share_pct=round(_safe_float(share), 2),
                )
            )

    # Merge MC value-stream quantiles onto deterministic value streams
    enriched_vs: list[ValueStreamBreakdown] = []
    for det_vs in det_metrics.value_streams:
        vs_name = det_vs.value_stream
        c_arr = vs_pv_costs.get(vs_name, np.zeros(n_sims, dtype=np.float64))
        b_arr = vs_pv_benefits.get(vs_name, np.zeros(n_sims, dtype=np.float64))
        n_arr = b_arr - c_arr
        p10, p50, p90 = np.percentile(n_arr, [10, 50, 90])
        enriched_vs.append(
            ValueStreamBreakdown(
                value_stream=vs_name,
                pv_costs=det_vs.pv_costs,
                pv_benefits=det_vs.pv_benefits,
                npv=det_vs.npv,
                bcr=det_vs.bcr,
                item_count=det_vs.item_count,
                sim_npv_p10=_safe_float(float(p10)),
                sim_npv_p50=_safe_float(float(p50)),
                sim_npv_p90=_safe_float(float(p90)),
                sim_pv_costs_mean=_safe_float(float(np.mean(c_arr))),
                sim_pv_benefits_mean=_safe_float(float(np.mean(b_arr))),
            )
        )

    duration_ms = round((time.perf_counter() - t0) * 1000.0, 2)
    now_iso = datetime.now(timezone.utc).isoformat()

    mc_summary = MonteCarloSummary(
        n_simulations=n_sims,
        seed=req.seed,
        prob_npv_positive=prob_npv_positive,
        prob_bcr_ge_one=prob_bcr_ge_one,
        npv_stats=npv_stats,
        bcr_stats=bcr_stats,
        npv_histogram=npv_histogram,
        yearly_cumulative_npv_bands=yearly_bands,
        sensitivity_drivers=sensitivity_drivers,
        value_streams=enriched_vs,
    )

    resolved_bca_id = bca_id if bca_id is not None else initiative.get("bca_id")
    resolved_bca_name = bca_name if bca_name is not None else initiative.get("bca_name")

    result = SimulationResult(
        run_id=run_id,
        initiative_id=initiative["id"],
        bca_id=resolved_bca_id,
        bca_name=resolved_bca_name,
        created_at=now_iso,
        n_simulations=n_sims,
        discount_rate=discount_rate,
        horizon_years=horizon,
        seed=req.seed,
        uncertainty_scale=float(req.uncertainty_scale),
        benefit_scale=float(req.benefit_scale),
        cost_scale=float(req.cost_scale),
        duration_ms=duration_ms,
        deterministic=det_metrics,
        monte_carlo=mc_summary,
    )
    arrays = _SimulationArrays(
        sim_npv=sim_npv,
        sim_pv_costs=sim_pv_costs,
        sim_pv_benefits=sim_pv_benefits,
        cum_yearly=cum_yearly,
        valid_bcr_mask=valid_bcr_mask,
        bcr_values=bcr_values,
    )
    return result, arrays


def run_monte_carlo(
    initiative: dict[str, Any],
    items: list[dict[str, Any]],
    catalog_map: dict[str, CatalogEntry],
    req: SimulationRequest,
    *,
    run_id: str | None = None,
    bca_id: str | None = None,
    bca_name: str | None = None,
) -> SimulationResult:
    """Run deterministic baseline plus vectorized NumPy Monte Carlo simulation."""
    result, _ = _execute_monte_carlo(
        initiative,
        items,
        catalog_map,
        req,
        run_id=run_id,
        bca_id=bca_id,
        bca_name=bca_name,
    )
    return result


def _build_aligned_npv_distribution(
    arr_a: np.ndarray,
    arr_b: np.ndarray,
    bins: int = 32,
) -> list[AlignedHistogramBin]:
    n_a = len(arr_a)
    n_b = len(arr_b)
    if n_a == 0 or n_b == 0:
        return []

    min_v = float(min(np.min(arr_a), np.min(arr_b)))
    max_v = float(max(np.max(arr_a), np.max(arr_b)))
    if math.isclose(min_v, max_v, rel_tol=1e-12, abs_tol=1e-9):
        pad = max(1.0, abs(min_v) * 0.05)
        return [
            AlignedHistogramBin(
                bin_start=_safe_float(min_v - pad),
                bin_end=_safe_float(max_v + pad),
                bin_mid=_safe_float(min_v),
                count_a=n_a,
                density_a=1.0,
                cdf_a=1.0,
                count_b=n_b,
                density_b=1.0,
                cdf_b=1.0,
            )
        ]

    edges = np.linspace(min_v, max_v, bins + 1, dtype=np.float64)
    counts_a, _ = np.histogram(arr_a, bins=edges)
    counts_b, _ = np.histogram(arr_b, bins=edges)
    cum_a = np.cumsum(counts_a) / float(n_a)
    cum_b = np.cumsum(counts_b) / float(n_b)

    out: list[AlignedHistogramBin] = []
    for idx in range(bins):
        b_start = float(edges[idx])
        b_end = float(edges[idx + 1])
        c_a = int(counts_a[idx])
        c_b = int(counts_b[idx])
        out.append(
            AlignedHistogramBin(
                bin_start=_safe_float(b_start),
                bin_end=_safe_float(b_end),
                bin_mid=_safe_float(0.5 * (b_start + b_end)),
                count_a=c_a,
                density_a=_safe_float(c_a / float(n_a)),
                cdf_a=_safe_float(float(cum_a[idx])),
                count_b=c_b,
                density_b=_safe_float(c_b / float(n_b)),
                cdf_b=_safe_float(float(cum_b[idx])),
            )
        )
    return out


def run_monte_carlo_comparison(
    bca_a_ctx: dict[str, Any],
    items_a: list[dict[str, Any]],
    bca_b_ctx: dict[str, Any],
    items_b: list[dict[str, Any]],
    catalog_map: dict[str, CatalogEntry],
    req: BCACompareRequest,
    *,
    comparison_id: str | None = None,
    run_a_id: str | None = None,
    run_b_id: str | None = None,
) -> tuple[BCAComparisonResult, SimulationResult, SimulationResult]:
    """Run vectorized Monte Carlo on two BCAs and compute head-to-head comparison metrics."""
    t0 = time.perf_counter()

    seed_a = req.seed
    seed_b = ((req.seed + 10_007) % 2_147_483_647) if req.seed is not None else None

    req_a = SimulationRequest(
        bca_id=req.bca_a_id,
        n_simulations=req.n_simulations,
        seed=seed_a,
        discount_rate_override=req.discount_rate_override,
        horizon_years_override=req.horizon_years_override,
        uncertainty_scale=req.uncertainty_scale,
        benefit_scale=req.benefit_scale,
        cost_scale=req.cost_scale,
        persist=req.persist,
    )
    req_b = SimulationRequest(
        bca_id=req.bca_b_id,
        n_simulations=req.n_simulations,
        seed=seed_b,
        discount_rate_override=req.discount_rate_override,
        horizon_years_override=req.horizon_years_override,
        uncertainty_scale=req.uncertainty_scale,
        benefit_scale=req.benefit_scale,
        cost_scale=req.cost_scale,
        persist=req.persist,
    )

    result_a, arr_a = _execute_monte_carlo(
        bca_a_ctx,
        items_a,
        catalog_map,
        req_a,
        run_id=run_a_id,
        bca_id=req.bca_a_id,
        bca_name=bca_a_ctx.get("bca_name"),
    )
    result_b, arr_b = _execute_monte_carlo(
        bca_b_ctx,
        items_b,
        catalog_map,
        req_b,
        run_id=run_b_id,
        bca_id=req.bca_b_id,
        bca_name=bca_b_ctx.get("bca_name"),
    )

    delta_npv = arr_b.sim_npv - arr_a.sim_npv
    prob_b_beats_a_npv = _safe_float(float(np.mean(delta_npv > 0.0)))
    prob_a_beats_b_npv = _safe_float(float(np.mean(delta_npv < 0.0)))

    bcr_comparable_mask = arr_a.valid_bcr_mask & arr_b.valid_bcr_mask
    if np.any(bcr_comparable_mask):
        prob_b_beats_a_bcr: float | None = _safe_float(
            float(np.mean(arr_b.bcr_values[bcr_comparable_mask] > arr_a.bcr_values[bcr_comparable_mask]))
        )
    else:
        prob_b_beats_a_bcr = None

    delta_npv_stats = _compute_distribution_stats(delta_npv)
    delta_npv_histogram = _build_histogram(delta_npv, bins=30)
    delta_pv_costs_mean = _safe_float(float(np.mean(arr_b.sim_pv_costs - arr_a.sim_pv_costs)))
    delta_pv_benefits_mean = _safe_float(float(np.mean(arr_b.sim_pv_benefits - arr_a.sim_pv_benefits)))
    aligned_dist = _build_aligned_npv_distribution(arr_a.sim_npv, arr_b.sim_npv, bins=32)

    horizon_a = arr_a.cum_yearly.shape[1]
    horizon_b = arr_b.cum_yearly.shape[1]
    max_horizon = max(horizon_a, horizon_b)
    bands_a = {b.year: b for b in result_a.monte_carlo.yearly_cumulative_npv_bands}
    bands_b = {b.year: b for b in result_b.monte_carlo.yearly_cumulative_npv_bands}

    yearly_comparison: list[YearlyComparisonRow] = []
    for yr in range(1, max_horizon + 1):
        ba = bands_a.get(yr)
        bb = bands_b.get(yr)
        d_p10: float | None = None
        d_p50: float | None = None
        d_p90: float | None = None
        if yr <= horizon_a and yr <= horizon_b:
            diff_yr = arr_b.cum_yearly[:, yr - 1] - arr_a.cum_yearly[:, yr - 1]
            dp = np.percentile(diff_yr, [10, 50, 90])
            d_p10 = _safe_float(float(dp[0]))
            d_p50 = _safe_float(float(dp[1]))
            d_p90 = _safe_float(float(dp[2]))
        yearly_comparison.append(
            YearlyComparisonRow(
                year=yr,
                a_p10=ba.p10 if ba else None,
                a_p50=ba.p50 if ba else None,
                a_p90=ba.p90 if ba else None,
                b_p10=bb.p10 if bb else None,
                b_p50=bb.p50 if bb else None,
                b_p90=bb.p90 if bb else None,
                delta_p10=d_p10,
                delta_p50=d_p50,
                delta_p90=d_p90,
            )
        )

    vs_a = {v.value_stream: v for v in result_a.monte_carlo.value_streams}
    vs_b = {v.value_stream: v for v in result_b.monte_carlo.value_streams}
    all_streams = sorted(set(vs_a.keys()) | set(vs_b.keys()))
    vs_comparison: list[ValueStreamComparisonRow] = []
    for name in all_streams:
        va = vs_a.get(name)
        vb = vs_b.get(name)
        a_costs = va.pv_costs if va else 0.0
        a_ben = va.pv_benefits if va else 0.0
        a_npv = va.npv if va else 0.0
        a_p50 = va.sim_npv_p50 if va else 0.0
        b_costs = vb.pv_costs if vb else 0.0
        b_ben = vb.pv_benefits if vb else 0.0
        b_npv = vb.npv if vb else 0.0
        b_p50 = vb.sim_npv_p50 if vb else 0.0
        delta_p50_val = (
            _safe_float(float(b_p50 - a_p50))
            if (a_p50 is not None and b_p50 is not None)
            else None
        )
        vs_comparison.append(
            ValueStreamComparisonRow(
                value_stream=name,
                a_pv_costs=a_costs,
                a_pv_benefits=a_ben,
                a_npv=a_npv,
                a_sim_npv_p50=a_p50,
                b_pv_costs=b_costs,
                b_pv_benefits=b_ben,
                b_npv=b_npv,
                b_sim_npv_p50=b_p50,
                delta_npv=_safe_float(b_npv - a_npv),
                delta_sim_npv_p50=delta_p50_val,
            )
        )

    duration_ms = round((time.perf_counter() - t0) * 1000.0, 2)
    now_iso = datetime.now(timezone.utc).isoformat()

    paired = BCAComparisonPairedMetrics(
        prob_b_beats_a_npv=prob_b_beats_a_npv,
        prob_a_beats_b_npv=prob_a_beats_b_npv,
        prob_b_beats_a_bcr=prob_b_beats_a_bcr,
        delta_npv_stats=delta_npv_stats,
        delta_npv_histogram=delta_npv_histogram,
        delta_pv_costs_mean=delta_pv_costs_mean,
        delta_pv_benefits_mean=delta_pv_benefits_mean,
        aligned_npv_distribution=aligned_dist,
        yearly_comparison=yearly_comparison,
        value_stream_comparison=vs_comparison,
    )

    comparison = BCAComparisonResult(
        comparison_id=comparison_id,
        initiative_id=bca_a_ctx["id"],
        bca_a_id=req.bca_a_id,
        bca_a_name=str(bca_a_ctx.get("bca_name") or "BCA A"),
        bca_b_id=req.bca_b_id,
        bca_b_name=str(bca_b_ctx.get("bca_name") or "BCA B"),
        created_at=now_iso,
        n_simulations=int(req.n_simulations),
        seed=req.seed,
        duration_ms=duration_ms,
        result_a=result_a,
        result_b=result_b,
        paired=paired,
    )
    return comparison, result_a, result_b
