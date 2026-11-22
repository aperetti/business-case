"""End-to-end tests for the OASIS OData v4 feed (/odata/v4, /odata) and Admin OData preview endpoints."""

from __future__ import annotations

import base64
import math
import xml.etree.ElementTree as ET

from fastapi.testclient import TestClient


def test_odata_service_doc_and_csdl_metadata(seeded_client: TestClient) -> None:
    for prefix in ("/odata/v4", "/odata"):
        svc = seeded_client.get(prefix)
        assert svc.status_code == 200
        assert svc.headers.get("odata-version") == "4.0"
        body = svc.json()
        assert body["@odata.context"].endswith(f"{prefix}/$metadata")
        names = [e["name"] for e in body["value"]]
        assert names == [
            "Initiatives",
            "CostBenefitItems",
            "YearlyCashFlows",
            "ValueStreams",
            "CatalogEntries",
            "SimulationRuns",
        ]

    meta = seeded_client.get("/odata/v4/$metadata")
    assert meta.status_code == 200
    assert meta.headers.get("odata-version") == "4.0"
    assert "application/xml" in meta.headers.get("content-type", "")

    root = ET.fromstring(meta.text)
    assert root.tag == "{http://docs.oasis-open.org/odata/ns/edmx}Edmx"
    assert root.attrib["Version"] == "4.0"

    edm_ns = "{http://docs.oasis-open.org/odata/ns/edm}"
    entity_types = {el.attrib["Name"] for el in root.findall(f".//{edm_ns}EntityType")}
    assert entity_types == {
        "Initiative",
        "CostBenefitItem",
        "YearlyCashFlow",
        "ValueStreamSummary",
        "CatalogEntry",
        "SimulationRun",
    }
    entity_sets = {el.attrib["Name"] for el in root.findall(f".//{edm_ns}EntitySet")}
    assert entity_sets == {
        "Initiatives",
        "CostBenefitItems",
        "YearlyCashFlows",
        "ValueStreams",
        "CatalogEntries",
        "SimulationRuns",
    }


def test_odata_extraction_math_filters_expand_and_navigation(seeded_client: TestClient) -> None:
    # Seed a simulation run for the first initiative so SimulationRuns + LatestSim* fields populate
    inits_resp = seeded_client.get("/odata/v4/Initiatives", params={"$orderby": "Npv desc", "$count": "true"})
    assert inits_resp.status_code == 200
    inits_body = inits_resp.json()
    assert inits_body["@odata.count"] == 3
    init_rows = inits_body["value"]
    assert init_rows[0]["Npv"] >= init_rows[1]["Npv"] >= init_rows[2]["Npv"]
    top_init = init_rows[0]
    top_id = top_init["Id"]
    assert top_init["CostStartYear"] == 2026
    assert top_init["CostEndYear"] == 2026 + top_init["HorizonYears"] - 1

    sim = seeded_client.post(f"/api/initiatives/{top_id}/simulate", json={"n_simulations": 1000, "seed": 42})
    assert sim.status_code == 200

    # Verify SimulationRuns and Initiatives.LatestSim* via OData
    runs_resp = seeded_client.get(
        "/odata/v4/SimulationRuns",
        params={"$filter": f"InitiativeId eq '{top_id}'", "$count": "true"},
    )
    assert runs_resp.status_code == 200
    assert runs_resp.json()["@odata.count"] == 1
    assert runs_resp.json()["value"][0]["Seed"] == 42

    refreshed_init = seeded_client.get(f"/odata/v4/Initiatives('{top_id}')")
    assert refreshed_init.status_code == 200
    r_init = refreshed_init.json()
    assert r_init["@odata.context"].endswith("/$metadata#Initiatives/$entity")
    assert r_init["LatestSimProbNpvPositive"] is not None
    assert r_init["LatestSimNpvP50"] is not None

    # Verify CostBenefitItems SignedPvTotal & YearlyCashFlows PV sum match Initiative KPIs
    nav_items = seeded_client.get(f"/odata/v4/Initiatives('{top_id}')/CostBenefitItems")
    assert nav_items.status_code == 200
    items = nav_items.json()["value"]
    assert len(items) == r_init["ItemCount"]
    assert math.isclose(sum(it["SignedPvTotal"] for it in items), r_init["Npv"], rel_tol=1e-6, abs_tol=1e-3)
    assert items[0]["CalendarStartYear"] == 2026 + items[0]["StartYear"] - 1

    nav_flows = seeded_client.get(f"/odata/v4/Initiatives('{top_id}')/YearlyCashFlows")
    assert nav_flows.status_code == 200
    flows = nav_flows.json()["value"]
    assert len(flows) == r_init["HorizonYears"]
    assert math.isclose(sum(f["PvCost"] for f in flows), r_init["PvCosts"], rel_tol=1e-6, abs_tol=1e-3)
    assert math.isclose(sum(f["PvBenefit"] for f in flows), r_init["PvBenefits"], rel_tol=1e-6, abs_tol=1e-3)

    # Scalar /$count & filtered /$count
    total_items_count = seeded_client.get("/odata/v4/CostBenefitItems/$count")
    assert total_items_count.status_code == 200
    assert int(total_items_count.text) == 18

    benefits_count = seeded_client.get(
        f"/odata/v4/Initiatives('{top_id}')/CostBenefitItems/$count",
        params={"$filter": "Kind eq 'benefit'"},
    )
    assert benefits_count.status_code == 200
    assert int(benefits_count.text) == r_init["BenefitItemCount"]

    # $filter functions (contains, tolower, startswith, not, parentheses), $select, $top, $skip
    filtered = seeded_client.get(
        "/odata/v4/CostBenefitItems",
        params={
            "$filter": "Kind eq 'benefit' and (contains(tolower(CatalogId), 'toil') or startswith(CatalogId, 'BEN-QUAL'))",
            "$select": "Id,CatalogId,Label,PvTotal",
            "$orderby": "PvTotal desc",
            "$top": "3",
            "$skip": "1",
            "$count": "true",
        },
    )
    assert filtered.status_code == 200
    fb = filtered.json()
    assert fb["@odata.count"] >= 2
    assert set(fb["value"][0].keys()) == {"Id", "CatalogId", "Label", "PvTotal"}

    # $expand with nested sub-options + single-entity navigation
    expanded = seeded_client.get(
        f"/odata/v4/Initiatives('{top_id}')",
        params={
            "$select": "Id,Name",
            "$expand": "CostBenefitItems($filter=Kind eq 'cost';$select=Label,PvTotal;$orderby=PvTotal desc;$top=2)",
        },
    )
    assert expanded.status_code == 200
    ex = expanded.json()
    assert len(ex["CostBenefitItems"]) <= 2
    assert set(ex["CostBenefitItems"][0].keys()) == {"Label", "PvTotal"}

    first_item_id = items[0]["Id"]
    parent_init = seeded_client.get(f"/odata/v4/CostBenefitItems('{first_item_id}')/Initiative")
    assert parent_init.status_code == 200
    assert parent_init.json()["Id"] == top_id

    parent_cat = seeded_client.get(f"/odata/v4/CostBenefitItems('{first_item_id}')/CatalogEntry")
    assert parent_cat.status_code == 200
    assert parent_cat.json()["Id"] == items[0]["CatalogId"]


def test_odata_auth_modes_errors_and_admin_preview(seeded_client: TestClient) -> None:
    # Open access initially when 0 keys exist
    assert seeded_client.get("/odata/v4/Initiatives").status_code == 200

    # Issue inbound API key -> enforces auth on /odata/*
    key_res = seeded_client.post("/api/admin/api-keys", json={"name": "Power BI Service"})
    assert key_res.status_code == 201
    secret = key_res.json()["secret_key"]
    key_id = key_res.json()["id"]

    unauth = seeded_client.get("/odata/v4/Initiatives")
    assert unauth.status_code == 401
    assert "Basic" in unauth.headers.get("www-authenticate", "")
    assert unauth.headers.get("odata-version") == "4.0"

    assert seeded_client.get("/odata/v4/$metadata").status_code == 401
    assert seeded_client.get("/odata/v4/Initiatives", headers={"Authorization": "Bearer wrong"}).status_code == 401

    # Bearer token works
    assert (
        seeded_client.get("/odata/v4/Initiatives", headers={"Authorization": f"Bearer {secret}"}).status_code
        == 200
    )

    # X-API-Key header works
    assert seeded_client.get("/odata/v4/CostBenefitItems", headers={"X-API-Key": secret}).status_code == 200

    # HTTP Basic with key as password OR as username works (Power BI / Excel prompt compatibility)
    basic_pw = base64.b64encode(f"powerbi:{secret}".encode()).decode()
    basic_user = base64.b64encode(f"{secret}:".encode()).decode()
    assert seeded_client.get("/odata/v4/ValueStreams", headers={"Authorization": f"Basic {basic_pw}"}).status_code == 200
    assert seeded_client.get("/odata/v4/CatalogEntries", headers={"Authorization": f"Basic {basic_user}"}).status_code == 200

    # Error handling: bad filter property (400), unknown select property (400), unknown entity set (404), missing key (404)
    auth_h = {"Authorization": f"Bearer {secret}"}
    assert seeded_client.get("/odata/v4/Initiatives?$filter=DoesNotExist eq 1", headers=auth_h).status_code == 400
    assert seeded_client.get("/odata/v4/Initiatives?$select=MissingCol", headers=auth_h).status_code == 400
    assert seeded_client.get("/odata/v4/UnknownEntitySet", headers=auth_h).status_code == 404
    assert seeded_client.get("/odata/v4/Initiatives('missing-id')", headers=auth_h).status_code == 404

    # Admin status & preview endpoints work cleanly from Admin UI
    status_out = seeded_client.get("/api/admin/odata/status")
    assert status_out.status_code == 200
    st = status_out.json()
    assert st["auth_mode"] == "api_key_required"
    assert st["inbound_key_count"] == 1
    assert len(st["entity_sets"]) == 6

    preview = seeded_client.get(
        "/api/admin/odata/preview",
        params={"entity_set": "CostBenefitItems", "filter": "Kind eq 'cost'", "top": 5},
    )
    assert preview.status_code == 200
    assert len(preview.json()["value"]) == 5

    bad_preview = seeded_client.get(
        "/api/admin/odata/preview",
        params={"entity_set": "Initiatives", "filter": "BadProp eq 1"},
    )
    assert bad_preview.status_code == 400

    # Revoke key and verify open access returns
    assert seeded_client.delete(f"/api/admin/api-keys/{key_id}").status_code == 204
    assert seeded_client.get("/odata/v4/Initiatives").status_code == 200
