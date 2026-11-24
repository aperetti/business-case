"""Tests for the PDF report endpoints."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.core.reports import _run_is_stale, fmt_axis, report_filename


def _demo(client: TestClient) -> tuple[str, str, str]:
    inits = client.get("/api/initiatives").json()
    init = max(inits, key=lambda i: i["bca_count"])
    assert init["bca_count"] >= 2
    return init["id"], init["bcas"][0]["id"], init["bcas"][1]["id"]


def _assert_pdf(res) -> None:
    assert res.status_code == 200, res.text
    assert res.headers["content-type"] == "application/pdf"
    assert res.headers["content-disposition"].startswith("attachment; filename=")
    assert res.content.startswith(b"%PDF")
    assert len(res.content) > 3000


def test_single_bca_report_with_and_without_simulation(seeded_client: TestClient) -> None:
    init_id, bca_a, bca_b = _demo(seeded_client)
    url = f"/api/initiatives/{init_id}/bcas/{bca_a}/report.pdf"
    _assert_pdf(seeded_client.get(url))

    run = seeded_client.post(
        f"/api/initiatives/{init_id}/simulate?bca_id={bca_a}", json={"n_simulations": 500, "seed": 1}
    ).json()
    _assert_pdf(seeded_client.get(url))
    _assert_pdf(seeded_client.get(url, params={"run_id": run["run_id"]}))

    other = seeded_client.post(
        f"/api/initiatives/{init_id}/simulate?bca_id={bca_b}", json={"n_simulations": 500, "seed": 1}
    ).json()
    assert seeded_client.get(url, params={"run_id": other["run_id"]}).status_code == 422
    assert seeded_client.get(url, params={"run_id": "missing"}).status_code == 404
    assert seeded_client.get(f"/api/initiatives/{init_id}/bcas/nope/report.pdf").status_code == 404
    assert seeded_client.get(f"/api/initiatives/nope/bcas/{bca_a}/report.pdf").status_code == 404


def test_comparison_report_paired_and_unpaired(seeded_client: TestClient) -> None:
    init_id, bca_a, bca_b = _demo(seeded_client)
    url = f"/api/initiatives/{init_id}/bcas/compare/report.pdf"

    # Deterministic only: neither BCA simulated yet.
    _assert_pdf(seeded_client.get(url, params={"bca_a_id": bca_a, "bca_b_id": bca_b}))
    assert seeded_client.get(url, params={"bca_a_id": bca_a, "bca_b_id": bca_a}).status_code == 422
    assert seeded_client.get(url, params={"bca_a_id": bca_a}).status_code == 422

    comp = seeded_client.post(
        f"/api/initiatives/{init_id}/bcas/compare",
        json={"bca_a_id": bca_a, "bca_b_id": bca_b, "n_simulations": 500, "seed": 3},
    ).json()
    _assert_pdf(seeded_client.get(url, params={"bca_a_id": bca_a, "bca_b_id": bca_b}))
    _assert_pdf(
        seeded_client.get(
            url, params={"bca_a_id": bca_a, "bca_b_id": bca_b, "comparison_id": comp["comparison_id"]}
        )
    )
    # Reversed pair doesn't match the saved comparison: falls back to individual runs.
    _assert_pdf(seeded_client.get(url, params={"bca_a_id": bca_b, "bca_b_id": bca_a}))
    mismatched = seeded_client.get(
        url, params={"bca_a_id": bca_b, "bca_b_id": bca_a, "comparison_id": comp["comparison_id"]}
    )
    assert mismatched.status_code == 422
    missing = seeded_client.get(url, params={"bca_a_id": bca_a, "bca_b_id": bca_b, "comparison_id": "x"})
    assert missing.status_code == 404


def test_stale_run_detection(seeded_client: TestClient) -> None:
    from app.db import repository

    init_id, bca_a, _ = _demo(seeded_client)
    db_path = seeded_client.app.state.db_path
    seeded_client.post(f"/api/initiatives/{init_id}/simulate?bca_id={bca_a}", json={"n_simulations": 300})
    bca = repository.get_bca_detail(db_path, init_id, bca_a)
    assert bca.latest_simulation is not None
    assert not _run_is_stale(bca.latest_simulation, bca)

    item = bca.items[0]
    params = {k: v * 1.5 for k, v in item.param_values.items()}
    res = seeded_client.patch(f"/api/items/{item.id}", json={"param_values": params})
    assert res.status_code == 200, res.text
    bca = repository.get_bca_detail(db_path, init_id, bca_a)
    assert _run_is_stale(bca.latest_simulation, bca)

    # What-if runs are never flagged as stale; their numbers differ by design.
    seeded_client.post(
        f"/api/initiatives/{init_id}/simulate?bca_id={bca_a}", json={"n_simulations": 300, "benefit_scale": 1.5}
    )
    bca = repository.get_bca_detail(db_path, init_id, bca_a)
    assert not _run_is_stale(bca.latest_simulation, bca)


def test_report_helpers() -> None:
    assert fmt_axis(1_500_000) == "$1.5M"
    assert fmt_axis(500_000) == "$500K"
    assert fmt_axis(-250_000) == "-$250K"
    name = report_filename("Big Program / 2027", "Plan B", "report")
    assert name.startswith("big-program-2027-plan-b-report-") and name.endswith(".pdf")
