# Cross-Domain Value Stream & Monte Carlo BCA Platform

A local-first Benefit-Cost Analysis (BCA) and Value Stream Modeling application built with **FastAPI + SQLite + Polars + NumPy/SciPy** and **React + TypeScript + Mantine + Recharts**.

## Features

- **Reusable Cost & Benefit Catalog**: 9 baseline templates (`COST-BUILD-01`, `COST-RUN-01`, `COST-ENAB-01`, `COST-LIFE-01`, `BEN-TOIL-01`, `BEN-FLOW-01`, `BEN-QUAL-01`, `BEN-CAP-01`, `BEN-COMP-01`) plus custom template creation using an AST-whitelisted safe arithmetic evaluator (`expr:...`, never `eval()`).
- **Multi-Year Cash-Flow Expansion (Polars)**: Year-by-year grid expansion across `1..horizon_years`, normalized ramp profiles (`immediate`, `linear`, `s_curve`, `custom_weights`), discounting, BCR, NPV, fractional discounted payback, and anti-double-counting guardrail warnings.
- **Vectorized Monte Carlo Engine (NumPy + SciPy)**: Configurable 1,000–50,000 runs, optional deterministic seed, `normal` / `lognormal` / `triangular` / `pert` distributions with physical non-negative & `[0, 1]` bounds clamping, Gaussian copula correlation groups, P5–P95 percentiles, histogram/CDF bins, cumulative cash-flow fan curves, Spearman rank sensitivity drivers, value-stream breakdown, and SQLite run history.
- **Mantine Workspace**:
  - **Initiatives & Assumptions**: Live deterministic KPIs, annual cost vs. benefit charts, and line-item editor drawer.
  - **Monte Carlo Certainty**: Probability-of-success rings (`P(NPV > 0)`, `P(BCR >= 1.0)`), what-if sensitivity controls, NPV histogram/CDF, sensitivity tornado chart, and run history comparison.
  - **Catalog Manager**: Filterable template explorer and custom formula creator.

---

## Project Structure

- `backend/` — FastAPI app, Polars/NumPy simulation engine, SQLite persistence (`PRAGMA foreign_keys = ON`, WAL mode), and `pytest` suite.
- `frontend/` — Vite + React + TypeScript + Mantine UI + Recharts dashboard.

---

## Running the Application

### 1. Backend (FastAPI + SQLite)

Requires Python 3.11+ and [`uv`](https://docs.astral.sh/uv/).

```bash
cd backend
uv sync
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

On startup, SQLite initializes automatically at `backend/data/bca.db` with the 9 baseline catalog templates and a sample initiative.

Run the backend test suite (including the 10,000-run Monte Carlo performance benchmark):

```bash
cd backend
uv run pytest -v
```

### 2. Frontend (React + Vite + Mantine)

Requires Node.js 18+ and `npm`. In a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser. Vite proxies `/api/*` and `/health` requests to `http://127.0.0.1:8000` by default (override via `VITE_API_BASE_URL` if needed).

Production build check:

```bash
cd frontend
npm run build
```

---

## Docker & Homelab Deployment (QA + Production)

[docker-compose.yml](docker-compose.yml) defines isolated **Production** and **QA** stacks, each with its own SQLite persistent volume (`bca_prod_data` / `bca_qa_data`), isolated Docker bridge network, FastAPI backend, and Nginx frontend reverse proxy:

- **Production:** `http://192.168.0.190:8094` (`PROD_PORT`, default `8094`)
- **QA:** `http://192.168.0.190:8095` (`QA_PORT`, default `8095`)

Build and start both environments:

```bash
docker compose up -d --build
docker compose ps
```
