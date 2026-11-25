"""Excel workbook export of every BCA under an initiative.

Workbook layout:
- "Summary": the initiative and a side-by-side table of every BCA.
- One overview sheet per BCA: assumptions, key metrics, yearly cash flow, value streams,
  and the list of line items (linked to their sheets).
- One sheet per line item (each cost and each benefit): details, parameters, and a yearly
  valuation table.

The yearly cash flows, present values, and totals are live Excel formulas: changing a BCA's
discount rate on its overview sheet recalculates every line item and total. Each line item's
base annual value comes from the platform's template formula and is written as a value.
Formulas carry the platform's computed results as cached values, so the numbers also show
in viewers that don't recalculate.
"""

from __future__ import annotations

import io
import re
from datetime import datetime, timezone
from typing import Any

import xlsxwriter
from xlsxwriter.utility import xl_rowcol_to_cell
from xlsxwriter.workbook import Workbook
from xlsxwriter.worksheet import Worksheet

from app.core.engine import compute_ramp_multipliers
from app.models import BCADetail, CatalogEntry, DistributionSpec, InitiativeDetail, InitiativeItemOut

INK = "#1F2433"
MUTED = "#6B7385"
ACCENT = "#475587"
RULE = "#D9DDE6"
SUBTLE = "#F3F5F9"
INPUT_BG = "#EAF0FB"
COST = "#C0564B"
BENEFIT = "#2F8A66"

MONEY = '$#,##0;[Red]-$#,##0'
PCT = "0.00%"
RATIO = '0.00"x"'
FACTOR = "0.0000"
MULT = "0.000"

RAMP_LABELS = {
    "immediate": "Immediate (100% from start year)",
    "linear": "Linear ramp",
    "s_curve": "S-curve ramp",
    "custom_weights": "Custom weights",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _SheetNames:
    """Excel-safe, unique sheet names (max 31 chars, no []:*?/\\)."""

    def __init__(self) -> None:
        self._used: set[str] = set()

    def make(self, raw: str) -> str:
        name = re.sub(r"[\[\]:*?/\\]", "-", raw).strip().strip("'") or "Sheet"
        name = name[:31].rstrip()
        candidate, n = name, 2
        while candidate.lower() in self._used:
            suffix = f" ({n})"
            candidate = name[: 31 - len(suffix)].rstrip() + suffix
            n += 1
        self._used.add(candidate.lower())
        return candidate


def _ref(sheet: str, row: int, col: int, *, absolute: bool = True) -> str:
    """Cross-sheet cell reference, e.g. 'My Sheet'!$C$5."""
    quoted = "'" + sheet.replace("'", "''") + "'"
    return f"{quoted}!{xl_rowcol_to_cell(row, col, row_abs=absolute, col_abs=absolute)}"


def _cell(row: int, col: int, *, absolute: bool = False) -> str:
    return xl_rowcol_to_cell(row, col, row_abs=absolute, col_abs=absolute)


def _link(sheet: str) -> str:
    return "internal:'" + sheet.replace("'", "''") + "'!A1"


def _describe_distribution(spec: DistributionSpec | None) -> str:
    if spec is None or spec.distribution == "fixed":
        return "Fixed"
    parts = [spec.distribution.replace("_", " ").title()]
    if spec.std_pct is not None:
        parts.append(f"std {spec.std_pct * 100:.0f}%")
    if spec.std is not None:
        parts.append(f"std {spec.std:,.4g}")
    if spec.low is not None or spec.mode is not None or spec.high is not None:
        parts.append(
            "low/mode/high "
            + " / ".join("-" if v is None else f"{v:,.4g}" for v in (spec.low, spec.mode, spec.high))
        )
    if spec.low_pct is not None or spec.high_pct is not None:
        lo = f"{spec.low_pct * 100:+.0f}%" if spec.low_pct is not None else "-"
        hi = f"{spec.high_pct * 100:+.0f}%" if spec.high_pct is not None else "-"
        parts.append(f"range {lo} / {hi}")
    return ", ".join(parts)


def _year_text(item: InitiativeItemOut, cost_start_year: int | None) -> str:
    rel = f"Y{item.start_year}" if item.start_year == item.end_year else f"Y{item.start_year}-Y{item.end_year}"
    if cost_start_year is None:
        return rel
    a, b = cost_start_year + item.start_year - 1, cost_start_year + item.end_year - 1
    return f"{rel} ({a})" if a == b else f"{rel} ({a}-{b})"


class _Formats:
    def __init__(self, wb: Workbook) -> None:
        base = {"font_name": "Calibri", "font_size": 10, "font_color": INK, "valign": "vcenter"}

        def f(**kw: Any):
            return wb.add_format({**base, **kw})

        self.title = f(bold=True, font_size=16)
        self.subtitle = f(font_color=MUTED, font_size=10)
        self.section = f(bold=True, font_size=11.5, font_color=ACCENT, bottom=1, bottom_color=ACCENT)
        self.label = f(font_color=MUTED)
        self.text = f()
        self.wrap = f(text_wrap=True, valign="top")
        self.note = f(font_color=MUTED, italic=True, font_size=9, text_wrap=True, valign="top")
        self.head = f(bold=True, font_color=MUTED, bottom=1, bottom_color=INK, text_wrap=True)
        self.head_r = f(bold=True, font_color=MUTED, bottom=1, bottom_color=INK, align="right", text_wrap=True)
        self.money = f(num_format=MONEY)
        self.money_b = f(num_format=MONEY, bold=True)
        self.money_total = f(num_format=MONEY, bold=True, top=1, top_color=INK)
        self.total_label = f(bold=True, top=1, top_color=INK)
        self.total_blank = f(top=1, top_color=INK)
        self.pct = f(num_format=PCT)
        self.ratio = f(num_format=RATIO)
        self.ratio_b = f(num_format=RATIO, bold=True)
        self.factor = f(num_format=FACTOR)
        self.mult = f(num_format=MULT)
        self.number = f(num_format="#,##0.####")
        self.int = f(num_format="0")
        self.input_pct = f(num_format=PCT, bg_color=INPUT_BG, border=1, border_color=RULE, bold=True)
        self.input_num = f(num_format="#,##0.####", bg_color=INPUT_BG, border=1, border_color=RULE)
        self.input_money = f(num_format=MONEY, bg_color=INPUT_BG, border=1, border_color=RULE, bold=True)
        self.link = f(font_color=ACCENT, underline=1)
        self.kpi_value = f(num_format=MONEY, bold=True, font_size=13)
        self.kpi_ratio = f(num_format=RATIO, bold=True, font_size=13)
        self.kpi_text = f(bold=True, font_size=13)
        self.cost = f(font_color=COST, bold=True)
        self.benefit = f(font_color=BENEFIT, bold=True)


def _section(ws: Worksheet, fmt: _Formats, row: int, title: str, width: int) -> int:
    ws.merge_range(row, 0, row, width - 1, title, fmt.section)
    ws.set_row(row, 20)
    return row + 1


def _kv(ws: Worksheet, fmt: _Formats, row: int, label: str, value: Any, value_fmt=None, *, span: int = 1) -> int:
    ws.write(row, 0, label, fmt.label)
    if span > 1:
        ws.merge_range(row, 1, row, span, value, value_fmt or fmt.text)
    else:
        ws.write(row, 1, value, value_fmt or fmt.text)
    return row + 1


# ---------------------------------------------------------------------------
# Line item sheet
# ---------------------------------------------------------------------------


class _ItemRefs:
    """Cell locations on an item sheet that the BCA overview sheet references."""

    def __init__(self, sheet: str) -> None:
        self.sheet = sheet
        self.year_rows: dict[int, int] = {}
        self.annual_col = 3
        self.pv_col = 5
        self.total_pv: tuple[int, int] = (0, 0)
        self.total_annual: tuple[int, int] = (0, 0)
        self.base: tuple[int, int] = (0, 0)


def _write_item_sheet(
    wb: Workbook,
    fmt: _Formats,
    name: str,
    overview_name: str,
    rate_cell: tuple[int, int],
    initiative: InitiativeDetail,
    bca: BCADetail,
    item: InitiativeItemOut,
    entry: CatalogEntry | None,
) -> _ItemRefs:
    ws = wb.add_worksheet(name)
    ws.set_tab_color(COST if item.kind == "cost" else BENEFIT)
    ws.hide_gridlines(2)
    ws.set_column(0, 0, 26)
    ws.set_column(1, 1, 16)
    ws.set_column(2, 2, 14)
    ws.set_column(3, 5, 16)
    ws.set_column(6, 7, 14)
    ws.set_landscape()
    ws.fit_to_pages(1, 0)
    refs = _ItemRefs(name)
    width = 8

    ws.merge_range(0, 0, 0, width - 1, item.label, fmt.title)
    ws.set_row(0, 24)
    ws.merge_range(1, 0, 1, width - 1, f"{bca.name}  ·  {initiative.name}", fmt.subtitle)
    ws.write_url(2, 0, _link(overview_name), fmt.link, string=f"< Back to {bca.name}")

    row = _section(ws, fmt, 4, "Details", width)
    row = _kv(ws, fmt, row, "Type", "Cost" if item.kind == "cost" else "Benefit", fmt.cost if item.kind == "cost" else fmt.benefit)
    row = _kv(ws, fmt, row, "Template", f"{item.catalog_id} · {item.catalog_name}", span=4)
    row = _kv(ws, fmt, row, "Value stream", item.value_stream or "-", span=4)
    row = _kv(ws, fmt, row, "Active years", _year_text(item, bca.cost_start_year), span=4)
    ramp = RAMP_LABELS.get(item.ramp_profile, item.ramp_profile)
    if item.ramp_profile == "custom_weights" and item.ramp_weights:
        ramp += ": " + ", ".join(f"{w:g}" for w in item.ramp_weights)
    row = _kv(ws, fmt, row, "Ramp profile", ramp, span=4)
    formula_text = (entry.formula_description if entry and entry.formula_description else item.formula_type) or "-"
    ws.write(row, 0, "Template formula", fmt.label)
    ws.merge_range(row, 1, row, width - 1, formula_text, fmt.wrap)
    ws.set_row(row, 15 * max(1, min(4, len(formula_text) // 90 + 1)))
    row += 1
    unc = item.uncertainty_spec
    row = _kv(ws, fmt, row, "Item uncertainty", _describe_distribution(unc.item_multiplier), span=4)
    if unc.correlation_group:
        row = _kv(ws, fmt, row, "Correlation group", f"{unc.correlation_group} (rho {unc.correlation_rho:+.2f})", span=4)
    if item.anti_double_count_tag:
        row = _kv(ws, fmt, row, "Anti-double-count tag", item.anti_double_count_tag, span=4)
    if item.guardrail_notes:
        ws.write(row, 0, "Guardrail notes", fmt.label)
        ws.merge_range(row, 1, row, width - 1, item.guardrail_notes, fmt.wrap)
        ws.set_row(row, 15 * max(1, min(4, len(item.guardrail_notes) // 90 + 1)))
        row += 1

    # Parameters
    row = _section(ws, fmt, row + 1, "Parameters", width)
    headers = ["Parameter", "Key", "Unit", "Value", "Template default", "Min", "Max", "Uncertainty"]
    for c, h in enumerate(headers):
        ws.write(row, c, h, fmt.head_r if 3 <= c <= 6 else fmt.head)
    row += 1
    params = entry.parameters if entry else []
    keys_seen = set()
    for p in params:
        keys_seen.add(p.key)
        ws.write(row, 0, p.label, fmt.text)
        ws.write(row, 1, p.key, fmt.label)
        ws.write(row, 2, p.unit or "", fmt.label)
        ws.write_number(row, 3, float(item.param_values.get(p.key, p.default_value)), fmt.input_num)
        ws.write_number(row, 4, float(p.default_value), fmt.number)
        if p.min_value is not None:
            ws.write_number(row, 5, float(p.min_value), fmt.number)
        if p.max_value is not None:
            ws.write_number(row, 6, float(p.max_value), fmt.number)
        ws.write(row, 7, _describe_distribution(unc.parameters.get(p.key)), fmt.text)
        row += 1
    for key, value in item.param_values.items():
        if key not in keys_seen:
            ws.write(row, 0, key, fmt.text)
            ws.write(row, 1, key, fmt.label)
            ws.write_number(row, 3, float(value), fmt.input_num)
            ws.write(row, 7, _describe_distribution(unc.parameters.get(key)), fmt.text)
            row += 1
    if not params and not item.param_values:
        ws.write(row, 0, "No parameters.", fmt.note)
        row += 1

    # Valuation inputs
    row = _section(ws, fmt, row + 1, "Valuation", width)
    ws.write(row, 0, "Base annual value", fmt.label)
    ws.write_number(row, 1, float(item.base_annual_value), fmt.input_money)
    ws.merge_range(
        row,
        2,
        row,
        width - 1,
        "Calculated by the template formula from the parameters above (full-year value at 100% realization).",
        fmt.note,
    )
    refs.base = (row, 1)
    row += 1
    ws.write(row, 0, "Discount rate", fmt.label)
    ws.write_formula(row, 1, "=" + _ref(overview_name, *rate_cell), fmt.pct, bca.discount_rate)
    ws.merge_range(row, 2, row, width - 1, f"Linked to the {bca.name} overview sheet.", fmt.note)
    local_rate = (row, 1)
    row += 2

    # Yearly table
    for c, h in enumerate(["Year", "Calendar year", "Ramp multiplier", "Annual value", "Discount factor", "Present value"]):
        ws.write(row, c, h, fmt.head_r if c >= 2 else fmt.head)
    row += 1
    ramps = compute_ramp_multipliers(
        horizon_years=bca.horizon_years,
        start_year=item.start_year,
        end_year=item.end_year,
        ramp_profile=item.ramp_profile,
        ramp_weights=item.ramp_weights,
    )
    base_abs = _cell(*refs.base, absolute=True)
    rate_abs = _cell(*local_rate, absolute=True)
    first = row
    for y in range(1, bca.horizon_years + 1):
        mult = float(ramps[y - 1])
        annual = item.base_annual_value * mult
        df = 1.0 / ((1.0 + bca.discount_rate) ** y)
        ws.write_number(row, 0, y, fmt.int)
        if bca.cost_start_year:
            ws.write_number(row, 1, bca.cost_start_year + y - 1, fmt.int)
        ws.write_number(row, 2, mult, fmt.mult)
        ws.write_formula(row, 3, f"={base_abs}*{_cell(row, 2)}", fmt.money, annual)
        ws.write_formula(row, 4, f"=1/(1+{rate_abs})^{_cell(row, 0)}", fmt.factor, df)
        ws.write_formula(row, 5, f"={_cell(row, 3)}*{_cell(row, 4)}", fmt.money, annual * df)
        refs.year_rows[y] = row
        row += 1
    last = row - 1
    ws.write(row, 0, "Total", fmt.total_label)
    for c in (1, 2, 4):
        ws.write_blank(row, c, None, fmt.total_blank)
    total_annual = sum(item.base_annual_value * float(m) for m in ramps)
    ws.write_formula(row, 3, f"=SUM({_cell(first, 3)}:{_cell(last, 3)})", fmt.money_total, total_annual)
    ws.write_formula(row, 5, f"=SUM({_cell(first, 5)}:{_cell(last, 5)})", fmt.money_total, item.pv_total)
    refs.total_annual = (row, 3)
    refs.total_pv = (row, 5)
    ws.freeze_panes(3, 0)
    return refs


# ---------------------------------------------------------------------------
# BCA overview sheet
# ---------------------------------------------------------------------------


class _OverviewRefs:
    def __init__(self, sheet: str) -> None:
        self.sheet = sheet
        self.rate: tuple[int, int] = (0, 0)
        self.pv_benefits: tuple[int, int] = (0, 0)
        self.pv_costs: tuple[int, int] = (0, 0)
        self.npv: tuple[int, int] = (0, 0)
        self.bcr: tuple[int, int] = (0, 0)


def _write_overview_sheet(
    ws: Worksheet,
    fmt: _Formats,
    initiative: InitiativeDetail,
    bca: BCADetail,
    items: list[tuple[InitiativeItemOut, _ItemRefs]],
    refs: _OverviewRefs,
    summary_name: str,
) -> None:
    det = bca.deterministic
    width = 9
    ws.merge_range(0, 0, 0, width - 1, bca.name + ("  (Baseline)" if bca.is_baseline else ""), fmt.title)
    ws.set_row(0, 24)
    ws.merge_range(1, 0, 1, width - 1, initiative.name, fmt.subtitle)
    ws.write_url(2, 0, _link(summary_name), fmt.link, string="< Back to Summary")
    row = 3
    if bca.description:
        ws.merge_range(row, 0, row, width - 1, bca.description, fmt.wrap)
        ws.set_row(row, 15 * max(1, min(5, len(bca.description) // 120 + 1)))
        row += 1

    # Assumptions (rate already placed at refs.rate)
    row = _section(ws, fmt, row + 1, "Assumptions", width)
    row = _kv(ws, fmt, row, "Horizon (years)", bca.horizon_years, fmt.int)
    ws.write(row, 0, "Discount rate", fmt.label)
    ws.write_number(row, 1, bca.discount_rate, fmt.input_pct)
    ws.merge_range(row, 2, row, width - 1, "Input: change this to recalculate every line item and total.", fmt.note)
    assert (row, 1) == refs.rate, "discount rate cell moved; item sheets reference it"
    row += 1
    row = _kv(ws, fmt, row, "First year", bca.cost_start_year or "Relative years (Y1 = first year)", fmt.int if bca.cost_start_year else fmt.text)
    row = _kv(ws, fmt, row, "Line items", f"{sum(1 for i, _ in items if i.kind == 'benefit')} benefits, {sum(1 for i, _ in items if i.kind == 'cost')} costs")

    # Key metrics (formulas over item sheets)
    row = _section(ws, fmt, row + 1, "Key metrics", width)
    ben = [_ref(r.sheet, *r.total_pv) for i, r in items if i.kind == "benefit"]
    cst = [_ref(r.sheet, *r.total_pv) for i, r in items if i.kind == "cost"]
    ws.write(row, 0, "PV benefits", fmt.label)
    ws.write_formula(row, 1, "=" + ("+".join(ben) if ben else "0"), fmt.kpi_value, det.pv_benefits)
    refs.pv_benefits = (row, 1)
    row += 1
    ws.write(row, 0, "PV costs", fmt.label)
    ws.write_formula(row, 1, "=" + ("+".join(cst) if cst else "0"), fmt.kpi_value, det.pv_costs)
    refs.pv_costs = (row, 1)
    row += 1
    ws.write(row, 0, "Net present value", fmt.label)
    ws.write_formula(row, 1, f"={_cell(*refs.pv_benefits)}-{_cell(*refs.pv_costs)}", fmt.kpi_value, det.npv)
    refs.npv = (row, 1)
    row += 1
    ws.write(row, 0, "Benefit-cost ratio", fmt.label)
    ws.write_formula(
        row,
        1,
        f'=IF({_cell(*refs.pv_costs)}>0,{_cell(*refs.pv_benefits)}/{_cell(*refs.pv_costs)},"N/A")',
        fmt.kpi_ratio,
        det.bcr if det.bcr is not None else "N/A",
    )
    refs.bcr = (row, 1)
    row += 1
    ws.write(row, 0, "Discounted payback", fmt.label)
    if det.discounted_payback_year is not None:
        ws.write_number(row, 1, round(det.discounted_payback_year, 2), fmt.kpi_text)
        ws.write(row, 2, "years", fmt.label)
    else:
        ws.write(row, 1, "No payback", fmt.kpi_text)
    ws.merge_range(row, 3, row, width - 1, "As calculated in the app (not recalculated in Excel).", fmt.note)
    row += 1

    sim = bca.latest_simulation
    if sim:
        mc = sim.monte_carlo
        row = _section(ws, fmt, row + 1, "Latest Monte Carlo run (values as of the run)", width)
        row = _kv(ws, fmt, row, "Run", f"{sim.n_simulations:,} iterations · {sim.created_at[:16].replace('T', ' ')} UTC", span=4)
        row = _kv(ws, fmt, row, "P(NPV > 0)", mc.prob_npv_positive, fmt.pct)
        row = _kv(ws, fmt, row, "P(BCR >= 1)", mc.prob_bcr_ge_one, fmt.pct)
        row = _kv(ws, fmt, row, "NPV P10", mc.npv_stats.p10, fmt.money)
        row = _kv(ws, fmt, row, "NPV P50", mc.npv_stats.p50, fmt.money)
        row = _kv(ws, fmt, row, "NPV P90", mc.npv_stats.p90, fmt.money)
        row = _kv(ws, fmt, row, "NPV mean", mc.npv_stats.mean, fmt.money)

    # Yearly cash flow (sums across item sheets)
    row = _section(ws, fmt, row + 1, "Cash flow by year", width)
    heads = ["Year", "Calendar year", "Benefits", "Costs", "Net", "PV benefits", "PV costs", "Net PV", "Cumulative net PV"]
    for c, h in enumerate(heads):
        ws.write(row, c, h, fmt.head_r if c >= 2 else fmt.head)
    row += 1
    first = row
    yearly = {y.year: y for y in det.yearly_cash_flows}

    def sum_refs(kind: str, col_attr: str, year: int) -> str:
        parts = [
            _ref(r.sheet, r.year_rows[year], getattr(r, col_attr), absolute=False)
            for i, r in items
            if i.kind == kind and year in r.year_rows
        ]
        return "+".join(parts) if parts else "0"

    for y in range(1, bca.horizon_years + 1):
        yc = yearly.get(y)
        ws.write_number(row, 0, y, fmt.int)
        if bca.cost_start_year:
            ws.write_number(row, 1, bca.cost_start_year + y - 1, fmt.int)
        ws.write_formula(row, 2, "=" + sum_refs("benefit", "annual_col", y), fmt.money, yc.undiscounted_benefit if yc else 0)
        ws.write_formula(row, 3, "=" + sum_refs("cost", "annual_col", y), fmt.money, yc.undiscounted_cost if yc else 0)
        ws.write_formula(row, 4, f"={_cell(row, 2)}-{_cell(row, 3)}", fmt.money, yc.net_undiscounted if yc else 0)
        ws.write_formula(row, 5, "=" + sum_refs("benefit", "pv_col", y), fmt.money, yc.pv_benefit if yc else 0)
        ws.write_formula(row, 6, "=" + sum_refs("cost", "pv_col", y), fmt.money, yc.pv_cost if yc else 0)
        ws.write_formula(row, 7, f"={_cell(row, 5)}-{_cell(row, 6)}", fmt.money, yc.net_pv if yc else 0)
        prev = f"+{_cell(row - 1, 8)}" if row > first else ""
        ws.write_formula(row, 8, f"={_cell(row, 7)}{prev}", fmt.money, yc.cumulative_net_pv if yc else 0)
        row += 1
    last = row - 1
    ws.write(row, 0, "Total", fmt.total_label)
    ws.write_blank(row, 1, None, fmt.total_blank)
    totals = {
        2: sum(y.undiscounted_benefit for y in det.yearly_cash_flows),
        3: sum(y.undiscounted_cost for y in det.yearly_cash_flows),
        4: sum(y.net_undiscounted for y in det.yearly_cash_flows),
        5: det.pv_benefits,
        6: det.pv_costs,
        7: det.npv,
    }
    for c, v in totals.items():
        ws.write_formula(row, c, f"=SUM({_cell(first, c)}:{_cell(last, c)})", fmt.money_total, v)
    ws.write_blank(row, 8, None, fmt.total_blank)
    row += 2

    # Line items
    row = _section(ws, fmt, row, "Line items", width)
    heads = ["Line item", "Type", "Template", "Value stream", "Years", "Ramp", "Base annual value", "Total (undiscounted)", "Present value"]
    for c, h in enumerate(heads):
        ws.write(row, c, h, fmt.head_r if c >= 6 else fmt.head)
    row += 1
    li_first = row
    for item, r in items:
        ws.write_url(row, 0, _link(r.sheet), fmt.link, string=item.label)
        ws.write(row, 1, "Cost" if item.kind == "cost" else "Benefit", fmt.cost if item.kind == "cost" else fmt.benefit)
        ws.write(row, 2, item.catalog_id, fmt.text)
        ws.write(row, 3, item.value_stream or "(unassigned)", fmt.text)
        ws.write(row, 4, _year_text(item, bca.cost_start_year), fmt.text)
        ws.write(row, 5, RAMP_LABELS.get(item.ramp_profile, item.ramp_profile).split(" (")[0], fmt.text)
        ws.write_formula(row, 6, "=" + _ref(r.sheet, *r.base), fmt.money, item.base_annual_value)
        ws.write_formula(
            row, 7, "=" + _ref(r.sheet, *r.total_annual), fmt.money,
            sum(item.base_annual_value * float(m) for m in compute_ramp_multipliers(
                horizon_years=bca.horizon_years, start_year=item.start_year, end_year=item.end_year,
                ramp_profile=item.ramp_profile, ramp_weights=item.ramp_weights,
            )),
        )
        ws.write_formula(row, 8, "=" + _ref(r.sheet, *r.total_pv), fmt.money, item.pv_total)
        row += 1
    if not items:
        ws.write(row, 0, "No line items.", fmt.note)
        row += 1
    li_last = row - 1

    # Value streams (SUMIFS over the line item table)
    if items and det.value_streams:
        row = _section(ws, fmt, row + 1, "Value streams", width)
        for c, h in enumerate(["Value stream", "Items", "PV benefits", "PV costs", "NPV", "BCR"]):
            ws.write(row, c, h, fmt.head_r if c >= 1 else fmt.head)
        row += 1
        vs_col = f"$D${li_first + 1}:$D${li_last + 1}"
        type_col = f"$B${li_first + 1}:$B${li_last + 1}"
        pv_col = f"$I${li_first + 1}:$I${li_last + 1}"
        for vs in sorted(det.value_streams, key=lambda v: -v.npv):
            label = vs.value_stream or "(unassigned)"
            ws.write(row, 0, label, fmt.text)
            ws.write_formula(row, 1, f"=COUNTIF({vs_col},{_cell(row, 0)})", fmt.int, vs.item_count)
            ws.write_formula(row, 2, f'=SUMIFS({pv_col},{vs_col},{_cell(row, 0)},{type_col},"Benefit")', fmt.money, vs.pv_benefits)
            ws.write_formula(row, 3, f'=SUMIFS({pv_col},{vs_col},{_cell(row, 0)},{type_col},"Cost")', fmt.money, vs.pv_costs)
            ws.write_formula(row, 4, f"={_cell(row, 2)}-{_cell(row, 3)}", fmt.money, vs.npv)
            ws.write_formula(
                row, 5, f'=IF({_cell(row, 3)}>0,{_cell(row, 2)}/{_cell(row, 3)},"N/A")', fmt.ratio,
                vs.bcr if vs.bcr is not None else "N/A",
            )
            row += 1

    if det.guardrail_warnings:
        row = _section(ws, fmt, row + 1, "Double-counting guardrails", width)
        for g in det.guardrail_warnings:
            ws.merge_range(row, 0, row, width - 1, f"{g.tag}: {g.message}", fmt.wrap)
            ws.set_row(row, 30)
            row += 1


# ---------------------------------------------------------------------------
# Workbook
# ---------------------------------------------------------------------------


def build_initiative_workbook(
    initiative: InitiativeDetail,
    bcas: list[BCADetail],
    catalog: dict[str, CatalogEntry],
    *,
    generated_by: str = "",
) -> bytes:
    buf = io.BytesIO()
    wb = xlsxwriter.Workbook(buf, {"in_memory": True, "strings_to_formulas": False, "strings_to_urls": False})
    wb.set_properties(
        {
            "title": f"{initiative.name} - business cases",
            "author": generated_by or "ValueStream BCA",
            "company": "ValueStream BCA",
            "comments": "Exported from ValueStream BCA",
        }
    )
    wb.set_calc_mode("auto")
    fmt = _Formats(wb)
    names = _SheetNames()
    now = datetime.now(timezone.utc)

    summary_name = names.make("Summary")
    summary = wb.add_worksheet(summary_name)
    summary.set_tab_color(INK)
    summary.hide_gridlines(2)

    # Tabs read: Summary, BCA 1 overview, its line items, BCA 2 overview, its line items, ...
    summary_rows = []
    for idx, bca in enumerate(bcas, start=1):
        ov_name = names.make(f"{idx}. {bca.name}")
        ov_ws = wb.add_worksheet(ov_name)
        ov_ws.set_tab_color(ACCENT)
        ov_ws.hide_gridlines(2)
        refs = _OverviewRefs(ov_name)
        # Item sheets link to the overview's discount rate cell, so fix its position up front:
        # title, subtitle, back link, optional description, section header, horizon, rate.
        refs.rate = (3 + (1 if bca.description else 0) + 3, 1)
        ordered = sorted(bca.items, key=lambda i: (i.kind != "cost", i.created_at))
        item_refs = []
        for k, item in enumerate(ordered, start=1):
            sheet_name = names.make(f"{idx}.{k} {'Cost' if item.kind == 'cost' else 'Benefit'} {item.label}")
            item_refs.append(
                (
                    item,
                    _write_item_sheet(
                        wb, fmt, sheet_name, ov_name, refs.rate, initiative, bca, item, catalog.get(item.catalog_id)
                    ),
                )
            )
        _write_overview_sheet(ov_ws, fmt, initiative, bca, item_refs, refs, summary_name)
        ov_ws.set_column(0, 0, 30)
        ov_ws.set_column(1, 8, 16)
        ov_ws.set_landscape()
        ov_ws.fit_to_pages(1, 0)
        summary_rows.append((bca, refs))

    # Summary sheet
    ws = summary
    width = 11
    ws.set_column(0, 0, 32)
    ws.set_column(1, 10, 14)
    ws.merge_range(0, 0, 0, width - 1, initiative.name, fmt.title)
    ws.set_row(0, 24)
    ws.merge_range(
        1, 0, 1, width - 1,
        f"Business case export  ·  {now.strftime('%b %d, %Y %H:%M UTC')}" + (f"  ·  {generated_by}" if generated_by else ""),
        fmt.subtitle,
    )
    row = 3
    if initiative.description:
        ws.merge_range(row, 0, row, width - 1, initiative.description, fmt.wrap)
        ws.set_row(row, 15 * max(1, min(5, len(initiative.description) // 140 + 1)))
        row += 1
    row = _kv(ws, fmt, row + 1, "Status", initiative.status.replace("_", " ").title())
    row = _kv(ws, fmt, row, "Domain", initiative.domain or "-")
    if initiative.external_resource_url:
        ws.write(row, 0, "External resource", fmt.label)
        ws.write_url(row, 1, initiative.external_resource_url, fmt.link, string=initiative.external_resource_url)
        row += 1
    row = _kv(ws, fmt, row, "Business cases", len(bcas), fmt.int)

    row = _section(ws, fmt, row + 1, "Business cases", width)
    heads = ["Business case", "Baseline", "Horizon", "Discount rate", "PV benefits", "PV costs", "NPV", "BCR", "Payback (yrs)", "P(NPV > 0)", "MC NPV P50"]
    for c, h in enumerate(heads):
        ws.write(row, c, h, fmt.head_r if c >= 2 else fmt.head)
    row += 1
    for bca, refs in summary_rows:
        det = bca.deterministic
        ws.write_url(row, 0, _link(refs.sheet), fmt.link, string=bca.name)
        ws.write(row, 1, "Yes" if bca.is_baseline else "", fmt.text)
        ws.write_number(row, 2, bca.horizon_years, fmt.int)
        ws.write_formula(row, 3, "=" + _ref(refs.sheet, *refs.rate), fmt.pct, bca.discount_rate)
        ws.write_formula(row, 4, "=" + _ref(refs.sheet, *refs.pv_benefits), fmt.money, det.pv_benefits)
        ws.write_formula(row, 5, "=" + _ref(refs.sheet, *refs.pv_costs), fmt.money, det.pv_costs)
        ws.write_formula(row, 6, "=" + _ref(refs.sheet, *refs.npv), fmt.money_b, det.npv)
        ws.write_formula(row, 7, "=" + _ref(refs.sheet, *refs.bcr), fmt.ratio, det.bcr if det.bcr is not None else "N/A")
        if det.discounted_payback_year is not None:
            ws.write_number(row, 8, round(det.discounted_payback_year, 2), fmt.number)
        else:
            ws.write(row, 8, "No payback", fmt.text)
        sim = bca.latest_simulation
        if sim:
            ws.write_number(row, 9, sim.monte_carlo.prob_npv_positive, fmt.pct)
            ws.write_number(row, 10, sim.monte_carlo.npv_stats.p50, fmt.money)
        else:
            ws.write(row, 9, "Not simulated", fmt.label)
        row += 1

    if initiative.measures:
        values_by_bca = {b.id: b.measure_values for b in initiative.bcas}
        row = _section(ws, fmt, row + 1, "Non-monetary benefits", width)
        for c, h in enumerate(["Measure", "Unit", "Better when"]):
            ws.write(row, c, h, fmt.head)
        for c, (bca, _) in enumerate(summary_rows, start=3):
            ws.write(row, c, bca.name, fmt.head_r)
        row += 1
        for m in initiative.measures:
            ws.write(row, 0, m.name, fmt.text)
            ws.write(row, 1, m.unit or "-", fmt.text)
            ws.write(row, 2, "Higher" if m.direction == "higher_is_better" else "Lower", fmt.text)
            for c, (bca, _) in enumerate(summary_rows, start=3):
                est = values_by_bca.get(bca.id, {}).get(m.id)
                if est is None:
                    ws.write(row, c, "Not scored", fmt.label)
                    continue
                ws.write_number(row, c, est.value, fmt.number)
                detail = []
                if est.low is not None or est.high is not None:
                    low = est.low if est.low is not None else est.value
                    high = est.high if est.high is not None else est.value
                    detail.append(f"Range: {low:g} to {high:g}")
                if est.note:
                    detail.append(est.note)
                if detail:
                    ws.write_comment(row, c, "\n".join(detail), {"x_scale": 1.6})
            row += 1
        ws.merge_range(
            row, 0, row, width - 1,
            "Expected values; hover a cell with a red corner for its low-high range and basis.",
            fmt.note,
        )
        row += 1

    row = _section(ws, fmt, row + 1, "How this workbook works", width)
    notes = [
        "Each business case has an overview sheet (blue tab) followed by one sheet per line item: red tabs are costs, green tabs are benefits.",
        "Shaded cells are inputs. Change a business case's discount rate on its overview sheet, or a line item's base annual value, and every yearly value, present value, and total recalculates.",
        "Base annual values come from each template's formula in the app. Parameter values are listed for reference; changing them in Excel does not recalculate the base annual value.",
        "Discounted payback and Monte Carlo results are values as calculated in the app.",
    ]
    for n in notes:
        ws.merge_range(row, 0, row, width - 1, "•  " + n, fmt.wrap)
        ws.set_row(row, 28)
        row += 1
    ws.activate()
    wb.close()
    return buf.getvalue()
