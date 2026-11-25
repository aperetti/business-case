"""Tests for non-monetary measures: defined per initiative, estimated per BCA."""

from __future__ import annotations

from fastapi.testclient import TestClient


def _two_bca_initiative(client: TestClient) -> tuple[str, str, str]:
    init = max(client.get("/api/initiatives").json(), key=lambda i: i["bca_count"])
    return init["id"], init["bcas"][0]["id"], init["bcas"][1]["id"]


def test_demo_initiative_ships_with_measures(seeded_client: TestClient) -> None:
    init_id, bca_a, bca_b = _two_bca_initiative(seeded_client)
    detail = seeded_client.get(f"/api/initiatives/{init_id}").json()
    names = [m["name"] for m in detail["measures"]]
    assert "Mean time to restore" in names
    mttr = next(m for m in detail["measures"] if m["name"] == "Mean time to restore")
    assert mttr["direction"] == "lower_is_better"
    by_bca = {b["id"]: b["measure_values"] for b in detail["bcas"]}
    assert by_bca[bca_a][mttr["id"]]["value"] == 3.5
    assert by_bca[bca_b][mttr["id"]]["value"] == 1.5


def test_measure_crud_and_values(seeded_client: TestClient) -> None:
    init_id, bca_a, bca_b = _two_bca_initiative(seeded_client)
    base = f"/api/initiatives/{init_id}/measures"

    res = seeded_client.post(base, json={"name": "Carbon footprint", "unit": "tCO2e", "direction": "lower_is_better"})
    assert res.status_code == 201, res.text
    measure = res.json()
    mid = measure["id"]

    dup = seeded_client.post(base, json={"name": "carbon FOOTPRINT"})
    assert dup.status_code == 422

    res = seeded_client.patch(f"{base}/{mid}", json={"unit": "t CO2e", "description": "Annual scope 2"})
    assert res.status_code == 200 and res.json()["unit"] == "t CO2e"
    assert res.json()["direction"] == "lower_is_better"

    value_url = f"/api/initiatives/{init_id}/bcas/{bca_a}/measures/{mid}"
    res = seeded_client.put(value_url, json={"value": 120, "low": 100, "high": 150, "note": "vendor estimate"})
    assert res.status_code == 200, res.text
    assert seeded_client.put(value_url, json={"value": 120, "low": 130}).status_code == 422
    assert seeded_client.put(value_url, json={"value": 120, "high": 110}).status_code == 422
    # Upsert replaces the estimate.
    assert seeded_client.put(value_url, json={"value": 90}).json()["low"] is None

    detail = seeded_client.get(f"/api/initiatives/{init_id}").json()
    vals = {b["id"]: b["measure_values"] for b in detail["bcas"]}
    assert vals[bca_a][mid]["value"] == 90
    assert mid not in vals[bca_b]

    # Cloning a BCA copies its measure estimates.
    clone = seeded_client.post(
        f"/api/initiatives/{init_id}/bcas", json={"name": "Clone", "clone_from_bca_id": bca_a}
    ).json()
    detail = seeded_client.get(f"/api/initiatives/{init_id}").json()
    clone_vals = next(b for b in detail["bcas"] if b["id"] == clone["id"])["measure_values"]
    assert clone_vals[mid]["value"] == 90

    assert seeded_client.delete(value_url).status_code == 204
    detail = seeded_client.get(f"/api/initiatives/{init_id}").json()
    assert mid not in next(b for b in detail["bcas"] if b["id"] == bca_a)["measure_values"]

    # Deleting the measure removes every BCA's estimate for it.
    assert seeded_client.delete(f"{base}/{mid}").status_code == 204
    detail = seeded_client.get(f"/api/initiatives/{init_id}").json()
    assert all(mid not in b["measure_values"] for b in detail["bcas"])
    assert all(m["id"] != mid for m in detail["measures"])


def test_measure_not_found_and_cross_initiative(seeded_client: TestClient) -> None:
    inits = seeded_client.get("/api/initiatives").json()
    init_id, bca_a, _ = _two_bca_initiative(seeded_client)
    other = next(i for i in inits if i["id"] != init_id)
    mid = seeded_client.post(f"/api/initiatives/{init_id}/measures", json={"name": "NPS"}).json()["id"]

    assert seeded_client.get("/api/initiatives/missing/measures").status_code == 404
    assert seeded_client.patch(f"/api/initiatives/{other['id']}/measures/{mid}", json={"unit": "x"}).status_code == 404
    # A BCA from another initiative cannot be scored on this initiative's measure.
    res = seeded_client.put(
        f"/api/initiatives/{init_id}/bcas/{other['bcas'][0]['id']}/measures/{mid}", json={"value": 1}
    )
    assert res.status_code == 404
    res = seeded_client.put(f"/api/initiatives/{init_id}/bcas/{bca_a}/measures/nope", json={"value": 1})
    assert res.status_code == 404
    assert seeded_client.post(f"/api/initiatives/{init_id}/measures", json={"name": " "}).status_code == 422


def test_measures_locked_once_approved(seeded_client: TestClient) -> None:
    from app.db.database import get_connection

    init_id, bca_a, _ = _two_bca_initiative(seeded_client)
    mid = seeded_client.post(f"/api/initiatives/{init_id}/measures", json={"name": "Agility"}).json()["id"]
    with get_connection(seeded_client.app.state.db_path) as conn:
        conn.execute("UPDATE initiatives SET status = 'approved' WHERE id = ?", (init_id,))

    assert seeded_client.post(f"/api/initiatives/{init_id}/measures", json={"name": "Other"}).status_code == 409
    res = seeded_client.put(f"/api/initiatives/{init_id}/bcas/{bca_a}/measures/{mid}", json={"value": 1})
    assert res.status_code == 409
    assert seeded_client.get(f"/api/initiatives/{init_id}/measures").status_code == 200
