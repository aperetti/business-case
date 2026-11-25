"""SQLite connection management, schema initialization, and baseline/demo seeding."""

from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator
from uuid import uuid4

from app.core.catalog import BASELINE_CATALOG

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS catalog_entries (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('cost', 'benefit')),
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

CREATE TABLE IF NOT EXISTS catalog_docs (
    catalog_id TEXT PRIMARY KEY REFERENCES catalog_entries(id) ON DELETE CASCADE,
    content_json TEXT NOT NULL,
    is_template INTEGER NOT NULL DEFAULT 0,
    updated_by TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS initiatives (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    domain TEXT NOT NULL,
    horizon_years INTEGER NOT NULL,
    discount_rate REAL NOT NULL,
    cost_start_year INTEGER,
    external_resource_url TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS initiative_bcas (
    id TEXT PRIMARY KEY,
    initiative_id TEXT NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    horizon_years INTEGER NOT NULL,
    discount_rate REAL NOT NULL,
    cost_start_year INTEGER,
    is_baseline INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS initiative_items (
    id TEXT PRIMARY KEY,
    initiative_id TEXT NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
    bca_id TEXT REFERENCES initiative_bcas(id) ON DELETE CASCADE,
    catalog_id TEXT NOT NULL REFERENCES catalog_entries(id) ON DELETE RESTRICT,
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

CREATE TABLE IF NOT EXISTS initiative_measures (
    id TEXT PRIMARY KEY,
    initiative_id TEXT NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT '',
    direction TEXT NOT NULL DEFAULT 'higher_is_better',
    description TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_measures_initiative ON initiative_measures(initiative_id, sort_order);

CREATE TABLE IF NOT EXISTS bca_measure_values (
    bca_id TEXT NOT NULL REFERENCES initiative_bcas(id) ON DELETE CASCADE,
    measure_id TEXT NOT NULL REFERENCES initiative_measures(id) ON DELETE CASCADE,
    value REAL NOT NULL,
    low REAL,
    high REAL,
    note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (bca_id, measure_id)
);
CREATE INDEX IF NOT EXISTS idx_measure_values_measure ON bca_measure_values(measure_id);

CREATE TABLE IF NOT EXISTS simulation_runs (
    id TEXT PRIMARY KEY,
    initiative_id TEXT NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
    bca_id TEXT REFERENCES initiative_bcas(id) ON DELETE CASCADE,
    n_simulations INTEGER NOT NULL,
    discount_rate REAL NOT NULL,
    horizon_years INTEGER NOT NULL,
    seed INTEGER,
    summary_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bca_comparisons (
    id TEXT PRIMARY KEY,
    initiative_id TEXT NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
    bca_a_id TEXT NOT NULL REFERENCES initiative_bcas(id) ON DELETE CASCADE,
    bca_b_id TEXT NOT NULL REFERENCES initiative_bcas(id) ON DELETE CASCADE,
    n_simulations INTEGER NOT NULL,
    seed INTEGER,
    summary_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bcas_initiative ON initiative_bcas(initiative_id, is_baseline DESC, sort_order ASC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_items_initiative ON initiative_items(initiative_id);
CREATE INDEX IF NOT EXISTS idx_runs_initiative_created ON simulation_runs(initiative_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comparisons_initiative ON bca_comparisons(initiative_id, created_at DESC);

CREATE TABLE IF NOT EXISTS llm_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    base_url TEXT NOT NULL DEFAULT '',
    api_key TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    temperature REAL NOT NULL DEFAULT 0.2,
    max_tokens INTEGER NOT NULL DEFAULT 1024,
    timeout_seconds INTEGER NOT NULL DEFAULT 45,
    system_prompt TEXT NOT NULL DEFAULT '',
    verified INTEGER NOT NULL DEFAULT 0,
    verified_at TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    key_last4 TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS sso_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    enabled INTEGER NOT NULL DEFAULT 0,
    provider TEXT NOT NULL DEFAULT 'firebase' CHECK(provider IN ('firebase', 'entra')),
    enforce_sso INTEGER NOT NULL DEFAULT 0,
    allowed_domains_json TEXT NOT NULL DEFAULT '[]',
    admin_emails_json TEXT NOT NULL DEFAULT '[]',
    firebase_project_id TEXT NOT NULL DEFAULT '',
    firebase_auth_domain TEXT NOT NULL DEFAULT '',
    firebase_api_key TEXT NOT NULL DEFAULT '',
    firebase_app_id TEXT NOT NULL DEFAULT '',
    firebase_tenant_id TEXT NOT NULL DEFAULT '',
    firebase_sign_in_methods_json TEXT NOT NULL DEFAULT '["google"]',
    entra_tenant_id TEXT NOT NULL DEFAULT '',
    entra_client_id TEXT NOT NULL DEFAULT '',
    entra_client_secret TEXT NOT NULL DEFAULT '',
    entra_authority_host TEXT NOT NULL DEFAULT 'https://login.microsoftonline.com',
    entra_redirect_uri TEXT NOT NULL DEFAULT '',
    entra_scopes TEXT NOT NULL DEFAULT 'openid profile email',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    permissions_json TEXT NOT NULL DEFAULT '[]',
    is_system INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'invited', 'disabled')),
    auth_provider TEXT NOT NULL DEFAULT 'local' CHECK(auth_provider IN ('local', 'firebase', 'entra')),
    last_login_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role_id);

CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    notify_submitter INTEGER NOT NULL DEFAULT 1,
    steps_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approval_requests (
    id TEXT PRIMARY KEY,
    initiative_id TEXT NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
    workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL,
    workflow_name TEXT NOT NULL,
    steps_json TEXT NOT NULL,
    notify_submitter INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'withdrawn')),
    current_step_index INTEGER,
    submitted_by_email TEXT NOT NULL DEFAULT '',
    submitted_by_name TEXT NOT NULL DEFAULT '',
    submitted_at TEXT NOT NULL,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_initiative ON approval_requests(initiative_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);

CREATE TABLE IF NOT EXISTS approval_actions (
    id TEXT PRIMARY KEY,
    request_id TEXT REFERENCES approval_requests(id) ON DELETE CASCADE,
    initiative_id TEXT NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    step_index INTEGER,
    step_name TEXT,
    actor_email TEXT NOT NULL DEFAULT '',
    actor_name TEXT NOT NULL DEFAULT '',
    comment TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approval_actions_initiative ON approval_actions(initiative_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_approval_actions_request ON approval_actions(request_id, created_at ASC);

CREATE TABLE IF NOT EXISTS email_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    enabled INTEGER NOT NULL DEFAULT 0,
    host TEXT NOT NULL DEFAULT '',
    port INTEGER NOT NULL DEFAULT 587,
    security TEXT NOT NULL DEFAULT 'starttls',
    username TEXT NOT NULL DEFAULT '',
    password TEXT NOT NULL DEFAULT '',
    from_address TEXT NOT NULL DEFAULT '',
    from_name TEXT NOT NULL DEFAULT 'ValueStream BCA',
    app_base_url TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_log (
    id TEXT PRIMARY KEY,
    recipients_json TEXT NOT NULL,
    subject TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT NOT NULL DEFAULT '',
    initiative_id TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_log_created ON email_log(created_at DESC);
"""


@contextmanager
def get_connection(db_path: Path) -> Iterator[sqlite3.Connection]:
    """Open a SQLite connection configured with WAL mode and enforced foreign keys."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON;")
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("PRAGMA busy_timeout = 5000;")
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _seed_baseline_catalog(conn: sqlite3.Connection, now_iso: str) -> None:
    for entry in BASELINE_CATALOG:
        conn.execute(
            """
            INSERT OR IGNORE INTO catalog_entries (
                id, kind, name, description, domains_json, value_stream_stage,
                parameters_json, formula_type, guardrail_notes, is_builtin, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
            """,
            (
                entry["id"],
                entry["kind"],
                entry["name"],
                entry["description"],
                json.dumps(entry["domains"]),
                entry.get("value_stream_stage"),
                json.dumps(entry["parameters"]),
                entry["formula_type"],
                entry.get("guardrail_notes", ""),
                now_iso,
            ),
        )


DEMO_INITIATIVES: list[dict] = [
    {
        "name": "Platform Delivery & Incident Automation Program",
        "description": (
            "Cross-team CI/CD modernization, automated runbook remediation, and shared internal "
            "developer platform modeled across a 7-year horizon."
        ),
        "domain": "software",
        "horizon_years": 7,
        "discount_rate": 0.07,
        "cost_start_year": 2026,
        "external_resource_url": "",
        "items": [
            {
                "catalog_id": "COST-BUILD-01",
                "label": "Core Platform Build & Integration",
                "value_stream": "Software Delivery",
                "start_year": 1,
                "end_year": 2,
                "ramp_profile": "custom_weights",
                "ramp_weights": [1.0, 0.35],
                "param_values": {"hours": 1400.0, "hourly_rate": 145.0, "vendor_cost": 45000.0},
                "uncertainty_spec": {
                    "correlation_group": "delivery_effort",
                    "correlation_rho": 0.75,
                    "parameters": {
                        "hours": {"distribution": "pert", "low_pct": -0.15, "high_pct": 0.40},
                        "vendor_cost": {"distribution": "triangular", "low_pct": -0.10, "high_pct": 0.30},
                    },
                },
                "anti_double_count_tag": None,
            },
            {
                "catalog_id": "COST-RUN-01",
                "label": "Cloud Hosting, Observability & SRE Support",
                "value_stream": "Incident Response",
                "start_year": 1,
                "end_year": 7,
                "ramp_profile": "immediate",
                "ramp_weights": None,
                "param_values": {
                    "annual_infra_cost": 28000.0,
                    "annual_license_cost": 18000.0,
                    "support_hours_per_year": 320.0,
                    "hourly_rate": 135.0,
                },
                "uncertainty_spec": {
                    "parameters": {
                        "annual_infra_cost": {"distribution": "normal", "std_pct": 0.15},
                        "support_hours_per_year": {"distribution": "pert", "low_pct": -0.20, "high_pct": 0.35},
                    },
                },
                "anti_double_count_tag": None,
            },
            {
                "catalog_id": "COST-ENAB-01",
                "label": "Developer Enablement & Workflow Transition",
                "value_stream": "Capability Enablement",
                "start_year": 1,
                "end_year": 1,
                "ramp_profile": "immediate",
                "ramp_weights": None,
                "param_values": {
                    "training_hours": 10.0,
                    "affected_staff": 60.0,
                    "hourly_rate": 95.0,
                    "transition_cost": 18000.0,
                },
                "uncertainty_spec": {
                    "correlation_group": "delivery_effort",
                    "correlation_rho": 0.65,
                    "item_multiplier": {"distribution": "triangular", "low": 0.85, "mode": 1.0, "high": 1.30},
                },
                "anti_double_count_tag": None,
            },
            {
                "catalog_id": "BEN-TOIL-01",
                "label": "CI/CD & Runbook Toil Automation",
                "value_stream": "Software Delivery",
                "start_year": 2,
                "end_year": 7,
                "ramp_profile": "s_curve",
                "ramp_weights": None,
                "param_values": {
                    "events_per_year": 12000.0,
                    "minutes_saved_per_event": 22.0,
                    "hourly_rate": 120.0,
                    "adoption_rate": 0.85,
                    "realization_factor": 0.78,
                },
                "uncertainty_spec": {
                    "correlation_group": "adoption",
                    "correlation_rho": 0.75,
                    "parameters": {
                        "adoption_rate": {"distribution": "pert", "low": 0.55, "mode": 0.85, "high": 0.96},
                        "realization_factor": {"distribution": "pert", "low": 0.45, "mode": 0.78, "high": 0.92},
                    },
                },
                "anti_double_count_tag": "eng-capacity",
            },
            {
                "catalog_id": "BEN-QUAL-01",
                "label": "Production Incident & MTTR Avoidance",
                "value_stream": "Incident Response",
                "start_year": 2,
                "end_year": 7,
                "ramp_profile": "linear",
                "ramp_weights": None,
                "param_values": {
                    "baseline_events_per_year": 64.0,
                    "risk_reduction_pct": 0.50,
                    "cost_per_event": 8500.0,
                },
                "uncertainty_spec": {
                    "correlation_group": "adoption",
                    "correlation_rho": 0.60,
                    "parameters": {
                        "risk_reduction_pct": {"distribution": "pert", "low": 0.25, "mode": 0.50, "high": 0.70},
                        "cost_per_event": {"distribution": "lognormal", "std_pct": 0.30},
                    },
                },
                "anti_double_count_tag": None,
            },
            {
                "catalog_id": "BEN-CAP-01",
                "label": "Shared Internal Platform Reuse Leverage",
                "value_stream": "Capability Enablement",
                "start_year": 3,
                "end_year": 7,
                "ramp_profile": "s_curve",
                "ramp_weights": None,
                "param_values": {
                    "downstream_initiatives": 4.0,
                    "avoided_setup_cost": 70000.0,
                    "reuse_probability": 0.75,
                },
                "uncertainty_spec": {
                    "correlation_group": "adoption",
                    "correlation_rho": 0.65,
                    "parameters": {
                        "reuse_probability": {"distribution": "triangular", "low": 0.40, "mode": 0.75, "high": 0.92},
                        "avoided_setup_cost": {"distribution": "normal", "std_pct": 0.20},
                    },
                },
                "anti_double_count_tag": None,
            },
        ],
        "measures": [
            {
                "name": "Customer satisfaction (CSAT)",
                "unit": "pts",
                "direction": "higher_is_better",
                "description": "Quarterly CSAT for internal platform users, 0-100.",
            },
            {
                "name": "Mean time to restore",
                "unit": "hours",
                "direction": "lower_is_better",
                "description": "Average time to restore service after a P1/P2 incident.",
            },
            {
                "name": "Delivery risk",
                "unit": "score 1-5",
                "direction": "lower_is_better",
                "description": "Delivery team's assessed execution risk (1 = low, 5 = high).",
            },
        ],
        "baseline_measure_values": {
            "Customer satisfaction (CSAT)": {"value": 74, "low": 70, "high": 78},
            "Mean time to restore": {"value": 3.5, "low": 2.5, "high": 5.0},
            "Delivery risk": {"value": 2, "low": 1.5, "high": 3},
        },
        "extra_bcas": [
            {
                "name": "Accelerated Cloud-Native BCA",
                "measure_values": {
                    "Customer satisfaction (CSAT)": {"value": 81, "low": 75, "high": 86},
                    "Mean time to restore": {"value": 1.5, "low": 1.0, "high": 2.5},
                    "Delivery risk": {"value": 3.5, "low": 2.5, "high": 4.5},
                },
                "description": (
                    "Higher Year-1 investment in managed PaaS and team enablement to compress "
                    "time-to-adoption and lower recurring SRE run overhead."
                ),
                "horizon_years": 7,
                "discount_rate": 0.07,
                "cost_start_year": 2026,
                "items": [
                    {
                        "catalog_id": "COST-BUILD-01",
                        "label": "Accelerated PaaS & Golden-Path Engineering",
                        "value_stream": "Software Delivery",
                        "start_year": 1,
                        "end_year": 2,
                        "ramp_profile": "custom_weights",
                        "ramp_weights": [1.0, 0.20],
                        "param_values": {"hours": 1750.0, "hourly_rate": 145.0, "vendor_cost": 75000.0},
                        "uncertainty_spec": {
                            "correlation_group": "delivery_effort",
                            "correlation_rho": 0.75,
                            "parameters": {
                                "hours": {"distribution": "pert", "low_pct": -0.10, "high_pct": 0.35},
                                "vendor_cost": {"distribution": "triangular", "low_pct": -0.10, "high_pct": 0.25},
                            },
                        },
                        "anti_double_count_tag": None,
                    },
                    {
                        "catalog_id": "COST-RUN-01",
                        "label": "Managed Cloud Hosting & Lean SRE Run",
                        "value_stream": "Incident Response",
                        "start_year": 1,
                        "end_year": 7,
                        "ramp_profile": "immediate",
                        "ramp_weights": None,
                        "param_values": {
                            "annual_infra_cost": 22000.0,
                            "annual_license_cost": 16000.0,
                            "support_hours_per_year": 210.0,
                            "hourly_rate": 135.0,
                        },
                        "uncertainty_spec": {
                            "parameters": {
                                "annual_infra_cost": {"distribution": "normal", "std_pct": 0.12},
                                "support_hours_per_year": {"distribution": "pert", "low_pct": -0.15, "high_pct": 0.25},
                            },
                        },
                        "anti_double_count_tag": None,
                    },
                    {
                        "catalog_id": "COST-ENAB-01",
                        "label": "Embedded Platform Coaching & Guilds",
                        "value_stream": "Capability Enablement",
                        "start_year": 1,
                        "end_year": 1,
                        "ramp_profile": "immediate",
                        "ramp_weights": None,
                        "param_values": {
                            "training_hours": 14.0,
                            "affected_staff": 70.0,
                            "hourly_rate": 95.0,
                            "transition_cost": 28000.0,
                        },
                        "uncertainty_spec": {
                            "correlation_group": "delivery_effort",
                            "correlation_rho": 0.65,
                            "item_multiplier": {"distribution": "triangular", "low": 0.90, "mode": 1.0, "high": 1.25},
                        },
                        "anti_double_count_tag": None,
                    },
                    {
                        "catalog_id": "BEN-TOIL-01",
                        "label": "Full-Pipeline & Self-Service Toil Automation",
                        "value_stream": "Software Delivery",
                        "start_year": 1,
                        "end_year": 7,
                        "ramp_profile": "s_curve",
                        "ramp_weights": None,
                        "param_values": {
                            "events_per_year": 13500.0,
                            "minutes_saved_per_event": 24.0,
                            "hourly_rate": 120.0,
                            "adoption_rate": 0.90,
                            "realization_factor": 0.80,
                        },
                        "uncertainty_spec": {
                            "correlation_group": "adoption",
                            "correlation_rho": 0.75,
                            "parameters": {
                                "adoption_rate": {"distribution": "pert", "low": 0.65, "mode": 0.90, "high": 0.98},
                                "realization_factor": {"distribution": "pert", "low": 0.55, "mode": 0.80, "high": 0.94},
                            },
                        },
                        "anti_double_count_tag": "eng-capacity",
                    },
                    {
                        "catalog_id": "BEN-QUAL-01",
                        "label": "Auto-Rollback & Canary Incident Avoidance",
                        "value_stream": "Incident Response",
                        "start_year": 2,
                        "end_year": 7,
                        "ramp_profile": "immediate",
                        "ramp_weights": None,
                        "param_values": {
                            "baseline_events_per_year": 64.0,
                            "risk_reduction_pct": 0.60,
                            "cost_per_event": 8500.0,
                        },
                        "uncertainty_spec": {
                            "correlation_group": "adoption",
                            "correlation_rho": 0.60,
                            "parameters": {
                                "risk_reduction_pct": {"distribution": "pert", "low": 0.35, "mode": 0.60, "high": 0.78},
                                "cost_per_event": {"distribution": "lognormal", "std_pct": 0.28},
                            },
                        },
                        "anti_double_count_tag": None,
                    },
                    {
                        "catalog_id": "BEN-CAP-01",
                        "label": "Multi-Team Platform Reuse Leverage",
                        "value_stream": "Capability Enablement",
                        "start_year": 2,
                        "end_year": 7,
                        "ramp_profile": "s_curve",
                        "ramp_weights": None,
                        "param_values": {
                            "downstream_initiatives": 5.0,
                            "avoided_setup_cost": 72000.0,
                            "reuse_probability": 0.80,
                        },
                        "uncertainty_spec": {
                            "correlation_group": "adoption",
                            "correlation_rho": 0.65,
                            "parameters": {
                                "reuse_probability": {"distribution": "triangular", "low": 0.50, "mode": 0.80, "high": 0.94},
                                "avoided_setup_cost": {"distribution": "normal", "std_pct": 0.18},
                            },
                        },
                        "anti_double_count_tag": None,
                    },
                ],
            }
        ],
    },
    {
        "name": "Invoice & Order Fulfillment Automation",
        "description": (
            "End-to-end RPA and API orchestration for AP/AR invoice triage, order exceptions, "
            "and automated compliance audit trails over a 5-year horizon."
        ),
        "domain": "automation",
        "horizon_years": 5,
        "discount_rate": 0.06,
        "cost_start_year": 2026,
        "external_resource_url": "",
        "items": [
            {
                "catalog_id": "COST-BUILD-01",
                "label": "ERP & Workflow Automation Build",
                "value_stream": "Order Operations",
                "start_year": 1,
                "end_year": 1,
                "ramp_profile": "immediate",
                "ramp_weights": None,
                "param_values": {"hours": 900.0, "hourly_rate": 140.0, "vendor_cost": 35000.0},
                "uncertainty_spec": {
                    "correlation_group": "ops_cost",
                    "correlation_rho": 0.70,
                    "parameters": {
                        "hours": {"distribution": "lognormal", "std_pct": 0.28},
                        "vendor_cost": {"distribution": "pert", "low_pct": -0.10, "high_pct": 0.65},
                    },
                },
                "anti_double_count_tag": None,
            },
            {
                "catalog_id": "COST-RUN-01",
                "label": "Orchestration Licensing & Ops Support",
                "value_stream": "Finance & Billing",
                "start_year": 1,
                "end_year": 5,
                "ramp_profile": "immediate",
                "ramp_weights": None,
                "param_values": {
                    "annual_infra_cost": 14000.0,
                    "annual_license_cost": 18000.0,
                    "support_hours_per_year": 180.0,
                    "hourly_rate": 125.0,
                },
                "uncertainty_spec": {
                    "correlation_group": "ops_cost",
                    "correlation_rho": 0.60,
                    "parameters": {
                        "annual_infra_cost": {"distribution": "normal", "std_pct": 0.30},
                        "annual_license_cost": {"distribution": "pert", "low_pct": -0.10, "high_pct": 0.45},
                    },
                },
                "anti_double_count_tag": None,
            },
            {
                "catalog_id": "COST-ENAB-01",
                "label": "Operations Training & Process Cutover",
                "value_stream": "Order Operations",
                "start_year": 1,
                "end_year": 1,
                "ramp_profile": "immediate",
                "ramp_weights": None,
                "param_values": {
                    "training_hours": 8.0,
                    "affected_staff": 50.0,
                    "hourly_rate": 75.0,
                    "transition_cost": 15000.0,
                },
                "uncertainty_spec": {
                    "item_multiplier": {"distribution": "triangular", "low": 0.80, "mode": 1.0, "high": 1.35},
                },
                "anti_double_count_tag": None,
            },
            {
                "catalog_id": "BEN-TOIL-01",
                "label": "Manual Invoice Triage Elimination",
                "value_stream": "Finance & Billing",
                "start_year": 1,
                "end_year": 5,
                "ramp_profile": "s_curve",
                "ramp_weights": None,
                "param_values": {
                    "events_per_year": 15000.0,
                    "minutes_saved_per_event": 10.0,
                    "hourly_rate": 68.0,
                    "adoption_rate": 0.82,
                    "realization_factor": 0.75,
                },
                "uncertainty_spec": {
                    "correlation_group": "ops_adoption",
                    "correlation_rho": 0.75,
                    "parameters": {
                        "adoption_rate": {"distribution": "pert", "low": 0.50, "mode": 0.82, "high": 0.95},
                        "realization_factor": {"distribution": "pert", "low": 0.40, "mode": 0.75, "high": 0.92},
                    },
                },
                "anti_double_count_tag": "ops-staff-hours",
            },
            {
                "catalog_id": "BEN-FLOW-01",
                "label": "Order Cycle-Time & Billing Acceleration",
                "value_stream": "Order Operations",
                "start_year": 2,
                "end_year": 5,
                "ramp_profile": "linear",
                "ramp_weights": None,
                "param_values": {
                    "accelerated_items_per_year": 360.0,
                    "value_per_item": 580.0,
                    "adoption_rate": 0.80,
                },
                "uncertainty_spec": {
                    "correlation_group": "ops_adoption",
                    "correlation_rho": 0.75,
                    "parameters": {
                        "value_per_item": {"distribution": "pert", "low": 200.0, "mode": 580.0, "high": 780.0},
                        "adoption_rate": {"distribution": "pert", "low": 0.35, "mode": 0.80, "high": 0.95},
                    },
                },
                "anti_double_count_tag": "ops-staff-hours",
            },
            {
                "catalog_id": "BEN-COMP-01",
                "label": "Automated Audit Trail & Dispute Avoidance",
                "value_stream": "Compliance",
                "start_year": 2,
                "end_year": 5,
                "ramp_profile": "immediate",
                "ramp_weights": None,
                "param_values": {
                    "audit_hours_saved": 240.0,
                    "hourly_rate": 110.0,
                    "avoided_penalty_expected": 45000.0,
                },
                "uncertainty_spec": {
                    "correlation_group": "ops_adoption",
                    "correlation_rho": 0.50,
                    "parameters": {
                        "avoided_penalty_expected": {
                            "distribution": "triangular",
                            "low": 5000.0,
                            "mode": 45000.0,
                            "high": 80000.0,
                        },
                    },
                },
                "anti_double_count_tag": None,
            },
        ],
    },
    {
        "name": "Legacy Datacenter & Core Network Modernization",
        "description": (
            "10-year infrastructure migration from aging on-prem colocation racks to resilient "
            "cloud landing zones with higher execution uncertainty and tail risk."
        ),
        "domain": "infrastructure",
        "horizon_years": 10,
        "discount_rate": 0.08,
        "cost_start_year": 2026,
        "external_resource_url": "",
        "items": [
            {
                "catalog_id": "COST-BUILD-01",
                "label": "Migration Engineering & Cutover Waves",
                "value_stream": "Core Infrastructure",
                "start_year": 1,
                "end_year": 2,
                "ramp_profile": "custom_weights",
                "ramp_weights": [0.60, 1.0],
                "param_values": {"hours": 2400.0, "hourly_rate": 155.0, "vendor_cost": 110000.0},
                "uncertainty_spec": {
                    "correlation_group": "migration_risk",
                    "correlation_rho": 0.75,
                    "parameters": {
                        "hours": {"distribution": "lognormal", "std_pct": 0.30},
                        "vendor_cost": {"distribution": "pert", "low_pct": -0.10, "high_pct": 0.55},
                    },
                },
                "anti_double_count_tag": None,
            },
            {
                "catalog_id": "COST-RUN-01",
                "label": "Managed Cloud & Network Run Costs",
                "value_stream": "Core Infrastructure",
                "start_year": 2,
                "end_year": 10,
                "ramp_profile": "immediate",
                "ramp_weights": None,
                "param_values": {
                    "annual_infra_cost": 58000.0,
                    "annual_license_cost": 24000.0,
                    "support_hours_per_year": 240.0,
                    "hourly_rate": 140.0,
                },
                "uncertainty_spec": {
                    "correlation_group": "migration_risk",
                    "correlation_rho": 0.65,
                    "parameters": {
                        "annual_infra_cost": {"distribution": "normal", "std_pct": 0.25},
                    },
                },
                "anti_double_count_tag": None,
            },
            {
                "catalog_id": "COST-LIFE-01",
                "label": "Edge & Hardware Refresh Reserve",
                "value_stream": "Reliability & Resilience",
                "start_year": 3,
                "end_year": 10,
                "ramp_profile": "immediate",
                "ramp_weights": None,
                "param_values": {"refresh_cost": 120000.0, "refresh_interval_years": 4.0},
                "uncertainty_spec": {
                    "parameters": {
                        "refresh_cost": {
                            "distribution": "triangular",
                            "low": 85000.0,
                            "mode": 120000.0,
                            "high": 185000.0,
                        },
                    },
                },
                "anti_double_count_tag": None,
            },
            {
                "catalog_id": "BEN-QUAL-01",
                "label": "Major Outage & SLA Breach Avoidance",
                "value_stream": "Reliability & Resilience",
                "start_year": 2,
                "end_year": 10,
                "ramp_profile": "linear",
                "ramp_weights": None,
                "param_values": {
                    "baseline_events_per_year": 18.0,
                    "risk_reduction_pct": 0.55,
                    "cost_per_event": 32000.0,
                },
                "uncertainty_spec": {
                    "correlation_group": "resilience",
                    "correlation_rho": 0.70,
                    "parameters": {
                        "risk_reduction_pct": {"distribution": "pert", "low": 0.20, "mode": 0.55, "high": 0.75},
                        "cost_per_event": {"distribution": "lognormal", "std_pct": 0.40},
                    },
                },
                "anti_double_count_tag": None,
            },
            {
                "catalog_id": "BEN-COMP-01",
                "label": "Regulatory Compliance & Audit Automation",
                "value_stream": "Core Infrastructure",
                "start_year": 3,
                "end_year": 10,
                "ramp_profile": "immediate",
                "ramp_weights": None,
                "param_values": {
                    "audit_hours_saved": 450.0,
                    "hourly_rate": 135.0,
                    "avoided_penalty_expected": 55000.0,
                },
                "uncertainty_spec": {
                    "parameters": {
                        "audit_hours_saved": {"distribution": "normal", "std_pct": 0.25},
                        "avoided_penalty_expected": {
                            "distribution": "triangular",
                            "low": 15000.0,
                            "mode": 55000.0,
                            "high": 110000.0,
                        },
                    },
                },
                "anti_double_count_tag": None,
            },
            {
                "catalog_id": "BEN-CAP-01",
                "label": "Shared Landing Zone Reuse Leverage",
                "value_stream": "Cloud Foundation",
                "start_year": 3,
                "end_year": 10,
                "ramp_profile": "s_curve",
                "ramp_weights": None,
                "param_values": {
                    "downstream_initiatives": 3.0,
                    "avoided_setup_cost": 85000.0,
                    "reuse_probability": 0.70,
                },
                "uncertainty_spec": {
                    "correlation_group": "resilience",
                    "correlation_rho": 0.70,
                    "parameters": {
                        "reuse_probability": {"distribution": "triangular", "low": 0.25, "mode": 0.70, "high": 0.90},
                    },
                },
                "anti_double_count_tag": None,
            },
        ],
    },
]


def _insert_bca_bundle(
    conn: sqlite3.Connection,
    init_id: str,
    *,
    name: str,
    description: str,
    horizon_years: int,
    discount_rate: float,
    cost_start_year: int | None,
    is_baseline: bool,
    sort_order: int,
    items: list[dict],
    now_iso: str,
    measure_ids: dict[str, str] | None = None,
    measure_values: dict[str, dict] | None = None,
) -> str:
    bca_id = str(uuid4())
    conn.execute(
        """
        INSERT INTO initiative_bcas (
            id, initiative_id, name, description, horizon_years, discount_rate,
            cost_start_year, is_baseline, sort_order, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            bca_id,
            init_id,
            name,
            description,
            horizon_years,
            discount_rate,
            cost_start_year,
            1 if is_baseline else 0,
            sort_order,
            now_iso,
            now_iso,
        ),
    )

    for item in items:
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
                init_id,
                bca_id,
                item["catalog_id"],
                item["label"],
                item["value_stream"],
                item["start_year"],
                item["end_year"],
                item["ramp_profile"],
                json.dumps(item["ramp_weights"]) if item["ramp_weights"] is not None else None,
                json.dumps(item["param_values"]),
                json.dumps(item["uncertainty_spec"]),
                item["anti_double_count_tag"],
                now_iso,
                now_iso,
            ),
        )
    for name, est in (measure_values or {}).items():
        conn.execute(
            """
            INSERT INTO bca_measure_values (bca_id, measure_id, value, low, high, note, updated_at)
            VALUES (?, ?, ?, ?, ?, '', ?)
            """,
            (bca_id, (measure_ids or {})[name], est["value"], est.get("low"), est.get("high"), now_iso),
        )
    return bca_id


def _insert_initiative_bundle(conn: sqlite3.Connection, spec: dict, now_iso: str) -> str:
    init_id = str(uuid4())
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
            spec["name"],
            spec["description"],
            spec["domain"],
            spec["horizon_years"],
            spec["discount_rate"],
            spec.get("cost_start_year"),
            spec.get("external_resource_url", ""),
            now_iso,
            now_iso,
        ),
    )

    measure_ids: dict[str, str] = {}
    for order, m in enumerate(spec.get("measures", [])):
        measure_ids[m["name"]] = str(uuid4())
        conn.execute(
            """
            INSERT INTO initiative_measures (
                id, initiative_id, name, unit, direction, description, sort_order, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (measure_ids[m["name"]], init_id, m["name"], m["unit"], m["direction"], m["description"], order, now_iso, now_iso),
        )

    _insert_bca_bundle(
        conn,
        init_id,
        name=spec.get("baseline_bca_name", "Baseline BCA"),
        description=spec.get("baseline_bca_description", spec["description"]),
        horizon_years=spec["horizon_years"],
        discount_rate=spec["discount_rate"],
        cost_start_year=spec.get("cost_start_year"),
        is_baseline=True,
        sort_order=0,
        items=spec["items"],
        now_iso=now_iso,
        measure_ids=measure_ids,
        measure_values=spec.get("baseline_measure_values"),
    )

    for idx, extra in enumerate(spec.get("extra_bcas", []), start=1):
        _insert_bca_bundle(
            conn,
            init_id,
            name=extra["name"],
            description=extra.get("description", ""),
            horizon_years=int(extra.get("horizon_years", spec["horizon_years"])),
            discount_rate=float(extra.get("discount_rate", spec["discount_rate"])),
            cost_start_year=extra.get("cost_start_year", spec.get("cost_start_year")),
            is_baseline=False,
            sort_order=idx,
            items=extra["items"],
            now_iso=now_iso,
            measure_ids=measure_ids,
            measure_values=extra.get("measure_values"),
        )
    return init_id


def _seed_demo_initiative(conn: sqlite3.Connection, now_iso: str) -> None:
    count = conn.execute("SELECT COUNT(*) FROM initiatives").fetchone()[0]
    if count > 0:
        return

    for spec in DEMO_INITIATIVES:
        _insert_initiative_bundle(conn, spec, now_iso)


def seed_missing_demos(db_path: Path) -> list[str]:
    """Insert any missing example initiatives by name without touching existing data."""
    now_iso = datetime.now(timezone.utc).isoformat()
    created_ids: list[str] = []
    with get_connection(db_path) as conn:
        existing_names = {
            row["name"] for row in conn.execute("SELECT name FROM initiatives").fetchall()
        }
        for spec in DEMO_INITIATIVES:
            if spec["name"] not in existing_names:
                created_ids.append(_insert_initiative_bundle(conn, spec, now_iso))
    return created_ids


def _seed_llm_settings(conn: sqlite3.Connection, now_iso: str) -> None:
    count = conn.execute("SELECT COUNT(*) FROM llm_settings").fetchone()[0]
    if count > 0:
        return
    base_url = os.getenv("OPENAI_BASE_URL", "").strip().rstrip("/")
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    model = os.getenv("OPENAI_MODEL", "").strip()
    conn.execute(
        """
        INSERT INTO llm_settings (
            id, base_url, api_key, model, temperature, max_tokens, timeout_seconds, system_prompt, updated_at
        ) VALUES (1, ?, ?, ?, 0.2, 1024, 45, '', ?)
        """,
        (base_url, api_key, model, now_iso),
    )


def _seed_sso_settings(conn: sqlite3.Connection, now_iso: str) -> None:
    count = conn.execute("SELECT COUNT(*) FROM sso_settings").fetchone()[0]
    if count > 0:
        return
    env_provider = os.getenv("SSO_PROVIDER", "firebase").strip().lower()
    provider = env_provider if env_provider in ("firebase", "entra") else "firebase"
    conn.execute(
        """
        INSERT INTO sso_settings (
            id, enabled, provider, enforce_sso, allowed_domains_json, admin_emails_json,
            firebase_project_id, firebase_auth_domain, firebase_api_key, firebase_app_id,
            firebase_tenant_id, firebase_sign_in_methods_json,
            entra_tenant_id, entra_client_id, entra_client_secret, entra_authority_host,
            entra_redirect_uri, entra_scopes, updated_at
        ) VALUES (1, 0, ?, 0, '[]', '[]', '', '', '', '', '', '["google"]', '', '', '', 'https://login.microsoftonline.com', '', 'openid profile email', ?)
        """,
        (provider, now_iso),
    )


SYSTEM_ROLES: list[dict] = [
    {
        "id": "role-admin",
        "name": "Administrator",
        "description": "Full platform, user, role, SSO, and AI provider administration.",
        "permissions": [
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
        ],
    },
    {
        "id": "role-analyst",
        "name": "BCA Analyst",
        "description": "Author initiatives, configure cost/benefit catalog templates, and run Monte Carlo simulations.",
        "permissions": [
            "initiatives:read",
            "initiatives:write",
            "simulations:run",
            "catalog:manage",
            "docs:ask",
        ],
    },
    {
        "id": "role-reviewer",
        "name": "Executive Reviewer",
        "description": "Inspect deterministic business cases, Monte Carlo confidence intervals, and ask the Docs Agent.",
        "permissions": [
            "initiatives:read",
            "docs:ask",
        ],
    },
    {
        "id": "role-ai-ops",
        "name": "AI & Integration Ops",
        "description": "Manage OpenAI-compatible Docs Agent models, upstream keys, and API gateway credentials.",
        "permissions": [
            "initiatives:read",
            "docs:ask",
            "admin:ai",
        ],
    },
]

DEMO_USERS: list[dict] = [
    {
        "email": "admin@valuestream.local",
        "display_name": "Platform Admin",
        "role_id": "role-admin",
        "status": "active",
        "auth_provider": "local",
    },
    {
        "email": "sarah.chen@valuestream.local",
        "display_name": "Sarah Chen",
        "role_id": "role-analyst",
        "status": "active",
        "auth_provider": "firebase",
    },
    {
        "email": "marcus.reed@valuestream.local",
        "display_name": "Marcus Reed",
        "role_id": "role-reviewer",
        "status": "invited",
        "auth_provider": "entra",
    },
]


def _seed_system_roles(conn: sqlite3.Connection, now_iso: str) -> None:
    for role in SYSTEM_ROLES:
        conn.execute(
            """
            INSERT OR IGNORE INTO roles (
                id, name, description, permissions_json, is_system, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 1, ?, ?)
            """,
            (
                role["id"],
                role["name"],
                role["description"],
                json.dumps(role["permissions"]),
                now_iso,
                now_iso,
            ),
        )


def _seed_demo_users(conn: sqlite3.Connection, now_iso: str) -> None:
    count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    if count > 0:
        return
    for user in DEMO_USERS:
        conn.execute(
            """
            INSERT OR IGNORE INTO users (
                id, email, display_name, role_id, status, auth_provider, last_login_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
            """,
            (
                str(uuid4()),
                user["email"],
                user["display_name"],
                user["role_id"],
                user["status"],
                user["auth_provider"],
                now_iso,
                now_iso,
            ),
        )


def _migrate_schema(conn: sqlite3.Connection) -> None:
    """Apply additive, non-destructive column and table migrations to existing SQLite databases."""
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(initiatives)").fetchall()}
    if "cost_start_year" not in cols:
        conn.execute("ALTER TABLE initiatives ADD COLUMN cost_start_year INTEGER;")
    if "external_resource_url" not in cols:
        conn.execute("ALTER TABLE initiatives ADD COLUMN external_resource_url TEXT NOT NULL DEFAULT '';")
    if "status" not in cols:
        conn.execute("ALTER TABLE initiatives ADD COLUMN status TEXT NOT NULL DEFAULT 'draft';")

    # Grant the new workflow-admin permission to the built-in Administrator role.
    admin_role = conn.execute("SELECT permissions_json FROM roles WHERE id = 'role-admin'").fetchone()
    if admin_role is not None:
        perms = json.loads(admin_role["permissions_json"] or "[]")
        if "admin:workflows" not in perms:
            perms.append("admin:workflows")
            conn.execute(
                "UPDATE roles SET permissions_json = ? WHERE id = 'role-admin'",
                (json.dumps(perms),),
            )

    llm_cols = {row["name"] for row in conn.execute("PRAGMA table_info(llm_settings)").fetchall()}
    if "verified" not in llm_cols:
        conn.execute("ALTER TABLE llm_settings ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;")
    if "verified_at" not in llm_cols:
        conn.execute("ALTER TABLE llm_settings ADD COLUMN verified_at TEXT;")

    item_cols = {row["name"] for row in conn.execute("PRAGMA table_info(initiative_items)").fetchall()}
    if "bca_id" not in item_cols:
        conn.execute(
            "ALTER TABLE initiative_items ADD COLUMN bca_id TEXT REFERENCES initiative_bcas(id) ON DELETE CASCADE;"
        )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_items_bca ON initiative_items(bca_id);")

    run_cols = {row["name"] for row in conn.execute("PRAGMA table_info(simulation_runs)").fetchall()}
    if "bca_id" not in run_cols:
        conn.execute(
            "ALTER TABLE simulation_runs ADD COLUMN bca_id TEXT REFERENCES initiative_bcas(id) ON DELETE CASCADE;"
        )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_runs_bca_created ON simulation_runs(bca_id, created_at DESC);")

    # Backfill a Baseline BCA for any initiative created prior to multi-BCA support
    # and attach its unattached items / simulation runs.
    init_rows = conn.execute("SELECT * FROM initiatives").fetchall()
    for init_row in init_rows:
        init_id = str(init_row["id"])
        existing_bca = conn.execute(
            """
            SELECT id FROM initiative_bcas
            WHERE initiative_id = ?
            ORDER BY is_baseline DESC, sort_order ASC, created_at ASC
            LIMIT 1
            """,
            (init_id,),
        ).fetchone()
        if existing_bca is None:
            baseline_id = str(uuid4())
            conn.execute(
                """
                INSERT INTO initiative_bcas (
                    id, initiative_id, name, description, horizon_years, discount_rate,
                    cost_start_year, is_baseline, sort_order, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
                """,
                (
                    baseline_id,
                    init_id,
                    "Baseline BCA",
                    init_row["description"] or "",
                    int(init_row["horizon_years"]),
                    float(init_row["discount_rate"]),
                    init_row["cost_start_year"],
                    init_row["created_at"],
                    init_row["updated_at"],
                ),
            )
        else:
            baseline_id = str(existing_bca["id"])

        conn.execute(
            "UPDATE initiative_items SET bca_id = ? WHERE initiative_id = ? AND bca_id IS NULL",
            (baseline_id, init_id),
        )
        conn.execute(
            "UPDATE simulation_runs SET bca_id = ? WHERE initiative_id = ? AND bca_id IS NULL",
            (baseline_id, init_id),
        )


def _seed_email_settings(conn: sqlite3.Connection, now_iso: str) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO email_settings (id, updated_at) VALUES (1, ?)",
        (now_iso,),
    )


DEFAULT_WORKFLOW_ID = "wf-standard"


def _seed_default_workflow(conn: sqlite3.Connection, now_iso: str) -> None:
    """Create a starter single-step workflow the first time the table is empty."""
    if conn.execute("SELECT COUNT(*) FROM workflows").fetchone()[0] > 0:
        return
    steps = [
        {
            "id": "step-exec-review",
            "name": "Executive Review",
            "approver_role_ids": ["role-reviewer", "role-admin"],
            "approver_emails": [],
            "required_approvals": 1,
            "notify_approvers": True,
        }
    ]
    conn.execute(
        """
        INSERT INTO workflows (
            id, name, description, is_active, is_default, notify_submitter, steps_json, created_at, updated_at
        ) VALUES (?, ?, ?, 1, 1, 1, ?, ?, ?)
        """,
        (
            DEFAULT_WORKFLOW_ID,
            "Standard Approval",
            "Single executive sign-off. Edit or add steps in Admin → Approval Workflows.",
            json.dumps(steps),
            now_iso,
            now_iso,
        ),
    )


def init_db(db_path: Path, *, seed_demo: bool = True) -> None:
    """Create tables if needed and seed baseline catalog (and optional demo initiative)."""
    now_iso = datetime.now(timezone.utc).isoformat()
    with get_connection(db_path) as conn:
        conn.executescript(SCHEMA_SQL)
        _migrate_schema(conn)
        _seed_baseline_catalog(conn, now_iso)
        _seed_llm_settings(conn, now_iso)
        _seed_sso_settings(conn, now_iso)
        _seed_system_roles(conn, now_iso)
        _seed_email_settings(conn, now_iso)
        _seed_default_workflow(conn, now_iso)
        if seed_demo:
            _seed_demo_initiative(conn, now_iso)
            _seed_demo_users(conn, now_iso)
