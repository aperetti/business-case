"""Structured ValueStream BCA documentation knowledge base & retrieval builder."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from app.db.repository import get_initiative_detail, list_catalog
from app.models import CatalogEntry, DocCitation


@dataclass(frozen=True)
class GuideKBEntry:
    slug: str
    title: str
    keywords: tuple[str, ...]
    content: str


GUIDE_KB_ENTRIES: list[GuideKBEntry] = [
    GuideKBEntry(
        slug="overview",
        title="ValueStream BCA Documentation & Workflow",
        keywords=("overview", "workflow", "catalog", "initiative", "structure", "value stream", "steps"),
        content=(
            "Initiatives decompose into standardized Cost and Benefit line items instantiated from the Catalog. "
            "Recommended 5-step workflow: "
            "(1) Set initiative horizon (5-10 years) and discount rate (typically 6%-10% real WACC). "
            "(2) Model all 4 cost phases: COST-BUILD-01 (build), COST-ENAB-01 (enablement/training), "
            "COST-RUN-01 (ongoing hosting/licensing/SRE), and COST-LIFE-01 (periodic refresh/decommission). "
            "(3) Ground benefits in observable operational baselines (tickets, PagerDuty logs, finance rates). "
            "(4) Apply start_year/end_year, realization ramps, and anti_double_count_tag to overlapping benefits. "
            "(5) Run 10,000-trial Monte Carlo with PERT/Triangular/Lognormal distributions and correlation groups."
        ),
    ),
    GuideKBEntry(
        slug="methodology",
        title="Discounting, NPV, BCR & Payback",
        keywords=("npv", "bcr", "pv", "discount", "payback", "present value", "formula", "irr", "ratio"),
        content=(
            "End-of-year discounting is applied across years t = 1..horizon_years: "
            "undiscounted(t) = base_annual_value * ramp_multiplier(t); "
            "discount_factor(t) = 1 / (1 + discount_rate) ** t; "
            "pv(t) = undiscounted(t) * discount_factor(t). "
            "PV of Costs and PV of Benefits sum discounted cash flows over 1..H. "
            "NPV = PV_Benefits - PV_Costs. BCR = PV_Benefits / PV_Costs. "
            "Discounted payback walks backwards to locate the last negative cumulative_net_pv year so temporary "
            "late refresh spikes do not cause false early payback, then linearly interpolates fractional breakeven."
        ),
    ),
    GuideKBEntry(
        slug="ramps",
        title="Realization Ramps & Timing",
        keywords=("ramp", "s_curve", "s-curve", "linear", "immediate", "custom_weights", "timing", "start_year", "end_year"),
        content=(
            "Outside [start_year, end_year], cash flows are $0. Inside active span [start_year..end_year]: "
            "- immediate: 1.00 each active year (SaaS licenses, cloud run, fixed recurring cost). "
            "- linear: k / span scaling steadily (gradual unit rollout or linear defect drop; 5-yr span = 0.20, 0.40, 0.60, 0.80, 1.00). "
            "- s_curve: logistic sigmoid raw = 1/(1+exp(-6*(x-0.5))) normalized by raw[-1] so final year = 1.00 (5-yr span = 0.05, 0.19, 0.52, 0.86, 1.00). "
            "- custom_weights: exact array matching (end_year - start_year + 1); auto-normalized by max(weights) only if max > 1.0."
        ),
    ),
    GuideKBEntry(
        slug="uncertainty",
        title="Monte Carlo, Correlation & Guardrails",
        keywords=(
            "monte carlo",
            "pert",
            "triangular",
            "lognormal",
            "normal",
            "fixed",
            "correlation",
            "rho",
            "copula",
            "spearman",
            "sensitivity",
            "guardrail",
            "double count",
            "anti_double_count_tag",
            "stress",
            "what-if",
            "what if",
            "iterations",
            "seed",
            "discount_rate_override",
            "uncertainty_scale",
            "benefit_scale",
            "cost_scale",
            "sliders",
        ),
        content=(
            "Stochastic engine supports 100-50,000 runs (10,000 default): "
            "fixed (point estimate), normal (symmetric bell around base via std/std_pct), "
            "lognormal (positive right-skewed tail for incidents or build overruns), "
            "triangular (low/mode/high), and pert (smooth beta 1+4*(mode-low)/span). "
            "Sampled values are clamped to catalog [min_value, max_value]. "
            "Gaussian copula links items/parameters sharing a correlation_group via "
            "z_corr = sign(rho)*sqrt(|rho|)*z_group + sqrt(1-|rho|)*eps. "
            "Spearman rank correlation ranks the top 10 Sensitivity Drivers and variance_share_pct. "
            "Sharing an anti_double_count_tag across >=2 benefit items triggers an explicit guardrail warning banner. "
            "What-If Inputs & Stress Testing (non-destructive per-run overrides): "
            "(1) Simulation Iterations (1,000-50,000 in UI, default 10,000): sets Monte Carlo trial count N, tightening P5/P10/P90/P95 tail stability; "
            "(2) Random Seed (0-2,147,483,647 or blank, default 42): fixes NumPy RNG draws so deltas reflect only What-If shocks; "
            "(3) What-If Discount Rate (0%-50%, defaults to initiative rate): overrides r in 1/(1+r)^t for both baseline comparison and trials, hitting late benefits harder than Y1 costs; "
            "(4) Uncertainty Spread Scale (0.00x-2.50x UI / 3.00x API, default 1.00x): scales sigma or stretches Triangular/PERT bounds around mode while enforcing catalog [min_value, max_value], with 0.00x collapsing to deterministic; "
            "(5) What-If Benefit Scale (0.50x-1.50x UI / 0.00x-3.00x API, default 1.00x): multiplies all benefit annual cash flows; "
            "(6) What-If Cost Scale (0.70x-1.50x UI / 0.00x-3.00x API, default 1.00x): multiplies all cost annual cash flows. "
            "Combined Downside Stress Test example: Benefit Scale=0.80x, Cost Scale=1.25x, Uncertainty Spread=1.50x with fixed Seed=42."
        ),
    ),
    GuideKBEntry(
        slug="odata",
        title="OData v4 Analytics & BI Feed",
        keywords=(
            "odata",
            "power bi",
            "powerbi",
            "excel",
            "tableau",
            "power query",
            "extract",
            "export",
            "metadata",
            "filter",
            "expand",
            "select",
            "orderby",
            "bi",
            "feed",
            "api key",
            "basic auth",
        ),
        content=(
            "Read-only OASIS OData v4.0 feed at /odata/v4 (alias /odata, CSDL schema at /odata/v4/$metadata) for Power BI Desktop, Excel OData.Feed, and REST ETL. "
            "Six relational Entity Sets: "
            "(1) Initiatives (Id, Name, Domain, HorizonYears, DiscountRate, CostStartYear, CostEndYear, ExternalResourceUrl, ItemCount, PvCosts, PvBenefits, Npv, Bcr, DiscountedPaybackYear, GuardrailWarningCount, LatestSimProbNpvPositive, LatestSimNpvP50); "
            "(2) CostBenefitItems (Id, InitiativeId, InitiativeName, CatalogId, Kind cost/benefit, Label, ValueStream, StartYear, EndYear, CalendarStartYear, CalendarEndYear, RampProfile, BaseAnnualValue, PvTotal, SignedPvTotal, AntiDoubleCountTag, ParametersJson, UncertaintyJson); "
            "(3) YearlyCashFlows (annual undiscounted & discounted PV cash flows and cumulative net PV per initiative year); "
            "(4) ValueStreams (PV costs, PV benefits, NPV, BCR per initiative value stream); "
            "(5) CatalogEntries (templates, formulas, guardrails); "
            "(6) SimulationRuns (persisted Monte Carlo statistics). "
            "Supports $filter (eq, ne, gt, ge, lt, le, and, or, not, contains, startswith, endswith, tolower), $select, $orderby, $top, $skip, $count, /$count, navigation paths (Initiatives('id')/CostBenefitItems), and $expand (with sub-options). "
            "Authentication: Open on local/LAN when 0 inbound API keys exist; when 1+ keys are created in Admin Portal -> Gateway & API Keys, accepts Authorization: Bearer <key>, HTTP Basic (paste API key into Username or Password for Power BI/Excel), or X-API-Key."
        ),
    ),
]


CATALOG_KB_DETAILS: dict[str, str] = {
    "COST-BUILD-01": (
        "Purpose: Non-recurring internal engineering hours + external vendor implementation fee. "
        "Formula: hours * hourly_rate + vendor_cost. "
        "When to use: Greenfield engineering, CI/CD, API orchestration, cloud migrations. Avoid ongoing SRE (COST-RUN-01) or training (COST-ENAB-01). "
        "Params: hours (typically 400-4000 hrs/yr), hourly_rate ($115-$185/hr loaded cost), vendor_cost ($0-$250k/yr). "
        "Recommended setup: Y1 or Y1-Y2 with custom_weights (e.g. [1.0, 0.35] or [0.6, 1.0]); PERT (-15%/+40%) or Lognormal on hours; "
        "group under delivery_effort (rho ~0.70). "
        "Worked examples: (1) Core CI/CD Build: hours=1400, hourly_rate=145, vendor_cost=45000 ($248,000 base), Y1-Y2 [1.0, 0.35] @7% -> $308,000 PV; "
        "(2) Two-Wave Cloud Migration: hours=2400, hourly_rate=155, vendor_cost=110000 ($482,000 base), Y1-Y2 [0.6, 1.0] @8% -> $681,071 PV."
    ),
    "COST-RUN-01": (
        "Purpose: Recurring annual cloud/on-prem hosting, SaaS licensing, and Tier-2/3 support labor. "
        "Formula: annual_infra_cost + annual_license_cost + support_hours_per_year * hourly_rate. "
        "When to use: Post-launch compute, observability ingest, bot subscriptions, SRE patching (~0.1-0.4 FTE). "
        "Recommended setup: Y1-H or Y2-H with immediate ramp; Normal (15-25% std) on infra and PERT on support hours. "
        "Guardrail: Reflect steady-state ops only, not Year 1 build sprints. "
        "Worked examples: (1) Observability & SRE stack: infra=28000, license=18000, support=320h @135 ($89,200/yr), Y1-Y5 immediate @7% -> $365,738 PV; "
        "(2) RPA Orchestration Run Rate: infra=14000, license=22000, support=180h @125 ($58,500/yr), Y2-Y5 immediate @6% -> $191,179 PV."
    ),
    "COST-ENAB-01": (
        "Purpose: Staff workshop/training opportunity cost and organizational change management outlays. "
        "Formula: training_hours * affected_staff * hourly_rate + transition_cost. "
        "When to use: Cross-org rollouts affecting 20-300 staff, documentation portals, floor support. "
        "Guardrail: Pair with COST-ENAB-01 whenever benefit items assume high adoption_rate (>0.75). "
        "Recommended setup: Y1 or Y1-Y2 wave weights; item_multiplier Triangular (0.80, 1.0, 1.30). "
        "Worked examples: (1) Dev Onboarding: 10h * 60 staff * $95 + $18k = $75,000 in Y1 @7% -> $70,093 PV; "
        "(2) Finance Cutover (Y1-Y2 [0.7, 0.3]): 8h * 120 * $75 + $20k ($92k base) @6% -> $87,472 PV."
    ),
    "COST-LIFE-01": (
        "Purpose: Amortized hardware refresh cycles, major LTS upgrades, tech-debt remediation, or decommissioning spikes. "
        "Formula: refresh_cost / max(refresh_interval_years, 1). "
        "Guardrail: Either amortize continuously (e.g. $120k / 4 yrs = $30k/yr across Y3-Y10) OR set refresh_interval_years=1 on a single spike year (start=end=Y4). Never combine interval=4 with a single year! "
        "Worked examples: (1) Edge Hardware Reserve: refresh_cost=120000, interval=4 ($30,000/yr), Y3-Y10 @8% -> $147,820 PV; "
        "(2) Year-4 Upgrade Spike: refresh_cost=95000, interval=1, Y4-Y4 @7% -> $72,475 PV."
    ),
    "BEN-TOIL-01": (
        "Purpose: Recovered labor capacity from automating repetitive manual workflows, tempered by adoption & realization. "
        "Formula: events_per_year * (minutes_saved_per_event / 60) * hourly_rate * adoption_rate * realization_factor. "
        "Guardrails: Keep realization_factor < 1.0 (0.60-0.85) because fragmented minutes do not convert 100% into cashable hiring reductions. "
        "Share anti_double_count_tag (e.g. eng-capacity or ops-staff-hours) if also claiming BEN-FLOW-01 on the same team. Count active touch time only, not idle queue wait. "
        "Recommended setup: Y2-H S-curve or linear; PERT on adoption_rate and realization_factor linked in 'adoption' correlation group. "
        "Worked examples: (1) CI/CD Runbook Toil: 12000 events * 22m * $120 * 0.85 * 0.78 ($350,064/yr base), Y2-Y5 s_curve @7% -> $550,450 PV; "
        "(2) AP Invoice Triage: 18000 * 10m * $68 * 0.82 * 0.75 ($125,460/yr base), Y1-Y5 s_curve @6% -> $276,770 PV."
    ),
    "BEN-FLOW-01": (
        "Purpose: Economic value of faster throughput, shorter cycle times, commercial Cost of Delay, or working-capital acceleration. "
        "Formula: accelerated_items_per_year * value_per_item * adoption_rate. "
        "Guardrails: value_per_item MUST reflect net incremental contribution margin or delay cost, never top-line gross revenue or internal labor hours already counted in BEN-TOIL-01. "
        "Worked examples: (1) Order-to-Cash Acceleration: 360 orders * $580 * 0.80 ($167,040/yr), Y2-Y5 linear @6% -> $349,179 PV; "
        "(2) Accelerated Releases: 48 releases * $4500 * 0.75 ($162,000/yr), Y2-Y5 s_curve @7% -> $254,715 PV."
    ),
    "BEN-QUAL-01": (
        "Purpose: Expected annual cost avoided by preventing outages, production defects, SLA credits, or rework. "
        "Formula: baseline_events_per_year * risk_reduction_pct * cost_per_event. "
        "Guardrails: Anchor baseline_events_per_year to trailing 12-month PagerDuty/Jira logs; keep regulatory fines separated in BEN-COMP-01. "
        "Recommended setup: Linear ramp; PERT on risk_reduction_pct + Lognormal (30-40% std) on cost_per_event. "
        "Worked examples: (1) Sev-2 Incident Avoidance: 64 * 0.50 * $8500 ($272,000/yr), Y2-Y5 linear @7% -> $510,599 PV; "
        "(2) Major Outage Avoidance: 18 * 0.55 * $32000 ($316,800/yr), Y2-Y7 linear @8% -> $793,572 PV."
    ),
    "BEN-CAP-01": (
        "Purpose: Avoided duplicate scaffolding/setup cost across downstream roadmap initiatives reusing a shared platform capability. "
        "Formula: downstream_initiatives * avoided_setup_cost * reuse_probability. "
        "Guardrails: Only claim committed PMO roadmap initiatives and weight realistically by reuse_probability [0..1]; keep avoided_setup_cost below standalone build cost. "
        "Recommended setup: Delayed start (Y2/Y3+) + s_curve ramp; Triangular on reuse_probability. "
        "Worked examples: (1) IDP Golden Paths: 4 * $70000 * 0.75 ($210,000/yr), Y3-Y7 s_curve @7% -> $391,720 PV; "
        "(2) Cloud Landing Zone Reuse: 3 * $85000 * 0.70 ($178,500/yr), Y2-Y6 s_curve @8% -> $337,168 PV."
    ),
    "BEN-COMP-01": (
        "Purpose: Direct compliance/audit prep labor savings plus expected annualized regulatory or contract penalty avoidance. "
        "Formula: audit_hours_saved * hourly_rate + avoided_penalty_expected. "
        "Guardrails: Enter expected probability-weighted annual penalty (Prob * Fine), not worst-case statutory maximum; do not overlap with BEN-QUAL-01 outage SLA credits. "
        "Worked examples: (1) Automated Billing Audit Trail: 240h * $110 + $45000 ($71,400/yr), Y2-Y5 immediate @6% -> $233,330 PV; "
        "(2) Policy-as-Code Cloud Controls: 450h * $135 + $55000 ($115,750/yr), Y2-Y7 immediate @8% -> $494,358 PV."
    ),
}


def _tokenize(text: str) -> set[str]:
    return {tok for tok in re.findall(r"[a-z0-9_-]{2,}", text.lower()) if tok}


def _format_catalog_summary_entry(entry: CatalogEntry) -> str:
    params_str = ", ".join(
        f"{p.key} ({p.unit or 'ratio'}, default={p.default_value}, bounds=[{p.min_value}, {p.max_value}])"
        for p in entry.parameters
    )
    extra = CATALOG_KB_DETAILS.get(entry.id, "")
    return (
        f"### {entry.id}: {entry.name} [{entry.kind.upper()}]\n"
        f"- Description: {entry.description or 'N/A'}\n"
        f"- Formula ({entry.formula_type}): {entry.formula_description}\n"
        f"- Domains: {', '.join(entry.domains) or 'general'} | Stage: {entry.value_stream_stage or 'Core'}\n"
        f"- Parameters: {params_str}\n"
        f"- Guardrail: {entry.guardrail_notes or 'None specified'}\n"
        + (f"- Guidance & Worked Examples: {extra}\n" if extra else "")
    )


def _format_initiative_snapshot(db_path: Path, initiative_id: str) -> str:
    try:
        detail = get_initiative_detail(db_path, initiative_id)
    except Exception:
        return ""

    det = detail.deterministic
    bcr_str = f"{det.bcr:.2f}x" if det.bcr is not None else "N/A"
    payback_str = f"{det.discounted_payback_year:.1f} yrs" if det.discounted_payback_year is not None else "No payback"
    lines = [
        f"### Active Initiative Context: {detail.name}",
        (
            f"- Domain: {detail.domain} | Horizon: {detail.horizon_years} yrs | Discount Rate: {detail.discount_rate * 100:.1f}%"
            + (f" | Cost Start Year: {detail.cost_start_year}" if detail.cost_start_year is not None else "")
            + (f" | External Resource: {detail.external_resource_url}" if detail.external_resource_url else "")
        ),
        f"- Deterministic Summary: PV Costs=${det.pv_costs:,.0f} | PV Benefits=${det.pv_benefits:,.0f} | NPV=${det.npv:,.0f} | BCR={bcr_str} | Payback={payback_str}",
        f"- Line Items ({len(detail.items)}):",
    ]
    for it in detail.items[:15]:
        lines.append(
            f"  * {it.label} [{it.catalog_id}, {it.kind}] stream='{it.value_stream}' "
            f"Y{it.start_year}-Y{it.end_year} ramp={it.ramp_profile} "
            f"base=${it.base_annual_value:,.0f}/yr pv=${it.pv_total:,.0f}"
            + (f" tag={it.anti_double_count_tag}" if it.anti_double_count_tag else "")
        )
    if det.guardrail_warnings:
        lines.append("- Active Guardrail Warnings:")
        for w in det.guardrail_warnings:
            lines.append(f"  * [{w.tag}] {w.message}")
    if len(detail.bcas) > 1:
        lines.append(f"- Scenarios / BCAs ({len(detail.bcas)}):")
        for bca in detail.bcas:
            p50_str = f" | MC P50=${bca.latest_npv_p50:,.0f}" if bca.latest_npv_p50 is not None else ""
            tag = " [Baseline]" if bca.is_baseline else ""
            lines.append(
                f"  * {bca.name}{tag}: Det. NPV=${bca.npv:,.0f} | Horizon={bca.horizon_years} yrs | Disc={bca.discount_rate * 100:.1f}%{p50_str}"
            )
    return "\n".join(lines)


def build_agent_context(
    db_path: Path,
    user_query: str,
    *,
    doc_slug: str | None = None,
    initiative_id: str | None = None,
    include_initiative_context: bool = False,
    extra_system_prompt: str = "",
) -> tuple[str, list[DocCitation]]:
    """Retrieve matching guide & catalog documentation plus optional live initiative state."""
    catalog = list_catalog(db_path)
    q_tokens = _tokenize(user_query)
    q_lower = user_query.lower()

    # Compact catalog index is always supplied so the model never invents IDs or formulas
    index_lines = [
        f"- {e.id} ({e.kind}): {e.name} — `{e.formula_description}`"
        for e in catalog
    ]

    # Score guides
    scored_guides: list[tuple[int, GuideKBEntry]] = []
    for g in GUIDE_KB_ENTRIES:
        score = 0
        if doc_slug and doc_slug == g.slug:
            score += 20
        for kw in g.keywords:
            if kw in q_lower:
                score += 4
        score += len(q_tokens & _tokenize(f"{g.title} {g.content}"))
        scored_guides.append((score, g))
    scored_guides.sort(key=lambda pair: pair[0], reverse=True)

    # Score catalog entries
    scored_catalog: list[tuple[int, CatalogEntry]] = []
    for entry in catalog:
        score = 0
        if entry.id.lower() in q_lower:
            score += 30
        if doc_slug and doc_slug == entry.id:
            score += 25
        searchable = f"{entry.id} {entry.name} {entry.description} {' '.join(entry.domains)} {entry.guardrail_notes} {CATALOG_KB_DETAILS.get(entry.id, '')}"
        score += len(q_tokens & _tokenize(searchable))
        if entry.kind in q_tokens:
            score += 2
        scored_catalog.append((score, entry))
    scored_catalog.sort(key=lambda pair: pair[0], reverse=True)

    # Select top 2 guides (always include at least overview or methodology if scores are tied/zero)
    selected_guides: list[GuideKBEntry] = []
    for sc, g in scored_guides:
        if len(selected_guides) < 2 and (sc > 0 or not doc_slug):
            selected_guides.append(g)
    if not selected_guides:
        selected_guides = [GUIDE_KB_ENTRIES[0]]

    # Select up to 4 catalog items (always include exact doc_slug match if present)
    selected_catalog: list[CatalogEntry] = []
    for sc, e in scored_catalog:
        if len(selected_catalog) < 4 and (sc > 0 or len(selected_catalog) < 2):
            selected_catalog.append(e)

    citations: list[DocCitation] = []
    seen_slugs: set[str] = set()

    for g in selected_guides:
        if g.slug not in seen_slugs:
            seen_slugs.add(g.slug)
            citations.append(DocCitation(slug=g.slug, title=g.title, kind="guide"))
    for e in selected_catalog:
        if e.id not in seen_slugs:
            seen_slugs.add(e.id)
            citations.append(DocCitation(slug=e.id, title=f"{e.id} — {e.name}", kind=e.kind))

    guide_blocks = "\n\n".join(f"### Guide ({g.slug}): {g.title}\n{g.content}" for g in selected_guides)
    catalog_blocks = "\n\n".join(_format_catalog_summary_entry(e) for e in selected_catalog)

    initiative_block = ""
    if include_initiative_context and initiative_id:
        initiative_block = _format_initiative_snapshot(db_path, initiative_id)

    sections = [
        (
            "You are the ValueStream BCA Documentation Agent, an expert financial and technical advisor for the "
            "Cross-Domain Value Stream & Monte Carlo Business Case Analysis (BCA) platform.\n"
            "Answer clearly, concisely, and accurately using ONLY the grounded documentation, catalog formulas, "
            "guardrails, and worked examples below. Cite catalog IDs (e.g. BEN-TOIL-01, COST-BUILD-01) and guide names explicitly. "
            "Do not invent undocumented catalog IDs or parameters. If a question asks for an equation, show both the exact "
            "catalog formula syntax and a crisp numeric walkthrough."
        ),
        "## Live Catalog Index\n" + "\n".join(index_lines),
        "## Relevant Documentation & Guides\n" + guide_blocks,
        "## Relevant Catalog Templates\n" + catalog_blocks,
    ]
    if initiative_block:
        sections.append("## Selected Initiative Snapshot\n" + initiative_block)
    if extra_system_prompt.strip():
        sections.append("## Additional Administrator Instructions\n" + extra_system_prompt.strip())

    return "\n\n".join(sections), citations
