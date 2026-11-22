"""OData v4.0 Core Engine: EDM metadata, query parser ($filter/$select/$orderby/$top/$skip/$count/$expand), and BCA data extraction."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote
from xml.sax.saxutils import escape as xml_escape

from app.core.engine import run_deterministic
from app.db.database import get_connection
from app.db.repository import _row_to_catalog_entry, _row_to_initiative_dict, _row_to_item_dict
from app.models import CatalogEntry, SimulationResult

ODATA_VERSION = "4.0"
ODATA_NS = "ValueStreamBCA"
DEFAULT_PAGE_SIZE = 1000
MAX_PAGE_SIZE = 10000


class ODataError(Exception):
    """Structured OData protocol/query validation error mapped to HTTP status codes."""

    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


def odata_error_payload(code: str, message: str) -> dict[str, Any]:
    return {"error": {"code": code, "message": message}}


@dataclass(frozen=True)
class ODataPropertyDef:
    name: str
    edm_type: str
    nullable: bool = True


@dataclass(frozen=True)
class ODataNavPropDef:
    name: str
    target_set: str
    target_type: str
    is_collection: bool
    partner: str | None = None
    fk_property: str | None = None


@dataclass(frozen=True)
class ODataEntitySetDef:
    name: str
    entity_type: str
    key_property: str
    description: str
    properties: tuple[ODataPropertyDef, ...]
    nav_properties: tuple[ODataNavPropDef, ...] = ()

    @property
    def property_map(self) -> dict[str, ODataPropertyDef]:
        return {p.name: p for p in self.properties}

    @property
    def nav_map(self) -> dict[str, ODataNavPropDef]:
        return {n.name: n for n in self.nav_properties}


INITIATIVE_DEF = ODataEntitySetDef(
    name="Initiatives",
    entity_type="Initiative",
    key_property="Id",
    description="Initiative baseline assumptions, deterministic PV/NPV/BCR KPIs, and latest Monte Carlo summary.",
    properties=(
        ODataPropertyDef("Id", "Edm.String", nullable=False),
        ODataPropertyDef("Name", "Edm.String", nullable=False),
        ODataPropertyDef("Description", "Edm.String", nullable=False),
        ODataPropertyDef("Domain", "Edm.String", nullable=False),
        ODataPropertyDef("HorizonYears", "Edm.Int32", nullable=False),
        ODataPropertyDef("DiscountRate", "Edm.Double", nullable=False),
        ODataPropertyDef("CostStartYear", "Edm.Int32", nullable=True),
        ODataPropertyDef("CostEndYear", "Edm.Int32", nullable=True),
        ODataPropertyDef("ExternalResourceUrl", "Edm.String", nullable=False),
        ODataPropertyDef("ItemCount", "Edm.Int32", nullable=False),
        ODataPropertyDef("CostItemCount", "Edm.Int32", nullable=False),
        ODataPropertyDef("BenefitItemCount", "Edm.Int32", nullable=False),
        ODataPropertyDef("PvCosts", "Edm.Double", nullable=False),
        ODataPropertyDef("PvBenefits", "Edm.Double", nullable=False),
        ODataPropertyDef("Npv", "Edm.Double", nullable=False),
        ODataPropertyDef("Bcr", "Edm.Double", nullable=True),
        ODataPropertyDef("DiscountedPaybackYear", "Edm.Double", nullable=True),
        ODataPropertyDef("GuardrailWarningCount", "Edm.Int32", nullable=False),
        ODataPropertyDef("LatestSimProbNpvPositive", "Edm.Double", nullable=True),
        ODataPropertyDef("LatestSimNpvP10", "Edm.Double", nullable=True),
        ODataPropertyDef("LatestSimNpvP50", "Edm.Double", nullable=True),
        ODataPropertyDef("LatestSimNpvP90", "Edm.Double", nullable=True),
        ODataPropertyDef("CreatedAt", "Edm.DateTimeOffset", nullable=False),
        ODataPropertyDef("UpdatedAt", "Edm.DateTimeOffset", nullable=False),
    ),
    nav_properties=(
        ODataNavPropDef(
            name="CostBenefitItems",
            target_set="CostBenefitItems",
            target_type=f"Collection({ODATA_NS}.CostBenefitItem)",
            is_collection=True,
            partner="Initiative",
        ),
        ODataNavPropDef(
            name="YearlyCashFlows",
            target_set="YearlyCashFlows",
            target_type=f"Collection({ODATA_NS}.YearlyCashFlow)",
            is_collection=True,
            partner="Initiative",
        ),
        ODataNavPropDef(
            name="ValueStreams",
            target_set="ValueStreams",
            target_type=f"Collection({ODATA_NS}.ValueStreamSummary)",
            is_collection=True,
            partner="Initiative",
        ),
        ODataNavPropDef(
            name="SimulationRuns",
            target_set="SimulationRuns",
            target_type=f"Collection({ODATA_NS}.SimulationRun)",
            is_collection=True,
            partner="Initiative",
        ),
    ),
)

COST_BENEFIT_ITEM_DEF = ODataEntitySetDef(
    name="CostBenefitItems",
    entity_type="CostBenefitItem",
    key_property="Id",
    description="Individual cost and benefit line items with ramp profiles, base annual values, PV totals, and parameters.",
    properties=(
        ODataPropertyDef("Id", "Edm.String", nullable=False),
        ODataPropertyDef("InitiativeId", "Edm.String", nullable=False),
        ODataPropertyDef("InitiativeName", "Edm.String", nullable=False),
        ODataPropertyDef("InitiativeDomain", "Edm.String", nullable=False),
        ODataPropertyDef("CatalogId", "Edm.String", nullable=False),
        ODataPropertyDef("CatalogName", "Edm.String", nullable=False),
        ODataPropertyDef("Kind", "Edm.String", nullable=False),
        ODataPropertyDef("Label", "Edm.String", nullable=False),
        ODataPropertyDef("ValueStream", "Edm.String", nullable=False),
        ODataPropertyDef("StartYear", "Edm.Int32", nullable=False),
        ODataPropertyDef("EndYear", "Edm.Int32", nullable=False),
        ODataPropertyDef("CalendarStartYear", "Edm.Int32", nullable=True),
        ODataPropertyDef("CalendarEndYear", "Edm.Int32", nullable=True),
        ODataPropertyDef("RampProfile", "Edm.String", nullable=False),
        ODataPropertyDef("BaseAnnualValue", "Edm.Double", nullable=False),
        ODataPropertyDef("PvTotal", "Edm.Double", nullable=False),
        ODataPropertyDef("SignedPvTotal", "Edm.Double", nullable=False),
        ODataPropertyDef("AntiDoubleCountTag", "Edm.String", nullable=True),
        ODataPropertyDef("FormulaType", "Edm.String", nullable=False),
        ODataPropertyDef("ParametersJson", "Edm.String", nullable=False),
        ODataPropertyDef("UncertaintyJson", "Edm.String", nullable=False),
        ODataPropertyDef("CreatedAt", "Edm.DateTimeOffset", nullable=False),
        ODataPropertyDef("UpdatedAt", "Edm.DateTimeOffset", nullable=False),
    ),
    nav_properties=(
        ODataNavPropDef(
            name="Initiative",
            target_set="Initiatives",
            target_type=f"{ODATA_NS}.Initiative",
            is_collection=False,
            partner="CostBenefitItems",
            fk_property="InitiativeId",
        ),
        ODataNavPropDef(
            name="CatalogEntry",
            target_set="CatalogEntries",
            target_type=f"{ODATA_NS}.CatalogEntry",
            is_collection=False,
            fk_property="CatalogId",
        ),
    ),
)

YEARLY_CASH_FLOW_DEF = ODataEntitySetDef(
    name="YearlyCashFlows",
    entity_type="YearlyCashFlow",
    key_property="Id",
    description="Annual undiscounted and discounted cost/benefit schedules and cumulative net cash flows per initiative year.",
    properties=(
        ODataPropertyDef("Id", "Edm.String", nullable=False),
        ODataPropertyDef("InitiativeId", "Edm.String", nullable=False),
        ODataPropertyDef("InitiativeName", "Edm.String", nullable=False),
        ODataPropertyDef("InitiativeDomain", "Edm.String", nullable=False),
        ODataPropertyDef("Year", "Edm.Int32", nullable=False),
        ODataPropertyDef("CalendarYear", "Edm.Int32", nullable=True),
        ODataPropertyDef("UndiscountedCost", "Edm.Double", nullable=False),
        ODataPropertyDef("UndiscountedBenefit", "Edm.Double", nullable=False),
        ODataPropertyDef("NetUndiscounted", "Edm.Double", nullable=False),
        ODataPropertyDef("PvCost", "Edm.Double", nullable=False),
        ODataPropertyDef("PvBenefit", "Edm.Double", nullable=False),
        ODataPropertyDef("NetPv", "Edm.Double", nullable=False),
        ODataPropertyDef("CumulativeUndiscountedNet", "Edm.Double", nullable=False),
        ODataPropertyDef("CumulativeNetPv", "Edm.Double", nullable=False),
    ),
    nav_properties=(
        ODataNavPropDef(
            name="Initiative",
            target_set="Initiatives",
            target_type=f"{ODATA_NS}.Initiative",
            is_collection=False,
            partner="YearlyCashFlows",
            fk_property="InitiativeId",
        ),
    ),
)

VALUE_STREAM_DEF = ODataEntitySetDef(
    name="ValueStreams",
    entity_type="ValueStreamSummary",
    key_property="Id",
    description="Initiative cost, benefit, NPV, and BCR rollups aggregated by value stream.",
    properties=(
        ODataPropertyDef("Id", "Edm.String", nullable=False),
        ODataPropertyDef("InitiativeId", "Edm.String", nullable=False),
        ODataPropertyDef("InitiativeName", "Edm.String", nullable=False),
        ODataPropertyDef("InitiativeDomain", "Edm.String", nullable=False),
        ODataPropertyDef("ValueStream", "Edm.String", nullable=False),
        ODataPropertyDef("ItemCount", "Edm.Int32", nullable=False),
        ODataPropertyDef("PvCosts", "Edm.Double", nullable=False),
        ODataPropertyDef("PvBenefits", "Edm.Double", nullable=False),
        ODataPropertyDef("Npv", "Edm.Double", nullable=False),
        ODataPropertyDef("Bcr", "Edm.Double", nullable=True),
    ),
    nav_properties=(
        ODataNavPropDef(
            name="Initiative",
            target_set="Initiatives",
            target_type=f"{ODATA_NS}.Initiative",
            is_collection=False,
            partner="ValueStreams",
            fk_property="InitiativeId",
        ),
    ),
)

CATALOG_ENTRY_DEF = ODataEntitySetDef(
    name="CatalogEntries",
    entity_type="CatalogEntry",
    key_property="Id",
    description="Built-in and custom reusable cost and benefit catalog templates with formulas and guardrails.",
    properties=(
        ODataPropertyDef("Id", "Edm.String", nullable=False),
        ODataPropertyDef("Kind", "Edm.String", nullable=False),
        ODataPropertyDef("Name", "Edm.String", nullable=False),
        ODataPropertyDef("Description", "Edm.String", nullable=False),
        ODataPropertyDef("Domains", "Edm.String", nullable=False),
        ODataPropertyDef("ValueStreamStage", "Edm.String", nullable=True),
        ODataPropertyDef("FormulaType", "Edm.String", nullable=False),
        ODataPropertyDef("FormulaDescription", "Edm.String", nullable=False),
        ODataPropertyDef("GuardrailNotes", "Edm.String", nullable=False),
        ODataPropertyDef("IsBuiltin", "Edm.Boolean", nullable=False),
        ODataPropertyDef("CreatedAt", "Edm.DateTimeOffset", nullable=False),
    ),
)

SIMULATION_RUN_DEF = ODataEntitySetDef(
    name="SimulationRuns",
    entity_type="SimulationRun",
    key_property="Id",
    description="Persisted Monte Carlo uncertainty runs with percentile NPV/BCR outcomes and timing.",
    properties=(
        ODataPropertyDef("Id", "Edm.String", nullable=False),
        ODataPropertyDef("InitiativeId", "Edm.String", nullable=False),
        ODataPropertyDef("InitiativeName", "Edm.String", nullable=False),
        ODataPropertyDef("NSimulations", "Edm.Int32", nullable=False),
        ODataPropertyDef("DiscountRate", "Edm.Double", nullable=False),
        ODataPropertyDef("HorizonYears", "Edm.Int32", nullable=False),
        ODataPropertyDef("Seed", "Edm.Int32", nullable=True),
        ODataPropertyDef("ProbNpvPositive", "Edm.Double", nullable=False),
        ODataPropertyDef("ProbBcrGte1", "Edm.Double", nullable=False),
        ODataPropertyDef("NpvMean", "Edm.Double", nullable=False),
        ODataPropertyDef("NpvStd", "Edm.Double", nullable=False),
        ODataPropertyDef("NpvP10", "Edm.Double", nullable=False),
        ODataPropertyDef("NpvP50", "Edm.Double", nullable=False),
        ODataPropertyDef("NpvP90", "Edm.Double", nullable=False),
        ODataPropertyDef("BcrP50", "Edm.Double", nullable=True),
        ODataPropertyDef("PvCostsMean", "Edm.Double", nullable=False),
        ODataPropertyDef("PvBenefitsMean", "Edm.Double", nullable=False),
        ODataPropertyDef("DurationMs", "Edm.Double", nullable=False),
        ODataPropertyDef("CreatedAt", "Edm.DateTimeOffset", nullable=False),
    ),
    nav_properties=(
        ODataNavPropDef(
            name="Initiative",
            target_set="Initiatives",
            target_type=f"{ODATA_NS}.Initiative",
            is_collection=False,
            partner="SimulationRuns",
            fk_property="InitiativeId",
        ),
    ),
)

ENTITY_SET_DEFS: tuple[ODataEntitySetDef, ...] = (
    INITIATIVE_DEF,
    COST_BENEFIT_ITEM_DEF,
    YEARLY_CASH_FLOW_DEF,
    VALUE_STREAM_DEF,
    CATALOG_ENTRY_DEF,
    SIMULATION_RUN_DEF,
)
ENTITY_SET_BY_NAME: dict[str, ODataEntitySetDef] = {d.name: d for d in ENTITY_SET_DEFS}


def _finite_or_none(val: float | None) -> float | None:
    if val is None:
        return None
    f = float(val)
    return f if math.isfinite(f) else None


def build_csdl_metadata_xml() -> str:
    """Build OASIS OData v4.0 CSDL XML document describing all entity types and relationships."""
    lines = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0">',
        "  <edmx:DataServices>",
        f'    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="{ODATA_NS}">',
    ]

    for edef in ENTITY_SET_DEFS:
        lines.append(f'      <EntityType Name="{xml_escape(edef.entity_type)}">')
        lines.append("        <Key>")
        lines.append(f'          <PropertyRef Name="{xml_escape(edef.key_property)}" />')
        lines.append("        </Key>")
        for prop in edef.properties:
            nullable_attr = ' Nullable="false"' if not prop.nullable else ""
            lines.append(
                f'        <Property Name="{xml_escape(prop.name)}" Type="{xml_escape(prop.edm_type)}"{nullable_attr} />'
            )
        for nav in edef.nav_properties:
            partner_attr = f' Partner="{xml_escape(nav.partner)}"' if nav.partner else ""
            lines.append(
                f'        <NavigationProperty Name="{xml_escape(nav.name)}" Type="{xml_escape(nav.target_type)}"{partner_attr} />'
            )
        lines.append("      </EntityType>")

    lines.append('      <EntityContainer Name="Container">')
    for edef in ENTITY_SET_DEFS:
        if edef.nav_properties:
            lines.append(
                f'        <EntitySet Name="{xml_escape(edef.name)}" EntityType="{ODATA_NS}.{xml_escape(edef.entity_type)}">'
            )
            for nav in edef.nav_properties:
                lines.append(
                    f'          <NavigationPropertyBinding Path="{xml_escape(nav.name)}" Target="{xml_escape(nav.target_set)}" />'
                )
            lines.append("        </EntitySet>")
        else:
            lines.append(
                f'        <EntitySet Name="{xml_escape(edef.name)}" EntityType="{ODATA_NS}.{xml_escape(edef.entity_type)}" />'
            )
    lines.append("      </EntityContainer>")
    lines.append("    </Schema>")
    lines.append("  </edmx:DataServices>")
    lines.append("</edmx:Edmx>")
    return "\n".join(lines)


@dataclass
class ODataDataset:
    rows_by_set: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    by_key: dict[str, dict[str, dict[str, Any]]] = field(default_factory=dict)
    child_index: dict[tuple[str, str], dict[str, list[dict[str, Any]]]] = field(default_factory=dict)

    def resolve_navigation(
        self,
        source_def: ODataEntitySetDef,
        source_row: dict[str, Any],
        nav_def: ODataNavPropDef,
    ) -> list[dict[str, Any]] | dict[str, Any] | None:
        if nav_def.is_collection:
            src_key = str(source_row[source_def.key_property])
            return list(self.child_index.get((source_def.name, nav_def.name), {}).get(src_key, []))
        fk_prop = nav_def.fk_property
        if not fk_prop:
            return None
        target_key = source_row.get(fk_prop)
        if target_key is None:
            return None
        return self.by_key.get(nav_def.target_set, {}).get(str(target_key))


def load_odata_dataset(db_path: Path) -> ODataDataset:
    """Extract live initiatives, line items, cash flows, value streams, catalog, and runs into an OData dataset."""
    with get_connection(db_path) as conn:
        cat_rows = conn.execute(
            "SELECT * FROM catalog_entries ORDER BY is_builtin DESC, id ASC"
        ).fetchall()
        init_rows = conn.execute(
            "SELECT * FROM initiatives ORDER BY updated_at DESC, created_at DESC"
        ).fetchall()
        bca_rows = conn.execute(
            """
            SELECT * FROM initiative_bcas
            ORDER BY is_baseline DESC, sort_order ASC, created_at ASC
            """
        ).fetchall()
        item_rows = conn.execute(
            "SELECT * FROM initiative_items ORDER BY created_at ASC"
        ).fetchall()
        run_rows = conn.execute(
            "SELECT * FROM simulation_runs ORDER BY created_at DESC"
        ).fetchall()

    baseline_bca_by_init: dict[str, str] = {}
    for row in bca_rows:
        init_id = str(row["initiative_id"])
        if init_id not in baseline_bca_by_init:
            baseline_bca_by_init[init_id] = str(row["id"])

    catalog_map: dict[str, CatalogEntry] = {}
    catalog_entities: list[dict[str, Any]] = []
    for row in cat_rows:
        entry = _row_to_catalog_entry(row)
        catalog_map[entry.id] = entry
        catalog_entities.append(
            {
                "Id": entry.id,
                "Kind": entry.kind,
                "Name": entry.name,
                "Description": entry.description,
                "Domains": ", ".join(entry.domains),
                "ValueStreamStage": entry.value_stream_stage,
                "FormulaType": entry.formula_type,
                "FormulaDescription": entry.formula_description,
                "GuardrailNotes": entry.guardrail_notes,
                "IsBuiltin": bool(entry.is_builtin),
                "CreatedAt": entry.created_at,
            }
        )

    items_by_init: dict[str, list[dict[str, Any]]] = {}
    for row in item_rows:
        it = _row_to_item_dict(row)
        init_id = it["initiative_id"]
        baseline_id = baseline_bca_by_init.get(init_id)
        if baseline_id is not None and it.get("bca_id") not in (None, baseline_id):
            continue
        items_by_init.setdefault(init_id, []).append(it)

    runs_raw_by_init: dict[str, list[tuple[Any, SimulationResult]]] = {}
    for row in run_rows:
        init_id = str(row["initiative_id"])
        baseline_id = baseline_bca_by_init.get(init_id)
        run_bca_id = row["bca_id"] if "bca_id" in row.keys() else None
        if baseline_id is not None and run_bca_id not in (None, baseline_id):
            continue
        try:
            summary = SimulationResult.model_validate_json(row["summary_json"])
        except Exception:
            continue
        runs_raw_by_init.setdefault(init_id, []).append((row, summary))

    init_entities: list[dict[str, Any]] = []
    cb_entities: list[dict[str, Any]] = []
    flow_entities: list[dict[str, Any]] = []
    vs_entities: list[dict[str, Any]] = []
    run_entities: list[dict[str, Any]] = []

    cb_by_init: dict[str, list[dict[str, Any]]] = {}
    flows_by_init: dict[str, list[dict[str, Any]]] = {}
    vs_by_init: dict[str, list[dict[str, Any]]] = {}
    runs_by_init: dict[str, list[dict[str, Any]]] = {}

    for row in init_rows:
        init_d = _row_to_initiative_dict(row)
        init_id = init_d["id"]
        init_items = items_by_init.get(init_id, [])
        det, per_item_pv, per_item_base = run_deterministic(init_d, init_items, catalog_map)

        cost_start_year = init_d.get("cost_start_year")
        horizon_years = int(init_d["horizon_years"])
        cost_end_year = (cost_start_year + horizon_years - 1) if cost_start_year is not None else None

        init_runs = runs_raw_by_init.get(init_id, [])
        latest_mc = init_runs[0][1].monte_carlo if init_runs else None

        cost_count = 0
        benefit_count = 0
        for it in init_items:
            entry = catalog_map[it["catalog_id"]]
            if entry.kind == "cost":
                cost_count += 1
            else:
                benefit_count += 1

            pv_val = float(per_item_pv.get(it["id"], 0.0))
            signed_pv = -pv_val if entry.kind == "cost" else pv_val
            start_yr = int(it["start_year"])
            end_yr = int(it["end_year"])

            cb_row = {
                "Id": it["id"],
                "InitiativeId": init_id,
                "InitiativeName": init_d["name"],
                "InitiativeDomain": init_d["domain"],
                "CatalogId": it["catalog_id"],
                "CatalogName": entry.name,
                "Kind": entry.kind,
                "Label": it["label"],
                "ValueStream": it["value_stream"],
                "StartYear": start_yr,
                "EndYear": end_yr,
                "CalendarStartYear": (cost_start_year + start_yr - 1) if cost_start_year is not None else None,
                "CalendarEndYear": (cost_start_year + end_yr - 1) if cost_start_year is not None else None,
                "RampProfile": it["ramp_profile"],
                "BaseAnnualValue": float(per_item_base.get(it["id"], 0.0)),
                "PvTotal": pv_val,
                "SignedPvTotal": signed_pv,
                "AntiDoubleCountTag": it["anti_double_count_tag"],
                "FormulaType": entry.formula_type,
                "ParametersJson": row_json(it["param_values"]),
                "UncertaintyJson": row_json(it["uncertainty_spec"]),
                "CreatedAt": it["created_at"],
                "UpdatedAt": it["updated_at"],
            }
            cb_entities.append(cb_row)
            cb_by_init.setdefault(init_id, []).append(cb_row)

        for yf in det.yearly_cash_flows:
            flow_row = {
                "Id": f"{init_id}:Y{yf.year}",
                "InitiativeId": init_id,
                "InitiativeName": init_d["name"],
                "InitiativeDomain": init_d["domain"],
                "Year": int(yf.year),
                "CalendarYear": (cost_start_year + int(yf.year) - 1) if cost_start_year is not None else None,
                "UndiscountedCost": float(yf.undiscounted_cost),
                "UndiscountedBenefit": float(yf.undiscounted_benefit),
                "NetUndiscounted": float(yf.net_undiscounted),
                "PvCost": float(yf.pv_cost),
                "PvBenefit": float(yf.pv_benefit),
                "NetPv": float(yf.net_pv),
                "CumulativeUndiscountedNet": float(yf.cumulative_undiscounted_net),
                "CumulativeNetPv": float(yf.cumulative_net_pv),
            }
            flow_entities.append(flow_row)
            flows_by_init.setdefault(init_id, []).append(flow_row)

        for vs in det.value_streams:
            vs_row = {
                "Id": f"{init_id}::{vs.value_stream}",
                "InitiativeId": init_id,
                "InitiativeName": init_d["name"],
                "InitiativeDomain": init_d["domain"],
                "ValueStream": vs.value_stream,
                "ItemCount": int(vs.item_count),
                "PvCosts": float(vs.pv_costs),
                "PvBenefits": float(vs.pv_benefits),
                "Npv": float(vs.npv),
                "Bcr": _finite_or_none(vs.bcr),
            }
            vs_entities.append(vs_row)
            vs_by_init.setdefault(init_id, []).append(vs_row)

        for r_row, sim_res in init_runs:
            mc = sim_res.monte_carlo
            pv_costs_mean = (
                sum(float(vs.sim_pv_costs_mean or 0.0) for vs in mc.value_streams)
                if mc.value_streams
                else float(sim_res.deterministic.pv_costs)
            )
            pv_benefits_mean = (
                sum(float(vs.sim_pv_benefits_mean or 0.0) for vs in mc.value_streams)
                if mc.value_streams
                else float(sim_res.deterministic.pv_benefits)
            )
            run_entity = {
                "Id": r_row["id"],
                "InitiativeId": init_id,
                "InitiativeName": init_d["name"],
                "NSimulations": int(r_row["n_simulations"]),
                "DiscountRate": float(r_row["discount_rate"]),
                "HorizonYears": int(r_row["horizon_years"]),
                "Seed": int(r_row["seed"]) if r_row["seed"] is not None else None,
                "ProbNpvPositive": float(mc.prob_npv_positive),
                "ProbBcrGte1": float(mc.prob_bcr_ge_one),
                "NpvMean": float(mc.npv_stats.mean),
                "NpvStd": float(mc.npv_stats.std),
                "NpvP10": float(mc.npv_stats.p10),
                "NpvP50": float(mc.npv_stats.p50),
                "NpvP90": float(mc.npv_stats.p90),
                "BcrP50": _finite_or_none(mc.bcr_stats.p50 if mc.bcr_stats else None),
                "PvCostsMean": pv_costs_mean,
                "PvBenefitsMean": pv_benefits_mean,
                "DurationMs": float(sim_res.duration_ms),
                "CreatedAt": r_row["created_at"],
            }
            run_entities.append(run_entity)
            runs_by_init.setdefault(init_id, []).append(run_entity)

        init_entities.append(
            {
                "Id": init_id,
                "Name": init_d["name"],
                "Description": init_d["description"],
                "Domain": init_d["domain"],
                "HorizonYears": horizon_years,
                "DiscountRate": float(init_d["discount_rate"]),
                "CostStartYear": cost_start_year,
                "CostEndYear": cost_end_year,
                "ExternalResourceUrl": init_d.get("external_resource_url", ""),
                "ItemCount": len(init_items),
                "CostItemCount": cost_count,
                "BenefitItemCount": benefit_count,
                "PvCosts": float(det.pv_costs),
                "PvBenefits": float(det.pv_benefits),
                "Npv": float(det.npv),
                "Bcr": _finite_or_none(det.bcr),
                "DiscountedPaybackYear": _finite_or_none(det.discounted_payback_year),
                "GuardrailWarningCount": len(det.guardrail_warnings),
                "LatestSimProbNpvPositive": float(latest_mc.prob_npv_positive) if latest_mc else None,
                "LatestSimNpvP10": float(latest_mc.npv_stats.p10) if latest_mc else None,
                "LatestSimNpvP50": float(latest_mc.npv_stats.p50) if latest_mc else None,
                "LatestSimNpvP90": float(latest_mc.npv_stats.p90) if latest_mc else None,
                "CreatedAt": init_d["created_at"],
                "UpdatedAt": init_d["updated_at"],
            }
        )

    rows_by_set = {
        "Initiatives": init_entities,
        "CostBenefitItems": cb_entities,
        "YearlyCashFlows": flow_entities,
        "ValueStreams": vs_entities,
        "CatalogEntries": catalog_entities,
        "SimulationRuns": run_entities,
    }
    by_key: dict[str, dict[str, dict[str, Any]]] = {}
    for edef in ENTITY_SET_DEFS:
        by_key[edef.name] = {
            str(r[edef.key_property]): r for r in rows_by_set[edef.name]
        }

    child_index = {
        ("Initiatives", "CostBenefitItems"): cb_by_init,
        ("Initiatives", "YearlyCashFlows"): flows_by_init,
        ("Initiatives", "ValueStreams"): vs_by_init,
        ("Initiatives", "SimulationRuns"): runs_by_init,
    }
    return ODataDataset(rows_by_set=rows_by_set, by_key=by_key, child_index=child_index)


def row_json(obj: Any) -> str:
    import json

    return json.dumps(obj, separators=(",", ":"), sort_keys=True)


# --- Safe Recursive-Descent OData v4 $filter Lexer & Evaluator ---

_COMPARE_OPS = {"eq", "ne", "gt", "ge", "lt", "le"}
_STRING_FUNCS = {"contains", "startswith", "endswith", "tolower", "toupper", "length"}


@dataclass(frozen=True)
class _Token:
    kind: str  # IDENT, STRING, NUMBER, LPAREN, RPAREN, COMMA, EOF
    value: Any


def _tokenize_filter(expr: str) -> list[_Token]:
    if len(expr) > 2000:
        raise ODataError(400, "BadFilter", "$filter expression exceeds maximum length (2000 characters).")
    tokens: list[_Token] = []
    i = 0
    n = len(expr)
    while i < n:
        ch = expr[i]
        if ch.isspace():
            i += 1
            continue
        if ch == "(":
            tokens.append(_Token("LPAREN", "("))
            i += 1
            continue
        if ch == ")":
            tokens.append(_Token("RPAREN", ")"))
            i += 1
            continue
        if ch == ",":
            tokens.append(_Token("COMMA", ","))
            i += 1
            continue
        if ch == "'":
            i += 1
            buf: list[str] = []
            closed = False
            while i < n:
                if expr[i] == "'":
                    if i + 1 < n and expr[i + 1] == "'":
                        buf.append("'")
                        i += 2
                        continue
                    closed = True
                    i += 1
                    break
                buf.append(expr[i])
                i += 1
            if not closed:
                raise ODataError(400, "BadFilter", "Unterminated string literal in $filter.")
            tokens.append(_Token("STRING", "".join(buf)))
            continue
        if ch == "-" or ch.isdigit():
            start = i
            if ch == "-":
                i += 1
                if i >= n or not expr[i].isdigit():
                    raise ODataError(400, "BadFilter", f"Unexpected '-' at position {start} in $filter.")
            while i < n and expr[i].isdigit():
                i += 1
            is_float = False
            if i < n and expr[i] == ".":
                is_float = True
                i += 1
                if i >= n or not expr[i].isdigit():
                    raise ODataError(400, "BadFilter", "Invalid decimal number in $filter.")
                while i < n and expr[i].isdigit():
                    i += 1
            raw_num = expr[start:i]
            tokens.append(_Token("NUMBER", float(raw_num) if is_float else int(raw_num)))
            continue
        if ch.isalpha() or ch == "_":
            start = i
            while i < n and (expr[i].isalnum() or expr[i] == "_"):
                i += 1
            tokens.append(_Token("IDENT", expr[start:i]))
            continue
        raise ODataError(400, "BadFilter", f"Unexpected character '{ch}' at position {i} in $filter.")

    tokens.append(_Token("EOF", None))
    return tokens


class _FilterParser:
    """Parse an OData $filter token stream into a predicate callable."""

    def __init__(self, tokens: list[_Token], valid_props: dict[str, ODataPropertyDef]) -> None:
        self.tokens = tokens
        self.pos = 0
        self.valid_props = valid_props

    def _peek(self) -> _Token:
        return self.tokens[self.pos]

    def _advance(self) -> _Token:
        tok = self.tokens[self.pos]
        self.pos += 1
        return tok

    def _expect(self, kind: str) -> _Token:
        tok = self._peek()
        if tok.kind != kind:
            raise ODataError(400, "BadFilter", f"Expected {kind} in $filter, got {tok.kind}.")
        return self._advance()

    def parse(self):
        fn = self._parse_or()
        if self._peek().kind != "EOF":
            raise ODataError(400, "BadFilter", f"Unexpected token '{self._peek().value}' in $filter.")
        return lambda row: bool(fn(row))

    def _parse_or(self):
        left = self._parse_and()
        while self._peek().kind == "IDENT" and str(self._peek().value).lower() == "or":
            self._advance()
            right = self._parse_and()
            prev_left, prev_right = left, right
            left = lambda row, l=prev_left, r=prev_right: bool(l(row)) or bool(r(row))
        return left

    def _parse_and(self):
        left = self._parse_not()
        while self._peek().kind == "IDENT" and str(self._peek().value).lower() == "and":
            self._advance()
            right = self._parse_not()
            prev_left, prev_right = left, right
            left = lambda row, l=prev_left, r=prev_right: bool(l(row)) and bool(r(row))
        return left

    def _parse_not(self):
        if self._peek().kind == "IDENT" and str(self._peek().value).lower() == "not":
            self._advance()
            operand = self._parse_not()
            return lambda row, op=operand: not bool(op(row))
        return self._parse_comparison()

    def _parse_comparison(self):
        left = self._parse_primary()
        if self._peek().kind == "IDENT" and str(self._peek().value).lower() in _COMPARE_OPS:
            op = str(self._advance().value).lower()
            right = self._parse_primary()
            return lambda row, l=left, r=right, o=op: _eval_compare(o, l(row), r(row))
        return left

    def _parse_primary(self):
        tok = self._peek()
        if tok.kind == "LPAREN":
            self._advance()
            inner = self._parse_or()
            self._expect("RPAREN")
            return inner
        if tok.kind in ("STRING", "NUMBER"):
            self._advance()
            val = tok.value
            return lambda _row, v=val: v
        if tok.kind == "IDENT":
            self._advance()
            raw_ident = str(tok.value)
            lower = raw_ident.lower()

            if self._peek().kind == "LPAREN":
                if lower not in _STRING_FUNCS:
                    raise ODataError(400, "BadFilter", f"Unsupported function '{raw_ident}' in $filter.")
                self._advance()
                arg1 = self._parse_or()
                if lower in ("contains", "startswith", "endswith"):
                    self._expect("COMMA")
                    arg2 = self._parse_or()
                    self._expect("RPAREN")
                    return _build_binary_str_fn(lower, arg1, arg2)
                self._expect("RPAREN")
                if lower == "tolower":
                    return lambda row, a=arg1: (lambda v: str(v).lower() if v is not None else None)(a(row))
                if lower == "toupper":
                    return lambda row, a=arg1: (lambda v: str(v).upper() if v is not None else None)(a(row))
                return lambda row, a=arg1: (lambda v: len(str(v)) if v is not None else 0)(a(row))

            if lower == "true":
                return lambda _row: True
            if lower == "false":
                return lambda _row: False
            if lower == "null":
                return lambda _row: None

            if raw_ident not in self.valid_props:
                raise ODataError(400, "BadFilter", f"Unknown property '{raw_ident}' in $filter.")
            return lambda row, key=raw_ident: row.get(key)

        raise ODataError(400, "BadFilter", f"Unexpected token '{tok.value}' in $filter.")


def _build_binary_str_fn(func_name: str, arg1, arg2):
    def _fn(row: dict[str, Any]) -> bool:
        a = arg1(row)
        b = arg2(row)
        if a is None or b is None:
            return False
        sa = str(a)
        sb = str(b)
        if func_name == "contains":
            return sb in sa
        if func_name == "startswith":
            return sa.startswith(sb)
        return sa.endswith(sb)

    return _fn


def _eval_compare(op: str, left: Any, right: Any) -> bool:
    if op == "eq":
        if type(left) is bool or type(right) is bool:
            return left is right
        return left == right
    if op == "ne":
        if type(left) is bool or type(right) is bool:
            return left is not right
        return left != right
    if left is None or right is None:
        return False
    try:
        if op == "gt":
            return bool(left > right)
        if op == "ge":
            return bool(left >= right)
        if op == "lt":
            return bool(left < right)
        if op == "le":
            return bool(left <= right)
    except TypeError as exc:
        raise ODataError(
            400,
            "BadFilter",
            f"Incompatible types for '{op}' comparison ({type(left).__name__} vs {type(right).__name__}).",
        ) from exc
    return False


def compile_filter(expr: str, entity_def: ODataEntitySetDef):
    tokens = _tokenize_filter(expr)
    return _FilterParser(tokens, entity_def.property_map).parse()


# --- Query Option Parsers ($select, $orderby, $expand, $top, $skip, $count) ---


def parse_select(raw: str | None, entity_def: ODataEntitySetDef) -> list[str] | None:
    if raw is None or not raw.strip():
        return None
    fields: list[str] = []
    valid = entity_def.property_map
    for part in raw.split(","):
        prop = part.strip()
        if not prop:
            continue
        if prop == "*":
            return None
        if prop not in valid:
            raise ODataError(
                400,
                "BadSelect",
                f"Unknown property '{prop}' in $select for entity set '{entity_def.name}'.",
            )
        if prop not in fields:
            fields.append(prop)
    if not fields:
        raise ODataError(400, "BadSelect", "$select cannot be empty.")
    return fields


def parse_orderby(raw: str | None, entity_def: ODataEntitySetDef) -> list[tuple[str, bool]]:
    if raw is None or not raw.strip():
        return []
    clauses: list[tuple[str, bool]] = []
    valid = entity_def.property_map
    for part in raw.split(","):
        cleaned = part.strip()
        if not cleaned:
            continue
        pieces = cleaned.split()
        if len(pieces) > 2:
            raise ODataError(400, "BadOrderBy", f"Invalid $orderby clause '{cleaned}'.")
        prop = pieces[0]
        if prop not in valid:
            raise ODataError(
                400,
                "BadOrderBy",
                f"Unknown property '{prop}' in $orderby for entity set '{entity_def.name}'.",
            )
        direction = pieces[1].lower() if len(pieces) == 2 else "asc"
        if direction not in ("asc", "desc"):
            raise ODataError(400, "BadOrderBy", f"Invalid sort direction '{pieces[1]}' in $orderby.")
        clauses.append((prop, direction == "desc"))
    return clauses


@dataclass(frozen=True)
class ExpandClause:
    nav_name: str
    filter_expr: str | None = None
    select_raw: str | None = None
    orderby_raw: str | None = None
    top: int | None = None
    skip: int = 0


def _split_top_level(text: str, sep: str = ",") -> list[str]:
    parts: list[str] = []
    buf: list[str] = []
    depth = 0
    in_quotes = False
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "'":
            if in_quotes and i + 1 < n and text[i + 1] == "'":
                buf.append("''")
                i += 2
                continue
            in_quotes = not in_quotes
            buf.append(ch)
        elif not in_quotes:
            if ch == "(":
                depth += 1
                buf.append(ch)
            elif ch == ")":
                depth -= 1
                if depth < 0:
                    raise ODataError(400, "BadExpand", "Unmatched ')' in $expand.")
                buf.append(ch)
            elif ch == sep and depth == 0:
                parts.append("".join(buf))
                buf = []
            else:
                buf.append(ch)
        else:
            buf.append(ch)
        i += 1
    if in_quotes or depth != 0:
        raise ODataError(400, "BadExpand", "Unterminated quote or parenthesis in $expand.")
    parts.append("".join(buf))
    return [p.strip() for p in parts if p.strip()]


def parse_expand(raw: str | None, entity_def: ODataEntitySetDef) -> list[ExpandClause]:
    if raw is None or not raw.strip():
        return []
    nav_map = entity_def.nav_map
    clauses: list[ExpandClause] = []
    for item in _split_top_level(raw, ","):
        if "(" in item:
            if not item.endswith(")"):
                raise ODataError(400, "BadExpand", f"Malformed $expand clause '{item}'.")
            idx = item.index("(")
            nav_name = item[:idx].strip()
            inner = item[idx + 1 : -1].strip()
        else:
            nav_name = item.strip()
            inner = ""

        if nav_name not in nav_map:
            raise ODataError(
                400,
                "BadExpand",
                f"Unknown navigation property '{nav_name}' on entity set '{entity_def.name}'.",
            )

        filter_expr: str | None = None
        select_raw: str | None = None
        orderby_raw: str | None = None
        top_val: int | None = None
        skip_val = 0

        if inner:
            sep = ";" if ";" in inner else "&"
            for opt in _split_top_level(inner, sep):
                if "=" not in opt:
                    raise ODataError(400, "BadExpand", f"Invalid $expand option '{opt}'.")
                k, v = opt.split("=", 1)
                k = k.strip()
                v = v.strip()
                if k == "$filter":
                    filter_expr = v
                elif k == "$select":
                    select_raw = v
                elif k == "$orderby":
                    orderby_raw = v
                elif k == "$top":
                    top_val = parse_nonneg_int(v, "$top", max_val=MAX_PAGE_SIZE)
                elif k == "$skip":
                    skip_val = parse_nonneg_int(v, "$skip")
                elif k == "$count":
                    continue
                else:
                    raise ODataError(400, "BadExpand", f"Unsupported nested option '{k}' in $expand.")

        clauses.append(
            ExpandClause(
                nav_name=nav_name,
                filter_expr=filter_expr,
                select_raw=select_raw,
                orderby_raw=orderby_raw,
                top=top_val,
                skip=skip_val,
            )
        )
    return clauses


def parse_nonneg_int(raw: str | None, param_name: str, *, max_val: int | None = None) -> int:
    if raw is None or not raw.strip():
        return 0
    try:
        val = int(raw)
    except ValueError as exc:
        raise ODataError(400, "BadQuery", f"{param_name} must be an integer.") from exc
    if val < 0:
        raise ODataError(400, "BadQuery", f"{param_name} must be >= 0.")
    if max_val is not None and val > max_val:
        raise ODataError(400, "BadQuery", f"{param_name} cannot exceed {max_val}.")
    return val


def parse_bool_param(raw: str | None, param_name: str) -> bool:
    if raw is None or not raw.strip():
        return False
    low = raw.strip().lower()
    if low == "true":
        return True
    if low == "false":
        return False
    raise ODataError(400, "BadQuery", f"{param_name} must be 'true' or 'false'.")


def _sort_rows(rows: list[dict[str, Any]], order_clauses: list[tuple[str, bool]]) -> list[dict[str, Any]]:
    if not order_clauses:
        return list(rows)
    out = list(rows)
    for prop, desc in reversed(order_clauses):
        out.sort(
            key=lambda r, p=prop: (0, "") if r.get(p) is None else (1, r[p]),
            reverse=desc,
        )
    return out


def _project_and_expand_row(
    row: dict[str, Any],
    entity_def: ODataEntitySetDef,
    dataset: ODataDataset,
    select_fields: list[str] | None,
    expand_clauses: list[ExpandClause],
) -> dict[str, Any]:
    if select_fields is not None:
        out: dict[str, Any] = {k: row[k] for k in select_fields}
    else:
        out = dict(row)

    for exp in expand_clauses:
        nav_def = entity_def.nav_map[exp.nav_name]
        target_def = ENTITY_SET_BY_NAME[nav_def.target_set]
        related = dataset.resolve_navigation(entity_def, row, nav_def)
        if nav_def.is_collection:
            items = list(related) if isinstance(related, list) else []
            if exp.filter_expr:
                pred = compile_filter(exp.filter_expr, target_def)
                items = [r for r in items if pred(r)]
            if exp.orderby_raw:
                items = _sort_rows(items, parse_orderby(exp.orderby_raw, target_def))
            if exp.skip:
                items = items[exp.skip :]
            if exp.top is not None:
                items = items[: exp.top]
            sub_select = parse_select(exp.select_raw, target_def)
            if sub_select is not None:
                items = [{k: r[k] for k in sub_select} for r in items]
            else:
                items = [dict(r) for r in items]
            out[exp.nav_name] = items
        else:
            if related is None:
                out[exp.nav_name] = None
            else:
                sub_select = parse_select(exp.select_raw, target_def)
                out[exp.nav_name] = (
                    {k: related[k] for k in sub_select} if sub_select is not None else dict(related)
                )
    return out


def _build_context_url(
    service_root: str,
    target_set_name: str,
    select_fields: list[str] | None,
    *,
    is_single_entity: bool = False,
) -> str:
    select_suffix = f"({','.join(select_fields)})" if select_fields else ""
    entity_suffix = "/$entity" if is_single_entity else ""
    return f"{service_root}/$metadata#{target_set_name}{select_suffix}{entity_suffix}"


def _build_next_link(
    service_root: str,
    resource_rel_path: str,
    query_params: dict[str, str],
    next_skip: int,
) -> str:
    merged = {k: v for k, v in query_params.items() if k != "$skip"}
    merged["$skip"] = str(next_skip)
    qs = "&".join(f"{quote(k, safe='$')}={quote(str(v), safe='')}" for k, v in merged.items())
    return f"{service_root}/{resource_rel_path}?{qs}"


@dataclass(frozen=True)
class ParsedODataPath:
    kind: str  # "collection" | "collection_count" | "entity" | "nav" | "nav_count"
    entity_set: str
    key: str | None = None
    nav_property: str | None = None


def parse_odata_path(resource_path: str) -> ParsedODataPath:
    cleaned = resource_path.strip("/")
    if not cleaned:
        raise ODataError(404, "NotFound", "Resource path cannot be empty.")

    segments = [s for s in cleaned.split("/") if s]
    first = segments[0]

    # Single entity lookup: EntitySet('key') or EntitySet(Id='key')
    if "(" in first:
        if not first.endswith(")"):
            raise ODataError(404, "NotFound", f"Malformed resource segment '{first}'.")
        idx = first.index("(")
        set_name = first[:idx]
        key_expr = first[idx + 1 : -1].strip()
        if set_name not in ENTITY_SET_BY_NAME:
            raise ODataError(404, "NotFound", f"Entity set '{set_name}' does not exist.")
        key_val = _parse_entity_key_expr(key_expr, ENTITY_SET_BY_NAME[set_name])

        if len(segments) == 1:
            return ParsedODataPath(kind="entity", entity_set=set_name, key=key_val)
        if len(segments) == 2:
            nav_name = segments[1]
            if nav_name not in ENTITY_SET_BY_NAME[set_name].nav_map:
                raise ODataError(
                    404,
                    "NotFound",
                    f"Navigation property '{nav_name}' not found on '{set_name}'.",
                )
            return ParsedODataPath(kind="nav", entity_set=set_name, key=key_val, nav_property=nav_name)
        if len(segments) == 3 and segments[2] == "$count":
            nav_name = segments[1]
            if nav_name not in ENTITY_SET_BY_NAME[set_name].nav_map:
                raise ODataError(
                    404,
                    "NotFound",
                    f"Navigation property '{nav_name}' not found on '{set_name}'.",
                )
            return ParsedODataPath(kind="nav_count", entity_set=set_name, key=key_val, nav_property=nav_name)
        raise ODataError(404, "NotFound", f"Unsupported OData path '/{cleaned}'.")

    # Collection lookup: EntitySet or EntitySet/$count
    set_name = first
    if set_name not in ENTITY_SET_BY_NAME:
        raise ODataError(404, "NotFound", f"Entity set '{set_name}' does not exist.")
    if len(segments) == 1:
        return ParsedODataPath(kind="collection", entity_set=set_name)
    if len(segments) == 2 and segments[1] == "$count":
        return ParsedODataPath(kind="collection_count", entity_set=set_name)
    raise ODataError(404, "NotFound", f"Unsupported OData path '/{cleaned}'.")


def _parse_entity_key_expr(expr: str, edef: ODataEntitySetDef) -> str:
    raw = expr.strip()
    if "=" in raw:
        lhs, rhs = raw.split("=", 1)
        if lhs.strip() != edef.key_property:
            raise ODataError(
                400,
                "BadKey",
                f"Invalid key predicate '{expr}'; expected key '{edef.key_property}'.",
            )
        raw = rhs.strip()
    if len(raw) >= 2 and raw.startswith("'") and raw.endswith("'"):
        raw = raw[1:-1].replace("''", "'")
    return unquote(raw)


def execute_odata_query(
    db_path: Path,
    *,
    resource_path: str,
    query_params: dict[str, str],
    service_root: str,
) -> tuple[Any, str]:
    """Execute an OData v4 GET query and return (payload_or_int, content_kind: 'json'|'count')."""
    parsed = parse_odata_path(resource_path)
    dataset = load_odata_dataset(db_path)
    source_def = ENTITY_SET_BY_NAME[parsed.entity_set]

    filter_raw = query_params.get("$filter")
    select_raw = query_params.get("$select")
    orderby_raw = query_params.get("$orderby")
    expand_raw = query_params.get("$expand")
    top_raw = query_params.get("$top")
    skip_raw = query_params.get("$skip")
    count_raw = query_params.get("$count")

    if parsed.kind == "collection_count":
        rows = list(dataset.rows_by_set[source_def.name])
        if filter_raw:
            pred = compile_filter(filter_raw, source_def)
            rows = [r for r in rows if pred(r)]
        return len(rows), "count"

    if parsed.kind == "entity":
        assert parsed.key is not None
        entity = dataset.by_key[source_def.name].get(parsed.key)
        if entity is None:
            raise ODataError(
                404,
                "NotFound",
                f"Entity '{parsed.key}' not found in '{source_def.name}'.",
            )
        select_fields = parse_select(select_raw, source_def)
        expand_clauses = parse_expand(expand_raw, source_def)
        projected = _project_and_expand_row(entity, source_def, dataset, select_fields, expand_clauses)
        projected["@odata.context"] = _build_context_url(
            service_root, source_def.name, select_fields, is_single_entity=True
        )
        return projected, "json"

    if parsed.kind in ("nav", "nav_count"):
        assert parsed.key is not None and parsed.nav_property is not None
        parent = dataset.by_key[source_def.name].get(parsed.key)
        if parent is None:
            raise ODataError(
                404,
                "NotFound",
                f"Entity '{parsed.key}' not found in '{source_def.name}'.",
            )
        nav_def = source_def.nav_map[parsed.nav_property]
        target_def = ENTITY_SET_BY_NAME[nav_def.target_set]
        related = dataset.resolve_navigation(source_def, parent, nav_def)

        if not nav_def.is_collection:
            if parsed.kind == "nav_count":
                raise ODataError(400, "BadQuery", "$count is only supported on collection navigation properties.")
            if related is None or not isinstance(related, dict):
                raise ODataError(
                    404,
                    "NotFound",
                    f"Related '{nav_def.name}' not found for '{source_def.name}({parsed.key})'.",
                )
            select_fields = parse_select(select_raw, target_def)
            expand_clauses = parse_expand(expand_raw, target_def)
            projected = _project_and_expand_row(related, target_def, dataset, select_fields, expand_clauses)
            projected["@odata.context"] = _build_context_url(
                service_root, target_def.name, select_fields, is_single_entity=True
            )
            return projected, "json"

        rows = list(related) if isinstance(related, list) else []
        if filter_raw:
            pred = compile_filter(filter_raw, target_def)
            rows = [r for r in rows if pred(r)]
        if parsed.kind == "nav_count":
            return len(rows), "count"

        return _format_collection_result(
            rows=rows,
            entity_def=target_def,
            dataset=dataset,
            service_root=service_root,
            resource_rel_path=resource_path.strip("/"),
            query_params=query_params,
            select_raw=select_raw,
            orderby_raw=orderby_raw,
            expand_raw=expand_raw,
            top_raw=top_raw,
            skip_raw=skip_raw,
            count_raw=count_raw,
        ), "json"

    # Collection: EntitySet
    rows = list(dataset.rows_by_set[source_def.name])
    if filter_raw:
        pred = compile_filter(filter_raw, source_def)
        rows = [r for r in rows if pred(r)]

    return _format_collection_result(
        rows=rows,
        entity_def=source_def,
        dataset=dataset,
        service_root=service_root,
        resource_rel_path=source_def.name,
        query_params=query_params,
        select_raw=select_raw,
        orderby_raw=orderby_raw,
        expand_raw=expand_raw,
        top_raw=top_raw,
        skip_raw=skip_raw,
        count_raw=count_raw,
    ), "json"


def _format_collection_result(
    *,
    rows: list[dict[str, Any]],
    entity_def: ODataEntitySetDef,
    dataset: ODataDataset,
    service_root: str,
    resource_rel_path: str,
    query_params: dict[str, str],
    select_raw: str | None,
    orderby_raw: str | None,
    expand_raw: str | None,
    top_raw: str | None,
    skip_raw: str | None,
    count_raw: str | None,
) -> dict[str, Any]:
    include_count = parse_bool_param(count_raw, "$count")
    select_fields = parse_select(select_raw, entity_def)
    order_clauses = parse_orderby(orderby_raw, entity_def)
    expand_clauses = parse_expand(expand_raw, entity_def)
    skip_val = parse_nonneg_int(skip_raw, "$skip")
    top_val = parse_nonneg_int(top_raw, "$top", max_val=MAX_PAGE_SIZE) if top_raw is not None else None

    ordered = _sort_rows(rows, order_clauses)
    total_filtered = len(ordered)
    after_skip = ordered[skip_val:]

    limit = top_val if top_val is not None else DEFAULT_PAGE_SIZE
    page_rows = after_skip[:limit]
    has_more = (top_val is None) and (len(after_skip) > limit)

    value = [
        _project_and_expand_row(r, entity_def, dataset, select_fields, expand_clauses)
        for r in page_rows
    ]

    payload: dict[str, Any] = {
        "@odata.context": _build_context_url(service_root, entity_def.name, select_fields),
    }
    if include_count:
        payload["@odata.count"] = total_filtered
    payload["value"] = value
    if has_more:
        payload["@odata.nextLink"] = _build_next_link(
            service_root, resource_rel_path, query_params, skip_val + limit
        )
    return payload


def build_service_document(service_root: str) -> dict[str, Any]:
    return {
        "@odata.context": f"{service_root}/$metadata",
        "value": [
            {"name": edef.name, "kind": "EntitySet", "url": edef.name}
            for edef in ENTITY_SET_DEFS
        ],
    }


def get_odata_entity_summaries(db_path: Path) -> list[dict[str, Any]]:
    dataset = load_odata_dataset(db_path)
    return [
        {
            "name": edef.name,
            "entity_type": f"{ODATA_NS}.{edef.entity_type}",
            "key_property": edef.key_property,
            "description": edef.description,
            "row_count": len(dataset.rows_by_set[edef.name]),
            "navigation_properties": [n.name for n in edef.nav_properties],
        }
        for edef in ENTITY_SET_DEFS
    ]
