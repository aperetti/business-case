"""Strict Pydantic v2 request and response schemas for the BCA platform."""

from __future__ import annotations

import math
from typing import Any, Literal
from urllib.parse import urlparse

from pydantic import BaseModel, Field, field_validator, model_validator

from app.core.catalog import is_valid_formula_type

RampProfile = Literal["immediate", "linear", "s_curve", "custom_weights"]
CatalogKind = Literal["cost", "benefit"]
DistributionKind = Literal["fixed", "normal", "triangular", "lognormal", "pert"]


def _check_finite(value: float, field_name: str) -> float:
    if not math.isfinite(value):
        raise ValueError(f"{field_name} must be a finite number.")
    return float(value)


def _validate_optional_http_url(raw: str, field_label: str = "URL") -> str:
    cleaned = raw.strip()
    if not cleaned:
        return ""
    parsed = urlparse(cleaned)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError(f"{field_label} must start with http:// or https:// and include a valid host.")
    return cleaned


class CatalogParameter(BaseModel):
    """Parameter definition inside a reusable cost or benefit catalog template."""

    key: str = Field(..., pattern=r"^[a-z][a-z0-9_]*$", min_length=1, max_length=64)
    label: str = Field(..., min_length=1, max_length=120)
    unit: str = Field(default="", max_length=40)
    default_value: float
    min_value: float | None = 0.0
    max_value: float | None = None
    required: bool = True

    @model_validator(mode="after")
    def validate_bounds(self) -> "CatalogParameter":
        _check_finite(self.default_value, "default_value")
        if self.min_value is not None:
            _check_finite(self.min_value, "min_value")
        if self.max_value is not None:
            _check_finite(self.max_value, "max_value")
        if self.min_value is not None and self.max_value is not None and self.min_value > self.max_value:
            raise ValueError(f"Parameter '{self.key}': min_value cannot exceed max_value.")
        if self.min_value is not None and self.default_value < self.min_value:
            raise ValueError(f"Parameter '{self.key}': default_value must be >= min_value.")
        if self.max_value is not None and self.default_value > self.max_value:
            raise ValueError(f"Parameter '{self.key}': default_value must be <= max_value.")
        return self


class CatalogEntryCreate(BaseModel):
    """Payload to create a custom catalog template."""

    id: str = Field(..., pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$")
    kind: CatalogKind
    name: str = Field(..., min_length=1, max_length=160)
    description: str = Field(default="", max_length=1000)
    domains: list[str] = Field(default_factory=list)
    value_stream_stage: str | None = Field(default=None, max_length=80)
    parameters: list[CatalogParameter] = Field(..., min_length=1)
    formula_type: str = Field(..., min_length=1, max_length=500)
    guardrail_notes: str = Field(default="", max_length=1500)

    @field_validator("domains")
    @classmethod
    def clean_domains(cls, v: list[str]) -> list[str]:
        cleaned = [item.strip().lower() for item in v if item and item.strip()]
        return list(dict.fromkeys(cleaned))

    @model_validator(mode="after")
    def validate_catalog_entry(self) -> "CatalogEntryCreate":
        keys = [p.key for p in self.parameters]
        if len(keys) != len(set(keys)):
            raise ValueError("Catalog parameter keys must be unique.")
        ok, err = is_valid_formula_type(self.formula_type, set(keys))
        if not ok:
            raise ValueError(err or "Invalid formula_type.")
        return self


class CatalogEntryUpdate(BaseModel):
    """Partial update of a catalog template. The ID cannot change."""

    kind: CatalogKind | None = None
    name: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=1000)
    domains: list[str] | None = None
    value_stream_stage: str | None = Field(default=None, max_length=80)
    parameters: list[CatalogParameter] | None = Field(default=None, min_length=1)
    formula_type: str | None = Field(default=None, min_length=1, max_length=500)
    guardrail_notes: str | None = Field(default=None, max_length=1500)


class CatalogDocAlternative(BaseModel):
    """'When to use another template' entry, optionally linking to another docs page."""

    text: str = Field(..., max_length=1000)
    link_slug: str | None = Field(default=None, max_length=64)
    link_label: str | None = Field(default=None, max_length=120)


class CatalogDocParameterGuidance(BaseModel):
    guidance: str = Field(default="", max_length=1500)
    typical_range: str = Field(default="", max_length=300)
    data_source: str = Field(default="", max_length=500)


class CatalogDocModelingTips(BaseModel):
    schedule: str = Field(default="", max_length=1500)
    ramp: str = Field(default="", max_length=1500)
    uncertainty: str = Field(default="", max_length=1500)
    correlation: str = Field(default="", max_length=1500)


class CatalogDocContent(BaseModel):
    """Editable documentation page for a catalog template."""

    headline: str = Field(default="", max_length=400)
    what_it_measures: str = Field(default="", max_length=5000)
    economic_rationale: str = Field(default="", max_length=5000)
    when_to_use: list[str] = Field(default_factory=list, max_length=30)
    when_not_to_use: list[CatalogDocAlternative] = Field(default_factory=list, max_length=30)
    formula_plain_english: str = Field(default="", max_length=3000)
    parameter_guidance: dict[str, CatalogDocParameterGuidance] = Field(default_factory=dict)
    modeling_tips: CatalogDocModelingTips = Field(default_factory=CatalogDocModelingTips)
    guardrail_notes: list[str] = Field(default_factory=list, max_length=30)

    @field_validator("when_to_use", "guardrail_notes")
    @classmethod
    def clean_lines(cls, v: list[str]) -> list[str]:
        cleaned = [line.strip() for line in v if line and line.strip()]
        if any(len(line) > 1500 for line in cleaned):
            raise ValueError("Each list item must be 1500 characters or fewer.")
        return cleaned

    @field_validator("when_not_to_use")
    @classmethod
    def clean_alternatives(cls, v: list[CatalogDocAlternative]) -> list[CatalogDocAlternative]:
        return [a for a in v if a.text.strip()]

    @field_validator("parameter_guidance")
    @classmethod
    def limit_guidance(cls, v: dict[str, CatalogDocParameterGuidance]) -> dict[str, CatalogDocParameterGuidance]:
        if len(v) > 50:
            raise ValueError("Too many parameter guidance entries.")
        return v


class CatalogDocUpdate(CatalogDocContent):
    """Saving a doc page requires at least a headline and 'What it measures'."""

    @model_validator(mode="after")
    def require_core_fields(self) -> "CatalogDocUpdate":
        if not self.headline.strip():
            raise ValueError("Headline is required.")
        if not self.what_it_measures.strip():
            raise ValueError("'What it measures' is required.")
        return self


class CatalogDocOut(BaseModel):
    """Stored doc page. ``is_template`` means it was auto-created and still needs to be filled out."""

    content: CatalogDocContent
    is_template: bool
    updated_at: str
    updated_by: str = ""


class CatalogEntry(CatalogEntryCreate):
    """Stored catalog template returned by the API."""

    formula_description: str = ""
    is_builtin: bool = False
    created_at: str
    doc: CatalogDocOut | None = None


class DistributionSpec(BaseModel):
    """Uncertainty specification for either an item multiplier or a specific parameter."""

    distribution: DistributionKind = "fixed"
    std_pct: float | None = Field(default=None, ge=0.0, le=5.0)
    std: float | None = Field(default=None, ge=0.0)
    low: float | None = None
    mode: float | None = None
    high: float | None = None
    low_pct: float | None = Field(default=None, ge=-1.0, le=0.0)
    high_pct: float | None = Field(default=None, ge=0.0, le=5.0)
    correlation_group: str | None = Field(default=None, max_length=64)
    correlation_rho: float = Field(default=0.7, ge=-0.99, le=0.99)

    @model_validator(mode="after")
    def validate_distribution_bounds(self) -> "DistributionSpec":
        for name in ("std_pct", "std", "low", "mode", "high", "low_pct", "high_pct", "correlation_rho"):
            val = getattr(self, name)
            if val is not None:
                _check_finite(val, name)
        if self.low is not None and self.high is not None and self.low > self.high:
            raise ValueError("Distribution 'low' cannot exceed 'high'.")
        if self.low is not None and self.mode is not None and self.low > self.mode:
            raise ValueError("Distribution 'low' cannot exceed 'mode'.")
        if self.mode is not None and self.high is not None and self.mode > self.high:
            raise ValueError("Distribution 'mode' cannot exceed 'high'.")
        if self.correlation_group is not None:
            cleaned = self.correlation_group.strip()
            self.correlation_group = cleaned or None
        return self


class UncertaintySpec(BaseModel):
    """Per-item and per-parameter stochastic uncertainty configuration."""

    item_multiplier: DistributionSpec | None = None
    parameters: dict[str, DistributionSpec] = Field(default_factory=dict)
    correlation_group: str | None = Field(default=None, max_length=64)
    correlation_rho: float = Field(default=0.7, ge=-0.99, le=0.99)

    @model_validator(mode="after")
    def normalize_group(self) -> "UncertaintySpec":
        _check_finite(self.correlation_rho, "correlation_rho")
        if self.correlation_group is not None:
            cleaned = self.correlation_group.strip()
            self.correlation_group = cleaned or None
        return self


class InitiativeCreate(BaseModel):
    """Payload to create a new initiative."""

    name: str = Field(..., min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    domain: str = Field(default="software", min_length=1, max_length=80)
    horizon_years: int = Field(default=7, ge=1, le=30)
    discount_rate: float = Field(default=0.06, ge=0.0, le=0.5)
    cost_start_year: int | None = Field(default=None, ge=2000, le=2100)
    external_resource_url: str = Field(default="", max_length=1000)

    @field_validator("domain")
    @classmethod
    def clean_domain(cls, v: str) -> str:
        return v.strip().lower()

    @field_validator("discount_rate")
    @classmethod
    def validate_discount_rate(cls, v: float) -> float:
        return _check_finite(v, "discount_rate")

    @field_validator("external_resource_url")
    @classmethod
    def validate_external_resource_url(cls, v: str) -> str:
        return _validate_optional_http_url(v, "External resource URL")


class InitiativeUpdate(BaseModel):
    """Partial update payload for an initiative."""

    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    domain: str | None = Field(default=None, min_length=1, max_length=80)
    horizon_years: int | None = Field(default=None, ge=1, le=30)
    discount_rate: float | None = Field(default=None, ge=0.0, le=0.5)
    cost_start_year: int | None = Field(default=None, ge=2000, le=2100)
    external_resource_url: str | None = Field(default=None, max_length=1000)

    @field_validator("domain")
    @classmethod
    def clean_domain(cls, v: str | None) -> str | None:
        return v.strip().lower() if v is not None else None

    @field_validator("discount_rate")
    @classmethod
    def validate_discount_rate(cls, v: float | None) -> float | None:
        return _check_finite(v, "discount_rate") if v is not None else None

    @field_validator("external_resource_url")
    @classmethod
    def validate_external_resource_url(cls, v: str | None) -> str | None:
        return _validate_optional_http_url(v, "External resource URL") if v is not None else None


class InitiativeItemCreate(BaseModel):
    """Payload to add a catalog-backed line item to an initiative (or specific BCA)."""

    bca_id: str | None = Field(default=None, max_length=64)
    catalog_id: str = Field(..., min_length=1, max_length=64)
    label: str = Field(..., min_length=1, max_length=200)
    value_stream: str = Field(..., min_length=1, max_length=120)
    start_year: int = Field(..., ge=1, le=30)
    end_year: int = Field(..., ge=1, le=30)
    ramp_profile: RampProfile = "immediate"
    ramp_weights: list[float] | None = None
    param_values: dict[str, float] = Field(default_factory=dict)
    uncertainty_spec: UncertaintySpec = Field(default_factory=UncertaintySpec)
    anti_double_count_tag: str | None = Field(default=None, max_length=80)

    @model_validator(mode="after")
    def validate_item(self) -> "InitiativeItemCreate":
        if self.start_year > self.end_year:
            raise ValueError("start_year cannot be greater than end_year.")
        for key, val in self.param_values.items():
            _check_finite(val, f"param_values.{key}")
        if self.ramp_profile == "custom_weights":
            expected_len = self.end_year - self.start_year + 1
            if not self.ramp_weights or len(self.ramp_weights) != expected_len:
                raise ValueError(
                    f"custom_weights requires exactly {expected_len} weight(s) matching years {self.start_year}..{self.end_year}."
                )
            for idx, w in enumerate(self.ramp_weights):
                _check_finite(w, f"ramp_weights[{idx}]")
                if w < 0.0:
                    raise ValueError("ramp_weights values must be non-negative.")
        elif self.ramp_weights is not None:
            for idx, w in enumerate(self.ramp_weights):
                _check_finite(w, f"ramp_weights[{idx}]")
                if w < 0.0:
                    raise ValueError("ramp_weights values must be non-negative.")
        if self.anti_double_count_tag is not None:
            cleaned = self.anti_double_count_tag.strip()
            self.anti_double_count_tag = cleaned or None
        return self


class InitiativeItemUpdate(BaseModel):
    """Partial update payload for an existing initiative line item."""

    catalog_id: str | None = Field(default=None, min_length=1, max_length=64)
    label: str | None = Field(default=None, min_length=1, max_length=200)
    value_stream: str | None = Field(default=None, min_length=1, max_length=120)
    start_year: int | None = Field(default=None, ge=1, le=30)
    end_year: int | None = Field(default=None, ge=1, le=30)
    ramp_profile: RampProfile | None = None
    ramp_weights: list[float] | None = None
    param_values: dict[str, float] | None = None
    uncertainty_spec: UncertaintySpec | None = None
    anti_double_count_tag: str | None = Field(default=None, max_length=80)

    @model_validator(mode="after")
    def validate_partial(self) -> "InitiativeItemUpdate":
        if self.param_values is not None:
            for key, val in self.param_values.items():
                _check_finite(val, f"param_values.{key}")
        if self.ramp_weights is not None:
            for idx, w in enumerate(self.ramp_weights):
                _check_finite(w, f"ramp_weights[{idx}]")
                if w < 0.0:
                    raise ValueError("ramp_weights values must be non-negative.")
        if self.anti_double_count_tag is not None:
            cleaned = self.anti_double_count_tag.strip()
            self.anti_double_count_tag = cleaned or None
        return self


class InitiativeItemOut(BaseModel):
    """Line item enriched with catalog metadata and deterministic valuation."""

    id: str
    initiative_id: str
    bca_id: str | None = None
    catalog_id: str
    kind: CatalogKind
    catalog_name: str
    formula_type: str
    guardrail_notes: str
    label: str
    value_stream: str
    start_year: int
    end_year: int
    ramp_profile: RampProfile
    ramp_weights: list[float] | None = None
    param_values: dict[str, float]
    uncertainty_spec: UncertaintySpec
    anti_double_count_tag: str | None = None
    base_annual_value: float = 0.0
    pv_total: float = 0.0
    created_at: str
    updated_at: str


class YearlyCashFlow(BaseModel):
    """Year-by-year deterministic cash flow and discounting summary."""

    year: int
    undiscounted_cost: float
    undiscounted_benefit: float
    net_undiscounted: float
    pv_cost: float
    pv_benefit: float
    net_pv: float
    cumulative_undiscounted_net: float
    cumulative_net_pv: float


class ValueStreamBreakdown(BaseModel):
    """Cost/benefit totals grouped by value_stream."""

    value_stream: str
    pv_costs: float
    pv_benefits: float
    npv: float
    bcr: float | None = None
    item_count: int
    sim_npv_p10: float | None = None
    sim_npv_p50: float | None = None
    sim_npv_p90: float | None = None
    sim_pv_costs_mean: float | None = None
    sim_pv_benefits_mean: float | None = None


class GuardrailWarning(BaseModel):
    """Warning surfaced when multiple benefit items share an anti-double-count tag."""

    tag: str
    message: str
    item_ids: list[str]
    item_labels: list[str]


class DeterministicMetrics(BaseModel):
    """Complete deterministic financial results for an initiative."""

    pv_costs: float
    pv_benefits: float
    npv: float
    bcr: float | None = None
    discounted_payback_year: float | None = None
    yearly_cash_flows: list[YearlyCashFlow]
    value_streams: list[ValueStreamBreakdown]
    guardrail_warnings: list[GuardrailWarning] = Field(default_factory=list)


class BCACreate(BaseModel):
    """Payload to create or clone a Business Case Analysis (BCA) under an initiative."""

    name: str = Field(..., min_length=1, max_length=160)
    description: str = Field(default="", max_length=2000)
    horizon_years: int | None = Field(default=None, ge=1, le=30)
    discount_rate: float | None = Field(default=None, ge=0.0, le=0.5)
    cost_start_year: int | None = Field(default=None, ge=2000, le=2100)
    clone_from_bca_id: str | None = Field(default=None, max_length=64)

    @field_validator("discount_rate")
    @classmethod
    def validate_discount_rate(cls, v: float | None) -> float | None:
        return _check_finite(v, "discount_rate") if v is not None else None


class BCAUpdate(BaseModel):
    """Partial update payload for an initiative BCA."""

    name: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=2000)
    horizon_years: int | None = Field(default=None, ge=1, le=30)
    discount_rate: float | None = Field(default=None, ge=0.0, le=0.5)
    cost_start_year: int | None = Field(default=None, ge=2000, le=2100)
    is_baseline: bool | None = None

    @field_validator("discount_rate")
    @classmethod
    def validate_discount_rate(cls, v: float | None) -> float | None:
        return _check_finite(v, "discount_rate") if v is not None else None


class BCASummary(BaseModel):
    """BCA scenario summary with deterministic KPIs and latest Monte Carlo snapshot."""

    id: str
    initiative_id: str
    name: str
    description: str
    horizon_years: int
    discount_rate: float
    cost_start_year: int | None = None
    is_baseline: bool
    sort_order: int = 0
    item_count: int
    pv_costs: float
    pv_benefits: float
    npv: float
    bcr: float | None = None
    discounted_payback_year: float | None = None
    guardrail_warning_count: int = 0
    latest_run_id: str | None = None
    latest_run_created_at: str | None = None
    latest_prob_npv_positive: float | None = None
    latest_prob_bcr_ge_one: float | None = None
    latest_npv_p10: float | None = None
    latest_npv_p50: float | None = None
    latest_npv_p90: float | None = None
    latest_bcr_p50: float | None = None
    created_at: str
    updated_at: str


class BCADetail(BaseModel):
    """Full BCA scenario including line items, deterministic breakdown, and latest MC run."""

    id: str
    initiative_id: str
    name: str
    description: str
    horizon_years: int
    discount_rate: float
    cost_start_year: int | None = None
    is_baseline: bool
    sort_order: int = 0
    created_at: str
    updated_at: str
    items: list[InitiativeItemOut]
    deterministic: DeterministicMetrics
    latest_simulation: "SimulationResult | None" = None


class InitiativeSummary(BaseModel):
    """Initiative list record with live deterministic KPIs and BCA summaries."""

    id: str
    name: str
    description: str
    domain: str
    horizon_years: int
    discount_rate: float
    cost_start_year: int | None = None
    external_resource_url: str = ""
    item_count: int
    pv_costs: float
    pv_benefits: float
    npv: float
    bcr: float | None = None
    bca_count: int = 1
    baseline_bca_id: str | None = None
    bcas: list[BCASummary] = Field(default_factory=list)
    status: "InitiativeStatus" = "draft"
    created_at: str
    updated_at: str


class InitiativeDetail(BaseModel):
    """Full initiative record including active BCA items, deterministic breakdown, and BCA list."""

    id: str
    name: str
    description: str
    domain: str
    horizon_years: int
    discount_rate: float
    cost_start_year: int | None = None
    external_resource_url: str = ""
    status: "InitiativeStatus" = "draft"
    created_at: str
    updated_at: str
    active_bca_id: str | None = None
    active_bca: BCASummary | None = None
    bcas: list[BCASummary] = Field(default_factory=list)
    items: list[InitiativeItemOut]
    deterministic: DeterministicMetrics


class SimulationRequest(BaseModel):
    """Parameters controlling a Monte Carlo simulation run."""

    bca_id: str | None = Field(default=None, max_length=64)
    n_simulations: int = Field(default=10_000, ge=100, le=50_000)
    seed: int | None = Field(default=None, ge=0, le=2_147_483_647)
    discount_rate_override: float | None = Field(default=None, ge=0.0, le=0.5)
    horizon_years_override: int | None = Field(default=None, ge=1, le=30)
    uncertainty_scale: float = Field(default=1.0, ge=0.0, le=3.0)
    benefit_scale: float = Field(default=1.0, ge=0.0, le=3.0)
    cost_scale: float = Field(default=1.0, ge=0.0, le=3.0)
    persist: bool = True

    @model_validator(mode="after")
    def check_finite_scales(self) -> "SimulationRequest":
        for name in ("discount_rate_override", "uncertainty_scale", "benefit_scale", "cost_scale"):
            val = getattr(self, name)
            if val is not None:
                _check_finite(val, name)
        return self


class DistributionStats(BaseModel):
    """Summary percentiles and moments of a simulated metric."""

    mean: float
    std: float
    min: float
    max: float
    p5: float
    p10: float
    p25: float
    p50: float
    p75: float
    p90: float
    p95: float


class HistogramBin(BaseModel):
    """Histogram bucket with density and cumulative probability for plotting."""

    bin_start: float
    bin_end: float
    bin_mid: float
    count: int
    density: float
    cumulative_prob: float


class YearlyPercentileBand(BaseModel):
    """Cumulative discounted net cash flow fan-chart band for a single year."""

    year: int
    p10: float
    p25: float
    p50: float
    p75: float
    p90: float
    mean: float


class SensitivityDriver(BaseModel):
    """Rank-correlation sensitivity driver ranking uncertainty contributors."""

    item_id: str
    item_label: str
    parameter_key: str
    driver_label: str
    kind: CatalogKind
    spearman_corr: float
    variance_share_pct: float


class MonteCarloSummary(BaseModel):
    """Stochastic simulation results."""

    n_simulations: int
    seed: int | None = None
    prob_npv_positive: float
    prob_bcr_ge_one: float
    npv_stats: DistributionStats
    bcr_stats: DistributionStats | None = None
    npv_histogram: list[HistogramBin]
    yearly_cumulative_npv_bands: list[YearlyPercentileBand]
    sensitivity_drivers: list[SensitivityDriver]
    value_streams: list[ValueStreamBreakdown]


class SimulationResult(BaseModel):
    """Combined deterministic baseline and Monte Carlo simulation response."""

    run_id: str | None = None
    initiative_id: str
    bca_id: str | None = None
    bca_name: str | None = None
    created_at: str
    n_simulations: int
    discount_rate: float
    horizon_years: int
    seed: int | None = None
    uncertainty_scale: float
    benefit_scale: float
    cost_scale: float
    duration_ms: float
    deterministic: DeterministicMetrics
    monte_carlo: MonteCarloSummary


class SimulationRunRecord(BaseModel):
    """Persisted simulation run loaded from SQLite."""

    id: str
    initiative_id: str
    bca_id: str | None = None
    bca_name: str | None = None
    n_simulations: int
    discount_rate: float
    horizon_years: int
    seed: int | None = None
    created_at: str
    summary: SimulationResult


class BCACompareRequest(BaseModel):
    """Parameters controlling a paired Monte Carlo comparison between two BCAs."""

    bca_a_id: str = Field(..., min_length=1, max_length=64)
    bca_b_id: str = Field(..., min_length=1, max_length=64)
    n_simulations: int = Field(default=10_000, ge=100, le=50_000)
    seed: int | None = Field(default=None, ge=0, le=2_147_483_647)
    discount_rate_override: float | None = Field(default=None, ge=0.0, le=0.5)
    horizon_years_override: int | None = Field(default=None, ge=1, le=30)
    uncertainty_scale: float = Field(default=1.0, ge=0.0, le=3.0)
    benefit_scale: float = Field(default=1.0, ge=0.0, le=3.0)
    cost_scale: float = Field(default=1.0, ge=0.0, le=3.0)
    persist: bool = True

    @model_validator(mode="after")
    def validate_compare(self) -> "BCACompareRequest":
        if self.bca_a_id == self.bca_b_id:
            raise ValueError("bca_a_id and bca_b_id must reference two distinct BCAs.")
        for name in ("discount_rate_override", "uncertainty_scale", "benefit_scale", "cost_scale"):
            val = getattr(self, name)
            if val is not None:
                _check_finite(val, name)
        return self


class AlignedHistogramBin(BaseModel):
    """Shared-range histogram bin comparing BCA A and BCA B NPV distributions."""

    bin_start: float
    bin_end: float
    bin_mid: float
    count_a: int
    density_a: float
    cdf_a: float
    count_b: int
    density_b: float
    cdf_b: float


class YearlyComparisonRow(BaseModel):
    """Year-by-year cumulative discounted NPV comparison between BCA A and BCA B."""

    year: int
    a_p10: float | None = None
    a_p50: float | None = None
    a_p90: float | None = None
    b_p10: float | None = None
    b_p50: float | None = None
    b_p90: float | None = None
    delta_p10: float | None = None
    delta_p50: float | None = None
    delta_p90: float | None = None


class ValueStreamComparisonRow(BaseModel):
    """Value-stream cost, benefit, and simulated P50 NPV comparison row."""

    value_stream: str
    a_pv_costs: float
    a_pv_benefits: float
    a_npv: float
    a_sim_npv_p50: float | None = None
    b_pv_costs: float
    b_pv_benefits: float
    b_npv: float
    b_sim_npv_p50: float | None = None
    delta_npv: float
    delta_sim_npv_p50: float | None = None


class BCAComparisonPairedMetrics(BaseModel):
    """Head-to-head stochastic metrics between BCA A and BCA B (B relative to A)."""

    prob_b_beats_a_npv: float
    prob_a_beats_b_npv: float
    prob_b_beats_a_bcr: float | None = None
    delta_npv_stats: DistributionStats
    delta_npv_histogram: list[HistogramBin]
    delta_pv_costs_mean: float
    delta_pv_benefits_mean: float
    aligned_npv_distribution: list[AlignedHistogramBin]
    yearly_comparison: list[YearlyComparisonRow]
    value_stream_comparison: list[ValueStreamComparisonRow]


class BCAComparisonResult(BaseModel):
    """Complete side-by-side Monte Carlo comparison result for two BCAs."""

    comparison_id: str | None = None
    initiative_id: str
    bca_a_id: str
    bca_a_name: str
    bca_b_id: str
    bca_b_name: str
    created_at: str
    n_simulations: int
    seed: int | None = None
    duration_ms: float
    result_a: SimulationResult
    result_b: SimulationResult
    paired: BCAComparisonPairedMetrics


class BCAComparisonRecord(BaseModel):
    """Persisted BCA comparison record loaded from SQLite."""

    id: str
    initiative_id: str
    bca_a_id: str
    bca_b_id: str
    n_simulations: int
    seed: int | None = None
    created_at: str
    summary: BCAComparisonResult


class HealthResponse(BaseModel):
    """Health check payload."""

    status: str
    database: str
    catalog_count: int


def _validate_http_base_url(raw: str | None) -> str | None:
    if raw is None:
        return None
    cleaned = raw.strip().rstrip("/")
    if not cleaned:
        return ""
    parsed = urlparse(cleaned)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("Endpoint base URL must start with http:// or https:// and include a valid host.")
    return cleaned


class LLMSettingsUpdate(BaseModel):
    """Admin payload to configure the OpenAI-compatible upstream LLM provider."""

    base_url: str = Field(default="", max_length=500)
    api_key: str | None = Field(default=None, max_length=2000)
    clear_api_key: bool = False
    model: str = Field(default="", max_length=200)
    temperature: float = Field(default=0.2, ge=0.0, le=2.0)
    max_tokens: int = Field(default=1024, ge=64, le=16384)
    timeout_seconds: int = Field(default=45, ge=5, le=180)
    system_prompt: str = Field(default="", max_length=4000)

    @field_validator("base_url")
    @classmethod
    def check_base_url(cls, v: str) -> str:
        validated = _validate_http_base_url(v)
        return validated if validated is not None else ""

    @field_validator("temperature")
    @classmethod
    def check_temperature(cls, v: float) -> float:
        return _check_finite(v, "temperature")

    @field_validator("model")
    @classmethod
    def clean_model(cls, v: str) -> str:
        return v.strip()


class LLMSettingsOut(BaseModel):
    """Masked LLM provider settings returned to the frontend."""

    base_url: str
    model: str
    temperature: float
    max_tokens: int
    timeout_seconds: int
    system_prompt: str
    api_key_set: bool
    api_key_masked: str
    configured: bool
    verified: bool = False
    verified_at: str | None = None
    updated_at: str | None = None


class DocsAgentStatusOut(BaseModel):
    """Client-safe Docs Agent availability status (omits secrets and upstream URL)."""

    configured: bool
    verified: bool
    available: bool
    model: str = ""


class LLMTestRequest(BaseModel):
    """Test upstream OpenAI-compatible connectivity using candidate or stored settings."""

    base_url: str | None = Field(default=None, max_length=500)
    api_key: str | None = Field(default=None, max_length=2000)
    clear_api_key: bool = False
    model: str | None = Field(default=None, max_length=200)
    timeout_seconds: int | None = Field(default=None, ge=5, le=180)

    @field_validator("base_url")
    @classmethod
    def check_base_url(cls, v: str | None) -> str | None:
        return _validate_http_base_url(v)


class LLMTestResponse(BaseModel):
    """Outcome of a live test chat completion request against the upstream provider."""

    ok: bool
    latency_ms: float
    model: str = ""
    reply_preview: str = ""
    error: str | None = None


class LLMModelsFetchRequest(BaseModel):
    """Request to query /models from an OpenAI-compatible endpoint."""

    base_url: str | None = Field(default=None, max_length=500)
    api_key: str | None = Field(default=None, max_length=2000)
    clear_api_key: bool = False
    timeout_seconds: int | None = Field(default=20, ge=5, le=180)

    @field_validator("base_url")
    @classmethod
    def check_base_url(cls, v: str | None) -> str | None:
        return _validate_http_base_url(v)


class LLMModelsFetchResponse(BaseModel):
    """Model IDs discovered from upstream /models."""

    models: list[str] = Field(default_factory=list)
    error: str | None = None


class ApiKeyCreate(BaseModel):
    """Payload to issue a new inbound API key for /v1/* consumers."""

    name: str = Field(..., min_length=1, max_length=100)


class ApiKeyOut(BaseModel):
    """Stored inbound API key metadata (hash never exposed)."""

    id: str
    name: str
    key_prefix: str
    key_last4: str
    created_at: str
    last_used_at: str | None = None
    managed_by_env: bool = False


class ApiKeyCreatedOut(ApiKeyOut):
    """Newly generated API key returned once upon creation."""

    secret_key: str


class KBStatusOut(BaseModel):
    """Summary of Docs Agent knowledge base & provider readiness."""

    guide_count: int
    builtin_catalog_count: int
    custom_catalog_count: int
    initiative_count: int
    configured: bool
    active_model: str
    inbound_key_count: int


class DocCitation(BaseModel):
    """Documentation page cited during a Docs Agent response."""

    slug: str
    title: str
    kind: Literal["guide", "cost", "benefit"]


class ChatMessage(BaseModel):
    """OpenAI-compatible chat message object."""

    role: Literal["system", "user", "assistant"]
    content: str

    @field_validator("content", mode="before")
    @classmethod
    def normalize_content(cls, v: Any) -> str:
        if isinstance(v, str):
            return v
        if isinstance(v, list):
            parts: list[str] = []
            for part in v:
                if isinstance(part, str):
                    parts.append(part)
                elif isinstance(part, dict) and part.get("type") == "text":
                    parts.append(str(part.get("text", "")))
            return "\n".join(p for p in parts if p)
        if v is None:
            return ""
        return str(v)


class OpenAIChatCompletionRequest(BaseModel):
    """OpenAI-compatible POST /v1/chat/completions payload with optional Docs context."""

    model: str = Field(default="bca-docs-agent", min_length=1, max_length=200)
    messages: list[ChatMessage] = Field(..., min_length=1)
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=None, ge=16, le=16384)
    stream: bool = False
    doc_slug: str | None = Field(default=None, max_length=100)
    initiative_id: str | None = Field(default=None, max_length=80)
    include_initiative_context: bool = False


class OpenAIChatChoiceMessage(BaseModel):
    """Assistant message inside a chat completion choice."""

    role: Literal["assistant"] = "assistant"
    content: str


class OpenAIChatChoice(BaseModel):
    """Single completion choice."""

    index: int = 0
    message: OpenAIChatChoiceMessage
    finish_reason: str = "stop"


class OpenAIUsage(BaseModel):
    """Token usage summary."""

    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class OpenAIChatCompletionResponse(BaseModel):
    """OpenAI-compatible non-streaming chat completion response plus optional doc citations."""

    id: str
    object: Literal["chat.completion"] = "chat.completion"
    created: int
    model: str
    choices: list[OpenAIChatChoice]
    usage: OpenAIUsage = Field(default_factory=OpenAIUsage)
    citations: list[DocCitation] = Field(default_factory=list)


class OpenAIModelObject(BaseModel):
    """OpenAI-compatible model metadata record."""

    id: str
    object: Literal["model"] = "model"
    created: int = 0
    owned_by: str = "valuestream-bca"


class OpenAIModelListResponse(BaseModel):
    """OpenAI-compatible GET /v1/models response."""

    object: Literal["list"] = "list"
    data: list[OpenAIModelObject]


SSOProvider = Literal["firebase", "entra"]
FirebaseSignInMethod = Literal["google", "microsoft", "email_password", "saml", "oidc"]


def _validate_https_host(raw: str) -> str:
    cleaned = raw.strip().rstrip("/")
    if not cleaned:
        return "https://login.microsoftonline.com"
    parsed = urlparse(cleaned)
    if parsed.scheme != "https" or not parsed.netloc:
        raise ValueError("Entra authority host must start with https:// and include a valid host.")
    return cleaned


def _validate_optional_http_uri(raw: str) -> str:
    return _validate_optional_http_url(raw, "Redirect URI")


class SSOSettingsUpdate(BaseModel):
    """Admin payload to configure Single Sign-On (defaulting to Firebase, with Entra option)."""

    enabled: bool = False
    provider: SSOProvider = "firebase"
    enforce_sso: bool = False
    allowed_domains: list[str] = Field(default_factory=list)
    admin_emails: list[str] = Field(default_factory=list)

    firebase_project_id: str = Field(default="", max_length=160)
    firebase_auth_domain: str = Field(default="", max_length=255)
    firebase_api_key: str = Field(default="", max_length=255)
    firebase_app_id: str = Field(default="", max_length=255)
    firebase_tenant_id: str = Field(default="", max_length=160)
    firebase_sign_in_methods: list[FirebaseSignInMethod] = Field(default_factory=lambda: ["google"])

    entra_tenant_id: str = Field(default="", max_length=160)
    entra_client_id: str = Field(default="", max_length=160)
    entra_client_secret: str | None = Field(default=None, max_length=1000)
    clear_entra_client_secret: bool = False
    entra_authority_host: str = Field(default="https://login.microsoftonline.com", max_length=255)
    entra_redirect_uri: str = Field(default="", max_length=500)
    entra_scopes: str = Field(default="openid profile email", max_length=500)

    @field_validator("allowed_domains")
    @classmethod
    def clean_allowed_domains(cls, v: list[str]) -> list[str]:
        cleaned = [item.strip().lower().lstrip("@") for item in v if item and item.strip().lstrip("@")]
        return list(dict.fromkeys(cleaned))

    @field_validator("admin_emails")
    @classmethod
    def clean_admin_emails(cls, v: list[str]) -> list[str]:
        cleaned = [item.strip().lower() for item in v if item and item.strip()]
        return list(dict.fromkeys(cleaned))

    @field_validator("firebase_sign_in_methods")
    @classmethod
    def clean_firebase_methods(cls, v: list[FirebaseSignInMethod]) -> list[FirebaseSignInMethod]:
        deduped = list(dict.fromkeys(v))
        return deduped or ["google"]

    @field_validator("entra_authority_host")
    @classmethod
    def check_authority_host(cls, v: str) -> str:
        return _validate_https_host(v)

    @field_validator("entra_redirect_uri")
    @classmethod
    def check_redirect_uri(cls, v: str) -> str:
        return _validate_optional_http_uri(v)

    @model_validator(mode="after")
    def validate_provider_requirements(self) -> "SSOSettingsUpdate":
        for attr in (
            "firebase_project_id",
            "firebase_auth_domain",
            "firebase_api_key",
            "firebase_app_id",
            "firebase_tenant_id",
            "entra_tenant_id",
            "entra_client_id",
            "entra_scopes",
        ):
            setattr(self, attr, getattr(self, attr).strip())

        if not self.entra_scopes:
            self.entra_scopes = "openid profile email"

        if self.enabled:
            if self.provider == "firebase":
                missing = [
                    name
                    for name, val in (
                        ("firebase_project_id", self.firebase_project_id),
                        ("firebase_auth_domain", self.firebase_auth_domain),
                        ("firebase_api_key", self.firebase_api_key),
                    )
                    if not val
                ]
                if missing:
                    raise ValueError(
                        f"Firebase SSO requires non-empty: {', '.join(missing)} when enabled."
                    )
            elif self.provider == "entra":
                missing = [
                    name
                    for name, val in (
                        ("entra_tenant_id", self.entra_tenant_id),
                        ("entra_client_id", self.entra_client_id),
                    )
                    if not val
                ]
                if missing:
                    raise ValueError(
                        f"Microsoft Entra ID SSO requires non-empty: {', '.join(missing)} when enabled."
                    )
        return self


class SSOSettingsOut(BaseModel):
    """Admin view of persisted SSO configuration with masked Entra client secret."""

    enabled: bool
    provider: SSOProvider
    enforce_sso: bool
    allowed_domains: list[str]
    admin_emails: list[str]

    firebase_project_id: str
    firebase_auth_domain: str
    firebase_api_key: str
    firebase_app_id: str
    firebase_tenant_id: str
    firebase_sign_in_methods: list[FirebaseSignInMethod]

    entra_tenant_id: str
    entra_client_id: str
    entra_client_secret_set: bool
    entra_client_secret_masked: str
    entra_authority_host: str
    entra_redirect_uri: str
    entra_scopes: str

    configured: bool
    oidc_discovery_url: str
    updated_at: str | None = None
    managed_by_env: bool = False
    env_vars: list[str] = Field(default_factory=list)


class SSOPublicConfigOut(BaseModel):
    """Safe public SSO metadata consumed by web sign-in flows (secrets & admin_emails omitted)."""

    enabled: bool
    provider: SSOProvider
    enforce_sso: bool
    configured: bool
    oidc_discovery_url: str

    firebase_project_id: str
    firebase_auth_domain: str
    firebase_api_key: str
    firebase_app_id: str
    firebase_tenant_id: str
    firebase_sign_in_methods: list[FirebaseSignInMethod]

    entra_tenant_id: str
    entra_client_id: str
    entra_authority_host: str
    entra_redirect_uri: str
    entra_scopes: str


class SSOTestRequest(BaseModel):
    """Candidate overrides for testing SSO OpenID Connect discovery metadata."""

    provider: SSOProvider | None = None
    firebase_project_id: str | None = Field(default=None, max_length=160)
    entra_tenant_id: str | None = Field(default=None, max_length=160)
    entra_client_id: str | None = Field(default=None, max_length=160)
    entra_authority_host: str | None = Field(default=None, max_length=255)
    timeout_seconds: int = Field(default=15, ge=5, le=60)

    @field_validator("entra_authority_host")
    @classmethod
    def check_authority_host(cls, v: str | None) -> str | None:
        return _validate_https_host(v) if v is not None else None


class SSOTestResponse(BaseModel):
    """Result of probing the provider OpenID Connect well-known discovery document."""

    ok: bool
    provider: SSOProvider
    latency_ms: float
    discovery_url: str = ""
    issuer: str = ""
    jwks_uri: str = ""
    authorization_endpoint: str = ""
    error: str | None = None


PermissionKey = Literal[
    "initiatives:read",
    "initiatives:write",
    "simulations:run",
    "catalog:manage",
    "docs:ask",
    "admin:users",
    "admin:roles",
    "admin:ai",
    "admin:sso",
    "admin:workflows",
]
UserStatus = Literal["active", "invited", "disabled"]
UserAuthProvider = Literal["local", "firebase", "entra"]


def _validate_clean_email(raw: str) -> str:
    cleaned = raw.strip().lower()
    if "@" not in cleaned or cleaned.startswith("@") or cleaned.endswith("@"):
        raise ValueError("Email must be a valid address containing '@'.")
    local, domain = cleaned.rsplit("@", 1)
    if not local or "." not in domain or domain.startswith(".") or domain.endswith("."):
        raise ValueError("Email domain must be valid (e.g., user@company.com).")
    return cleaned


class RoleCreate(BaseModel):
    """Payload to create a custom RBAC role."""

    name: str = Field(..., min_length=2, max_length=80)
    description: str = Field(default="", max_length=500)
    permissions: list[PermissionKey] = Field(..., min_length=1)

    @field_validator("name")
    @classmethod
    def clean_name(cls, v: str) -> str:
        cleaned = v.strip()
        if not cleaned:
            raise ValueError("Role name cannot be empty.")
        return cleaned

    @field_validator("permissions")
    @classmethod
    def dedupe_permissions(cls, v: list[PermissionKey]) -> list[PermissionKey]:
        return list(dict.fromkeys(v))


class RoleUpdate(BaseModel):
    """Partial update payload for a role."""

    name: str | None = Field(default=None, min_length=2, max_length=80)
    description: str | None = Field(default=None, max_length=500)
    permissions: list[PermissionKey] | None = Field(default=None, min_length=1)

    @field_validator("name")
    @classmethod
    def clean_name(cls, v: str | None) -> str | None:
        if v is None:
            return None
        cleaned = v.strip()
        if not cleaned:
            raise ValueError("Role name cannot be empty.")
        return cleaned

    @field_validator("permissions")
    @classmethod
    def dedupe_permissions(cls, v: list[PermissionKey] | None) -> list[PermissionKey] | None:
        return list(dict.fromkeys(v)) if v is not None else None


class RoleOut(BaseModel):
    """Persisted RBAC role with live member count."""

    id: str
    name: str
    description: str
    permissions: list[PermissionKey]
    is_system: bool
    user_count: int = 0
    created_at: str
    updated_at: str


class UserCreate(BaseModel):
    """Payload to invite or create an application user."""

    email: str = Field(..., min_length=3, max_length=200)
    display_name: str = Field(..., min_length=1, max_length=120)
    role_id: str = Field(..., min_length=1, max_length=64)
    status: UserStatus = "active"
    auth_provider: UserAuthProvider = "firebase"

    @field_validator("email")
    @classmethod
    def check_email(cls, v: str) -> str:
        return _validate_clean_email(v)

    @field_validator("display_name")
    @classmethod
    def clean_display_name(cls, v: str) -> str:
        cleaned = v.strip()
        if not cleaned:
            raise ValueError("Display name cannot be empty.")
        return cleaned


class UserUpdate(BaseModel):
    """Partial update payload for a managed user."""

    email: str | None = Field(default=None, min_length=3, max_length=200)
    display_name: str | None = Field(default=None, min_length=1, max_length=120)
    role_id: str | None = Field(default=None, min_length=1, max_length=64)
    status: UserStatus | None = None
    auth_provider: UserAuthProvider | None = None

    @field_validator("email")
    @classmethod
    def check_email(cls, v: str | None) -> str | None:
        return _validate_clean_email(v) if v is not None else None

    @field_validator("display_name")
    @classmethod
    def clean_display_name(cls, v: str | None) -> str | None:
        if v is None:
            return None
        cleaned = v.strip()
        if not cleaned:
            raise ValueError("Display name cannot be empty.")
        return cleaned


class UserOut(BaseModel):
    """Managed user record enriched with role display name."""

    id: str
    email: str
    display_name: str
    role_id: str
    role_name: str
    status: UserStatus
    auth_provider: UserAuthProvider
    last_login_at: str | None = None
    created_at: str
    updated_at: str


class AuthUserOut(BaseModel):
    """Authenticated user session profile with resolved RBAC permissions."""

    id: str
    email: str
    display_name: str
    role_id: str
    role_name: str
    permissions: list[str]
    is_admin: bool
    photo_url: str = ""
    auth_provider: UserAuthProvider


class AuthMeOut(BaseModel):
    """Session introspection response returned by GET /api/auth/me."""

    authenticated: bool
    auth_required: bool
    sso_enabled: bool
    provider: SSOProvider
    user: AuthUserOut | None = None


class ODataEntitySetSummary(BaseModel):
    """Metadata and live row count for an exposed OData v4 entity set."""

    name: str
    entity_type: str
    key_property: str
    description: str
    row_count: int
    navigation_properties: list[str] = Field(default_factory=list)


class ODataStatusOut(BaseModel):
    """Status summary for the built-in OData v4 BI integration endpoints."""

    service_root_path: str
    alias_path: str
    metadata_path: str
    odata_version: str
    auth_mode: Literal["open", "api_key_required"]
    inbound_key_count: int
    entity_sets: list[ODataEntitySetSummary]


BCADetail.model_rebuild()


# --- Approval workflows -------------------------------------------------------

InitiativeStatus = Literal["draft", "in_review", "approved", "rejected"]
ApprovalRequestStatus = Literal["pending", "approved", "rejected", "withdrawn"]
ApprovalActionKind = Literal["submit", "approve", "reject", "withdraw", "reopen"]
SmtpSecurity = Literal["starttls", "ssl", "none"]


def _clean_email_list(values: list[str]) -> list[str]:
    cleaned: list[str] = []
    for raw in values:
        if not str(raw).strip():
            continue
        email = _validate_clean_email(str(raw))
        if email not in cleaned:
            cleaned.append(email)
    return cleaned


class WorkflowStep(BaseModel):
    """One sequential approval stage. Any listed role member or email may approve."""

    id: str = Field(default="", max_length=64)
    name: str = Field(..., min_length=1, max_length=120)
    approver_role_ids: list[str] = Field(default_factory=list, max_length=20)
    approver_emails: list[str] = Field(default_factory=list, max_length=50)
    required_approvals: int = Field(default=1, ge=1, le=20)
    notify_approvers: bool = True

    @field_validator("name")
    @classmethod
    def clean_name(cls, v: str) -> str:
        cleaned = v.strip()
        if not cleaned:
            raise ValueError("Step name cannot be empty.")
        return cleaned

    @field_validator("approver_role_ids")
    @classmethod
    def dedupe_roles(cls, v: list[str]) -> list[str]:
        return list(dict.fromkeys(r.strip() for r in v if r.strip()))

    @field_validator("approver_emails")
    @classmethod
    def clean_emails(cls, v: list[str]) -> list[str]:
        return _clean_email_list(v)

    @model_validator(mode="after")
    def require_approvers(self) -> "WorkflowStep":
        if not self.approver_role_ids and not self.approver_emails:
            raise ValueError(f"Step '{self.name}' needs at least one approver role or email.")
        return self


class WorkflowCreate(BaseModel):
    """Payload to define an approval workflow."""

    name: str = Field(..., min_length=2, max_length=120)
    description: str = Field(default="", max_length=1000)
    is_active: bool = True
    is_default: bool = False
    notify_submitter: bool = True
    steps: list[WorkflowStep] = Field(..., min_length=1, max_length=20)

    @field_validator("name")
    @classmethod
    def clean_name(cls, v: str) -> str:
        cleaned = v.strip()
        if len(cleaned) < 2:
            raise ValueError("Workflow name must be at least 2 characters.")
        return cleaned


class WorkflowUpdate(BaseModel):
    """Partial update payload for an approval workflow."""

    name: str | None = Field(default=None, min_length=2, max_length=120)
    description: str | None = Field(default=None, max_length=1000)
    is_active: bool | None = None
    is_default: bool | None = None
    notify_submitter: bool | None = None
    steps: list[WorkflowStep] | None = Field(default=None, min_length=1, max_length=20)

    @field_validator("name")
    @classmethod
    def clean_name(cls, v: str | None) -> str | None:
        if v is None:
            return None
        cleaned = v.strip()
        if len(cleaned) < 2:
            raise ValueError("Workflow name must be at least 2 characters.")
        return cleaned


class WorkflowOut(BaseModel):
    """Persisted approval workflow definition."""

    id: str
    name: str
    description: str
    is_active: bool
    is_default: bool
    notify_submitter: bool
    steps: list[WorkflowStep]
    in_use_count: int = 0
    created_at: str
    updated_at: str


class WorkflowSummaryOut(BaseModel):
    """Minimal active workflow listing for submitters."""

    id: str
    name: str
    description: str
    is_default: bool
    step_names: list[str]


class ApprovalSubmitRequest(BaseModel):
    """Submit an initiative into an approval workflow."""

    workflow_id: str | None = Field(default=None, max_length=64)
    comment: str = Field(default="", max_length=2000)


class ApprovalDecisionRequest(BaseModel):
    """Approve or reject the current step of a pending approval request."""

    decision: Literal["approve", "reject"]
    comment: str = Field(default="", max_length=2000)

    @model_validator(mode="after")
    def require_reject_reason(self) -> "ApprovalDecisionRequest":
        if self.decision == "reject" and not self.comment.strip():
            raise ValueError("A comment is required when rejecting.")
        return self


class ApprovalCommentRequest(BaseModel):
    """Optional comment for withdraw / reopen actions."""

    comment: str = Field(default="", max_length=2000)


class ApprovalActionOut(BaseModel):
    """Audit-trail entry for an approval request."""

    id: str
    action: ApprovalActionKind
    step_index: int | None = None
    step_name: str | None = None
    actor_email: str
    actor_name: str
    comment: str
    created_at: str


class ApprovalStepProgress(BaseModel):
    """Progress of one workflow step within a request."""

    index: int
    name: str
    required_approvals: int
    approvals: int
    state: Literal["pending", "active", "approved", "rejected", "skipped"]
    approvers: list[str]


class ApprovalRequestOut(BaseModel):
    """Approval request with step progress, history, and the caller's allowed actions."""

    id: str
    initiative_id: str
    workflow_id: str | None
    workflow_name: str
    status: ApprovalRequestStatus
    current_step_index: int | None
    submitted_by_email: str
    submitted_by_name: str
    submitted_at: str
    completed_at: str | None = None
    steps: list[ApprovalStepProgress]
    actions: list[ApprovalActionOut]


class InitiativeApprovalOut(BaseModel):
    """Approval state for an initiative, including what the current caller may do."""

    initiative_id: str
    status: InitiativeStatus
    current_request: ApprovalRequestOut | None = None
    history: list[ApprovalActionOut] = Field(default_factory=list)
    can_submit: bool = False
    can_decide: bool = False
    can_withdraw: bool = False
    can_reopen: bool = False
    decide_blocked_reason: str | None = None


class PendingApprovalOut(BaseModel):
    """An approval step awaiting action by the current caller."""

    request_id: str
    initiative_id: str
    initiative_name: str
    workflow_name: str
    step_name: str
    submitted_by_name: str
    submitted_at: str


class EmailSettingsOut(BaseModel):
    """SMTP notification settings (password masked)."""

    enabled: bool
    host: str
    port: int
    security: SmtpSecurity
    username: str
    password_set: bool
    password_masked: str
    from_address: str
    from_name: str
    app_base_url: str
    configured: bool
    updated_at: str | None = None


class EmailSettingsUpdate(BaseModel):
    """Update SMTP settings. Omit password to keep the stored one; send "" to clear it."""

    enabled: bool = False
    host: str = Field(default="", max_length=255)
    port: int = Field(default=587, ge=1, le=65535)
    security: SmtpSecurity = "starttls"
    username: str = Field(default="", max_length=255)
    password: str | None = Field(default=None, max_length=500)
    from_address: str = Field(default="", max_length=200)
    from_name: str = Field(default="ValueStream BCA", max_length=120)
    app_base_url: str = Field(default="", max_length=500)

    @field_validator("host", "username", "from_name")
    @classmethod
    def strip_text(cls, v: str) -> str:
        return v.strip()

    @field_validator("from_address")
    @classmethod
    def check_from(cls, v: str) -> str:
        return _validate_clean_email(v) if v.strip() else ""

    @field_validator("app_base_url")
    @classmethod
    def check_base_url(cls, v: str) -> str:
        return _validate_optional_http_url(v, "App base URL").rstrip("/")


class EmailTestRequest(BaseModel):
    """Send a test notification to one address."""

    to: str = Field(..., min_length=3, max_length=200)

    @field_validator("to")
    @classmethod
    def check_to(cls, v: str) -> str:
        return _validate_clean_email(v)


class EmailTestResponse(BaseModel):
    ok: bool
    message: str


class EmailLogOut(BaseModel):
    """Outbound notification log entry."""

    id: str
    recipients: list[str]
    subject: str
    status: Literal["sent", "failed", "skipped"]
    error: str
    initiative_id: str | None = None
    created_at: str
