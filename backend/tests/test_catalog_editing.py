"""Tests for editing catalog templates and their documentation pages."""

from __future__ import annotations

from fastapi.testclient import TestClient

CUSTOM = {
    "id": "BEN-SLA-01",
    "kind": "benefit",
    "name": "SLA Penalty Avoidance",
    "description": "Avoided contractual SLA penalties",
    "domains": ["software"],
    "value_stream_stage": "Operate",
    "parameters": [
        {"key": "incidents", "label": "Incidents avoided", "unit": "count/yr", "default_value": 10, "min_value": 0},
        {"key": "penalty", "label": "Penalty per incident", "unit": "$", "default_value": 5000, "min_value": 0},
    ],
    "formula_type": "expr:incidents * penalty",
    "guardrail_notes": "",
}


def _add_item(client: TestClient, init_id: str, catalog_id: str, params: dict) -> dict:
    res = client.post(
        f"/api/initiatives/{init_id}/items",
        json={
            "catalog_id": catalog_id,
            "label": "SLA savings",
            "value_stream": "Operate",
            "start_year": 1,
            "end_year": 3,
            "ramp_profile": "immediate",
            "param_values": params,
        },
    )
    assert res.status_code == 201, res.text
    return res.json()


def test_new_template_gets_blank_doc_template(client: TestClient) -> None:
    created = client.post("/api/catalog", json=CUSTOM)
    assert created.status_code == 201, created.text
    doc = created.json()["doc"]
    assert doc["is_template"] is True
    content = doc["content"]
    assert content["headline"] == "" and content["what_it_measures"] == ""
    assert content["when_to_use"] == [] and content["guardrail_notes"] == []
    assert set(content["parameter_guidance"]) == {"incidents", "penalty"}
    assert all(g == {"guidance": "", "typical_range": "", "data_source": ""} for g in content["parameter_guidance"].values())

    # Built-ins ship their docs in the UI and have no stored override.
    builtin = client.get("/api/catalog/COST-BUILD-01").json()
    assert builtin["doc"] is None

    # Adding a parameter keeps the template's guidance checklist in sync.
    params = CUSTOM["parameters"] + [
        {"key": "multiplier", "label": "Contract multiplier", "default_value": 1, "min_value": 0}
    ]
    upd = client.patch(
        "/api/catalog/BEN-SLA-01",
        json={"parameters": params, "formula_type": "expr:incidents * penalty * multiplier"},
    )
    assert upd.status_code == 200, upd.text
    assert set(upd.json()["doc"]["content"]["parameter_guidance"]) == {"incidents", "penalty", "multiplier"}


def test_save_doc_requires_core_fields_and_clears_template(client: TestClient) -> None:
    client.post("/api/catalog", json=CUSTOM)
    incomplete = client.put("/api/catalog/BEN-SLA-01/doc", json={"headline": "x"})
    assert incomplete.status_code == 422

    saved = client.put(
        "/api/catalog/BEN-SLA-01/doc",
        json={
            "headline": "Avoided SLA penalties from fewer customer-facing incidents",
            "what_it_measures": "Contractual penalty dollars not paid because incidents were prevented.",
            "when_to_use": ["Enterprise contracts with SLA credits", "  "],
            "when_not_to_use": [{"text": "Use BEN-REV-01 for lost revenue", "link_slug": "BEN-REV-01"}],
            "parameter_guidance": {"incidents": {"guidance": "From the incident log", "typical_range": "5-20"}},
            "modeling_tips": {"ramp": "linear"},
            "guardrail_notes": ["Do not also count churn"],
        },
    )
    assert saved.status_code == 200, saved.text
    doc = saved.json()["doc"]
    assert doc["is_template"] is False
    assert doc["content"]["when_to_use"] == ["Enterprise contracts with SLA credits"]
    assert doc["content"]["when_not_to_use"][0]["link_slug"] == "BEN-REV-01"

    # Custom templates have no shipped doc to reset to.
    assert client.delete("/api/catalog/BEN-SLA-01/doc").status_code == 422

    # Built-in docs can be overridden and reset.
    over = client.put(
        "/api/catalog/COST-BUILD-01/doc",
        json={"headline": "Edited", "what_it_measures": "Edited body"},
    )
    assert over.status_code == 200 and over.json()["doc"]["content"]["headline"] == "Edited"
    reset = client.delete("/api/catalog/COST-BUILD-01/doc")
    assert reset.status_code == 200 and reset.json()["doc"] is None


def test_edit_template_fields_and_validation(client: TestClient) -> None:
    client.post("/api/catalog", json=CUSTOM)
    renamed = client.patch(
        "/api/catalog/BEN-SLA-01",
        json={"name": "SLA Credits Avoided", "domains": [" Software ", "Ops"], "guardrail_notes": "Watch churn"},
    )
    assert renamed.status_code == 200
    body = renamed.json()
    assert body["name"] == "SLA Credits Avoided"
    assert body["domains"] == ["software", "ops"]
    assert body["formula_type"] == "expr:incidents * penalty"

    # Formula must still reference declared parameters.
    bad = client.patch("/api/catalog/BEN-SLA-01", json={"formula_type": "expr:incidents * missing_key"})
    assert bad.status_code == 422
    # Built-in registered formulas still require their keys.
    builtin_bad = client.patch(
        "/api/catalog/COST-BUILD-01",
        json={"parameters": [{"key": "hours", "label": "Hours", "default_value": 1, "min_value": 0}]},
    )
    assert builtin_bad.status_code == 422
    # Built-ins can be renamed.
    assert client.patch("/api/catalog/COST-BUILD-01", json={"name": "Build & Integrate"}).status_code == 200
    assert client.patch("/api/catalog/NOPE-01", json={"name": "x"}).status_code == 404


def test_math_changes_guarded_by_line_items_and_approval_lock(client: TestClient) -> None:
    client.post("/api/catalog", json=CUSTOM)
    init_id = client.post("/api/initiatives", json={"name": "Reliability"}).json()["id"]
    _add_item(client, init_id, "BEN-SLA-01", {"incidents": 12, "penalty": 8000})

    # Tightening bounds below an existing item's value is refused with a clear reason.
    tight = [dict(p) for p in CUSTOM["parameters"]]
    tight[1] = {**tight[1], "max_value": 6000}
    res = client.patch("/api/catalog/BEN-SLA-01", json={"parameters": tight})
    assert res.status_code == 422
    assert "penalty=8000" in res.json()["detail"]

    # Kind cannot flip while line items use the template.
    assert client.patch("/api/catalog/BEN-SLA-01", json={"kind": "cost"}).status_code == 422

    # Formula change is fine while the initiative is a draft...
    ok = client.patch("/api/catalog/BEN-SLA-01", json={"formula_type": "expr:incidents * penalty * 1.1"})
    assert ok.status_code == 200

    # ...but blocked once it's under review; descriptive edits still allowed.
    assert client.post(f"/api/initiatives/{init_id}/approval/submit", json={}).status_code == 200
    locked = client.patch("/api/catalog/BEN-SLA-01", json={"formula_type": "expr:incidents * penalty"})
    assert locked.status_code == 409
    assert "Reliability" in locked.json()["detail"]
    assert client.patch("/api/catalog/BEN-SLA-01", json={"description": "Clarified"}).status_code == 200
