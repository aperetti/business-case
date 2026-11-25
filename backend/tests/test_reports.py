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


def test_excel_export_has_overview_and_one_sheet_per_line_item(seeded_client: TestClient) -> None:
    import html
    import io
    import re
    import zipfile

    init_id, bca_a, bca_b = _demo(seeded_client)
    seeded_client.post(f"/api/initiatives/{init_id}/simulate?bca_id={bca_a}", json={"n_simulations": 300})
    res = seeded_client.get(f"/api/initiatives/{init_id}/export.xlsx")
    assert res.status_code == 200, res.text
    assert res.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    assert re.search(r'filename=".+-business-cases-\d{8}\.xlsx"', res.headers["content-disposition"])

    with zipfile.ZipFile(io.BytesIO(res.content)) as zf:
        workbook_xml = zf.read("xl/workbook.xml").decode()
    sheet_names = [html.unescape(n) for n in re.findall(r'<sheet name="([^"]+)"', workbook_xml)]

    a = seeded_client.get(f"/api/initiatives/{init_id}/bcas/{bca_a}").json()
    b = seeded_client.get(f"/api/initiatives/{init_id}/bcas/{bca_b}").json()
    assert sheet_names[0] == "Summary"
    assert len(sheet_names) == 1 + (1 + len(a["items"])) + (1 + len(b["items"]))
    assert all(len(n) <= 31 for n in sheet_names)
    assert len({n.lower() for n in sheet_names}) == len(sheet_names)
    cost_sheets = [n for n in sheet_names if re.match(r"^1\.\d+ Cost ", n)]
    benefit_sheets = [n for n in sheet_names if re.match(r"^1\.\d+ Benefit ", n)]
    assert len(cost_sheets) == sum(1 for i in a["items"] if i["kind"] == "cost")
    assert len(benefit_sheets) == sum(1 for i in a["items"] if i["kind"] == "benefit")

    assert seeded_client.get("/api/initiatives/missing/export.xlsx").status_code == 404


def test_excel_sheet_names_are_safe_and_unique() -> None:
    from app.core.excel_export import _SheetNames

    names = _SheetNames()
    first = names.make("1.1 Cost CI/CD [phase:1] * really long label that overflows")
    assert len(first) <= 31 and not set("[]:*?/\\") & set(first)
    assert names.make("Summary") == "Summary"
    assert names.make("summary") == "summary (2)"


def test_excel_summary_lists_non_monetary_measures(seeded_client: TestClient) -> None:
    import io
    import zipfile

    init_id, _, _ = _demo(seeded_client)
    res = seeded_client.get(f"/api/initiatives/{init_id}/export.xlsx")
    assert res.status_code == 200
    with zipfile.ZipFile(io.BytesIO(res.content)) as zf:
        strings = zf.read("xl/sharedStrings.xml").decode()
        names = zf.namelist()
    assert "Non-monetary benefits" in strings
    assert "Mean time to restore" in strings
    assert any(n.startswith("xl/comments") for n in names)
