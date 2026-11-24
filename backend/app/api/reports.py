"""PDF report downloads for a single BCA scenario and for a two-BCA comparison."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import Response

from app.core.reports import build_bca_report, build_comparison_report, report_filename
from app.db import repository

router = APIRouter(prefix="/api/initiatives", tags=["reports"])


def _actor(request: Request) -> str:
    user = getattr(request.state, "auth_user", None)
    if not user:
        return ""
    return getattr(user, "display_name", "") or getattr(user, "email", "") or ""


def _pdf(content: bytes, filename: str) -> Response:
    return Response(
        content=content,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


@router.get("/{initiative_id}/bcas/compare/report.pdf")
def comparison_report(
    request: Request,
    initiative_id: str,
    bca_a_id: str = Query(..., min_length=1, max_length=64),
    bca_b_id: str = Query(..., min_length=1, max_length=64),
    comparison_id: str | None = Query(default=None, max_length=64),
) -> Response:
    """Report comparing BCA A (reference) with BCA B (challenger).

    Uses the given paired comparison, else the latest saved comparison for this A/B pair,
    else each BCA's latest individual simulation run.
    """
    if bca_a_id == bca_b_id:
        raise HTTPException(
            status_code=422,
            detail="Choose two different BCAs to compare.",
        )
    db_path = request.app.state.db_path
    try:
        initiative = repository.get_initiative_detail(db_path, initiative_id)
        bca_a = repository.get_bca_detail(db_path, initiative_id, bca_a_id)
        bca_b = repository.get_bca_detail(db_path, initiative_id, bca_b_id)
        if comparison_id:
            comparison = repository.get_bca_comparison(db_path, initiative_id, comparison_id)
            if comparison.bca_a_id != bca_a.id or comparison.bca_b_id != bca_b.id:
                raise HTTPException(
                    status_code=422,
                    detail="That comparison is for a different pair of BCAs.",
                )
        else:
            comparison = repository.find_latest_bca_comparison(db_path, initiative_id, bca_a.id, bca_b.id)
    except repository.NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

    pdf = build_comparison_report(
        initiative,
        bca_a,
        bca_b,
        comparison=comparison,
        sim_a=bca_a.latest_simulation,
        sim_b=bca_b.latest_simulation,
        generated_by=_actor(request),
    )
    return _pdf(pdf, report_filename(initiative.name, bca_a.name, "vs", bca_b.name))


@router.get("/{initiative_id}/bcas/{bca_id}/report.pdf")
def bca_report(
    request: Request,
    initiative_id: str,
    bca_id: str,
    run_id: str | None = Query(default=None, max_length=64),
) -> Response:
    """Report for one BCA scenario. Uses `run_id` for Monte Carlo results, else the latest run."""
    db_path = request.app.state.db_path
    try:
        initiative = repository.get_initiative_detail(db_path, initiative_id, bca_id=bca_id)
        bca = repository.get_bca_detail(db_path, initiative_id, bca_id)
        sim = bca.latest_simulation
        if run_id:
            sim = repository.get_simulation_run(db_path, initiative_id, run_id)
            if sim.bca_id and sim.bca_id != bca.id:
                raise HTTPException(
                    status_code=422,
                    detail="That simulation run belongs to a different BCA.",
                )
    except repository.NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

    pdf = build_bca_report(initiative, bca, sim, generated_by=_actor(request))
    return _pdf(pdf, report_filename(initiative.name, bca.name, "report"))
