"""Monte Carlo simulation execution and run history endpoints."""

from __future__ import annotations

import math
import zlib
from uuid import uuid4

import numpy as np
from fastapi import APIRouter, HTTPException, Query, Request, status

from app.core.engine import (
    run_monte_carlo,
    run_monte_carlo_comparison,
    sample_pairwise_draws,
    sample_triangular_estimate,
)
from app.db import repository
from app.models import (
    BCACompareRequest,
    BCAComparisonRecord,
    BCAComparisonResult,
    PairwiseCaseSamples,
    PairwiseSamples,
    SimulationRequest,
    SimulationResult,
    SimulationRunRecord,
)

router = APIRouter(prefix="/api/initiatives", tags=["simulations"])


@router.post("/{initiative_id}/simulate", response_model=SimulationResult)
def simulate_initiative(
    request: Request,
    initiative_id: str,
    payload: SimulationRequest | None = None,
    bca_id: str | None = Query(default=None),
) -> SimulationResult:
    req = payload or SimulationRequest()
    target_bca_id = bca_id if bca_id is not None else req.bca_id
    db_path = request.app.state.db_path
    try:
        init_dict, item_dicts, catalog_map = repository.get_initiative_context(
            db_path, initiative_id, bca_id=target_bca_id
        )
    except repository.NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

    run_id = str(uuid4()) if req.persist else None
    result = run_monte_carlo(
        init_dict,
        item_dicts,
        catalog_map,
        req,
        run_id=run_id,
        bca_id=init_dict.get("bca_id"),
        bca_name=init_dict.get("bca_name"),
    )
    if req.persist:
        result = repository.save_simulation_run(db_path, result)
    return result


def _finite_or_none(arr: np.ndarray) -> list[float | None]:
    return [float(v) if math.isfinite(v) else None for v in arr.tolist()]


@router.get("/{initiative_id}/pairwise-samples", response_model=PairwiseSamples)
def pairwise_samples(
    request: Request,
    initiative_id: str,
    points: int = Query(default=300, ge=50, le=2000),
    seed: int = Query(default=20240601, ge=0, le=2_147_483_647),
) -> PairwiseSamples:
    """Fresh Monte Carlo draws per BCA for the pair-wise plot; nothing is stored.

    Financial metrics in one draw come from the same simulated future, so their joint
    spread is real. Non-monetary estimates are drawn independently from a triangular
    (low, expected, high) distribution.
    """
    db_path = request.app.state.db_path
    try:
        detail = repository.get_initiative_detail(db_path, initiative_id)
        cases: list[PairwiseCaseSamples] = []
        for bca in detail.bcas:
            init_dict, item_dicts, catalog_map = repository.get_initiative_context(
                db_path, initiative_id, bca_id=bca.id
            )
            draws = sample_pairwise_draws(init_dict, item_dicts, catalog_map, n_points=points, seed=seed)
            rng = np.random.default_rng([seed, zlib.crc32(bca.id.encode())])
            measures = {
                mid: [
                    float(v)
                    for v in sample_triangular_estimate(est.value, est.low, est.high, points, rng)
                ]
                for mid, est in sorted(bca.measure_values.items())
            }
            cases.append(
                PairwiseCaseSamples(
                    bca_id=bca.id,
                    npv=[float(v) for v in draws["npv"]],
                    bcr=_finite_or_none(draws["bcr"]),
                    pv_benefits=[float(v) for v in draws["pv_benefits"]],
                    pv_costs=[float(v) for v in draws["pv_costs"]],
                    payback=_finite_or_none(draws["payback"]),
                    measures=measures,
                )
            )
    except repository.NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return PairwiseSamples(n_points=points, seed=seed, cases=cases)


@router.get("/{initiative_id}/runs", response_model=list[SimulationRunRecord])
def list_simulation_runs(
    request: Request,
    initiative_id: str,
    bca_id: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
) -> list[SimulationRunRecord]:
    try:
        return repository.list_simulation_runs(
            request.app.state.db_path, initiative_id, bca_id=bca_id, limit=limit
        )
    except repository.NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


@router.post("/{initiative_id}/bcas/compare", response_model=BCAComparisonResult)
def compare_initiative_bcas(
    request: Request,
    initiative_id: str,
    payload: BCACompareRequest,
) -> BCAComparisonResult:
    db_path = request.app.state.db_path
    try:
        bca_a_ctx, items_a, catalog_map = repository.get_initiative_context(
            db_path, initiative_id, bca_id=payload.bca_a_id
        )
        bca_b_ctx, items_b, _ = repository.get_initiative_context(
            db_path, initiative_id, bca_id=payload.bca_b_id
        )
    except repository.NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

    comparison_id = str(uuid4()) if payload.persist else None
    run_a_id = str(uuid4()) if payload.persist else None
    run_b_id = str(uuid4()) if payload.persist else None
    comparison, result_a, result_b = run_monte_carlo_comparison(
        bca_a_ctx,
        items_a,
        bca_b_ctx,
        items_b,
        catalog_map,
        payload,
        comparison_id=comparison_id,
        run_a_id=run_a_id,
        run_b_id=run_b_id,
    )
    if payload.persist:
        saved_a = repository.save_simulation_run(db_path, result_a)
        saved_b = repository.save_simulation_run(db_path, result_b)
        comparison = comparison.model_copy(update={"result_a": saved_a, "result_b": saved_b})
        comparison = repository.save_bca_comparison(db_path, comparison)
    return comparison


@router.get("/{initiative_id}/bcas/comparisons", response_model=list[BCAComparisonRecord])
def list_initiative_bca_comparisons(
    request: Request,
    initiative_id: str,
    limit: int = Query(default=20, ge=1, le=100),
) -> list[BCAComparisonRecord]:
    try:
        return repository.list_bca_comparisons(request.app.state.db_path, initiative_id, limit=limit)
    except repository.NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
