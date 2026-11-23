"""Repository queries and domain-level persistence operations."""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from app.config import (
    get_env_api_keys,
    get_sso_env_config,
    is_api_keys_env_managed,
    is_sso_env_managed,
)
from app.core.catalog import describe_formula
from app.core.engine import run_deterministic
from app.db.database import get_connection
from app.models import (
    ApiKeyCreatedOut,
    ApiKeyOut,
    AuthUserOut,
    BCAComparisonRecord,
    BCAComparisonResult,
    BCACreate,
    BCADetail,
    BCASummary,
    BCAUpdate,
    CatalogEntry,
    CatalogEntryCreate,
    CatalogParameter,
    InitiativeCreate,
    InitiativeDetail,
    InitiativeItemCreate,
    InitiativeItemOut,
    InitiativeItemUpdate,
    InitiativeSummary,
    InitiativeUpdate,
    LLMSettingsOut,
    LLMSettingsUpdate,
    RoleCreate,
    RoleOut,
    RoleUpdate,
    SSOPublicConfigOut,
    SSOProvider,
    SSOSettingsOut,
    SSOSettingsUpdate,
    SimulationResult,
    SimulationRunRecord,
    UncertaintySpec,
    UserCreate,
    UserOut,
    UserUpdate,
)


class ConflictError(Exception):
    """Raised on duplicate unique resource ID."""


class NotFoundError(Exception):
    """Raised when a requested entity does not exist."""


class ValidationError(Exception):
    """Raised on domain validation rule violations."""


class ForbiddenError(Exception):
    """Raised when an authenticated principal lacks authorization."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_catalog_entry(row: sqlite3.Row) -> CatalogEntry:
    params = [CatalogParameter.model_validate(p) for p in json.loads(row["parameters_json"])]
    formula_type = row["formula_type"]
    return CatalogEntry(
        id=row["id"],
        kind=row["kind"],
        name=row["name"],
        description=row["description"],
        domains=json.loads(row["domains_json"]),
        value_stream_stage=row["value_stream_stage"],
        parameters=params,
        formula_type=formula_type,
        formula_description=describe_formula(formula_type),
        guardrail_notes=row["guardrail_notes"],
        is_builtin=bool(row["is_builtin"]),
        created_at=row["created_at"],
    )


def _row_to_item_dict(row: sqlite3.Row) -> dict[str, Any]:
    keys = row.keys()
    return {
        "id": row["id"],
        "initiative_id": row["initiative_id"],
        "bca_id": row["bca_id"] if "bca_id" in keys else None,
        "catalog_id": row["catalog_id"],
        "label": row["label"],
        "value_stream": row["value_stream"],
        "start_year": int(row["start_year"]),
        "end_year": int(row["end_year"]),
        "ramp_profile": row["ramp_profile"],
        "ramp_weights": json.loads(row["ramp_weights_json"]) if row["ramp_weights_json"] else None,
        "param_values": json.loads(row["param_values_json"]),
        "uncertainty_spec": json.loads(row["uncertainty_spec_json"]),
        "anti_double_count_tag": row["anti_double_count_tag"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _row_to_bca_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "initiative_id": row["initiative_id"],
        "name": row["name"],
        "description": row["description"] or "",
        "horizon_years": int(row["horizon_years"]),
        "discount_rate": float(row["discount_rate"]),
        "cost_start_year": int(row["cost_start_year"]) if row["cost_start_year"] is not None else None,
        "is_baseline": bool(row["is_baseline"]),
        "sort_order": int(row["sort_order"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _row_to_initiative_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "domain": row["domain"],
        "horizon_years": int(row["horizon_years"]),
        "discount_rate": float(row["discount_rate"]),
        "cost_start_year": int(row["cost_start_year"]) if row["cost_start_year"] is not None else None,
        "external_resource_url": row["external_resource_url"] or "",
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _load_catalog_map(conn: sqlite3.Connection) -> dict[str, CatalogEntry]:
    rows = conn.execute("SELECT * FROM catalog_entries ORDER BY is_builtin DESC, id ASC").fetchall()
    return {r["id"]: _row_to_catalog_entry(r) for r in rows}


def _validate_item_against_context(
    *,
    horizon_years: int,
    catalog_entry: CatalogEntry,
    start_year: int,
    end_year: int,
    ramp_profile: str,
    ramp_weights: list[float] | None,
    param_values: dict[str, float],
) -> dict[str, float]:
    if start_year > end_year:
        raise ValidationError("start_year cannot be greater than end_year.")
    if end_year > horizon_years:
        raise ValidationError(f"end_year ({end_year}) cannot exceed initiative horizon_years ({horizon_years}).")
    if ramp_profile == "custom_weights":
        expected = end_year - start_year + 1
        if not ramp_weights or len(ramp_weights) != expected:
            raise ValidationError(
                f"custom_weights requires exactly {expected} weights for years {start_year}..{end_year}."
            )

    normalized_params: dict[str, float] = {}
    param_by_key = {p.key: p for p in catalog_entry.parameters}
    for key, p in param_by_key.items():
        if key in param_values:
            val = float(param_values[key])
        elif p.required:
            val = float(p.default_value)
        else:
            val = float(p.default_value)

        if p.min_value is not None and val < p.min_value:
            raise ValidationError(f"Parameter '{key}' ({val}) must be >= {p.min_value}.")
        if p.max_value is not None and val > p.max_value:
            raise ValidationError(f"Parameter '{key}' ({val}) must be <= {p.max_value}.")
        normalized_params[key] = val

    return normalized_params


# --- Catalog operations ---


def list_catalog(
    db_path: Path,
    *,
    domain: str | None = None,
    kind: str | None = None,
    search: str | None = None,
) -> list[CatalogEntry]:
    with get_connection(db_path) as conn:
        query = "SELECT * FROM catalog_entries WHERE 1=1"
        params: list[Any] = []
        if kind:
            query += " AND kind = ?"
            params.append(kind)
        query += " ORDER BY kind ASC, is_builtin DESC, id ASC"
        rows = conn.execute(query, params).fetchall()
        entries = [_row_to_catalog_entry(r) for r in rows]

    if domain:
        target = domain.strip().lower()
        entries = [e for e in entries if target in e.domains]
    if search:
        q = search.strip().lower()
        entries = [
            e
            for e in entries
            if q in e.id.lower() or q in e.name.lower() or q in e.description.lower()
        ]
    return entries


def create_catalog_entry(db_path: Path, payload: CatalogEntryCreate) -> CatalogEntry:
    now = _now_iso()
    with get_connection(db_path) as conn:
        existing = conn.execute("SELECT id FROM catalog_entries WHERE id = ?", (payload.id,)).fetchone()
        if existing:
            raise ConflictError(f"Catalog entry '{payload.id}' already exists.")
        conn.execute(
            """
            INSERT INTO catalog_entries (
                id, kind, name, description, domains_json, value_stream_stage,
                parameters_json, formula_type, guardrail_notes, is_builtin, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
            """,
            (
                payload.id,
                payload.kind,
                payload.name.strip(),
                payload.description.strip(),
                json.dumps(payload.domains),
                payload.value_stream_stage.strip() if payload.value_stream_stage else None,
                json.dumps([p.model_dump() for p in payload.parameters]),
                payload.formula_type.strip(),
                payload.guardrail_notes.strip(),
                now,
            ),
        )
        row = conn.execute("SELECT * FROM catalog_entries WHERE id = ?", (payload.id,)).fetchone()
        assert row is not None
        return _row_to_catalog_entry(row)


# --- Initiative & BCA operations ---


def _ensure_baseline_bca(conn: sqlite3.Connection, init_dict: dict[str, Any]) -> dict[str, Any]:
    row = conn.execute(
        """
        SELECT * FROM initiative_bcas
        WHERE initiative_id = ?
        ORDER BY is_baseline DESC, sort_order ASC, created_at ASC
        LIMIT 1
        """,
        (init_dict["id"],),
    ).fetchone()
    if row is not None:
        return _row_to_bca_dict(row)

    bca_id = str(uuid4())
    now = _now_iso()
    conn.execute(
        """
        INSERT INTO initiative_bcas (
            id, initiative_id, name, description, horizon_years, discount_rate,
            cost_start_year, is_baseline, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
        """,
        (
            bca_id,
            init_dict["id"],
            "Baseline BCA",
            init_dict["description"],
            init_dict["horizon_years"],
            init_dict["discount_rate"],
            init_dict["cost_start_year"],
            now,
            now,
        ),
    )
    conn.execute(
        "UPDATE initiative_items SET bca_id = ? WHERE initiative_id = ? AND bca_id IS NULL",
        (bca_id, init_dict["id"]),
    )
    conn.execute(
        "UPDATE simulation_runs SET bca_id = ? WHERE initiative_id = ? AND bca_id IS NULL",
        (bca_id, init_dict["id"]),
    )
    created = conn.execute("SELECT * FROM initiative_bcas WHERE id = ?", (bca_id,)).fetchone()
    assert created is not None
    return _row_to_bca_dict(created)


def _resolve_bca_dict(
    conn: sqlite3.Connection, init_dict: dict[str, Any], bca_id: str | None = None
) -> dict[str, Any]:
    if bca_id is None:
        return _ensure_baseline_bca(conn, init_dict)
    row = conn.execute(
        "SELECT * FROM initiative_bcas WHERE id = ? AND initiative_id = ?",
        (bca_id, init_dict["id"]),
    ).fetchone()
    if row is None:
        raise NotFoundError(f"BCA '{bca_id}' not found on initiative '{init_dict['id']}'.")
    return _row_to_bca_dict(row)


def _load_latest_runs_by_bca(
    conn: sqlite3.Connection, initiative_id: str | None = None
) -> dict[tuple[str, str | None], SimulationResult]:
    if initiative_id is not None:
        rows = conn.execute(
            """
            SELECT initiative_id, bca_id, summary_json
            FROM simulation_runs
            WHERE initiative_id = ?
            ORDER BY created_at DESC
            """,
            (initiative_id,),
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT initiative_id, bca_id, summary_json
            FROM simulation_runs
            ORDER BY created_at DESC
            """
        ).fetchall()

    latest: dict[tuple[str, str | None], SimulationResult] = {}
    for row in rows:
        key = (str(row["initiative_id"]), row["bca_id"])
        if key in latest:
            continue
        try:
            latest[key] = SimulationResult.model_validate_json(row["summary_json"])
        except Exception:
            continue
    return latest


def _build_bca_summary(
    bca_dict: dict[str, Any],
    item_dicts: list[dict[str, Any]],
    catalog_map: dict[str, CatalogEntry],
    latest_run: SimulationResult | None = None,
) -> BCASummary:
    det, _, _ = run_deterministic(bca_dict, item_dicts, catalog_map)
    mc = latest_run.monte_carlo if latest_run else None
    return BCASummary(
        id=bca_dict["id"],
        initiative_id=bca_dict["initiative_id"],
        name=bca_dict["name"],
        description=bca_dict["description"],
        horizon_years=bca_dict["horizon_years"],
        discount_rate=bca_dict["discount_rate"],
        cost_start_year=bca_dict["cost_start_year"],
        is_baseline=bca_dict["is_baseline"],
        sort_order=bca_dict["sort_order"],
        item_count=len(item_dicts),
        pv_costs=det.pv_costs,
        pv_benefits=det.pv_benefits,
        npv=det.npv,
        bcr=det.bcr,
        discounted_payback_year=det.discounted_payback_year,
        guardrail_warning_count=len(det.guardrail_warnings),
        latest_run_id=latest_run.run_id if latest_run else None,
        latest_run_created_at=latest_run.created_at if latest_run else None,
        latest_prob_npv_positive=mc.prob_npv_positive if mc else None,
        latest_prob_bcr_ge_one=mc.prob_bcr_ge_one if mc else None,
        latest_npv_p10=mc.npv_stats.p10 if mc else None,
        latest_npv_p50=mc.npv_stats.p50 if mc else None,
        latest_npv_p90=mc.npv_stats.p90 if mc else None,
        latest_bcr_p50=(mc.bcr_stats.p50 if mc and mc.bcr_stats else None),
        created_at=bca_dict["created_at"],
        updated_at=bca_dict["updated_at"],
    )


def _build_items_out(
    bca_ctx: dict[str, Any],
    item_dicts: list[dict[str, Any]],
    catalog_map: dict[str, CatalogEntry],
) -> tuple[list[InitiativeItemOut], Any]:
    det_metrics, per_item_pv, per_item_base = run_deterministic(bca_ctx, item_dicts, catalog_map)
    items_out: list[InitiativeItemOut] = []
    for it in item_dicts:
        entry = catalog_map[it["catalog_id"]]
        items_out.append(
            InitiativeItemOut(
                id=it["id"],
                initiative_id=it["initiative_id"],
                bca_id=it.get("bca_id"),
                catalog_id=it["catalog_id"],
                kind=entry.kind,
                catalog_name=entry.name,
                formula_type=entry.formula_type,
                guardrail_notes=entry.guardrail_notes,
                label=it["label"],
                value_stream=it["value_stream"],
                start_year=it["start_year"],
                end_year=it["end_year"],
                ramp_profile=it["ramp_profile"],
                ramp_weights=it["ramp_weights"],
                param_values=it["param_values"],
                uncertainty_spec=UncertaintySpec.model_validate(it["uncertainty_spec"]),
                anti_double_count_tag=it["anti_double_count_tag"],
                base_annual_value=per_item_base.get(it["id"], 0.0),
                pv_total=per_item_pv.get(it["id"], 0.0),
                created_at=it["created_at"],
                updated_at=it["updated_at"],
            )
        )
    return items_out, det_metrics


def _build_initiative_detail(
    init_dict: dict[str, Any],
    active_bca: dict[str, Any],
    active_items: list[dict[str, Any]],
    all_bcas: list[dict[str, Any]],
    items_by_bca: dict[str, list[dict[str, Any]]],
    latest_runs: dict[tuple[str, str | None], SimulationResult],
    catalog_map: dict[str, CatalogEntry],
) -> InitiativeDetail:
    items_out, det_metrics = _build_items_out(active_bca, active_items, catalog_map)
    bca_summaries: list[BCASummary] = []
    active_summary: BCASummary | None = None
    for bca in all_bcas:
        b_id = bca["id"]
        b_items = items_by_bca.get(b_id, [])
        latest_run = latest_runs.get((init_dict["id"], b_id))
        if latest_run is None and bca["is_baseline"]:
            latest_run = latest_runs.get((init_dict["id"], None))
        summary = _build_bca_summary(bca, b_items, catalog_map, latest_run)
        bca_summaries.append(summary)
        if b_id == active_bca["id"]:
            active_summary = summary

    return InitiativeDetail(
        id=init_dict["id"],
        name=init_dict["name"],
        description=init_dict["description"],
        domain=init_dict["domain"],
        horizon_years=active_bca["horizon_years"],
        discount_rate=active_bca["discount_rate"],
        cost_start_year=active_bca["cost_start_year"],
        external_resource_url=init_dict["external_resource_url"],
        created_at=init_dict["created_at"],
        updated_at=init_dict["updated_at"],
        active_bca_id=active_bca["id"],
        active_bca=active_summary,
        bcas=bca_summaries,
        items=items_out,
        deterministic=det_metrics,
    )


def list_initiatives(db_path: Path) -> list[InitiativeSummary]:
    with get_connection(db_path) as conn:
        catalog_map = _load_catalog_map(conn)
        init_rows = conn.execute("SELECT * FROM initiatives ORDER BY updated_at DESC, created_at DESC").fetchall()
        bca_rows = conn.execute(
            "SELECT * FROM initiative_bcas ORDER BY is_baseline DESC, sort_order ASC, created_at ASC"
        ).fetchall()
        item_rows = conn.execute("SELECT * FROM initiative_items ORDER BY created_at ASC").fetchall()
        latest_runs = _load_latest_runs_by_bca(conn)

        bcas_by_init: dict[str, list[dict[str, Any]]] = {}
        for r in bca_rows:
            b = _row_to_bca_dict(r)
            bcas_by_init.setdefault(b["initiative_id"], []).append(b)

        items_by_init: dict[str, list[dict[str, Any]]] = {}
        items_by_bca: dict[str, list[dict[str, Any]]] = {}
        for r in item_rows:
            d = _row_to_item_dict(r)
            items_by_init.setdefault(d["initiative_id"], []).append(d)
            if d.get("bca_id"):
                items_by_bca.setdefault(d["bca_id"], []).append(d)

        summaries: list[InitiativeSummary] = []
        for row in init_rows:
            init_d = _row_to_initiative_dict(row)
            init_id = init_d["id"]
            init_bcas = bcas_by_init.get(init_id)
            if not init_bcas:
                baseline_d = _ensure_baseline_bca(conn, init_d)
                init_bcas = [baseline_d]

            baseline_d = init_bcas[0]
            bca_summaries: list[BCASummary] = []
            for bca in init_bcas:
                b_items = items_by_bca.get(bca["id"], [])
                if not b_items and bca["id"] == baseline_d["id"]:
                    b_items = [it for it in items_by_init.get(init_id, []) if it.get("bca_id") in (None, baseline_d["id"])]
                latest_run = latest_runs.get((init_id, bca["id"]))
                if latest_run is None and bca["is_baseline"]:
                    latest_run = latest_runs.get((init_id, None))
                bca_summaries.append(_build_bca_summary(bca, b_items, catalog_map, latest_run))

            base_sum = bca_summaries[0]
            summaries.append(
                InitiativeSummary(
                    id=init_id,
                    name=init_d["name"],
                    description=init_d["description"],
                    domain=init_d["domain"],
                    horizon_years=base_sum.horizon_years,
                    discount_rate=base_sum.discount_rate,
                    cost_start_year=base_sum.cost_start_year,
                    external_resource_url=init_d["external_resource_url"],
                    item_count=base_sum.item_count,
                    pv_costs=base_sum.pv_costs,
                    pv_benefits=base_sum.pv_benefits,
                    npv=base_sum.npv,
                    bcr=base_sum.bcr,
                    bca_count=len(bca_summaries),
                    baseline_bca_id=base_sum.id,
                    bcas=bca_summaries,
                    created_at=init_d["created_at"],
                    updated_at=init_d["updated_at"],
                )
            )
    return summaries


def get_initiative_detail(
    db_path: Path, initiative_id: str, *, bca_id: str | None = None
) -> InitiativeDetail:
    with get_connection(db_path) as conn:
        row = conn.execute("SELECT * FROM initiatives WHERE id = ?", (initiative_id,)).fetchone()
        if not row:
            raise NotFoundError(f"Initiative '{initiative_id}' not found.")
        init_d = _row_to_initiative_dict(row)
        active_bca = _resolve_bca_dict(conn, init_d, bca_id)
        bca_rows = conn.execute(
            """
            SELECT * FROM initiative_bcas
            WHERE initiative_id = ?
            ORDER BY is_baseline DESC, sort_order ASC, created_at ASC
            """,
            (initiative_id,),
        ).fetchall()
        all_bcas = [_row_to_bca_dict(r) for r in bca_rows]
        item_rows = conn.execute(
            "SELECT * FROM initiative_items WHERE initiative_id = ? ORDER BY created_at ASC",
            (initiative_id,),
        ).fetchall()
        catalog_map = _load_catalog_map(conn)
        latest_runs = _load_latest_runs_by_bca(conn, initiative_id)

    baseline_id = all_bcas[0]["id"] if all_bcas else active_bca["id"]
    items_by_bca: dict[str, list[dict[str, Any]]] = {}
    for r in item_rows:
        it = _row_to_item_dict(r)
        target_b = it.get("bca_id") or baseline_id
        items_by_bca.setdefault(target_b, []).append(it)

    active_items = items_by_bca.get(active_bca["id"], [])
    return _build_initiative_detail(
        init_d,
        active_bca,
        active_items,
        all_bcas,
        items_by_bca,
        latest_runs,
        catalog_map,
    )


def get_initiative_context(
    db_path: Path, initiative_id: str, *, bca_id: str | None = None
) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, CatalogEntry]]:
    with get_connection(db_path) as conn:
        row = conn.execute("SELECT * FROM initiatives WHERE id = ?", (initiative_id,)).fetchone()
        if not row:
            raise NotFoundError(f"Initiative '{initiative_id}' not found.")
        init_d = _row_to_initiative_dict(row)
        bca_d = _resolve_bca_dict(conn, init_d, bca_id)
        item_rows = conn.execute(
            """
            SELECT * FROM initiative_items
            WHERE initiative_id = ? AND (bca_id = ? OR (bca_id IS NULL AND ? = 1))
            ORDER BY created_at ASC
            """,
            (initiative_id, bca_d["id"], 1 if bca_d["is_baseline"] else 0),
        ).fetchall()
        catalog_map = _load_catalog_map(conn)

    ctx = {
        **init_d,
        "horizon_years": bca_d["horizon_years"],
        "discount_rate": bca_d["discount_rate"],
        "cost_start_year": bca_d["cost_start_year"],
        "bca_id": bca_d["id"],
        "bca_name": bca_d["name"],
    }
    return ctx, [_row_to_item_dict(r) for r in item_rows], catalog_map


def create_initiative(db_path: Path, payload: InitiativeCreate) -> InitiativeDetail:
    init_id = str(uuid4())
    bca_id = str(uuid4())
    now = _now_iso()
    with get_connection(db_path) as conn:
        conn.execute(
            """
            INSERT INTO initiatives (
                id, name, description, domain, horizon_years, discount_rate,
                cost_start_year, external_resource_url, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                init_id,
                payload.name.strip(),
                payload.description.strip(),
                payload.domain,
                payload.horizon_years,
                payload.discount_rate,
                payload.cost_start_year,
                payload.external_resource_url,
                now,
                now,
            ),
        )
        conn.execute(
            """
            INSERT INTO initiative_bcas (
                id, initiative_id, name, description, horizon_years, discount_rate,
                cost_start_year, is_baseline, sort_order, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
            """,
            (
                bca_id,
                init_id,
                "Baseline BCA",
                payload.description.strip(),
                payload.horizon_years,
                payload.discount_rate,
                payload.cost_start_year,
                now,
                now,
            ),
        )
    return get_initiative_detail(db_path, init_id, bca_id=bca_id)


def update_initiative(db_path: Path, initiative_id: str, payload: InitiativeUpdate) -> InitiativeDetail:
    now = _now_iso()
    with get_connection(db_path) as conn:
        row = conn.execute("SELECT * FROM initiatives WHERE id = ?", (initiative_id,)).fetchone()
        if not row:
            raise NotFoundError(f"Initiative '{initiative_id}' not found.")
        current = _row_to_initiative_dict(row)
        baseline_bca = _ensure_baseline_bca(conn, current)

        new_horizon = payload.horizon_years if payload.horizon_years is not None else baseline_bca["horizon_years"]

        max_end_row = conn.execute(
            """
            SELECT COALESCE(MAX(end_year), 0) AS max_end
            FROM initiative_items
            WHERE initiative_id = ? AND (bca_id = ? OR bca_id IS NULL)
            """,
            (initiative_id, baseline_bca["id"]),
        ).fetchone()
        max_end = int(max_end_row["max_end"]) if max_end_row else 0
        if max_end > new_horizon:
            raise ValidationError(
                f"Cannot reduce horizon_years to {new_horizon}; line items currently extend to year {max_end}."
            )

        new_cost_start_year = (
            payload.cost_start_year
            if "cost_start_year" in payload.model_fields_set
            else baseline_bca["cost_start_year"]
        )
        new_discount_rate = (
            payload.discount_rate if payload.discount_rate is not None else baseline_bca["discount_rate"]
        )
        new_external_url = (
            payload.external_resource_url
            if payload.external_resource_url is not None
            else current["external_resource_url"]
        )

        conn.execute(
            """
            UPDATE initiatives
            SET name = ?, description = ?, domain = ?, horizon_years = ?, discount_rate = ?,
                cost_start_year = ?, external_resource_url = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                payload.name.strip() if payload.name is not None else current["name"],
                payload.description.strip() if payload.description is not None else current["description"],
                payload.domain if payload.domain is not None else current["domain"],
                new_horizon,
                new_discount_rate,
                new_cost_start_year,
                new_external_url,
                now,
                initiative_id,
            ),
        )
        if (
            payload.horizon_years is not None
            or payload.discount_rate is not None
            or "cost_start_year" in payload.model_fields_set
        ):
            conn.execute(
                """
                UPDATE initiative_bcas
                SET horizon_years = ?, discount_rate = ?, cost_start_year = ?, updated_at = ?
                WHERE id = ?
                """,
                (new_horizon, new_discount_rate, new_cost_start_year, now, baseline_bca["id"]),
            )
    return get_initiative_detail(db_path, initiative_id)


def delete_initiative(db_path: Path, initiative_id: str) -> None:
    with get_connection(db_path) as conn:
        cur = conn.execute("DELETE FROM initiatives WHERE id = ?", (initiative_id,))
        if cur.rowcount == 0:
            raise NotFoundError(f"Initiative '{initiative_id}' not found.")


# --- BCA CRUD operations ---


def list_bcas(db_path: Path, initiative_id: str) -> list[BCASummary]:
    detail = get_initiative_detail(db_path, initiative_id)
    return detail.bcas


def get_bca_detail(db_path: Path, initiative_id: str, bca_id: str) -> BCADetail:
    with get_connection(db_path) as conn:
        init_row = conn.execute("SELECT * FROM initiatives WHERE id = ?", (initiative_id,)).fetchone()
        if not init_row:
            raise NotFoundError(f"Initiative '{initiative_id}' not found.")
        init_d = _row_to_initiative_dict(init_row)
        bca_d = _resolve_bca_dict(conn, init_d, bca_id)
        item_rows = conn.execute(
            """
            SELECT * FROM initiative_items
            WHERE initiative_id = ? AND (bca_id = ? OR (bca_id IS NULL AND ? = 1))
            ORDER BY created_at ASC
            """,
            (initiative_id, bca_d["id"], 1 if bca_d["is_baseline"] else 0),
        ).fetchall()
        catalog_map = _load_catalog_map(conn)
        latest_runs = _load_latest_runs_by_bca(conn, initiative_id)

    item_dicts = [_row_to_item_dict(r) for r in item_rows]
    items_out, det_metrics = _build_items_out(bca_d, item_dicts, catalog_map)
    latest_run = latest_runs.get((initiative_id, bca_d["id"]))
    if latest_run is None and bca_d["is_baseline"]:
        latest_run = latest_runs.get((initiative_id, None))

    return BCADetail(
        id=bca_d["id"],
        initiative_id=initiative_id,
        name=bca_d["name"],
        description=bca_d["description"],
        horizon_years=bca_d["horizon_years"],
        discount_rate=bca_d["discount_rate"],
        cost_start_year=bca_d["cost_start_year"],
        is_baseline=bca_d["is_baseline"],
        sort_order=bca_d["sort_order"],
        created_at=bca_d["created_at"],
        updated_at=bca_d["updated_at"],
        items=items_out,
        deterministic=det_metrics,
        latest_simulation=latest_run,
    )


def create_bca(db_path: Path, initiative_id: str, payload: BCACreate) -> BCADetail:
    new_bca_id = str(uuid4())
    now = _now_iso()
    with get_connection(db_path) as conn:
        init_row = conn.execute("SELECT * FROM initiatives WHERE id = ?", (initiative_id,)).fetchone()
        if not init_row:
            raise NotFoundError(f"Initiative '{initiative_id}' not found.")
        init_d = _row_to_initiative_dict(init_row)
        baseline_bca = _ensure_baseline_bca(conn, init_d)

        source_bca = (
            _resolve_bca_dict(conn, init_d, payload.clone_from_bca_id)
            if payload.clone_from_bca_id
            else baseline_bca
        )

        horizon_years = (
            payload.horizon_years if payload.horizon_years is not None else source_bca["horizon_years"]
        )
        discount_rate = (
            payload.discount_rate if payload.discount_rate is not None else source_bca["discount_rate"]
        )
        cost_start_year = (
            payload.cost_start_year
            if "cost_start_year" in payload.model_fields_set
            else source_bca["cost_start_year"]
        )

        source_items: list[sqlite3.Row] = []
        if payload.clone_from_bca_id:
            source_items = conn.execute(
                """
                SELECT * FROM initiative_items
                WHERE initiative_id = ? AND (bca_id = ? OR (bca_id IS NULL AND ? = 1))
                ORDER BY created_at ASC
                """,
                (initiative_id, source_bca["id"], 1 if source_bca["is_baseline"] else 0),
            ).fetchall()
            max_end = max((int(it["end_year"]) for it in source_items), default=0)
            if max_end > horizon_years:
                raise ValidationError(
                    f"Cannot set horizon_years to {horizon_years}; cloned items extend to year {max_end}."
                )

        max_sort_row = conn.execute(
            "SELECT COALESCE(MAX(sort_order), -1) AS max_sort FROM initiative_bcas WHERE initiative_id = ?",
            (initiative_id,),
        ).fetchone()
        next_sort = int(max_sort_row["max_sort"]) + 1 if max_sort_row else 1

        conn.execute(
            """
            INSERT INTO initiative_bcas (
                id, initiative_id, name, description, horizon_years, discount_rate,
                cost_start_year, is_baseline, sort_order, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
            """,
            (
                new_bca_id,
                initiative_id,
                payload.name.strip(),
                payload.description.strip(),
                horizon_years,
                discount_rate,
                cost_start_year,
                next_sort,
                now,
                now,
            ),
        )

        for src in source_items:
            conn.execute(
                """
                INSERT INTO initiative_items (
                    id, initiative_id, bca_id, catalog_id, label, value_stream,
                    start_year, end_year, ramp_profile, ramp_weights_json,
                    param_values_json, uncertainty_spec_json, anti_double_count_tag,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid4()),
                    initiative_id,
                    new_bca_id,
                    src["catalog_id"],
                    src["label"],
                    src["value_stream"],
                    int(src["start_year"]),
                    int(src["end_year"]),
                    src["ramp_profile"],
                    src["ramp_weights_json"],
                    src["param_values_json"],
                    src["uncertainty_spec_json"],
                    src["anti_double_count_tag"],
                    now,
                    now,
                ),
            )

        conn.execute("UPDATE initiatives SET updated_at = ? WHERE id = ?", (now, initiative_id))

    return get_bca_detail(db_path, initiative_id, new_bca_id)


def update_bca(
    db_path: Path, initiative_id: str, bca_id: str, payload: BCAUpdate
) -> BCADetail:
    now = _now_iso()
    with get_connection(db_path) as conn:
        init_row = conn.execute("SELECT * FROM initiatives WHERE id = ?", (initiative_id,)).fetchone()
        if not init_row:
            raise NotFoundError(f"Initiative '{initiative_id}' not found.")
        init_d = _row_to_initiative_dict(init_row)
        current = _resolve_bca_dict(conn, init_d, bca_id)

        new_horizon = payload.horizon_years if payload.horizon_years is not None else current["horizon_years"]
        max_end_row = conn.execute(
            """
            SELECT COALESCE(MAX(end_year), 0) AS max_end
            FROM initiative_items
            WHERE initiative_id = ? AND (bca_id = ? OR (bca_id IS NULL AND ? = 1))
            """,
            (initiative_id, bca_id, 1 if current["is_baseline"] else 0),
        ).fetchone()
        max_end = int(max_end_row["max_end"]) if max_end_row else 0
        if max_end > new_horizon:
            raise ValidationError(
                f"Cannot reduce horizon_years to {new_horizon}; BCA line items extend to year {max_end}."
            )

        new_name = payload.name.strip() if payload.name is not None else current["name"]
        new_desc = payload.description.strip() if payload.description is not None else current["description"]
        new_rate = payload.discount_rate if payload.discount_rate is not None else current["discount_rate"]
        new_start_year = (
            payload.cost_start_year
            if "cost_start_year" in payload.model_fields_set
            else current["cost_start_year"]
        )

        new_is_baseline = current["is_baseline"]
        if payload.is_baseline is True:
            conn.execute(
                "UPDATE initiative_bcas SET is_baseline = 0 WHERE initiative_id = ?",
                (initiative_id,),
            )
            new_is_baseline = True

        conn.execute(
            """
            UPDATE initiative_bcas
            SET name = ?, description = ?, horizon_years = ?, discount_rate = ?,
                cost_start_year = ?, is_baseline = ?, updated_at = ?
            WHERE id = ? AND initiative_id = ?
            """,
            (
                new_name,
                new_desc,
                new_horizon,
                new_rate,
                new_start_year,
                1 if new_is_baseline else 0,
                now,
                bca_id,
                initiative_id,
            ),
        )

        if new_is_baseline:
            conn.execute(
                """
                UPDATE initiatives
                SET horizon_years = ?, discount_rate = ?, cost_start_year = ?, updated_at = ?
                WHERE id = ?
                """,
                (new_horizon, new_rate, new_start_year, now, initiative_id),
            )
        else:
            conn.execute("UPDATE initiatives SET updated_at = ? WHERE id = ?", (now, initiative_id))

    return get_bca_detail(db_path, initiative_id, bca_id)


def delete_bca(db_path: Path, initiative_id: str, bca_id: str) -> None:
    now = _now_iso()
    with get_connection(db_path) as conn:
        init_row = conn.execute("SELECT * FROM initiatives WHERE id = ?", (initiative_id,)).fetchone()
        if not init_row:
            raise NotFoundError(f"Initiative '{initiative_id}' not found.")
        init_d = _row_to_initiative_dict(init_row)
        target = _resolve_bca_dict(conn, init_d, bca_id)

        cnt_row = conn.execute(
            "SELECT COUNT(*) AS cnt FROM initiative_bcas WHERE initiative_id = ?",
            (initiative_id,),
        ).fetchone()
        cnt = int(cnt_row["cnt"]) if cnt_row else 0
        if cnt <= 1:
            raise ValidationError("Cannot delete the only BCA of an initiative.")

        conn.execute("DELETE FROM initiative_bcas WHERE id = ? AND initiative_id = ?", (bca_id, initiative_id))

        if target["is_baseline"]:
            next_row = conn.execute(
                """
                SELECT * FROM initiative_bcas
                WHERE initiative_id = ?
                ORDER BY sort_order ASC, created_at ASC
                LIMIT 1
                """,
                (initiative_id,),
            ).fetchone()
            if next_row is not None:
                next_bca = _row_to_bca_dict(next_row)
                conn.execute("UPDATE initiative_bcas SET is_baseline = 1 WHERE id = ?", (next_bca["id"],))
                conn.execute(
                    """
                    UPDATE initiatives
                    SET horizon_years = ?, discount_rate = ?, cost_start_year = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        next_bca["horizon_years"],
                        next_bca["discount_rate"],
                        next_bca["cost_start_year"],
                        now,
                        initiative_id,
                    ),
                )
        else:
            conn.execute("UPDATE initiatives SET updated_at = ? WHERE id = ?", (now, initiative_id))


# --- Line Item operations ---


def create_item(
    db_path: Path,
    initiative_id: str,
    payload: InitiativeItemCreate,
    *,
    bca_id: str | None = None,
) -> InitiativeItemOut:
    item_id = str(uuid4())
    now = _now_iso()
    target_bca_param = bca_id if bca_id is not None else payload.bca_id
    with get_connection(db_path) as conn:
        init_row = conn.execute("SELECT * FROM initiatives WHERE id = ?", (initiative_id,)).fetchone()
        if not init_row:
            raise NotFoundError(f"Initiative '{initiative_id}' not found.")
        init_d = _row_to_initiative_dict(init_row)
        bca_d = _resolve_bca_dict(conn, init_d, target_bca_param)
        resolved_bca_id = bca_d["id"]

        cat_row = conn.execute("SELECT * FROM catalog_entries WHERE id = ?", (payload.catalog_id,)).fetchone()
        if not cat_row:
            raise NotFoundError(f"Catalog entry '{payload.catalog_id}' not found.")
        entry = _row_to_catalog_entry(cat_row)

        normalized_params = _validate_item_against_context(
            horizon_years=bca_d["horizon_years"],
            catalog_entry=entry,
            start_year=payload.start_year,
            end_year=payload.end_year,
            ramp_profile=payload.ramp_profile,
            ramp_weights=payload.ramp_weights,
            param_values=payload.param_values,
        )

        ramp_weights = payload.ramp_weights if payload.ramp_profile == "custom_weights" else None
        conn.execute(
            """
            INSERT INTO initiative_items (
                id, initiative_id, bca_id, catalog_id, label, value_stream,
                start_year, end_year, ramp_profile, ramp_weights_json,
                param_values_json, uncertainty_spec_json, anti_double_count_tag,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                item_id,
                initiative_id,
                resolved_bca_id,
                payload.catalog_id,
                payload.label.strip(),
                payload.value_stream.strip(),
                payload.start_year,
                payload.end_year,
                payload.ramp_profile,
                json.dumps(ramp_weights) if ramp_weights is not None else None,
                json.dumps(normalized_params),
                payload.uncertainty_spec.model_dump_json(),
                payload.anti_double_count_tag,
                now,
                now,
            ),
        )
        conn.execute("UPDATE initiative_bcas SET updated_at = ? WHERE id = ?", (now, resolved_bca_id))
        conn.execute("UPDATE initiatives SET updated_at = ? WHERE id = ?", (now, initiative_id))

    detail = get_initiative_detail(db_path, initiative_id, bca_id=resolved_bca_id)
    for item in detail.items:
        if item.id == item_id:
            return item
    raise RuntimeError("Created item could not be reloaded.")


def update_item(db_path: Path, item_id: str, payload: InitiativeItemUpdate) -> InitiativeItemOut:
    now = _now_iso()
    with get_connection(db_path) as conn:
        row = conn.execute("SELECT * FROM initiative_items WHERE id = ?", (item_id,)).fetchone()
        if not row:
            raise NotFoundError(f"Initiative item '{item_id}' not found.")
        current = _row_to_item_dict(row)
        initiative_id = current["initiative_id"]

        init_row = conn.execute("SELECT * FROM initiatives WHERE id = ?", (initiative_id,)).fetchone()
        assert init_row is not None
        init_d = _row_to_initiative_dict(init_row)
        bca_d = _resolve_bca_dict(conn, init_d, current.get("bca_id"))
        resolved_bca_id = bca_d["id"]

        catalog_id = payload.catalog_id if payload.catalog_id is not None else current["catalog_id"]
        cat_row = conn.execute("SELECT * FROM catalog_entries WHERE id = ?", (catalog_id,)).fetchone()
        if not cat_row:
            raise NotFoundError(f"Catalog entry '{catalog_id}' not found.")
        entry = _row_to_catalog_entry(cat_row)

        start_year = payload.start_year if payload.start_year is not None else current["start_year"]
        end_year = payload.end_year if payload.end_year is not None else current["end_year"]
        ramp_profile = payload.ramp_profile if payload.ramp_profile is not None else current["ramp_profile"]
        if payload.ramp_weights is not None:
            ramp_weights = payload.ramp_weights
        elif ramp_profile == "custom_weights":
            ramp_weights = current["ramp_weights"]
        else:
            ramp_weights = None

        raw_params = payload.param_values if payload.param_values is not None else current["param_values"]
        normalized_params = _validate_item_against_context(
            horizon_years=bca_d["horizon_years"],
            catalog_entry=entry,
            start_year=start_year,
            end_year=end_year,
            ramp_profile=ramp_profile,
            ramp_weights=ramp_weights,
            param_values=raw_params,
        )

        uncertainty_json = (
            payload.uncertainty_spec.model_dump_json()
            if payload.uncertainty_spec is not None
            else json.dumps(current["uncertainty_spec"])
        )
        fields_set = payload.model_fields_set
        tag = payload.anti_double_count_tag if "anti_double_count_tag" in fields_set else current["anti_double_count_tag"]

        conn.execute(
            """
            UPDATE initiative_items
            SET bca_id = ?, catalog_id = ?, label = ?, value_stream = ?, start_year = ?, end_year = ?,
                ramp_profile = ?, ramp_weights_json = ?, param_values_json = ?,
                uncertainty_spec_json = ?, anti_double_count_tag = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                resolved_bca_id,
                catalog_id,
                payload.label.strip() if payload.label is not None else current["label"],
                payload.value_stream.strip() if payload.value_stream is not None else current["value_stream"],
                start_year,
                end_year,
                ramp_profile,
                json.dumps(ramp_weights) if ramp_profile == "custom_weights" and ramp_weights is not None else None,
                json.dumps(normalized_params),
                uncertainty_json,
                tag,
                now,
                item_id,
            ),
        )
        conn.execute("UPDATE initiative_bcas SET updated_at = ? WHERE id = ?", (now, resolved_bca_id))
        conn.execute("UPDATE initiatives SET updated_at = ? WHERE id = ?", (now, initiative_id))

    detail = get_initiative_detail(db_path, initiative_id, bca_id=resolved_bca_id)
    for item in detail.items:
        if item.id == item_id:
            return item
    raise RuntimeError("Updated item could not be reloaded.")


def delete_item(db_path: Path, item_id: str) -> None:
    now = _now_iso()
    with get_connection(db_path) as conn:
        row = conn.execute("SELECT initiative_id, bca_id FROM initiative_items WHERE id = ?", (item_id,)).fetchone()
        if not row:
            raise NotFoundError(f"Initiative item '{item_id}' not found.")
        initiative_id = row["initiative_id"]
        bca_id = row["bca_id"]
        conn.execute("DELETE FROM initiative_items WHERE id = ?", (item_id,))
        if bca_id:
            conn.execute("UPDATE initiative_bcas SET updated_at = ? WHERE id = ?", (now, bca_id))
        conn.execute("UPDATE initiatives SET updated_at = ? WHERE id = ?", (now, initiative_id))


# --- Simulation Run & Comparison persistence ---


def save_simulation_run(db_path: Path, result: SimulationResult) -> SimulationResult:
    run_id = result.run_id or str(uuid4())
    stored_result = result.model_copy(update={"run_id": run_id})
    with get_connection(db_path) as conn:
        conn.execute(
            """
            INSERT INTO simulation_runs (
                id, initiative_id, bca_id, n_simulations, discount_rate, horizon_years, seed, summary_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                stored_result.initiative_id,
                stored_result.bca_id,
                stored_result.n_simulations,
                stored_result.discount_rate,
                stored_result.horizon_years,
                stored_result.seed,
                stored_result.model_dump_json(),
                stored_result.created_at,
            ),
        )
    return stored_result


def list_simulation_runs(
    db_path: Path, initiative_id: str, *, bca_id: str | None = None, limit: int = 50
) -> list[SimulationRunRecord]:
    with get_connection(db_path) as conn:
        exists = conn.execute("SELECT id FROM initiatives WHERE id = ?", (initiative_id,)).fetchone()
        if not exists:
            raise NotFoundError(f"Initiative '{initiative_id}' not found.")
        if bca_id is not None:
            bca_exists = conn.execute(
                "SELECT id FROM initiative_bcas WHERE id = ? AND initiative_id = ?",
                (bca_id, initiative_id),
            ).fetchone()
            if not bca_exists:
                raise NotFoundError(f"BCA '{bca_id}' not found on initiative '{initiative_id}'.")
            rows = conn.execute(
                """
                SELECT sr.*, b.name AS bca_name
                FROM simulation_runs sr
                LEFT JOIN initiative_bcas b ON b.id = sr.bca_id
                WHERE sr.initiative_id = ? AND sr.bca_id = ?
                ORDER BY sr.created_at DESC
                LIMIT ?
                """,
                (initiative_id, bca_id, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT sr.*, b.name AS bca_name
                FROM simulation_runs sr
                LEFT JOIN initiative_bcas b ON b.id = sr.bca_id
                WHERE sr.initiative_id = ?
                ORDER BY sr.created_at DESC
                LIMIT ?
                """,
                (initiative_id, limit),
            ).fetchall()

    records: list[SimulationRunRecord] = []
    for row in rows:
        parsed = SimulationResult.model_validate_json(row["summary_json"])
        eff_bca_id = parsed.bca_id or row["bca_id"]
        eff_bca_name = parsed.bca_name or row["bca_name"]
        if parsed.bca_id != eff_bca_id or parsed.bca_name != eff_bca_name:
            parsed = parsed.model_copy(update={"bca_id": eff_bca_id, "bca_name": eff_bca_name})
        records.append(
            SimulationRunRecord(
                id=row["id"],
                initiative_id=row["initiative_id"],
                bca_id=eff_bca_id,
                bca_name=eff_bca_name,
                n_simulations=int(row["n_simulations"]),
                discount_rate=float(row["discount_rate"]),
                horizon_years=int(row["horizon_years"]),
                seed=row["seed"],
                created_at=row["created_at"],
                summary=parsed,
            )
        )
    return records


def save_bca_comparison(db_path: Path, comparison: BCAComparisonResult) -> BCAComparisonResult:
    comp_id = comparison.comparison_id or str(uuid4())
    stored = comparison.model_copy(update={"comparison_id": comp_id})
    with get_connection(db_path) as conn:
        conn.execute(
            """
            INSERT INTO bca_comparisons (
                id, initiative_id, bca_a_id, bca_b_id, n_simulations, seed, summary_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                comp_id,
                stored.initiative_id,
                stored.bca_a_id,
                stored.bca_b_id,
                stored.n_simulations,
                stored.seed,
                stored.model_dump_json(),
                stored.created_at,
            ),
        )
    return stored


def list_bca_comparisons(
    db_path: Path, initiative_id: str, limit: int = 20
) -> list[BCAComparisonRecord]:
    with get_connection(db_path) as conn:
        exists = conn.execute("SELECT id FROM initiatives WHERE id = ?", (initiative_id,)).fetchone()
        if not exists:
            raise NotFoundError(f"Initiative '{initiative_id}' not found.")
        rows = conn.execute(
            """
            SELECT * FROM bca_comparisons
            WHERE initiative_id = ?
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (initiative_id, limit),
        ).fetchall()

    records: list[BCAComparisonRecord] = []
    for row in rows:
        parsed = BCAComparisonResult.model_validate_json(row["summary_json"])
        records.append(
            BCAComparisonRecord(
                id=row["id"],
                initiative_id=row["initiative_id"],
                bca_a_id=row["bca_a_id"],
                bca_b_id=row["bca_b_id"],
                n_simulations=int(row["n_simulations"]),
                seed=row["seed"],
                created_at=row["created_at"],
                summary=parsed,
            )
        )
    return records


def check_health(db_path: Path) -> int:
    with get_connection(db_path) as conn:
        row = conn.execute("SELECT COUNT(*) AS cnt FROM catalog_entries").fetchone()
        return int(row["cnt"]) if row else 0


# --- Admin LLM Settings & API Keys ---


def mask_secret(secret: str) -> str:
    """Return a masked display string without exposing secret characters."""
    cleaned = secret.strip()
    if not cleaned:
        return ""
    if len(cleaned) >= 10:
        return f"{cleaned[:4]}••••{cleaned[-4:]}"
    return "••••"


_LLM_VERIFIED_TTL_SECONDS = 900.0
_llm_verified_fingerprints: dict[tuple[str, str, str], tuple[float, str]] = {}


def clear_llm_verified_cache() -> None:
    """Clear cached LLM Test Connection fingerprints (for test isolation)."""
    _llm_verified_fingerprints.clear()


def _llm_fingerprint(base_url: str, model: str, api_key: str) -> tuple[str, str, str]:
    key_hash = (
        hashlib.sha256(api_key.strip().encode("utf-8")).hexdigest()
        if api_key.strip()
        else ""
    )
    return base_url.strip().rstrip("/"), model.strip(), key_hash


def _row_to_llm_raw(row: sqlite3.Row | None) -> dict[str, Any]:
    if row is None:
        return {
            "base_url": "",
            "api_key": "",
            "model": "",
            "temperature": 0.2,
            "max_tokens": 1024,
            "timeout_seconds": 45,
            "system_prompt": "",
            "verified": False,
            "verified_at": None,
            "updated_at": None,
        }
    keys = set(row.keys())
    return {
        "base_url": str(row["base_url"] or ""),
        "api_key": str(row["api_key"] or ""),
        "model": str(row["model"] or ""),
        "temperature": float(row["temperature"]),
        "max_tokens": int(row["max_tokens"]),
        "timeout_seconds": int(row["timeout_seconds"]),
        "system_prompt": str(row["system_prompt"] or ""),
        "verified": bool(row["verified"]) if "verified" in keys else False,
        "verified_at": str(row["verified_at"]) if ("verified_at" in keys and row["verified_at"]) else None,
        "updated_at": str(row["updated_at"]) if row["updated_at"] else None,
    }


def _raw_to_llm_out(raw: dict[str, Any]) -> LLMSettingsOut:
    api_key = str(raw.get("api_key") or "")
    base_url = str(raw.get("base_url") or "").strip()
    model = str(raw.get("model") or "").strip()
    configured = bool(base_url and model)
    verified = bool(raw.get("verified")) and configured
    return LLMSettingsOut(
        base_url=base_url,
        model=model,
        temperature=float(raw.get("temperature", 0.2)),
        max_tokens=int(raw.get("max_tokens", 1024)),
        timeout_seconds=int(raw.get("timeout_seconds", 45)),
        system_prompt=str(raw.get("system_prompt") or ""),
        api_key_set=bool(api_key),
        api_key_masked=mask_secret(api_key),
        configured=configured,
        verified=verified,
        verified_at=raw.get("verified_at") if verified else None,
        updated_at=raw.get("updated_at"),
    )


def get_llm_settings_raw(db_path: Path) -> dict[str, Any]:
    with get_connection(db_path) as conn:
        row = conn.execute("SELECT * FROM llm_settings WHERE id = 1").fetchone()
    return _row_to_llm_raw(row)


def get_llm_settings(db_path: Path) -> LLMSettingsOut:
    return _raw_to_llm_out(get_llm_settings_raw(db_path))


def update_llm_settings(db_path: Path, payload: LLMSettingsUpdate) -> LLMSettingsOut:
    now = _now_iso()
    with get_connection(db_path) as conn:
        existing = conn.execute("SELECT * FROM llm_settings WHERE id = 1").fetchone()
        current = _row_to_llm_raw(existing)

        if payload.clear_api_key:
            next_key = ""
        elif payload.api_key is not None and payload.api_key.strip():
            next_key = payload.api_key.strip()
        else:
            next_key = current["api_key"]
            current_base = str(current.get("base_url") or "").rstrip("/")
            if next_key and payload.base_url.rstrip("/") != current_base:
                # Keep the stored secret bound to its endpoint so it can't be redirected
                # to an attacker-controlled base URL.
                raise ValidationError(
                    "The saved API key is only used with the endpoint it was saved for. "
                    "Re-enter the API key (or clear it) when changing the Endpoint Base URL."
                )

        configured = bool(payload.base_url and payload.model)
        connection_changed = (
            payload.base_url.rstrip("/") != str(current.get("base_url") or "").rstrip("/")
            or payload.model != str(current.get("model") or "")
            or next_key != str(current.get("api_key") or "")
        )

        if not configured:
            next_verified = False
            next_verified_at: str | None = None
        elif not connection_changed and bool(current.get("verified")):
            next_verified = True
            next_verified_at = current.get("verified_at")
        else:
            fp = _llm_fingerprint(payload.base_url, payload.model, next_key)
            cached = _llm_verified_fingerprints.get(fp)
            if cached is not None and (time.monotonic() - cached[0]) <= _LLM_VERIFIED_TTL_SECONDS:
                next_verified = True
                next_verified_at = cached[1]
            else:
                next_verified = False
                next_verified_at = None

        conn.execute(
            """
            INSERT INTO llm_settings (
                id, base_url, api_key, model, temperature, max_tokens, timeout_seconds,
                system_prompt, verified, verified_at, updated_at
            ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                base_url = excluded.base_url,
                api_key = excluded.api_key,
                model = excluded.model,
                temperature = excluded.temperature,
                max_tokens = excluded.max_tokens,
                timeout_seconds = excluded.timeout_seconds,
                system_prompt = excluded.system_prompt,
                verified = excluded.verified,
                verified_at = excluded.verified_at,
                updated_at = excluded.updated_at
            """,
            (
                payload.base_url,
                next_key,
                payload.model,
                payload.temperature,
                payload.max_tokens,
                payload.timeout_seconds,
                payload.system_prompt.strip(),
                int(next_verified),
                next_verified_at,
                now,
            ),
        )
        row = conn.execute("SELECT * FROM llm_settings WHERE id = 1").fetchone()
    return _raw_to_llm_out(_row_to_llm_raw(row))


def record_llm_test_result(
    db_path: Path,
    *,
    base_url: str,
    model: str,
    api_key: str,
    ok: bool,
) -> None:
    """Persist live Test Connection verification status for matching saved LLM settings."""
    fp = _llm_fingerprint(base_url, model, api_key)
    norm_base, norm_model, _ = fp
    now_iso = _now_iso()
    now_mono = time.monotonic()

    if ok and norm_base and norm_model:
        _llm_verified_fingerprints[fp] = (now_mono, now_iso)
    else:
        _llm_verified_fingerprints.pop(fp, None)

    if not norm_base or not norm_model:
        return

    with get_connection(db_path) as conn:
        row = conn.execute("SELECT base_url, model, api_key FROM llm_settings WHERE id = 1").fetchone()
        if row is None:
            return
        saved_fp = _llm_fingerprint(
            str(row["base_url"] or ""),
            str(row["model"] or ""),
            str(row["api_key"] or ""),
        )
        if saved_fp == fp:
            conn.execute(
                "UPDATE llm_settings SET verified = ?, verified_at = ? WHERE id = 1",
                (1 if ok else 0, now_iso if ok else None),
            )


def _mask_env_api_key(raw_key: str) -> tuple[str, str]:
    if len(raw_key) >= 12:
        return raw_key[:4], raw_key[-4:]
    if len(raw_key) >= 6:
        return raw_key[:2], raw_key[-2:]
    return "", ""


def list_api_keys(db_path: Path) -> list[ApiKeyOut]:
    env_keys = get_env_api_keys()
    if env_keys:
        items: list[ApiKeyOut] = []
        for idx, raw_key in enumerate(env_keys, start=1):
            prefix, last4 = _mask_env_api_key(raw_key)
            items.append(
                ApiKeyOut(
                    id=f"env-key-{idx}",
                    name=f"Environment Key #{idx} (BCA_API_KEYS)",
                    key_prefix=prefix,
                    key_last4=last4,
                    created_at="environment",
                    last_used_at=None,
                    managed_by_env=True,
                )
            )
        return items

    with get_connection(db_path) as conn:
        rows = conn.execute(
            "SELECT id, name, key_prefix, key_last4, created_at, last_used_at FROM api_keys ORDER BY created_at DESC"
        ).fetchall()
    return [
        ApiKeyOut(
            id=row["id"],
            name=row["name"],
            key_prefix=row["key_prefix"],
            key_last4=row["key_last4"],
            created_at=row["created_at"],
            last_used_at=row["last_used_at"],
            managed_by_env=False,
        )
        for row in rows
    ]


def create_api_key(db_path: Path, name: str) -> ApiKeyCreatedOut:
    if is_api_keys_env_managed():
        raise ConflictError(
            "Inbound API keys are managed by the BCA_API_KEYS environment variable and locked in the Admin Portal."
        )

    key_id = str(uuid4())
    secret_key = f"bca-{secrets.token_urlsafe(24)}"
    key_hash = hashlib.sha256(secret_key.encode("utf-8")).hexdigest()
    key_prefix = secret_key[:8]
    key_last4 = secret_key[-4:]
    now = _now_iso()

    with get_connection(db_path) as conn:
        conn.execute(
            """
            INSERT INTO api_keys (id, name, key_prefix, key_last4, key_hash, created_at, last_used_at)
            VALUES (?, ?, ?, ?, ?, ?, NULL)
            """,
            (key_id, name.strip(), key_prefix, key_last4, key_hash, now),
        )

    return ApiKeyCreatedOut(
        id=key_id,
        name=name.strip(),
        key_prefix=key_prefix,
        key_last4=key_last4,
        created_at=now,
        last_used_at=None,
        managed_by_env=False,
        secret_key=secret_key,
    )


def delete_api_key(db_path: Path, key_id: str) -> None:
    if is_api_keys_env_managed():
        raise ConflictError(
            "Inbound API keys are managed by the BCA_API_KEYS environment variable and locked in the Admin Portal."
        )

    with get_connection(db_path) as conn:
        cur = conn.execute("DELETE FROM api_keys WHERE id = ?", (key_id,))
        if cur.rowcount == 0:
            raise NotFoundError(f"API key '{key_id}' not found.")


def count_inbound_api_keys(db_path: Path) -> int:
    env_keys = get_env_api_keys()
    if env_keys:
        return len(env_keys)

    with get_connection(db_path) as conn:
        row = conn.execute("SELECT COUNT(*) AS cnt FROM api_keys").fetchone()
    return int(row["cnt"]) if row else 0


def inbound_open_access_allowed(db_path: Path) -> bool:
    """Keyless /v1 and /odata access is only allowed when no keys exist AND SSO is not enforced.

    With SSO enforced the web UI requires sign-in, so the BI feed and OpenAI-compatible
    gateway (which expose the same initiative data) must not stay anonymously readable.
    """
    if count_inbound_api_keys(db_path) > 0:
        return False
    sso = get_sso_settings(db_path)
    return not (sso.enabled and sso.enforce_sso and sso.configured)


def verify_inbound_api_key(db_path: Path, bearer_token: str | None) -> bool:
    """Allow open access when no keys are stored; otherwise verify Bearer token against env or SHA-256 hashes."""
    env_keys = get_env_api_keys()
    if env_keys:
        if not bearer_token or not bearer_token.strip():
            return False
        candidate_hash = hashlib.sha256(bearer_token.strip().encode("utf-8")).hexdigest()
        matched = False
        for raw_key in env_keys:
            expected_hash = hashlib.sha256(raw_key.encode("utf-8")).hexdigest()
            if hmac.compare_digest(candidate_hash, expected_hash):
                matched = True
        return matched

    with get_connection(db_path) as conn:
        rows = conn.execute("SELECT id, key_hash FROM api_keys").fetchall()
        if not rows:
            return inbound_open_access_allowed(db_path)
        if not bearer_token or not bearer_token.strip():
            return False
        candidate_hash = hashlib.sha256(bearer_token.strip().encode("utf-8")).hexdigest()
        matched_id: str | None = None
        for row in rows:
            if hmac.compare_digest(candidate_hash, str(row["key_hash"])):
                matched_id = str(row["id"])
        if matched_id is not None:
            conn.execute("UPDATE api_keys SET last_used_at = ? WHERE id = ?", (_now_iso(), matched_id))
            return True
    return False


def count_kb_entities(db_path: Path) -> tuple[int, int, int]:
    """Return (builtin_catalog_count, custom_catalog_count, initiative_count)."""
    with get_connection(db_path) as conn:
        cat_rows = conn.execute(
            "SELECT is_builtin, COUNT(*) AS cnt FROM catalog_entries GROUP BY is_builtin"
        ).fetchall()
        builtin_cnt = 0
        custom_cnt = 0
        for r in cat_rows:
            if bool(r["is_builtin"]):
                builtin_cnt = int(r["cnt"])
            else:
                custom_cnt = int(r["cnt"])
        init_row = conn.execute("SELECT COUNT(*) AS cnt FROM initiatives").fetchone()
        init_cnt = int(init_row["cnt"]) if init_row else 0
    return builtin_cnt, custom_cnt, init_cnt


# --- Admin SSO Settings ---


def build_sso_discovery_url(
    provider: SSOProvider,
    firebase_project_id: str,
    entra_tenant_id: str,
    entra_authority_host: str,
) -> str:
    """Compute the OpenID Connect discovery URL for Firebase Auth or Microsoft Entra ID."""
    if provider == "firebase":
        pid = firebase_project_id.strip()
        return f"https://securetoken.google.com/{pid}/.well-known/openid-configuration" if pid else ""
    tid = entra_tenant_id.strip()
    host = (entra_authority_host.strip().rstrip("/") or "https://login.microsoftonline.com")
    return f"{host}/{tid}/v2.0/.well-known/openid-configuration" if tid else ""


def _row_to_sso_raw(row: sqlite3.Row | None) -> dict[str, Any]:
    if row is None:
        return {
            "enabled": False,
            "provider": "firebase",
            "enforce_sso": False,
            "allowed_domains": [],
            "admin_emails": [],
            "firebase_project_id": "",
            "firebase_auth_domain": "",
            "firebase_api_key": "",
            "firebase_app_id": "",
            "firebase_tenant_id": "",
            "firebase_sign_in_methods": ["google"],
            "entra_tenant_id": "",
            "entra_client_id": "",
            "entra_client_secret": "",
            "entra_authority_host": "https://login.microsoftonline.com",
            "entra_redirect_uri": "",
            "entra_scopes": "openid profile email",
            "updated_at": None,
        }
    return {
        "enabled": bool(row["enabled"]),
        "provider": str(row["provider"] or "firebase"),
        "enforce_sso": bool(row["enforce_sso"]),
        "allowed_domains": json.loads(row["allowed_domains_json"] or "[]"),
        "admin_emails": json.loads(row["admin_emails_json"] or "[]"),
        "firebase_project_id": str(row["firebase_project_id"] or ""),
        "firebase_auth_domain": str(row["firebase_auth_domain"] or ""),
        "firebase_api_key": str(row["firebase_api_key"] or ""),
        "firebase_app_id": str(row["firebase_app_id"] or ""),
        "firebase_tenant_id": str(row["firebase_tenant_id"] or ""),
        "firebase_sign_in_methods": json.loads(row["firebase_sign_in_methods_json"] or '["google"]') or ["google"],
        "entra_tenant_id": str(row["entra_tenant_id"] or ""),
        "entra_client_id": str(row["entra_client_id"] or ""),
        "entra_client_secret": str(row["entra_client_secret"] or ""),
        "entra_authority_host": str(row["entra_authority_host"] or "https://login.microsoftonline.com"),
        "entra_redirect_uri": str(row["entra_redirect_uri"] or ""),
        "entra_scopes": str(row["entra_scopes"] or "openid profile email"),
        "updated_at": str(row["updated_at"]) if row["updated_at"] else None,
    }


def _is_sso_configured(raw: dict[str, Any]) -> bool:
    if raw["provider"] == "firebase":
        return bool(
            raw["firebase_project_id"].strip()
            and raw["firebase_auth_domain"].strip()
            and raw["firebase_api_key"].strip()
        )
    return bool(raw["entra_tenant_id"].strip() and raw["entra_client_id"].strip())


def _raw_to_sso_out(raw: dict[str, Any]) -> SSOSettingsOut:
    provider: SSOProvider = "entra" if raw["provider"] == "entra" else "firebase"
    secret = str(raw.get("entra_client_secret") or "")
    discovery_url = build_sso_discovery_url(
        provider,
        raw["firebase_project_id"],
        raw["entra_tenant_id"],
        raw["entra_authority_host"],
    )
    return SSOSettingsOut(
        enabled=bool(raw["enabled"]),
        provider=provider,
        enforce_sso=bool(raw["enforce_sso"]),
        allowed_domains=list(raw["allowed_domains"]),
        admin_emails=list(raw["admin_emails"]),
        firebase_project_id=raw["firebase_project_id"],
        firebase_auth_domain=raw["firebase_auth_domain"],
        firebase_api_key=raw["firebase_api_key"],
        firebase_app_id=raw["firebase_app_id"],
        firebase_tenant_id=raw["firebase_tenant_id"],
        firebase_sign_in_methods=list(raw["firebase_sign_in_methods"]),
        entra_tenant_id=raw["entra_tenant_id"],
        entra_client_id=raw["entra_client_id"],
        entra_client_secret_set=bool(secret),
        entra_client_secret_masked=mask_secret(secret),
        entra_authority_host=raw["entra_authority_host"],
        entra_redirect_uri=raw["entra_redirect_uri"],
        entra_scopes=raw["entra_scopes"],
        configured=_is_sso_configured(raw),
        oidc_discovery_url=discovery_url,
        updated_at=raw.get("updated_at"),
        managed_by_env=bool(raw.get("managed_by_env", False)),
        env_vars=list(raw.get("env_vars", [])),
    )


def get_sso_settings_raw(db_path: Path) -> dict[str, Any]:
    env_cfg, env_vars = get_sso_env_config()
    if env_cfg is not None:
        return {**env_cfg, "managed_by_env": True, "env_vars": env_vars}

    with get_connection(db_path) as conn:
        row = conn.execute("SELECT * FROM sso_settings WHERE id = 1").fetchone()
    return {**_row_to_sso_raw(row), "managed_by_env": False, "env_vars": []}


def get_sso_settings(db_path: Path) -> SSOSettingsOut:
    return _raw_to_sso_out(get_sso_settings_raw(db_path))


def get_sso_public_config(db_path: Path) -> SSOPublicConfigOut:
    out = get_sso_settings(db_path)
    return SSOPublicConfigOut(
        enabled=out.enabled,
        provider=out.provider,
        enforce_sso=out.enforce_sso,
        configured=out.configured,
        oidc_discovery_url=out.oidc_discovery_url,
        firebase_project_id=out.firebase_project_id,
        firebase_auth_domain=out.firebase_auth_domain,
        firebase_api_key=out.firebase_api_key,
        firebase_app_id=out.firebase_app_id,
        firebase_tenant_id=out.firebase_tenant_id,
        firebase_sign_in_methods=out.firebase_sign_in_methods,
        entra_tenant_id=out.entra_tenant_id,
        entra_client_id=out.entra_client_id,
        entra_authority_host=out.entra_authority_host,
        entra_redirect_uri=out.entra_redirect_uri,
        entra_scopes=out.entra_scopes,
    )


def update_sso_settings(db_path: Path, payload: SSOSettingsUpdate) -> SSOSettingsOut:
    if is_sso_env_managed():
        raise ConflictError(
            "SSO settings are managed by environment variables and locked in the Admin Portal. Update your .env file and restart the server to change them."
        )

    now = _now_iso()
    with get_connection(db_path) as conn:
        existing = conn.execute("SELECT * FROM sso_settings WHERE id = 1").fetchone()
        current = _row_to_sso_raw(existing)

        if payload.clear_entra_client_secret:
            next_secret = ""
        elif payload.entra_client_secret is not None and payload.entra_client_secret.strip():
            next_secret = payload.entra_client_secret.strip()
        else:
            next_secret = current["entra_client_secret"]

        conn.execute(
            """
            INSERT INTO sso_settings (
                id, enabled, provider, enforce_sso, allowed_domains_json, admin_emails_json,
                firebase_project_id, firebase_auth_domain, firebase_api_key, firebase_app_id,
                firebase_tenant_id, firebase_sign_in_methods_json,
                entra_tenant_id, entra_client_id, entra_client_secret, entra_authority_host,
                entra_redirect_uri, entra_scopes, updated_at
            ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                enabled = excluded.enabled,
                provider = excluded.provider,
                enforce_sso = excluded.enforce_sso,
                allowed_domains_json = excluded.allowed_domains_json,
                admin_emails_json = excluded.admin_emails_json,
                firebase_project_id = excluded.firebase_project_id,
                firebase_auth_domain = excluded.firebase_auth_domain,
                firebase_api_key = excluded.firebase_api_key,
                firebase_app_id = excluded.firebase_app_id,
                firebase_tenant_id = excluded.firebase_tenant_id,
                firebase_sign_in_methods_json = excluded.firebase_sign_in_methods_json,
                entra_tenant_id = excluded.entra_tenant_id,
                entra_client_id = excluded.entra_client_id,
                entra_client_secret = excluded.entra_client_secret,
                entra_authority_host = excluded.entra_authority_host,
                entra_redirect_uri = excluded.entra_redirect_uri,
                entra_scopes = excluded.entra_scopes,
                updated_at = excluded.updated_at
            """,
            (
                int(payload.enabled),
                payload.provider,
                int(payload.enforce_sso),
                json.dumps(payload.allowed_domains),
                json.dumps(payload.admin_emails),
                payload.firebase_project_id,
                payload.firebase_auth_domain,
                payload.firebase_api_key,
                payload.firebase_app_id,
                payload.firebase_tenant_id,
                json.dumps(payload.firebase_sign_in_methods),
                payload.entra_tenant_id,
                payload.entra_client_id,
                next_secret,
                payload.entra_authority_host,
                payload.entra_redirect_uri,
                payload.entra_scopes,
                now,
            ),
        )
        row = conn.execute("SELECT * FROM sso_settings WHERE id = 1").fetchone()
    return _raw_to_sso_out(_row_to_sso_raw(row))


# --- Admin Roles & Users Management ---


def _row_to_role_out(row: sqlite3.Row) -> RoleOut:
    return RoleOut(
        id=str(row["id"]),
        name=str(row["name"]),
        description=str(row["description"] or ""),
        permissions=json.loads(row["permissions_json"] or "[]"),
        is_system=bool(row["is_system"]),
        user_count=int(row["user_count"]),
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
    )


def list_roles(db_path: Path) -> list[RoleOut]:
    with get_connection(db_path) as conn:
        rows = conn.execute(
            """
            SELECT r.*, COALESCE(u.cnt, 0) AS user_count
            FROM roles r
            LEFT JOIN (SELECT role_id, COUNT(*) AS cnt FROM users GROUP BY role_id) u
              ON u.role_id = r.id
            ORDER BY r.is_system DESC, LOWER(r.name) ASC
            """
        ).fetchall()
    return [_row_to_role_out(r) for r in rows]


def create_role(db_path: Path, payload: RoleCreate) -> RoleOut:
    role_id = f"role-{uuid4().hex[:10]}"
    now = _now_iso()
    with get_connection(db_path) as conn:
        dup = conn.execute("SELECT id FROM roles WHERE LOWER(name) = LOWER(?)", (payload.name,)).fetchone()
        if dup:
            raise ConflictError(f"Role '{payload.name}' already exists.")
        conn.execute(
            """
            INSERT INTO roles (id, name, description, permissions_json, is_system, created_at, updated_at)
            VALUES (?, ?, ?, ?, 0, ?, ?)
            """,
            (
                role_id,
                payload.name,
                payload.description.strip(),
                json.dumps(payload.permissions),
                now,
                now,
            ),
        )
        row = conn.execute(
            """
            SELECT r.*, 0 AS user_count FROM roles r WHERE r.id = ?
            """,
            (role_id,),
        ).fetchone()
    assert row is not None
    return _row_to_role_out(row)


def update_role(db_path: Path, role_id: str, payload: RoleUpdate) -> RoleOut:
    now = _now_iso()
    with get_connection(db_path) as conn:
        row = conn.execute("SELECT * FROM roles WHERE id = ?", (role_id,)).fetchone()
        if not row:
            raise NotFoundError(f"Role '{role_id}' not found.")

        next_name = payload.name if payload.name is not None else str(row["name"])
        next_desc = payload.description.strip() if payload.description is not None else str(row["description"] or "")
        next_perms = (
            payload.permissions
            if payload.permissions is not None
            else json.loads(row["permissions_json"] or "[]")
        )

        if role_id == "role-admin" and ("admin:roles" not in next_perms or "admin:users" not in next_perms):
            raise ValidationError(
                "System Administrator role must retain 'admin:roles' and 'admin:users' permissions."
            )

        dup = conn.execute(
            "SELECT id FROM roles WHERE LOWER(name) = LOWER(?) AND id != ?",
            (next_name, role_id),
        ).fetchone()
        if dup:
            raise ConflictError(f"Role '{next_name}' already exists.")

        conn.execute(
            """
            UPDATE roles
            SET name = ?, description = ?, permissions_json = ?, updated_at = ?
            WHERE id = ?
            """,
            (next_name, next_desc, json.dumps(next_perms), now, role_id),
        )
        updated_row = conn.execute(
            """
            SELECT r.*, COALESCE((SELECT COUNT(*) FROM users u WHERE u.role_id = r.id), 0) AS user_count
            FROM roles r WHERE r.id = ?
            """,
            (role_id,),
        ).fetchone()
    assert updated_row is not None
    return _row_to_role_out(updated_row)


def delete_role(db_path: Path, role_id: str) -> None:
    with get_connection(db_path) as conn:
        row = conn.execute(
            """
            SELECT r.is_system, COALESCE((SELECT COUNT(*) FROM users u WHERE u.role_id = r.id), 0) AS user_count
            FROM roles r WHERE r.id = ?
            """,
            (role_id,),
        ).fetchone()
        if not row:
            raise NotFoundError(f"Role '{role_id}' not found.")
        if bool(row["is_system"]):
            raise ConflictError("Built-in system roles cannot be deleted.")
        if int(row["user_count"]) > 0:
            raise ConflictError(
                f"Cannot delete role while {int(row['user_count'])} user(s) are assigned to it."
            )
        conn.execute("DELETE FROM roles WHERE id = ?", (role_id,))


def _row_to_user_out(row: sqlite3.Row) -> UserOut:
    return UserOut(
        id=str(row["id"]),
        email=str(row["email"]),
        display_name=str(row["display_name"]),
        role_id=str(row["role_id"]),
        role_name=str(row["role_name"]),
        status=row["status"],
        auth_provider=row["auth_provider"],
        last_login_at=str(row["last_login_at"]) if row["last_login_at"] else None,
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
    )


def list_users(
    db_path: Path,
    *,
    search: str | None = None,
    role_id: str | None = None,
    status_filter: str | None = None,
) -> list[UserOut]:
    with get_connection(db_path) as conn:
        query = (
            "SELECT u.*, r.name AS role_name "
            "FROM users u "
            "JOIN roles r ON r.id = u.role_id "
            "WHERE 1=1"
        )
        params: list[Any] = []
        if role_id and role_id.strip():
            query += " AND u.role_id = ?"
            params.append(role_id.strip())
        if status_filter and status_filter.strip():
            query += " AND u.status = ?"
            params.append(status_filter.strip().lower())
        if search and search.strip():
            like = f"%{search.strip().lower()}%"
            query += " AND (LOWER(u.email) LIKE ? OR LOWER(u.display_name) LIKE ?)"
            params.extend([like, like])
        query += " ORDER BY u.created_at ASC, LOWER(u.email) ASC"
        rows = conn.execute(query, params).fetchall()
    return [_row_to_user_out(r) for r in rows]


def create_user(db_path: Path, payload: UserCreate) -> UserOut:
    user_id = str(uuid4())
    now = _now_iso()
    with get_connection(db_path) as conn:
        role_row = conn.execute("SELECT id FROM roles WHERE id = ?", (payload.role_id,)).fetchone()
        if not role_row:
            raise ValidationError(f"Role '{payload.role_id}' does not exist.")
        dup = conn.execute("SELECT id FROM users WHERE LOWER(email) = LOWER(?)", (payload.email,)).fetchone()
        if dup:
            raise ConflictError(f"User with email '{payload.email}' already exists.")
        conn.execute(
            """
            INSERT INTO users (
                id, email, display_name, role_id, status, auth_provider, last_login_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
            """,
            (
                user_id,
                payload.email,
                payload.display_name,
                payload.role_id,
                payload.status,
                payload.auth_provider,
                now,
                now,
            ),
        )
        row = conn.execute(
            "SELECT u.*, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?",
            (user_id,),
        ).fetchone()
    assert row is not None
    return _row_to_user_out(row)


def update_user(db_path: Path, user_id: str, payload: UserUpdate) -> UserOut:
    now = _now_iso()
    with get_connection(db_path) as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row:
            raise NotFoundError(f"User '{user_id}' not found.")

        next_email = payload.email if payload.email is not None else str(row["email"])
        next_name = payload.display_name if payload.display_name is not None else str(row["display_name"])
        next_role = payload.role_id if payload.role_id is not None else str(row["role_id"])
        next_status = payload.status if payload.status is not None else str(row["status"])
        next_provider = payload.auth_provider if payload.auth_provider is not None else str(row["auth_provider"])

        role_row = conn.execute("SELECT id FROM roles WHERE id = ?", (next_role,)).fetchone()
        if not role_row:
            raise ValidationError(f"Role '{next_role}' does not exist.")

        dup = conn.execute(
            "SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id != ?",
            (next_email, user_id),
        ).fetchone()
        if dup:
            raise ConflictError(f"User with email '{next_email}' already exists.")

        conn.execute(
            """
            UPDATE users
            SET email = ?, display_name = ?, role_id = ?, status = ?, auth_provider = ?, updated_at = ?
            WHERE id = ?
            """,
            (next_email, next_name, next_role, next_status, next_provider, now, user_id),
        )
        updated = conn.execute(
            "SELECT u.*, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?",
            (user_id,),
        ).fetchone()
    assert updated is not None
    return _row_to_user_out(updated)


def delete_user(db_path: Path, user_id: str) -> None:
    with get_connection(db_path) as conn:
        cur = conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        if cur.rowcount == 0:
            raise NotFoundError(f"User '{user_id}' not found.")


def _should_refresh_last_login(last_login_raw: str | None, now_dt: datetime) -> bool:
    if not last_login_raw:
        return True
    try:
        prev_dt = datetime.fromisoformat(last_login_raw)
        if prev_dt.tzinfo is None:
            prev_dt = prev_dt.replace(tzinfo=timezone.utc)
        return (now_dt - prev_dt).total_seconds() >= 300.0
    except ValueError:
        return True


def resolve_or_provision_sso_user(
    db_path: Path,
    *,
    email: str,
    display_name: str,
    photo_url: str = "",
    provider: SSOProvider = "firebase",
    allowed_domains: list[str] | None = None,
    admin_emails: list[str] | None = None,
) -> AuthUserOut:
    """Resolve an authenticated SSO email to an RBAC user, enforcing domain/invite policy."""
    norm_email = email.strip().lower()
    if "@" not in norm_email:
        raise ForbiddenError("Verified account is missing a valid email address.")
    domain = norm_email.rsplit("@", 1)[1]
    allowed_set = {d.strip().lower().lstrip("@") for d in (allowed_domains or []) if d and d.strip()}
    admin_set = {a.strip().lower() for a in (admin_emails or []) if a and a.strip()}

    now_dt = datetime.now(timezone.utc)
    now = now_dt.isoformat()
    clean_name = display_name.strip() or norm_email.split("@", 1)[0]

    with get_connection(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE LOWER(email) = ?",
            (norm_email,),
        ).fetchone()

        is_listed_admin = norm_email in admin_set

        if is_listed_admin:
            if row is not None:
                needs_update = (
                    str(row["role_id"]) != "role-admin"
                    or str(row["status"]) != "active"
                    or str(row["auth_provider"]) != provider
                    or _should_refresh_last_login(row["last_login_at"], now_dt)
                )
                if needs_update:
                    next_name = str(row["display_name"] or "").strip() or clean_name
                    conn.execute(
                        """
                        UPDATE users
                        SET role_id = 'role-admin',
                            status = 'active',
                            auth_provider = ?,
                            display_name = ?,
                            last_login_at = ?,
                            updated_at = ?
                        WHERE id = ?
                        """,
                        (provider, next_name, now, now, row["id"]),
                    )
            else:
                conn.execute(
                    """
                    INSERT INTO users (
                        id, email, display_name, role_id, status, auth_provider, last_login_at, created_at, updated_at
                    ) VALUES (?, ?, ?, 'role-admin', 'active', ?, ?, ?, ?)
                    """,
                    (str(uuid4()), norm_email, clean_name, provider, now, now, now),
                )
        elif row is not None:
            current_status = str(row["status"] or "")
            if current_status == "disabled":
                raise ForbiddenError(
                    "Your account has been disabled. Contact a platform administrator."
                )
            needs_activation = current_status != "active"
            if needs_activation or _should_refresh_last_login(row["last_login_at"], now_dt):
                next_provider = provider if str(row["auth_provider"]) in {"local", ""} else str(row["auth_provider"])
                next_name = (
                    clean_name
                    if needs_activation or not str(row["display_name"] or "").strip()
                    else str(row["display_name"])
                )
                conn.execute(
                    """
                    UPDATE users
                    SET status = 'active',
                        auth_provider = ?,
                        display_name = ?,
                        last_login_at = ?,
                        updated_at = ?
                    WHERE id = ?
                    """,
                    (next_provider, next_name, now, now, row["id"]),
                )
        else:
            if allowed_set:
                if domain not in allowed_set:
                    raise ForbiddenError(
                        f"Email domain '{domain}' is not authorized to access this workspace."
                    )
            elif admin_set:
                raise ForbiddenError(
                    "Access requires an administrator invitation. Ask an admin to add your email under Admin Portal → Users."
                )

            conn.execute(
                """
                INSERT INTO users (
                    id, email, display_name, role_id, status, auth_provider, last_login_at, created_at, updated_at
                ) VALUES (?, ?, ?, 'role-analyst', 'active', ?, ?, ?, ?)
                """,
                (str(uuid4()), norm_email, clean_name, provider, now, now, now),
            )

        resolved = conn.execute(
            """
            SELECT u.*, r.name AS role_name, r.permissions_json
            FROM users u
            JOIN roles r ON r.id = u.role_id
            WHERE LOWER(u.email) = ?
            """,
            (norm_email,),
        ).fetchone()

    assert resolved is not None
    perms = [str(p) for p in json.loads(resolved["permissions_json"] or "[]")]
    return AuthUserOut(
        id=str(resolved["id"]),
        email=str(resolved["email"]),
        display_name=str(resolved["display_name"]),
        role_id=str(resolved["role_id"]),
        role_name=str(resolved["role_name"]),
        permissions=perms,
        is_admin=any(p.startswith("admin:") for p in perms),
        photo_url=photo_url,
        auth_provider=resolved["auth_provider"],
    )
