Here is a structured, ready-to-paste Software Requirements Specification (SRS) you can hand directly to an LLM or coding agent to scaffold the application.
Requirements Specification: Cross-Domain Value Stream & Monte Carlo BCA Platform
1. Overview & Goals
Build a domain-agnostic Benefit-Cost Analysis (BCA) and Value Stream Modeling application supporting software delivery, automation, capability development, and infrastructure/modernization initiatives.
 * Core objective: Let teams instantiate reusable cost and benefit catalog items, map them across multi-year horizons and realization curves, and evaluate certainty using Monte Carlo simulation rather than single-point estimates.
 * Domain neutrality: Avoid hardcoding DER, utility tariff, or sector-specific assumptions into the core data model; domains are tags/filters and custom parameter bindings.
 * Local-first architecture: FastAPI + SQLite backend paired with a React + Mantine frontend, using Polars and NumPy for vectorized financial and simulation math.
2. Tech Stack & Project Structure
 * Backend: Python (3.11+), uv for dependency/environment management, FastAPI, Pydantic v2, SQLite (via sqlite3 or SQLAlchemy/SQLModel), Polars, NumPy (and optional SciPy for distributions).
 * Frontend: React (TypeScript, Vite), @mantine/core, @mantine/hooks, @mantine/form (with Zod validation), and a charting library (e.g., @mantine/charts or Recharts/D3) for distributions and cash-flow curves.
 * Suggested layout:
   * backend/app/api/ — FastAPI routers (catalog.py, initiatives.py, simulations.py)
   * backend/app/core/catalog.py — Built-in reusable cost & benefit catalog definitions and formula evaluators
   * backend/app/core/engine.py — Polars cash-flow expansion, discounting, and vectorized Monte Carlo engine
   * backend/app/db/ — SQLite schema, migrations/init, and repository queries
   * frontend/src/ — Mantine UI views, catalog builder, initiative line-item editor, and Monte Carlo results dashboard
3. Domain Model: Reusable Cost & Benefit Catalog
3.1 Catalog Entry Schema
Each catalog entry defines a reusable template that initiatives instantiate:
 * id (string, unique, e.g., COST-BUILD-01, BEN-TOIL-01)
 * kind ("cost" | "benefit")
 * name (string)
 * description (string)
 * domains (list of strings, e.g., ["software", "automation", "capability", "operations"])
 * value_stream_stage (optional default stage, e.g., "Build", "Automate", "Operate", "Enable")
 * parameters (list of parameter definitions: key, label, unit, default_value, min_value, max_value, required)
 * formula_type (safe expression or registered Python formula key—never eval() on untrusted input)
 * guardrail_notes (string explaining double-counting or realization caveats)
3.2 Baseline Seed Catalog
Seed SQLite on startup with at least these starter items:
 * Costs:
   * COST-BUILD-01: Build, Integration & Deployment (hours, hourly_rate, vendor_cost)
   * COST-RUN-01: Recurring Hosting, Licensing & Support (annual_infra_cost, annual_license_cost, support_hours_per_year, hourly_rate)
   * COST-ENAB-01: Enablement, Training & Change Management (training_hours, affected_staff, hourly_rate, transition_cost)
   * COST-LIFE-01: Lifecycle Refresh & Decommissioning (refresh_cost, refresh_interval_years)
 * Benefits:
   * BEN-TOIL-01: Automated Toil Elimination (events_per_year, minutes_saved_per_event, hourly_rate, adoption_rate, realization_factor)
   * BEN-FLOW-01: Cycle-Time & Throughput Acceleration (accelerated_items_per_year, value_per_item, adoption_rate)
   * BEN-QUAL-01: Defect, Rework & Incident Avoidance (baseline_events_per_year, risk_reduction_pct, cost_per_event)
   * BEN-CAP-01: Shared Capability & Reuse Leverage (downstream_initiatives, avoided_setup_cost, reuse_probability)
   * BEN-COMP-01: Compliance, Audit & Risk Reduction (audit_hours_saved, hourly_rate, avoided_penalty_expected)
4. Initiative & Cash-Flow Modeling Requirements
4.1 Initiative Entities
 * Initiative: id, name, description, domain, horizon_years (e.g., 5–15), discount_rate (e.g., 0.06 for 6%), created_at, updated_at.
 * Initiative Line Item (initiative_items): Links an initiative_id to a catalog_id, stores:
   * label (custom override name for this initiative)
   * value_stream (e.g., "Software Delivery", "Incident Response", "Capability Enablement")
   * start_year and end_year (1-indexed within horizon_years)
   * ramp_profile ("immediate" | "linear" | "s_curve" | "custom_weights")
   * param_values (JSON object binding catalog parameter keys to numbers)
   * uncertainty_spec (JSON defining per-item or per-parameter uncertainty: distribution type "normal" | "triangular" | "lognormal" | "pert", spread/std/low/high, and optional correlation group)
   * anti_double_count_tag (optional tag to flag overlapping benefit claims)
4.2 Deterministic & Stochastic Calculation Rules (Polars + NumPy)
 * Expand to Year-by-Year Cash Flows using Polars:
   * Generate a (initiative_item, year) grid across 1..horizon_years.
   * Compute base annual cost or benefit for each active year, applying start_year..end_year bounds and ramp_profile multipliers normalized cleanly.
 * Discounting:
   * Discount cash flows by year t \in \{1, \dots, T\} at rate r:
     
   * Compute PV of Costs, PV of Benefits, Net Present Value (NPV = PV Benefits - PV Costs), Benefit-Cost Ratio (BCR = PV Benefits / PV Costs), and Discounted Payback Year.
 * Monte Carlo Simulation:
   * Support configurable n_simulations (default 5,000–20,000, capped safely for local latency) and an optional random_seed for reproducibility.
   * Vectorize sampling in NumPy across (n_simulations, horizon_years) or (n_simulations, n_items, horizon_years) rather than Python row loops.
   * Clamp cost/quantity parameters where physically non-negative (e.g., hours, rates, probabilities in [0, 1]).
   * Return distribution statistics for NPV and BCR:
     * Mean, standard deviation, and probability of positive NPV (P(NPV > 0)) and P(BCR >= 1.0)
     * Percentiles: P5, P10, P25, P50 (median), P75, P90, P95
     * Histogram bins for chart rendering
     * Top sensitivity / variance drivers (rank or correlation of input parameters with simulated NPV)
5. SQLite Persistence & FastAPI Contract
5.1 SQLite Schema
Use normalized tables with foreign keys enabled (PRAGMA foreign_keys = ON;) and WAL mode (PRAGMA journal_mode = WAL;) for reliable local concurrency:
 * catalog_entries
 * initiatives
 * initiative_items
 * simulation_runs (stores id, initiative_id, n_simulations, discount_rate, horizon_years, seed, summary_json, created_at)
5.2 API Endpoints
 * GET /health — Service and DB health check
 * GET /api/catalog & POST /api/catalog — List/filter (by domain or kind) and create custom catalog entries
 * GET /api/initiatives, POST /api/initiatives, GET /api/initiatives/{id}, PATCH /api/initiatives/{id}, DELETE /api/initiatives/{id}
 * POST /api/initiatives/{id}/items, PATCH /api/items/{item_id}, DELETE /api/items/{item_id}
 * POST /api/initiatives/{id}/simulate — Runs deterministic baseline + Monte Carlo simulation, persists summary in simulation_runs, and returns deterministic metrics, percentile bands, histogram bins, and per-value-stream breakdowns
 * GET /api/initiatives/{id}/runs — List past simulation runs for comparison
6. Frontend Requirements (React + Mantine)
Build a clean, responsive workspace using Mantine components (AppShell, Tabs, Table/DataTable, NumberInput, Select, Slider, Drawer/Modal, Badge, Alert):
 * Initiatives & Assumptions View:
   * Create/edit initiatives (horizon_years, discount_rate, domain).
   * Add line items from the reusable catalog, adjust parameters and ramp profiles, and configure uncertainty distributions (std or low/mode/high + correlation key).
   * Display live deterministic NPV, BCR, and payback alongside a year-by-year cost vs. benefit breakdown.
 * Monte Carlo Certainty Dashboard:
   * Controls for simulation count (1,000–50,000), seed, and quick "what-if" parameter/uncertainty tweaks.
   * Probability of success cards: P(NPV > 0), P(BCR > 1.0), P10 / P50 / P90 NPV and BCR.
   * Distribution chart: Histogram or CDF of simulated NPV with markers for P10, P50, P90, and breakeven ($0).
   * Value-stream breakdown: Compare costs and benefits grouped by value_stream so teams see where value or uncertainty originates.
 * Catalog Manager View:
   * Browse built-in and custom cost/benefit templates, inspect formulas and anti-double-counting guardrails, and add new domain templates.
7. Non-Functional & Quality Requirements
 * Validation & safety: Strict Pydantic request/response schemas; reject invalid year ranges (start_year > end_year or end_year > horizon_years) and disallow arbitrary code execution in formulas.
 * Performance: A 10,000-run simulation for an initiative with ~15 line items over a 10-year horizon should complete in under ~1 second on standard hardware.
 * Testing: Include unit tests (pytest) for deterministic PV/NPV/BCR math, ramp curves, parameter clamping, reproducibility with fixed seeds, and FastAPI endpoint round-trips.
How to Prompt the LLM With This Spec
> "Implement the application described in the requirements specification below. Start with the FastAPI + SQLite backend, Polars/NumPy deterministic and Monte Carlo engine, and seed catalog, then build the React + Mantine frontend. Provide clear run instructions for both backend and frontend."
> 

