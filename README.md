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

## Initiative Approval Workflows

Initiatives move through **Draft → In Review → Approved / Rejected**. Admins define workflows in **Admin → Approval Workflows**: ordered steps, each approvable by members of selected roles and/or specific email addresses, with an optional quorum (`required approvals`). A starter "Standard Approval" workflow (Executive Reviewer or Administrator) is seeded on first run.

- Submitting snapshots the workflow's steps, so later edits to a workflow never change requests already in review.
- Initiatives, BCAs, and line items are **locked** while in review or approved (API returns `409`). Withdraw a pending request, or **Reopen as Draft** after a decision, to edit again.
- Any rejection ends the request (a comment is required); rejected initiatives can be revised and resubmitted.
- With Firebase SSO active, only eligible approvers can decide, and submitters cannot approve their own initiative. With SSO off the workspace is open-access, so anyone can act.
- **Email:** configure SMTP on the same admin page. Approvers are emailed when their step starts, and the submitter when a final decision is made. Every notification (sent, failed, or skipped) appears in the page's notification log. Email links use `#initiative/<id>` deep links built from the configured App URL.
- Managing workflows and email requires the `admin:workflows` permission (granted to Administrator).

## PDF Reports

Two downloadable PDF reports are generated server-side with ReportLab:

- **Business case report**: the **PDF Report** button on the Business Cases bar exports the active BCA: an executive summary, KPIs, assumptions, yearly cash flow, value streams, the Monte Carlo risk profile, top uncertainty drivers and line items. On the Monte Carlo tab it uses the run currently being viewed; elsewhere it uses the latest run. API: `GET /api/initiatives/{id}/bcas/{bca_id}/report.pdf[?run_id=]`.
- **Comparison report**: the **PDF Report** button on the Compare BCAs tab exports A vs B. It includes side-by-side metrics with deltas, the head-to-head win probability, NPV over time, distributions, value streams, drivers and an appendix of line items. It uses the selected paired comparison, or else the latest saved one for that pair. Failing that, it uses each BCA's latest run. API: `GET /api/initiatives/{id}/bcas/compare/report.pdf?bca_a_id=&bca_b_id=[&comparison_id=]`.

Deterministic figures always reflect current inputs. If inputs changed after the simulation being reported, the PDF shows a note saying so.

## Excel Export

The **Export to Excel** button on the Business Cases bar downloads one workbook containing every BCA under the initiative. API: `GET /api/initiatives/{id}/export.xlsx`.

- **Summary** sheet: the initiative, plus a side-by-side table of every BCA. Each row links to that BCA's sheet.
- **One overview sheet per BCA** (blue tab): assumptions, key metrics, the latest Monte Carlo results, cash flow by year, line items and value streams.
- **One sheet per cost and benefit** (red and green tabs): details, parameters and their uncertainty, and a yearly valuation of ramp × base value × discount factor.

Cash flows, present values and totals are live formulas. Changing a BCA's discount rate on its overview sheet, or a line item's base annual value, recalculates everything that depends on it. Base annual values come from each template's formula in the app. Discounted payback and Monte Carlo results are exported as values.

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

### Environment-Managed Authentication (`.env`)

By default, SSO settings and inbound API keys can be edited in the **Admin Portal** and persisted in SQLite. To lock configuration per environment without storing secrets in `bca.db`:

1. Copy `.env.example` to `.env` (or `.env.prod` / `.env.qa` for separate Docker Compose stacks — all `.env*` files except `.env.example` are gitignored).
2. Set any non-empty SSO variables (`SSO_ENABLED`, `SSO_PROVIDER`, `FIREBASE_*`, `ENTRA_*`, `SSO_ALLOWED_DOMAINS`, `SSO_ADMIN_EMAILS`) and/or `BCA_API_KEYS` (comma-separated or JSON array of keys for `/v1/*` and `/odata/*`).
3. Restart the backend / containers (`docker compose up -d`).

Whenever one or more env vars are active for SSO or API keys, environment values override SQLite at runtime and the corresponding Admin Portal controls become read-only (`409 Conflict` on write APIs) until those variables are unset.
