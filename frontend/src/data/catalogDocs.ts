import type {
  CatalogEntry,
  CatalogKind,
  RampProfile,
  UncertaintySpec,
} from '../types/api';

export interface GuideTable {
  headers: string[];
  rows: string[][];
}

export interface GuideSection {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
  formula?: string;
  callout?: string;
  table?: GuideTable;
}

export interface GuideDocPage {
  slug: string;
  title: string;
  subtitle: string;
  sections: GuideSection[];
}

export interface ParameterGuidance {
  guidance: string;
  typicalRange: string;
  dataSource: string;
}

export interface AlternativeRef {
  text: string;
  linkSlug?: string;
  linkLabel?: string;
}

export interface WorkedExampleSpec {
  id: string;
  title: string;
  domain: string;
  valueStream: string;
  summary: string;
  horizonYears: number;
  discountRate: number;
  startYear: number;
  endYear: number;
  rampProfile: RampProfile;
  rampWeights?: number[] | null;
  paramValues: Record<string, number>;
  uncertaintySummary: string;
  uncertaintySpec: UncertaintySpec;
  antiDoubleCountTag?: string | null;
}

export interface CatalogItemDoc {
  id: string;
  headline: string;
  whatItMeasures: string;
  economicRationale: string;
  whenToUse: string[];
  whenNotToUse: AlternativeRef[];
  formulaPlainEnglish: string;
  parameterGuidance: Record<string, ParameterGuidance>;
  modelingTips: {
    schedule: string;
    ramp: string;
    uncertainty: string;
    correlation: string;
  };
  guardrailDeepDive: string[];
  examples: WorkedExampleSpec[];
}

export interface ComputedYearlyRow {
  year: number;
  rampMultiplier: number;
  undiscounted: number;
  discountFactor: number;
  pv: number;
}

export interface ComputedExampleResult {
  baseAnnualValue: number;
  totalUndiscounted: number;
  totalPv: number;
  yearlyRows: ComputedYearlyRow[];
}

type Token =
  | { type: 'num'; value: number }
  | { type: 'ident'; value: string }
  | { type: 'op'; value: '+' | '-' | '*' | '/' | '**' }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'comma' };

function tokenizeExpr(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = expr.length;
  while (i < n) {
    const ch = expr[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen' });
      i += 1;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'comma' });
      i += 1;
      continue;
    }
    if (ch === '*' && expr[i + 1] === '*') {
      tokens.push({ type: 'op', value: '**' });
      i += 2;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ type: 'op', value: ch });
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const slice = expr.slice(i);
      const match = slice.match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
      if (!match) {
        throw new Error(`Invalid numeric literal near '${slice.slice(0, 8)}'`);
      }
      tokens.push({ type: 'num', value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      const slice = expr.slice(i);
      const match = slice.match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
      if (!match) {
        throw new Error(`Invalid identifier near '${slice.slice(0, 8)}'`);
      }
      tokens.push({ type: 'ident', value: match[0] });
      i += match[0].length;
      continue;
    }
    throw new Error(`Unexpected character '${ch}' in formula`);
  }
  return tokens;
}

/**
 * Pure recursive-descent arithmetic parser matching backend AST whitelist rules.
 * Never uses eval() or Function().
 */
export function evaluateSafeMathExpr(expr: string, params: Record<string, number>): number {
  const cleaned = expr.trim();
  if (!cleaned) return 0;
  let tokens: Token[];
  try {
    tokens = tokenizeExpr(cleaned);
  } catch {
    return 0;
  }
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const consume = (): Token | undefined => {
    const t = tokens[pos];
    pos += 1;
    return t;
  };

  function parseExpression(): number {
    let left = parseTerm();
    while (true) {
      const t = peek();
      if (t?.type === 'op' && (t.value === '+' || t.value === '-')) {
        consume();
        const right = parseTerm();
        left = t.value === '+' ? left + right : left - right;
      } else {
        break;
      }
    }
    return left;
  }

  function parseTerm(): number {
    let left = parsePower();
    while (true) {
      const t = peek();
      if (t?.type === 'op' && (t.value === '*' || t.value === '/')) {
        consume();
        const right = parsePower();
        if (t.value === '*') {
          left = left * right;
        } else {
          left = right === 0 ? 0 : left / right;
        }
      } else {
        break;
      }
    }
    return left;
  }

  function parsePower(): number {
    const base = parseUnary();
    const t = peek();
    if (t?.type === 'op' && t.value === '**') {
      consume();
      const exp = parsePower();
      return Math.pow(base, exp);
    }
    return base;
  }

  function parseUnary(): number {
    const t = peek();
    if (t?.type === 'op' && (t.value === '+' || t.value === '-')) {
      consume();
      const inner = parseUnary();
      return t.value === '-' ? -inner : inner;
    }
    return parsePrimary();
  }

  function parsePrimary(): number {
    const t = consume();
    if (!t) return 0;
    if (t.type === 'num') return t.value;
    if (t.type === 'lparen') {
      const val = parseExpression();
      if (peek()?.type === 'rparen') consume();
      return val;
    }
    if (t.type === 'ident') {
      if (peek()?.type === 'lparen') {
        consume();
        const args: number[] = [];
        if (peek()?.type !== 'rparen') {
          args.push(parseExpression());
          while (peek()?.type === 'comma') {
            consume();
            args.push(parseExpression());
          }
        }
        if (peek()?.type === 'rparen') consume();
        if (t.value === 'abs') return Math.abs(args[0] ?? 0);
        if (t.value === 'min') return args.length > 0 ? Math.min(...args) : 0;
        if (t.value === 'max') return args.length > 0 ? Math.max(...args) : 0;
        return 0;
      }
      return Number(params[t.value] ?? 0);
    }
    return 0;
  }

  try {
    const result = parseExpression();
    return Number.isFinite(result) ? result : 0;
  } catch {
    return 0;
  }
}

/**
 * Exact match for backend/app/core/catalog.py evaluate_formula().
 */
export function evaluateCatalogFormula(formulaType: string, params: Record<string, number>): number {
  const p = (key: string): number => Number(params[key] ?? 0);
  switch (formulaType) {
    case 'cost_build':
      return p('hours') * p('hourly_rate') + p('vendor_cost');
    case 'cost_run':
      return p('annual_infra_cost') + p('annual_license_cost') + p('support_hours_per_year') * p('hourly_rate');
    case 'cost_enablement':
      return p('training_hours') * p('affected_staff') * p('hourly_rate') + p('transition_cost');
    case 'cost_lifecycle': {
      const denom = Math.max(p('refresh_interval_years'), 1);
      return denom === 0 ? 0 : p('refresh_cost') / denom;
    }
    case 'ben_toil':
      return (
        p('events_per_year') *
        (p('minutes_saved_per_event') / 60) *
        p('hourly_rate') *
        p('adoption_rate') *
        p('realization_factor')
      );
    case 'ben_flow':
      return p('accelerated_items_per_year') * p('value_per_item') * p('adoption_rate');
    case 'ben_quality':
      return p('baseline_events_per_year') * p('risk_reduction_pct') * p('cost_per_event');
    case 'ben_capability':
      return p('downstream_initiatives') * p('avoided_setup_cost') * p('reuse_probability');
    case 'ben_compliance':
      return p('audit_hours_saved') * p('hourly_rate') + p('avoided_penalty_expected');
    default:
      if (formulaType.startsWith('expr:')) {
        return evaluateSafeMathExpr(formulaType.slice(5), params);
      }
      return 0;
  }
}

/**
 * Exact port of compute_ramp_multipliers() from backend/app/core/engine.py.
 */
export function computeRampMultipliers(
  horizonYears: number,
  startYear: number,
  endYear: number,
  rampProfile: RampProfile,
  rampWeights?: number[] | null
): number[] {
  const multipliers = Array.from({ length: horizonYears }, () => 0);
  const effStart = Math.max(1, startYear);
  const effEnd = Math.min(horizonYears, endYear);
  if (effStart > effEnd) return multipliers;

  const span = Math.max(1, endYear - startYear + 1);
  let profile: number[];

  if (rampProfile === 'immediate') {
    profile = Array.from({ length: span }, () => 1);
  } else if (rampProfile === 'linear') {
    profile = Array.from({ length: span }, (_, idx) => (idx + 1) / span);
  } else if (rampProfile === 's_curve') {
    if (span === 1) {
      profile = [1];
    } else {
      const raw = Array.from({ length: span }, (_, idx) => {
        const x = idx / (span - 1);
        return 1 / (1 + Math.exp(-6 * (x - 0.5)));
      });
      const last = raw[raw.length - 1] || 1;
      profile = raw.map((val) => val / last);
    }
  } else if (rampProfile === 'custom_weights') {
    const source = rampWeights && rampWeights.length > 0 ? rampWeights : Array.from({ length: span }, () => 1);
    const aligned =
      source.length === span
        ? [...source]
        : Array.from({ length: span }, (_, idx) => (idx < source.length ? source[idx] : 1));
    const maxW = aligned.length > 0 ? Math.max(...aligned) : 0;
    profile = maxW > 1 ? aligned.map((w) => w / maxW) : aligned;
  } else {
    profile = Array.from({ length: span }, () => 1);
  }

  const sliceStart = effStart - startYear;
  for (let year = effStart; year <= effEnd; year += 1) {
    multipliers[year - 1] = profile[sliceStart + (year - effStart)] ?? 0;
  }
  return multipliers;
}

export function computeExampleResult(
  formulaType: string,
  example: WorkedExampleSpec
): ComputedExampleResult {
  const baseAnnualValue = evaluateCatalogFormula(formulaType, example.paramValues);
  const ramps = computeRampMultipliers(
    example.horizonYears,
    example.startYear,
    example.endYear,
    example.rampProfile,
    example.rampWeights
  );

  let totalUndiscounted = 0;
  let totalPv = 0;
  const yearlyRows: ComputedYearlyRow[] = [];

  for (let y = 1; y <= example.horizonYears; y += 1) {
    const rampMultiplier = ramps[y - 1] ?? 0;
    const undiscounted = baseAnnualValue * rampMultiplier;
    const discountFactor = 1 / Math.pow(1 + example.discountRate, y);
    const pv = undiscounted * discountFactor;
    totalUndiscounted += undiscounted;
    totalPv += pv;
    yearlyRows.push({
      year: y,
      rampMultiplier,
      undiscounted,
      discountFactor,
      pv,
    });
  }

  return {
    baseAnnualValue,
    totalUndiscounted,
    totalPv,
    yearlyRows,
  };
}

export const GUIDE_PAGES: GuideDocPage[] = [
  {
    slug: 'overview',
    title: 'ValueStream BCA Documentation',
    subtitle:
      'Methodology, catalog model reference, and worked examples for evidence-based technology and operations business cases.',
    sections: [
      {
        heading: 'How Initiatives Are Modeled',
        paragraphs: [
          'ValueStream BCA evaluates technology, automation, infrastructure, and operational initiatives by decomposing them into standardized Cost and Benefit line items instantiated from the shared Catalog.',
          'Rather than hardcoding ad-hoc spreadsheet formulas, each line item binds a catalog formula to four structured layers: (1) Domain parameters with physical bounds, (2) Value stream ownership, (3) Active year span and realization ramp, and (4) Monte Carlo parameter uncertainty and correlation.',
        ],
        bullets: [
          'Cost templates capture lifecycle expenditure evenly across upfront engineering (COST-BUILD-01), ongoing run/support (COST-RUN-01), people enablement (COST-ENAB-01), and periodic refresh debt (COST-LIFE-01).',
          'Benefit templates separate distinct economic mechanisms — labor toil elimination, throughput acceleration, incident avoidance, cross-program reuse, and audit/compliance reduction — so reviewers can scrutinize assumptions and prevent double counting.',
          'Custom templates can be authored anytime using safe AST-validated arithmetic expressions (expr:...) without code deploys.',
        ],
      },
      {
        heading: 'Recommended Workflow for a Defensible Business Case',
        bullets: [
          '1. Set Initiative Horizon & Discount Rate: Pick 5–10 years matching the asset lifespan and your finance hurdle rate (typically 6%–10% real WACC).',
          '2. Model All Four Cost Phases: Pair Build costs (COST-BUILD-01) with Enablement (COST-ENAB-01), steady-state Run (COST-RUN-01), and Lifecycle Refresh (COST-LIFE-01) where applicable.',
          '3. Ground Benefits in Observable Baselines: Tie every benefit parameter to ticket logs, billing volume, or post-mortems rather than speculative percentages.',
          '4. Apply Ramps & Anti-Double-Count Tags: Delay operational benefits until build/rollout waves complete, and tag overlapping benefits (such as Toil + Flow affecting the same staff hours).',
          '5. Run 10,000-Iteration Monte Carlo: Assign PERT, Triangular, Normal, or Lognormal spreads and correlation groups so executive reviews focus on P10–P90 confidence intervals and P(NPV > 0).',
        ],
      },
    ],
  },
  {
    slug: 'methodology',
    title: 'Discounting, NPV, BCR & Payback',
    subtitle:
      'Exact deterministic cash-flow math used by the Polars evaluation engine across initiatives and value streams.',
    sections: [
      {
        heading: 'End-of-Year Present Value Discounting',
        paragraphs: [
          'Every active line item computes a steady-state annual value at 100% ramp, scales it by each year’s ramp multiplier, and discounts each year t = 1 … H using standard end-of-year compounding.',
        ],
        formula:
          'undiscounted(t) = base_annual_value * ramp_multiplier(t)\ndiscount_factor(t) = 1 / (1 + discount_rate) ** t\npv(t) = undiscounted(t) * discount_factor(t)',
        callout:
          'Tip: Year 1 cash flows are discounted by 1 / (1 + r)^1. At a 7% discount rate, $100,000 occurring in Year 1 has a PV of $93,458, whereas $100,000 occurring in Year 5 has a PV of $71,299.',
      },
      {
        heading: 'Portfolio Summary Metrics',
        bullets: [
          'PV of Costs: Sum of discounted annual cash outflows across all cost line items over years 1..H.',
          'PV of Benefits: Sum of discounted annual cash inflows across all benefit line items over years 1..H.',
          'Net Present Value (NPV): PV of Benefits minus PV of Costs. Positive NPV indicates value creation above the discount hurdle rate.',
          'Benefit-Cost Ratio (BCR): PV of Benefits divided by PV of Costs. A BCR above 1.0x corresponds to positive NPV; capital-constrained portfolios often target >= 1.5x at P50.',
          'Value Stream Breakdown: Items sharing a value_stream label roll up independently so sponsors can verify whether every targeted operational stream clears 1.0x.',
        ],
      },
      {
        heading: 'Discounted Payback Interpolation',
        paragraphs: [
          'Discounted payback measures how many years elapse until cumulative discounted net cash flow (Σ net_pv) becomes permanently non-negative.',
          'To avoid false early payback caused by late refresh spikes (for example COST-LIFE-01 in Year 4), the engine walks backwards to locate the last negative cumulative PV year and linearly interpolates within the crossing year:',
        ],
        formula:
          'payback_year = last_negative_year + (-cumulative_net_pv[last_negative_year] / net_pv[crossing_year])',
        table: {
          headers: ['Cumulative PV State', 'Payback Result', 'Interpretation'],
          rows: [
            ['Already >= 0 in Year 1', 'pv_cost[1] / pv_benefit[1] (<= 1.0)', 'Fractional Year-1 breakeven'],
            ['Turns >= 0 permanently in Year t', 't - 1 + fractional crossing', 'Exact interpolated discounted payback'],
            ['Remains < 0 at Horizon end', 'No payback (null)', 'Costs exceed benefits inside horizon'],
            ['Zero PV Costs & positive Benefits', 'Immediate (0.0)', 'No discounted outlay required'],
          ],
        },
      },
    ],
  },
  {
    slug: 'ramps',
    title: 'Realization Ramps & Timing',
    subtitle:
      'Control when costs hit and how gradually benefits materialize across start_year..end_year.',
    sections: [
      {
        heading: 'Active Window & Normalization Rules',
        paragraphs: [
          'Each line item specifies start_year and end_year (inclusive, bounded within 1..horizon_years). Outside [start_year, end_year], cash flow is $0. Inside the active span, the selected ramp profile scales annual realization from 0.0 to 1.0.',
        ],
        table: {
          headers: ['Ramp Profile', '5-Year Span Multipliers (Y1..Y5)', 'Best Suited For'],
          rows: [
            ['immediate', '1.00 · 1.00 · 1.00 · 1.00 · 1.00', 'SaaS licenses, cloud run rates, fixed annual savings once live'],
            ['linear', '0.20 · 0.40 · 0.60 · 0.80 · 1.00', 'Steady rollout across business units or gradual defect reduction'],
            ['s_curve', '0.05 · 0.19 · 0.52 · 0.86 · 1.00', 'Org-wide workflow adoption, self-service platform reuse'],
            ['custom_weights', 'User weights (auto-normalized if max > 1)', 'Two-wave builds (e.g., [1.0, 0.35]), phased cutovers'],
          ],
        },
      },
      {
        heading: 'Exact S-Curve & Custom Weights Formulas',
        paragraphs: [
          'For multi-year s_curve spans, the engine evaluates a logistic sigmoid centered at the midpoint and divides by the final year value so the final active year always reaches 100% (1.0):',
        ],
        formula:
          'x = np.linspace(0.0, 1.0, span)\nraw = 1.0 / (1.0 + exp(-6.0 * (x - 0.5)))\nprofile = raw / raw[-1]',
        callout:
          'When modeling phased delivery with custom_weights, you can enter raw fractions directly (such as [1.0, 0.35] for Year 1 heavy build and Year 2 stabilization) or relative weights like [60, 100], which automatically normalize to [0.60, 1.00].',
      },
    ],
  },
  {
    slug: 'uncertainty',
    title: 'Monte Carlo, Correlation & Guardrails',
    subtitle:
      'Vectorized 10,000-trial uncertainty simulation, Gaussian copula dependency modeling, and anti-double-counting checks.',
    sections: [
      {
        heading: 'Choosing the Right Probability Distribution',
        paragraphs: [
          'Both individual parameters and an overall item_multiplier (base 1.0x) can vary stochastically. Every sampled parameter respects the catalog bounds [min_value, max_value] via clamping so ratios like adoption_rate never exceed 1.0.',
        ],
        table: {
          headers: ['Distribution', 'Shape & Parameters', 'Recommended Use Cases'],
          rows: [
            ['fixed', 'Deterministic point value', 'Contracted fixed-fee quotes or known unit rates'],
            ['pert', 'Smooth beta curve bounded by [low, mode, high]', 'Adoption rates, realization factors, bounded engineering hours'],
            ['triangular', 'Piecewise linear [low, mode, high]', 'Early scoping ranges, reuse probabilities, compliance penalties'],
            ['normal', 'Symmetric bell curve around base (std or std_pct)', 'Cloud run variability, labor hourly rates, audit hours'],
            ['lognormal', 'Positive right-skewed tail (std or std_pct)', 'Incident costs, software build overruns, tail outage severity'],
          ],
        },
      },
      {
        heading: 'Gaussian Copula Correlation Groups',
        paragraphs: [
          'Independent sampling understates portfolio risk when multiple items succeed or slip together (for instance, low developer adoption reducing Toil, Incident Avoidance, and Platform Reuse simultaneously).',
          'Assigning items or parameters to a shared correlation_group (such as "adoption" or "delivery_effort") with correlation strength rho constructs correlated latent draws:',
        ],
        formula: 'z_corr = sign(rho) * sqrt(|rho|) * z_group + sqrt(1 - |rho|) * eps',
        bullets: [
          'Positive rho (+0.60 to +0.85) links co-moving drivers — e.g., build hours and vendor integration rising together during scope creep.',
          'Spearman rank correlation on the Monte Carlo dashboard decomposes NPV variance into the top Sensitivity Drivers, showing which assumption creates the largest risk.',
          'Anti-Double-Count Guardrails: Sharing an anti_double_count_tag across two or more benefit items triggers an explicit review banner on the Deterministic Overview and Reports — useful whenever BEN-TOIL-01 and BEN-FLOW-01 touch the same team.',
        ],
      },
      {
        heading: 'What-If Inputs & Scenario Stress Testing',
        paragraphs: [
          'The Monte Carlo Certainty dashboard exposes six interactive simulation and What-If controls so teams can run downside/upside sensitivity shocks and compare scenarios without altering the initiative’s saved baseline assumptions.',
          'Clicking Reset What-If Sliders restores the discount rate to the initiative’s saved baseline and resets all three scale factors to 1.00×. Every persisted run records its parameters in Saved Simulation History for side-by-side comparison.',
        ],
        table: {
          headers: ['What-If Control', 'Range & Default', 'What It Does & Simulation Impact'],
          rows: [
            [
              'Simulation Iterations',
              '1,000 – 50,000 (default 10,000; API min 100)',
              'Sets the number of vectorized Monte Carlo trials N. Higher iterations tighten sampling error on tail percentiles (P5, P10, P90, P95), smooth NPV histogram bins, and stabilize Spearman sensitivity rankings at modest compute cost.',
            ],
            [
              'Random Seed',
              '0 – 2,147,483,647 or blank (default 42)',
              'Seeds NumPy’s default_rng(seed) generator. Keeping a constant seed reproduces identical underlying draws across runs so deltas reflect only your What-If shocks rather than random noise. Leave blank for fresh random draws.',
            ],
            [
              'What-If Discount Rate (%)',
              '0.0% – 50.0% (defaults to initiative rate)',
              'Temporarily overrides the initiative hurdle rate r in discount_factor(t) = 1 / (1 + r)^t for both the deterministic baseline comparison and every simulated trial. Higher rates discount late Years 3–7 benefits more steeply than Year 1 build costs, shifting NPV left, lowering BCR, and lengthening payback.',
            ],
            [
              'Uncertainty Spread Scale',
              '0.00× – 2.50× (default 1.00×; API max 3.00×)',
              'Multiplies the dispersion of all stochastic distributions while holding base/mode fixed. At 0.00×, all stochastic inputs collapse to their deterministic base values (zero variance). Normal/Lognormal multiply sigma by the scale; Triangular/PERT stretch bounds symmetrically around mode (mode ± half_span × scale), still clamped to catalog [min_value, max_value]. Values > 1.0× widen the P10–P90 fan to stress-test estimation overconfidence.',
            ],
            [
              'What-If Benefit Scale',
              '0.50× – 1.50× (default 1.00×; API 0.00× – 3.00×)',
              'Applies a uniform multiplicative shock to every benefit line item’s annual value (max(0, sim_annual) × benefit_scale) across both deterministic and simulated trials. For example, 0.80× models a 20% portfolio-wide benefit shortfall, shifting the entire NPV distribution downward and reducing P(NPV > $0) and P(BCR >= 1.0x).',
            ],
            [
              'What-If Cost Scale',
              '0.70× – 1.50× (default 1.00×; API 0.00× – 3.00×)',
              'Applies a uniform multiplicative shock to every cost line item’s annual value (max(0, sim_annual) × cost_scale) across both deterministic and simulated trials. For example, 1.25× simulates a 25% delivery and run cost overrun, shifting NPV downward, compressing BCR, and delaying cumulative breakeven.',
            ],
          ],
        },
        formula:
          'item_annual(trial) = max(0, formula(sampled_params) * sampled_multiplier) * (cost_scale | benefit_scale)\nitem_pv(trial)     = sum_t [ item_annual(trial) * ramp(t) / (1 + discount_rate_override)^t ]',
        bullets: [
          'Combined Downside Stress Test: Pair Benefit Scale = 0.80×, Cost Scale = 1.25×, and Uncertainty Spread = 1.50× with a fixed Random Seed (e.g., 42) to verify whether P50 NPV stays positive and P(NPV > $0) clears your governance floor (typically 70%–80%) under severe execution headwinds.',
          'Deterministic Sanity Check (Spread = 0.00×): Setting Uncertainty Spread Scale to 0.00× collapses all draws to a single point matching the scaled deterministic NPV — ideal for checking Benefit/Cost/Discount shocks before re-introducing variance.',
          'Non-Destructive Overrides: What-If controls never mutate your saved initiative assumptions or line-item specs; update baseline fields in Initiatives & Assumptions only when committing a new permanent forecast.',
        ],
        callout:
          'Catalog physical bounds ([min_value, max_value]) remain strictly enforced even when Uncertainty Spread Scale exceeds 1.0×, so probability ratios such as adoption_rate or risk_reduction_pct are always clamped within [0.0, 1.0].',
      },
    ],
  },
  {
    slug: 'odata',
    title: 'OData v4 Analytics & BI Feed',
    subtitle:
      'Extract initiatives, cost/benefit line items, yearly cash flows, value streams, catalog templates, and simulation history directly into Power BI, Excel, and external ETL tools.',
    sections: [
      {
        heading: 'Service Endpoints & Authentication',
        paragraphs: [
          'ValueStream BCA exposes an OASIS OData v4.0 compliant read-only feed at /odata/v4 (with an identical alias at /odata) and a full CSDL XML schema document at /odata/v4/$metadata.',
          'Authentication mirrors the OpenAI gateway: when zero inbound API keys exist, the feed allows direct local and LAN access. Once at least one API key is created under Admin Portal → Gateway & API Keys, clients must supply it via Authorization: Bearer <key>, HTTP Basic Auth (API key entered as either Username or Password for native Power BI and Excel support), or X-API-Key.',
        ],
        table: {
          headers: ['Entity Set', 'Granularity & Key', 'Key Fields & Relationships'],
          rows: [
            ['Initiatives', 'One row per initiative (Id)', 'Name, Domain, HorizonYears, DiscountRate, CostStartYear, CostEndYear, ExternalResourceUrl, PvCosts, PvBenefits, Npv, Bcr, DiscountedPaybackYear, LatestSim* · Nav: CostBenefitItems, YearlyCashFlows, ValueStreams, SimulationRuns'],
            ['CostBenefitItems', 'One row per line item (Id)', 'InitiativeId, InitiativeName, CatalogId, Kind (cost/benefit), Label, ValueStream, StartYear, EndYear, CalendarStartYear, CalendarEndYear, RampProfile, BaseAnnualValue, PvTotal, SignedPvTotal, AntiDoubleCountTag, ParametersJson, UncertaintyJson · Nav: Initiative, CatalogEntry'],
            ['YearlyCashFlows', 'One row per initiative year (Id)', 'InitiativeId, Year, CalendarYear, UndiscountedCost, UndiscountedBenefit, NetUndiscounted, PvCost, PvBenefit, NetPv, CumulativeUndiscountedNet, CumulativeNetPv · Nav: Initiative'],
            ['ValueStreams', 'One row per initiative value stream (Id)', 'InitiativeId, ValueStream, ItemCount, PvCosts, PvBenefits, Npv, Bcr · Nav: Initiative'],
            ['CatalogEntries', 'One row per template (Id)', 'Kind, Name, Domains, ValueStreamStage, FormulaType, FormulaDescription, GuardrailNotes, IsBuiltin'],
            ['SimulationRuns', 'One row per persisted MC run (Id)', 'InitiativeId, NSimulations, DiscountRate, HorizonYears, Seed, ProbNpvPositive, ProbBcrGte1, NpvMean, NpvP10, NpvP50, NpvP90, BcrP50, DurationMs · Nav: Initiative'],
          ],
        },
      },
      {
        heading: 'Supported OData v4 Query Options',
        paragraphs: [
          'Filter, sort, project, paginate, and join initiatives with their cost and benefit line items server-side using standard OData v4 query string parameters:',
        ],
        formula:
          '/odata/v4/CostBenefitItems?$filter=Kind eq \'benefit\' and PvTotal gt 100000&$select=InitiativeName,Label,ValueStream,PvTotal&$orderby=PvTotal desc\n/odata/v4/Initiatives?$expand=CostBenefitItems($filter=Kind eq \'cost\';$select=Label,PvTotal)&$count=true',
        bullets: [
          '$filter: Supports eq, ne, gt, ge, lt, le, and, or, not, parentheses, null checks, plus string functions contains(), startswith(), endswith(), tolower(), toupper(), length().',
          '$select & $orderby: Project specific columns to keep Power BI / Excel refreshes fast and sort ascending or descending across multiple fields.',
          '$expand & Navigation Paths: Expand child collections inline with nested $filter/$select/$orderby/$top, or fetch /Initiatives(\'{id}\')/CostBenefitItems directly.',
          '$top, $skip & $count: Paginate large extracts (default page size 1,000 with @odata.nextLink) or append /$count for scalar row counts.',
        ],
        callout:
          'You can test live queries and copy pre-built Power BI / Power Query (M) / cURL snippets directly inside Admin Portal → OData Data Feed.',
      },
    ],
  },
];

export const CATALOG_ITEM_DOCS: Record<string, CatalogItemDoc> = {
  'COST-BUILD-01': {
    id: 'COST-BUILD-01',
    headline: 'Captures non-recurring internal engineering labor and external vendor/contractor build outlays.',
    whatItMeasures:
      'COST-BUILD-01 quantifies the capital and implementation effort required to architect, integrate, test, and deploy a solution into production. It blends internal engineering hours at a loaded labor rate with external consulting, contractor, or turnkey integration fees.',
    economicRationale:
      'Build expenditure forms the primary denominator of Return on Investment and drives early negative cumulative cash flow. Separating upfront build from steady-state run ensures capital intensity is visible without inflating recurring operational baseline projections.',
    whenToUse: [
      'Software engineering, API integration, ETL/pipeline construction, and automated workflow orchestration.',
      'Cloud landing-zone setup, infrastructure-as-code migration waves, and datacenter cutover projects.',
      'External SI/vendor fixed-fee statements of work paired with internal oversight engineering.',
    ],
    whenNotToUse: [
      {
        text: 'Steady-state cloud hosting, SaaS subscriptions, and Tier-2/3 SRE on-call operations belong in Recurring Hosting & Support.',
        linkSlug: 'COST-RUN-01',
        linkLabel: 'View COST-RUN-01',
      },
      {
        text: 'User workshops, training curricula, documentation, and organizational cutover belong in Enablement & Change Management.',
        linkSlug: 'COST-ENAB-01',
        linkLabel: 'View COST-ENAB-01',
      },
      {
        text: 'Periodic multi-year hardware replacements or major version upgrades in Years 3–10 belong in Lifecycle Refresh.',
        linkSlug: 'COST-LIFE-01',
        linkLabel: 'View COST-LIFE-01',
      },
    ],
    formulaPlainEnglish:
      'Annual base build outlay equals internal engineering hours multiplied by blended hourly rate, plus annual external vendor or implementation fees.',
    parameterGuidance: {
      hours: {
        guidance: 'Total active engineering, architecture, QA, and release hours for a 100% build year.',
        typicalRange: '400 – 4,000 hrs/yr',
        dataSource: 'Engineering sprint capacity plans, Jira story-point velocity, historical build actuals.',
      },
      hourly_rate: {
        guidance: 'Loaded internal cost per hour including salary, benefits, and payroll burden (not billing markup).',
        typicalRange: '$115 – $185 / hr',
        dataSource: 'Finance FP&A standard engineering blended labor rate table.',
      },
      vendor_cost: {
        guidance: 'External SOW milestones, boutique specialists, or vendor setup/onboarding fees during build.',
        typicalRange: '$0 – $250,000 / yr',
        dataSource: 'Procurement SOW quotes or vendor implementation proposals.',
      },
    },
    modelingTips: {
      schedule: 'Typically Y1 only for small automations, or Y1–Y2 for multi-quarter platform/migration programs.',
      ramp: 'Use custom_weights (e.g., [1.0, 0.35] for main build + Y2 stabilization, or [0.6, 1.0] for dual-wave migrations).',
      uncertainty: 'Use PERT (-15% / +40%) or right-skewed Lognormal (std 25%–30%) on hours to reflect software estimation optimism bias.',
      correlation: 'Group hours and vendor_cost under delivery_effort (rho ≈ 0.70) so scope expansion pushes both upward together.',
    },
    guardrailDeepDive: [
      'Avoid leaving COST-BUILD-01 active across the entire 5–10 year horizon; scope end_year strictly to active implementation.',
      'Do not hide ongoing maintenance bugs or feature enhancements here; transition steady-state SRE hours to COST-RUN-01.',
      'Use loaded internal cost rather than fully burdened commercial consulting rates unless contractors supply the hours.',
    ],
    examples: [
      {
        id: 'build-ex-platform',
        title: 'Core CI/CD & Platform Build (Two-Year Tail)',
        domain: 'software',
        valueStream: 'Software Delivery',
        summary:
          'An engineering team builds shared CI/CD templates and runbook automation across Year 1 (full sprint allocation) and Year 2 stabilization (35% weight via custom_weights).',
        horizonYears: 5,
        discountRate: 0.07,
        startYear: 1,
        endYear: 2,
        rampProfile: 'custom_weights',
        rampWeights: [1.0, 0.35],
        paramValues: { hours: 1400, hourly_rate: 145, vendor_cost: 45000 },
        uncertaintySummary: 'PERT (-15%/+40%) on hours and Triangular (-10%/+30%) on vendor_cost in delivery_effort group (rho = 0.75).',
        uncertaintySpec: {
          correlation_group: 'delivery_effort',
          correlation_rho: 0.75,
          parameters: {
            hours: { distribution: 'pert', low_pct: -0.15, high_pct: 0.4 },
            vendor_cost: { distribution: 'triangular', low_pct: -0.1, high_pct: 0.3 },
          },
        },
      },
      {
        id: 'build-ex-migration',
        title: 'Two-Wave Cloud Migration & Cutover',
        domain: 'infrastructure',
        valueStream: 'Core Infrastructure',
        summary:
          'A datacenter modernization splits effort across Wave 1 readiness in Year 1 (0.60) and peak workload cutover in Year 2 (1.00) at an 8% discount rate.',
        horizonYears: 7,
        discountRate: 0.08,
        startYear: 1,
        endYear: 2,
        rampProfile: 'custom_weights',
        rampWeights: [0.6, 1.0],
        paramValues: { hours: 2400, hourly_rate: 155, vendor_cost: 110000 },
        uncertaintySummary: 'Lognormal (std 30%) on hours and PERT (-10%/+55%) on vendor_cost reflecting migration discovery risk.',
        uncertaintySpec: {
          correlation_group: 'migration_risk',
          correlation_rho: 0.75,
          parameters: {
            hours: { distribution: 'lognormal', std_pct: 0.3 },
            vendor_cost: { distribution: 'pert', low_pct: -0.1, high_pct: 0.55 },
          },
        },
      },
    ],
  },

  'COST-RUN-01': {
    id: 'COST-RUN-01',
    headline: 'Captures recurring annual cloud compute, software licensing, and steady-state SRE/support labor.',
    whatItMeasures:
      'COST-RUN-01 models the incremental ongoing operating cost (OpEx) needed to keep the new platform, automation tool, or cloud workload healthy every year across its useful life.',
    economicRationale:
      'Even high-ROI automations rarely cost zero to operate. Neglecting SaaS renewals, observability ingest, and patch/support labor artificially inflates long-term BCR and masks breakeven erosion over 5–10 year horizons.',
    whenToUse: [
      'Incremental AWS/GCP/Azure compute, storage, network egress, and observability cluster spend.',
      'Annual enterprise SaaS, RPA bot licenses, or third-party API consumption fees.',
      'Dedicated Tier-2/3 support, dependency patching, and on-call SRE hours required post-launch.',
    ],
    whenNotToUse: [
      {
        text: 'One-time initial integration engineering and contractor build belongs in Build, Integration & Deployment.',
        linkSlug: 'COST-BUILD-01',
        linkLabel: 'View COST-BUILD-01',
      },
      {
        text: 'CapEx hardware swaps or multi-year platform rewrites belong in Lifecycle Refresh & Decommissioning.',
        linkSlug: 'COST-LIFE-01',
        linkLabel: 'View COST-LIFE-01',
      },
    ],
    formulaPlainEnglish:
      'Annual operating cost equals annual cloud/infrastructure spend plus annual software/SaaS licensing plus annual support hours times support hourly rate.',
    parameterGuidance: {
      annual_infra_cost: {
        guidance: 'Incremental net cloud or colocation run cost (minus any immediately retired compute if netted, or model retirement cleanly).',
        typicalRange: '$10,000 – $120,000 / yr',
        dataSource: 'Cloud pricing calculators, FinOps unit economics, staging telemetry benchmarks.',
      },
      annual_license_cost: {
        guidance: 'Recurring commercial software subscriptions, per-seat orchestration fees, or enterprise support contracts.',
        typicalRange: '$0 – $85,000 / yr',
        dataSource: 'Procurement vendor quotes and multi-year EA rate cards.',
      },
      support_hours_per_year: {
        guidance: 'Steady-state maintenance: upgrades, ticket escalations, certificate rotation, and vendor coordination (~0.1–0.4 FTE).',
        typicalRange: '120 – 800 hrs/yr',
        dataSource: 'SRE service ownership run-rate benchmarks.',
      },
      hourly_rate: {
        guidance: 'Loaded hourly labor rate for operations/SRE engineers maintaining the service.',
        typicalRange: '$110 – $165 / hr',
        dataSource: 'Finance FP&A operations rate card.',
      },
    },
    modelingTips: {
      schedule: 'Start in Y1 if sandboxes/licenses are procured early, or Y2 if hosting begins after build cutover; run through horizon_years.',
      ramp: 'Usually immediate, or custom_weights [0.5, 1.0, 1.0, ...] when environments scale up partway through Year 1.',
      uncertainty: 'Normal (15%–25% std) on annual_infra_cost captures usage elasticity; PERT captures license tier growth or support creep.',
      correlation: 'Optionally link annual_infra_cost positively to benefit adoption if more usage triggers both value and compute.',
    },
    guardrailDeepDive: [
      'Ensure support_hours_per_year covers steady-state operations only — do not double-count Year 1 implementation sprints from COST-BUILD-01.',
      'Check net vs. gross infrastructure: if replacing an older paid tool, state clearly whether annual_infra_cost is incremental net spend.',
    ],
    examples: [
      {
        id: 'run-ex-sre',
        title: 'Cloud Observability & SRE Run Stack',
        domain: 'operations',
        valueStream: 'Incident Response',
        summary:
          'Steady-state production observability cluster, workflow engine licensing, and ~0.16 FTE of SRE maintenance active across a 5-year horizon.',
        horizonYears: 5,
        discountRate: 0.07,
        startYear: 1,
        endYear: 5,
        rampProfile: 'immediate',
        paramValues: {
          annual_infra_cost: 28000,
          annual_license_cost: 18000,
          support_hours_per_year: 320,
          hourly_rate: 135,
        },
        uncertaintySummary: 'Normal (std 15%) on annual_infra_cost and PERT (-20%/+35%) on support_hours_per_year.',
        uncertaintySpec: {
          parameters: {
            annual_infra_cost: { distribution: 'normal', std_pct: 0.15 },
            support_hours_per_year: { distribution: 'pert', low_pct: -0.2, high_pct: 0.35 },
          },
        },
      },
      {
        id: 'run-ex-rpa',
        title: 'Enterprise RPA Orchestration Run Rate',
        domain: 'automation',
        valueStream: 'Finance & Billing',
        summary:
          'Annual runner compute, unattended bot licensing, and operations support starting in Year 2 once build completes, discounted at 6%.',
        horizonYears: 5,
        discountRate: 0.06,
        startYear: 2,
        endYear: 5,
        rampProfile: 'immediate',
        paramValues: {
          annual_infra_cost: 14000,
          annual_license_cost: 22000,
          support_hours_per_year: 180,
          hourly_rate: 125,
        },
        uncertaintySummary: 'Normal (std 25%) on infra and PERT (-10%/+45%) on license cost for bot volume tiering.',
        uncertaintySpec: {
          correlation_group: 'ops_cost',
          correlation_rho: 0.6,
          parameters: {
            annual_infra_cost: { distribution: 'normal', std_pct: 0.25 },
            annual_license_cost: { distribution: 'pert', low_pct: -0.1, high_pct: 0.45 },
          },
        },
      },
    ],
  },

  'COST-ENAB-01': {
    id: 'COST-ENAB-01',
    headline: 'Models staff training opportunity time, documentation, and organizational change management outlays.',
    whatItMeasures:
      'COST-ENAB-01 accounts for the human adoption investment required so teams actually use a new system: staff workshop hours (valued at their loaded rate) plus enablement collateral, trainers, and cutover communications.',
    economicRationale:
      'Business cases frequently assume 80%–90% adoption rates in BEN-TOIL-01 or BEN-FLOW-01 while budgeting zero time for end users to learn the workflow. Explicitly pricing enablement makes high adoption credible to finance reviewers.',
    whenToUse: [
      'Cross-organization rollouts affecting dozens or hundreds of engineers, analysts, or operations specialists.',
      'Parallel-run workflow transition periods, playbook authoring, and hands-on clinic sessions.',
      'External change-management coaching or training platform modules.',
    ],
    whenNotToUse: [
      {
        text: 'Core platform coding, API wiring, and deployment belong in Build, Integration & Deployment.',
        linkSlug: 'COST-BUILD-01',
        linkLabel: 'View COST-BUILD-01',
      },
      {
        text: 'Annual recurring onboarding for steady-state new hires can be absorbed in Run support if ongoing.',
        linkSlug: 'COST-RUN-01',
        linkLabel: 'View COST-RUN-01',
      },
    ],
    formulaPlainEnglish:
      'Annual enablement cost equals training hours per person times affected staff count times participant hourly rate, plus change program and materials spend.',
    parameterGuidance: {
      training_hours: {
        guidance: 'Average structured workshop, self-paced lab, and shadowed cutover hours per affected employee.',
        typicalRange: '4 – 24 hrs/person',
        dataSource: 'Enablement curriculum plan or previous tool rollout retrospectives.',
      },
      affected_staff: {
        guidance: 'Headcount changing their daily workflow because of the initiative.',
        typicalRange: '20 – 300 people',
        dataSource: 'HR/department roster of target user personas.',
      },
      hourly_rate: {
        guidance: 'Loaded hourly opportunity cost rate of the participating staff cohort.',
        typicalRange: '$65 – $135 / hr',
        dataSource: 'FP&A departmental blended wage rate.',
      },
      transition_cost: {
        guidance: 'Instructional design, trainer fees, documentation portals, town halls, and floor-support materials.',
        typicalRange: '$5,000 – $50,000 / yr',
        dataSource: 'L&D / Change Management program budget.',
      },
    },
    modelingTips: {
      schedule: 'Align strictly with rollout waves — typically Y1 only, or Y1–Y2 across phased department rollouts.',
      ramp: 'Immediate for single-year rollouts; custom_weights (e.g., [0.7, 0.3]) for two-wave deployments.',
      uncertainty: 'Item multiplier Triangular (0.80, 1.0, 1.30) cleanly captures rollout schedule stretch or extra refresher workshops.',
      correlation: 'Group under delivery_effort with COST-BUILD-01 when launch complexity drives both build and training effort.',
    },
    guardrailDeepDive: [
      'Any benefit claiming >75% adoption_rate should generally pair with an explicit COST-ENAB-01 item covering the impacted teams.',
      'Include participant opportunity hours transparently; Finance reviews often check whether training time was hand-waved.',
    ],
    examples: [
      {
        id: 'enab-ex-dev',
        title: 'Developer Platform Onboarding Program',
        domain: 'software',
        valueStream: 'Capability Enablement',
        summary:
          'One-year Year-1 onboarding wave training 60 product engineers for 10 hours each with workshops and internal documentation templates.',
        horizonYears: 5,
        discountRate: 0.07,
        startYear: 1,
        endYear: 1,
        rampProfile: 'immediate',
        paramValues: {
          training_hours: 10,
          affected_staff: 60,
          hourly_rate: 95,
          transition_cost: 18000,
        },
        uncertaintySummary: 'Item multiplier Triangular (0.85, 1.00, 1.30) in delivery_effort group (rho = 0.65).',
        uncertaintySpec: {
          correlation_group: 'delivery_effort',
          correlation_rho: 0.65,
          item_multiplier: { distribution: 'triangular', low: 0.85, mode: 1.0, high: 1.3 },
          parameters: {},
        },
      },
      {
        id: 'enab-ex-ops',
        title: 'Two-Wave Finance & Order Operations Cutover',
        domain: 'operations',
        valueStream: 'Order Operations',
        summary:
          'Rolling training across 120 order-ops and AP specialists split 70% in Year 1 and 30% in Year 2 via custom_weights.',
        horizonYears: 5,
        discountRate: 0.06,
        startYear: 1,
        endYear: 2,
        rampProfile: 'custom_weights',
        rampWeights: [0.7, 0.3],
        paramValues: {
          training_hours: 8,
          affected_staff: 120,
          hourly_rate: 75,
          transition_cost: 20000,
        },
        uncertaintySummary: 'Item multiplier Triangular (0.80, 1.00, 1.35) reflecting regional refresher workshops.',
        uncertaintySpec: {
          item_multiplier: { distribution: 'triangular', low: 0.8, mode: 1.0, high: 1.35 },
          parameters: {},
        },
      },
    ],
  },

  'COST-LIFE-01': {
    id: 'COST-LIFE-01',
    headline: 'Models periodic hardware replacements, major platform upgrades, tech-debt remediation, or retirement spikes.',
    whatItMeasures:
      'COST-LIFE-01 prevents "infinite asset life" optimism in 6–10 year business cases by embedding scheduled refresh reserves (refresh_cost / refresh_interval_years) or discrete one-year upgrade/decommissioning spikes.',
    economicRationale:
      'Physical switches/servers age out every 3–5 years, and major software frameworks require periodic breaking-version upgrades or eventual decommissioning. Amortizing a lifecycle reserve—or placing a spike in Year 4—gives CFOs an honest total cost of ownership.',
    whenToUse: [
      'Hardware/edge appliance refresh cycles on 7–10 year infrastructure modernizations.',
      'Major framework re-platforming, Kubernetes LTS leaps, or data-store version migrations mid-horizon.',
      'End-of-life legacy system decommissioning and data-archival projects.',
    ],
    whenNotToUse: [
      {
        text: 'Routine weekly patching and small support tickets belong in Recurring Hosting, Licensing & Support.',
        linkSlug: 'COST-RUN-01',
        linkLabel: 'View COST-RUN-01',
      },
      {
        text: 'Initial Year-1 greenfield implementation belongs in Build, Integration & Deployment.',
        linkSlug: 'COST-BUILD-01',
        linkLabel: 'View COST-BUILD-01',
      },
    ],
    formulaPlainEnglish:
      'Annualized lifecycle reserve equals refresh cost divided by refresh interval years (clamped to >= 1.0 year). Setting refresh_interval_years = 1 for a single-year span models a lump-sum event.',
    parameterGuidance: {
      refresh_cost: {
        guidance: 'Total capital/labor cost of one full refresh cycle or decommissioning event.',
        typicalRange: '$35,000 – $300,000',
        dataSource: 'Hardware vendor lifecycle quotes or historical major upgrade retrospectives.',
      },
      refresh_interval_years: {
        guidance: 'Years between cycles when amortizing continuously, or set to 1.0 when modeling a discrete single-year spike (start_year == end_year).',
        typicalRange: '1 – 5 years',
        dataSource: 'IT asset depreciation schedule or EOSL (End of Support Life) roadmap.',
      },
    },
    modelingTips: {
      schedule: 'Choose either amortized reserves across operating years (e.g., Y3–Y10, interval 4) OR a lump spike (Y4–Y4, interval 1).',
      ramp: 'Almost always immediate across the chosen reserve/spike years.',
      uncertainty: 'Triangular (e.g., 0.7x / 1.0x / 1.55x) on refresh_cost reflects future hardware/vendor pricing drift.',
      correlation: 'Often left independent, or mildly tied to migration_risk if decommissioning hinges on legacy complexity.',
    },
    guardrailDeepDive: [
      'Never set both refresh_interval_years = 4 AND start_year = end_year = 4 — that would only charge 1/4th of the refresh cost once.',
      'Either amortize (e.g. $120K / 4 yrs = $30K/yr over Y3–Y10) OR charge the full spike once ($95K / 1 yr in Y4–Y4).',
    ],
    examples: [
      {
        id: 'life-ex-reserve',
        title: 'Amortized Edge Hardware Refresh Reserve (10-Yr)',
        domain: 'infrastructure',
        valueStream: 'Reliability & Resilience',
        summary:
          'Annualized $30K/yr reserve ($120K cycle every 4 years) funded across Years 3–10 of a 10-year datacenter modernization.',
        horizonYears: 10,
        discountRate: 0.08,
        startYear: 3,
        endYear: 10,
        rampProfile: 'immediate',
        paramValues: { refresh_cost: 120000, refresh_interval_years: 4 },
        uncertaintySummary: 'Triangular ($85K, $120K, $185K) on refresh_cost reflecting hardware price volatility.',
        uncertaintySpec: {
          parameters: {
            refresh_cost: { distribution: 'triangular', low: 85000, mode: 120000, high: 185000 },
          },
        },
      },
      {
        id: 'life-ex-spike',
        title: 'Discrete Year-4 Major Platform Upgrade Spike',
        domain: 'software',
        valueStream: 'Software Delivery',
        summary:
          'Single-year Year-4 re-platforming and LTS migration modeled with refresh_interval_years = 1 and start_year = end_year = 4.',
        horizonYears: 6,
        discountRate: 0.07,
        startYear: 4,
        endYear: 4,
        rampProfile: 'immediate',
        paramValues: { refresh_cost: 95000, refresh_interval_years: 1 },
        uncertaintySummary: 'Triangular ($70K, $95K, $145K) on refresh_cost.',
        uncertaintySpec: {
          parameters: {
            refresh_cost: { distribution: 'triangular', low: 70000, mode: 95000, high: 145000 },
          },
        },
      },
    ],
  },

  'BEN-TOIL-01': {
    id: 'BEN-TOIL-01',
    headline: 'Quantifies recovered labor capacity from automating repetitive manual workflows, discounted for real-world realization.',
    whatItMeasures:
      'BEN-TOIL-01 calculates the economic value of repetitive manual tasks eliminated (such as manual deployments, ticket triage, invoice entry, or environment provisioning), tempered explicitly by organizational adoption_rate and capacity realization_factor.',
    economicRationale:
      'A classic BCA trap is assuming "saving 10 minutes per ticket equals 100% headcount cost reduction." In reality, fragmented time savings do not convert 1:1 into higher-value output or avoided hiring. Multiplying by realization_factor (typically 0.65–0.80) makes labor capacity claims credible.',
    whenToUse: [
      'CI/CD automation, self-service developer portals, runbook remediation, or automated access provisioning.',
      'Back-office RPA / API orchestration removing repetitive data entry, invoice matching, or exception triage.',
      'Support workflows where average handle time drops across thousands of recurring events per year.',
    ],
    whenNotToUse: [
      {
        text: 'Revenue acceleration or faster customer order fulfillment beyond saved staff minutes belongs in Cycle-Time & Throughput Acceleration.',
        linkSlug: 'BEN-FLOW-01',
        linkLabel: 'View BEN-FLOW-01',
      },
      {
        text: 'Avoided outage downtime costs, SLA credits, or corrupted shipments belong in Defect, Rework & Incident Avoidance.',
        linkSlug: 'BEN-QUAL-01',
        linkLabel: 'View BEN-QUAL-01',
      },
      {
        text: 'Compliance and SOX/SOC-2 audit prep hours are better separated under Compliance, Audit & Risk Reduction.',
        linkSlug: 'BEN-COMP-01',
        linkLabel: 'View BEN-COMP-01',
      },
    ],
    formulaPlainEnglish:
      'Annual realized toil value equals annual events times hours saved per event (minutes / 60) times loaded hourly rate times adoption rate times capacity realization factor.',
    parameterGuidance: {
      events_per_year: {
        guidance: 'Annual volume of repetitive manual events addressed by automation.',
        typicalRange: '1,000 – 50,000 events/yr',
        dataSource: 'ITSM ticket exports, CI build logs, ERP transaction counts.',
      },
      minutes_saved_per_event: {
        guidance: 'Measured reduction in active human touch time per event (exclude passive wait/queue time — model wait value in BEN-FLOW-01).',
        typicalRange: '5 – 45 min/event',
        dataSource: 'Time-and-motion studies, 2-week engineer toil diaries, pilot timings.',
      },
      hourly_rate: {
        guidance: 'Loaded hourly wage rate of the role currently executing the manual work.',
        typicalRange: '$55 – $140 / hr',
        dataSource: 'FP&A departmental loaded labor rate.',
      },
      adoption_rate: {
        guidance: 'Steady-state share of eligible workflows/teams actually using the automation [0, 1].',
        typicalRange: '0.65 – 0.90',
        dataSource: 'Historical internal platform adoption benchmarks.',
      },
      realization_factor: {
        guidance: 'Fraction of saved labor hours actually redeployed to productive backlog work or avoided hiring [0, 1].',
        typicalRange: '0.60 – 0.85',
        dataSource: 'Finance realization haircut policy (typically 0.70–0.75 conservative default).',
      },
    },
    modelingTips: {
      schedule: 'Begin in Y2 (after Y1 build/enablement) or partway through Y1; run to horizon_years.',
      ramp: 'Prefer s_curve for organic developer/team adoption or linear for phased BU onboarding.',
      uncertainty: 'Put PERT distributions on adoption_rate and realization_factor — these typically dominate sensitivity.',
      correlation: 'Group adoption_rate under a shared adoption factor (rho = 0.70–0.80) across co-dependent benefits.',
    },
    guardrailDeepDive: [
      'Always keep realization_factor strictly below 1.0 (e.g., 0.70–0.80) unless eliminating dedicated contract/BPO spend 1-for-1.',
      'Tag both BEN-TOIL-01 and BEN-FLOW-01 with the same anti_double_count_tag (e.g. eng-capacity) if faster cycles merely re-count the same saved labor hours.',
      'Do not include idle queue waiting time inside minutes_saved_per_event; count active touch time only.',
    ],
    examples: [
      {
        id: 'toil-ex-cicd',
        title: 'CI/CD Pipeline & Runbook Toil Elimination',
        domain: 'software',
        valueStream: 'Software Delivery',
        summary:
          'Automating 12,000 annual manual environment checks and deploy handoffs (22 min each) across engineering teams from Year 2 to Year 5 via an S-curve rollout.',
        horizonYears: 5,
        discountRate: 0.07,
        startYear: 2,
        endYear: 5,
        rampProfile: 's_curve',
        paramValues: {
          events_per_year: 12000,
          minutes_saved_per_event: 22,
          hourly_rate: 120,
          adoption_rate: 0.85,
          realization_factor: 0.78,
        },
        uncertaintySummary: 'PERT distributions on adoption_rate (0.55..0.96) and realization_factor (0.45..0.92), rho = 0.75 in adoption group.',
        uncertaintySpec: {
          correlation_group: 'adoption',
          correlation_rho: 0.75,
          parameters: {
            adoption_rate: { distribution: 'pert', low: 0.55, mode: 0.85, high: 0.96 },
            realization_factor: { distribution: 'pert', low: 0.45, mode: 0.78, high: 0.92 },
          },
        },
        antiDoubleCountTag: 'eng-capacity',
      },
      {
        id: 'toil-ex-invoice',
        title: 'Manual AP Invoice Exception Triage Automation',
        domain: 'automation',
        valueStream: 'Finance & Billing',
        summary:
          'RPA + API validation saving 10 touch minutes across 18,000 invoices/year in a 5-year finance automation business case (6% discount rate).',
        horizonYears: 5,
        discountRate: 0.06,
        startYear: 1,
        endYear: 5,
        rampProfile: 's_curve',
        paramValues: {
          events_per_year: 18000,
          minutes_saved_per_event: 10,
          hourly_rate: 68,
          adoption_rate: 0.82,
          realization_factor: 0.75,
        },
        uncertaintySummary: 'PERT on adoption_rate and realization_factor linked to ops_adoption (rho = 0.75).',
        uncertaintySpec: {
          correlation_group: 'ops_adoption',
          correlation_rho: 0.75,
          parameters: {
            adoption_rate: { distribution: 'pert', low: 0.5, mode: 0.82, high: 0.95 },
            realization_factor: { distribution: 'pert', low: 0.4, mode: 0.75, high: 0.92 },
          },
        },
        antiDoubleCountTag: 'ops-staff-hours',
      },
    ],
  },

  'BEN-FLOW-01': {
    id: 'BEN-FLOW-01',
    headline: 'Captures commercial throughput, faster time-to-market, or working-capital acceleration from shorter cycle times.',
    whatItMeasures:
      'BEN-FLOW-01 values speed and throughput gains separately from labor hours: delivering more orders, shipping revenue-generating features sooner, or compressing days-sales-outstanding (DSO) via shorter end-to-end lead time.',
    economicRationale:
      'Even if zero labor minutes are saved, compressing order lead time from 6 days to 1 day reduces customer abandonment and frees working capital. Likewise, shipping commercial product increments 3 weeks earlier captures incremental gross margin (Cost of Delay).',
    whenToUse: [
      'Higher fulfilled order capacity, faster customer onboarding, or lower cart/quote abandonment.',
      'Accelerated software releases with documented commercial Cost of Delay per release.',
      'Working capital / DSO compression from billing customers faster.',
    ],
    whenNotToUse: [
      {
        text: 'Internal engineering or operations labor hours saved belong in Automated Toil Elimination.',
        linkSlug: 'BEN-TOIL-01',
        linkLabel: 'View BEN-TOIL-01',
      },
      {
        text: 'Lower defect rates or avoided production outages belong in Defect, Rework & Incident Avoidance.',
        linkSlug: 'BEN-QUAL-01',
        linkLabel: 'View BEN-QUAL-01',
      },
    ],
    formulaPlainEnglish:
      'Annual throughput value equals net accelerated deliveries/items per year multiplied by net economic value per item multiplied by workflow adoption rate.',
    parameterGuidance: {
      accelerated_items_per_year: {
        guidance: 'Count of orders, invoices, or product launches materially accelerated or unlocked annually.',
        typicalRange: '24 – 1,000 items/yr',
        dataSource: 'Order funnel conversion analytics, release cadence history.',
      },
      value_per_item: {
        guidance: 'Net incremental contribution margin, avoided customer churn value, or interest/working-capital benefit per item (not gross revenue).',
        typicalRange: '$250 – $10,000 / item',
        dataSource: 'Product P&L contribution margin analysis or Treasury working-capital rate.',
      },
      adoption_rate: {
        guidance: 'Fraction of workflows adopting the accelerated path [0, 1].',
        typicalRange: '0.65 – 0.90',
        dataSource: 'Channel eligibility & rollout scope.',
      },
    },
    modelingTips: {
      schedule: 'Typically starts in Y2 after core workflow integration stabilizes.',
      ramp: 'Linear or s_curve as go-to-market teams and customers shift onto the faster workflow.',
      uncertainty: 'Model PERT uncertainty on both value_per_item and adoption_rate, since unit economics often vary widely.',
      correlation: 'Share correlation_group = adoption with related operational benefits.',
    },
    guardrailDeepDive: [
      'Always use NET contribution margin (gross margin after COGS and fulfillment cost), never top-line gross revenue.',
      'Explicitly verify value_per_item excludes internal staff hours already monetized in BEN-TOIL-01 — tag both if reviewing overlap.',
    ],
    examples: [
      {
        id: 'flow-ex-orders',
        title: 'Order Cycle-Time & Billing Acceleration',
        domain: 'automation',
        valueStream: 'Order Operations',
        summary:
          'Automated credit/fulfillment checks save 4 days of order delay on 360 commercial orders/yr (net retention + working-capital gain of $580/order) from Y2–Y5.',
        horizonYears: 5,
        discountRate: 0.06,
        startYear: 2,
        endYear: 5,
        rampProfile: 'linear',
        paramValues: {
          accelerated_items_per_year: 360,
          value_per_item: 580,
          adoption_rate: 0.8,
        },
        uncertaintySummary: 'PERT on value_per_item ($200..$780) and adoption_rate (0.35..0.95) in ops_adoption group.',
        uncertaintySpec: {
          correlation_group: 'ops_adoption',
          correlation_rho: 0.75,
          parameters: {
            value_per_item: { distribution: 'pert', low: 200, mode: 580, high: 780 },
            adoption_rate: { distribution: 'pert', low: 0.35, mode: 0.8, high: 0.95 },
          },
        },
        antiDoubleCountTag: 'ops-staff-hours',
      },
      {
        id: 'flow-ex-releases',
        title: 'Accelerated Feature Releases (Cost of Delay)',
        domain: 'software',
        valueStream: 'Software Delivery',
        summary:
          'Automated canary releases unlock earlier commercial rollout of 48 feature increments/yr worth $4,500 net Cost-of-Delay margin each.',
        horizonYears: 5,
        discountRate: 0.07,
        startYear: 2,
        endYear: 5,
        rampProfile: 's_curve',
        paramValues: {
          accelerated_items_per_year: 48,
          value_per_item: 4500,
          adoption_rate: 0.75,
        },
        uncertaintySummary: 'PERT on value_per_item (-40%/+50%) reflecting commercial demand elasticity.',
        uncertaintySpec: {
          correlation_group: 'adoption',
          correlation_rho: 0.65,
          parameters: {
            value_per_item: { distribution: 'pert', low: 2700, mode: 4500, high: 6750 },
            adoption_rate: { distribution: 'pert', low: 0.5, mode: 0.75, high: 0.9 },
          },
        },
      },
    ],
  },

  'BEN-QUAL-01': {
    id: 'BEN-QUAL-01',
    headline: 'Models expected annual losses avoided by preventing production incidents, defects, outages, and rework.',
    whatItMeasures:
      'BEN-QUAL-01 quantifies risk-adjusted cost avoidance from lowering failure frequency or severity—including war-room response labor, lost transaction revenue, SLA customer credits, and physical scrap/rework.',
    economicRationale:
      'Unplanned outages and production defects act as an invisible reliability tax. Anchoring baseline_events_per_year to actual trailing 12-month incident logs grounds quality investments in verifiable operational cost rather than abstract percentages.',
    whenToUse: [
      'Automated contract testing, canary rollbacks, observability alerting, and chaos resilience engineering.',
      'Datacenter high-availability failover, redundant WAN links, or immutable infrastructure eliminating drift outages.',
      'Automated data validation preventing costly downstream billing/shipment errors.',
    ],
    whenNotToUse: [
      {
        text: 'Regulatory fines and external audit preparation labor belong in Compliance, Audit & Risk Reduction.',
        linkSlug: 'BEN-COMP-01',
        linkLabel: 'View BEN-COMP-01',
      },
      {
        text: 'Routine preventive manual tasks without an active failure event belong in Automated Toil Elimination.',
        linkSlug: 'BEN-TOIL-01',
        linkLabel: 'View BEN-TOIL-01',
      },
    ],
    formulaPlainEnglish:
      'Expected annual quality benefit equals trailing baseline incidents/year times fractional reduction ratio [0..1] times average all-in cost per incident.',
    parameterGuidance: {
      baseline_events_per_year: {
        guidance: 'Historical annual count of Sev-1/Sev-2 incidents, escaped defects, or order errors from the past 12–24 months.',
        typicalRange: '10 – 120 events/yr',
        dataSource: 'PagerDuty / Jira incident post-mortem logs, defect trackers.',
      },
      risk_reduction_pct: {
        guidance: 'Conservative fraction of baseline incidents prevented or mitigated by the architecture change [0, 1].',
        typicalRange: '0.25 – 0.65',
        dataSource: 'Root-cause classification showing % of incidents addressable by the proposed controls.',
      },
      cost_per_event: {
        guidance: 'Average composite impact: engineering recovery hours + SLA credits + direct customer refund/margin loss.',
        typicalRange: '$3,500 – $50,000 / event',
        dataSource: 'Finance post-mortem cost-of-downtime templates.',
      },
    },
    modelingTips: {
      schedule: 'Start once resilience/testing controls go live (typically Y2 to horizon_years).',
      ramp: 'Linear ramp captures iterative test coverage or workload cutover across services.',
      uncertainty: 'Pair PERT on risk_reduction_pct with Lognormal (std 30%–40%) on cost_per_event because outage severity is heavy-tailed.',
      correlation: 'Group risk_reduction_pct with adoption when adoption of safety guardrails drives incident reduction.',
    },
    guardrailDeepDive: [
      'Audit trailing PagerDuty/Jira root causes: only count the subset of historical incidents the solution actually addresses.',
      'Avoid counting regulatory contract fines in both BEN-QUAL-01 cost_per_event and BEN-COMP-01 avoided_penalty_expected.',
    ],
    examples: [
      {
        id: 'qual-ex-incidents',
        title: 'Production Sev-2 Incident & MTTR Avoidance',
        domain: 'software',
        valueStream: 'Incident Response',
        summary:
          'Automated pre-deploy contract gates and canary rollbacks halve 64 annual Sev-2/Sev-3 incidents ($8,500 avg cost each), ramping linearly across Y2–Y5.',
        horizonYears: 5,
        discountRate: 0.07,
        startYear: 2,
        endYear: 5,
        rampProfile: 'linear',
        paramValues: {
          baseline_events_per_year: 64,
          risk_reduction_pct: 0.5,
          cost_per_event: 8500,
        },
        uncertaintySummary: 'PERT on risk_reduction_pct (0.25..0.70) and Lognormal (std 30%) on cost_per_event.',
        uncertaintySpec: {
          correlation_group: 'adoption',
          correlation_rho: 0.6,
          parameters: {
            risk_reduction_pct: { distribution: 'pert', low: 0.25, mode: 0.5, high: 0.7 },
            cost_per_event: { distribution: 'lognormal', std_pct: 0.3 },
          },
        },
      },
      {
        id: 'qual-ex-outage',
        title: 'Major Datacenter Outage & SLA Avoidance',
        domain: 'infrastructure',
        valueStream: 'Reliability & Resilience',
        summary:
          'Active-active cloud landing zones reduce 18 legacy outages/year ($32,000 blended SLA & recovery cost) by 55% over Years 2–7.',
        horizonYears: 7,
        discountRate: 0.08,
        startYear: 2,
        endYear: 7,
        rampProfile: 'linear',
        paramValues: {
          baseline_events_per_year: 18,
          risk_reduction_pct: 0.55,
          cost_per_event: 32000,
        },
        uncertaintySummary: 'PERT on risk_reduction_pct (0.20..0.75) and Lognormal (std 40%) on outage cost_per_event.',
        uncertaintySpec: {
          correlation_group: 'resilience',
          correlation_rho: 0.7,
          parameters: {
            risk_reduction_pct: { distribution: 'pert', low: 0.2, mode: 0.55, high: 0.75 },
            cost_per_event: { distribution: 'lognormal', std_pct: 0.4 },
          },
        },
      },
    ],
  },

  'BEN-CAP-01': {
    id: 'BEN-CAP-01',
    headline: 'Captures avoided duplicate setup, scaffolding, and integration costs for downstream roadmap initiatives.',
    whatItMeasures:
      'BEN-CAP-01 quantifies platform leverage: when a foundational initiative (identity, event bus, golden deployment path, cloud landing zone) saves future projects from rebuilding boilerplate plumbing from scratch.',
    economicRationale:
      'Shared capabilities often fail standalone Year-1 payback tests if valued only on their first consumer. Weighting committed downstream projects by reuse_probability lets portfolio reviewers value platform optionality rigorously without counting imaginary projects.',
    whenToUse: [
      'Internal Developer Platforms (IDP), reusable Terraform/cloud landing zones, shared API gateways, or central observability.',
      'Data mesh ingestion templates or shared ML feature stores reused across multiple product verticals.',
      'Multi-year portfolio architecture investments specifically chartered as enablers.',
    ],
    whenNotToUse: [
      {
        text: 'Daily developer/operator time savings on existing routines belong in Automated Toil Elimination.',
        linkSlug: 'BEN-TOIL-01',
        linkLabel: 'View BEN-TOIL-01',
      },
      {
        text: 'Single-project savings with no confirmed portfolio roadmap consumers should not be inflated with BEN-CAP-01.',
        linkSlug: 'BEN-FLOW-01',
        linkLabel: 'View BEN-FLOW-01',
      },
    ],
    formulaPlainEnglish:
      'Expected annual reuse leverage equals committed downstream reusing initiatives per year times avoided boilerplate setup cost per initiative times reuse probability.',
    parameterGuidance: {
      downstream_initiatives: {
        guidance: 'Count of future funded/roadmap initiatives per year that would otherwise build this capability independently.',
        typicalRange: '2 – 8 initiatives/yr',
        dataSource: 'Annual portfolio planning / PMO approved roadmap.',
      },
      avoided_setup_cost: {
        guidance: 'Estimated engineering + vendor setup cost saved each time a downstream program reuses the shared template.',
        typicalRange: '$35,000 – $120,000 / initiative',
        dataSource: 'Comparable past greenfield build costs (from COST-BUILD-01 actuals).',
      },
      reuse_probability: {
        guidance: 'Likelihood each planned downstream team successfully adopts the shared capability as-is [0, 1].',
        typicalRange: '0.50 – 0.85',
        dataSource: 'Architecture review board governance strictness & historical reuse rate.',
      },
    },
    modelingTips: {
      schedule: 'Delay start_year until the shared platform finishes Year 1–2 stabilization (commonly Y3–Y7).',
      ramp: 's_curve fits platform adoption cleanly as early adopters validate golden paths before broader portfolio rollout.',
      uncertainty: 'Triangular distribution on reuse_probability (e.g., 0.30..0.90) highlights governance adoption risk.',
      correlation: 'Pair reuse_probability inside the shared adoption correlation group (rho ≈ 0.65).',
    },
    guardrailDeepDive: [
      'Document the named roadmap programs behind downstream_initiatives in initiative notes; avoid vague TAM counts.',
      'Keep avoided_setup_cost strictly below standalone COST-BUILD-01 total so leverage stays credible.',
    ],
    examples: [
      {
        id: 'cap-ex-idp',
        title: 'Internal Developer Platform Golden Paths',
        domain: 'capability',
        valueStream: 'Capability Enablement',
        summary:
          'Four downstream product launches per year avoid $70K each in CI/CD, SSO, and telemetry boilerplate at 75% reuse probability across Years 3–7.',
        horizonYears: 7,
        discountRate: 0.07,
        startYear: 3,
        endYear: 7,
        rampProfile: 's_curve',
        paramValues: {
          downstream_initiatives: 4,
          avoided_setup_cost: 70000,
          reuse_probability: 0.75,
        },
        uncertaintySummary: 'Triangular (0.40, 0.75, 0.92) on reuse_probability and Normal (std 20%) on avoided_setup_cost.',
        uncertaintySpec: {
          correlation_group: 'adoption',
          correlation_rho: 0.65,
          parameters: {
            reuse_probability: { distribution: 'triangular', low: 0.4, mode: 0.75, high: 0.92 },
            avoided_setup_cost: { distribution: 'normal', std_pct: 0.2 },
          },
        },
      },
      {
        id: 'cap-ex-landingzone',
        title: 'Reusable Cloud Landing Zone & Security Guardrails',
        domain: 'infrastructure',
        valueStream: 'Cloud Foundation',
        summary:
          'Three cloud workload migrations/yr save $85K in IAM, VPC networking, and KMS setup at 70% probability across Years 2–6.',
        horizonYears: 6,
        discountRate: 0.08,
        startYear: 2,
        endYear: 6,
        rampProfile: 's_curve',
        paramValues: {
          downstream_initiatives: 3,
          avoided_setup_cost: 85000,
          reuse_probability: 0.7,
        },
        uncertaintySummary: 'Triangular (0.25, 0.70, 0.90) on reuse_probability tied to resilience correlation group.',
        uncertaintySpec: {
          correlation_group: 'resilience',
          correlation_rho: 0.7,
          parameters: {
            reuse_probability: { distribution: 'triangular', low: 0.25, mode: 0.7, high: 0.9 },
          },
        },
      },
    ],
  },

  'BEN-COMP-01': {
    id: 'BEN-COMP-01',
    headline: 'Models audit evidence labor savings plus expected annualized reduction in regulatory, tax, or contract penalties.',
    whatItMeasures:
      'BEN-COMP-01 combines two distinct compliance levers: direct hours saved gathering SOC-2 / ISO / SOX evidence every year, and annualized expected risk reduction against regulatory fines or commercial audit penalties.',
    economicRationale:
      'Audit evidence collection consumes expensive senior engineering and compliance hours every quarter, while compliance gaps create asymmetric penalty exposure. Separating verifiable hour savings from probabilistic penalty exposure maintains transparent auditability.',
    whenToUse: [
      'Continuous policy-as-code guardrails, immutable audit trails, and automated SOC-2 / PCI-DSS evidence collection.',
      'Automated invoice tax validation, SOX financial control logs, and dispute documentation workflows.',
      'Legacy operating system / unsupported database retirements closing critical audit findings.',
    ],
    whenNotToUse: [
      {
        text: 'Customer-facing downtime credits and production bug war-room recovery belong in Defect & Incident Avoidance.',
        linkSlug: 'BEN-QUAL-01',
        linkLabel: 'View BEN-QUAL-01',
      },
      {
        text: 'Day-to-day operational processing outside audit cycles belongs in Automated Toil Elimination.',
        linkSlug: 'BEN-TOIL-01',
        linkLabel: 'View BEN-TOIL-01',
      },
    ],
    formulaPlainEnglish:
      'Annual compliance benefit equals annual audit preparation hours saved times blended hourly rate, plus expected avoided annual regulatory or audit penalty.',
    parameterGuidance: {
      audit_hours_saved: {
        guidance: 'Annual hours currently spent pulling screenshots, reconciling logs, and answering external auditor requests.',
        typicalRange: '120 – 800 hrs/yr',
        dataSource: 'InfoSec GRC compliance calendar & internal audit time tracking.',
      },
      hourly_rate: {
        guidance: 'Blended loaded rate of compliance analysts and senior engineers supporting audits.',
        typicalRange: '$95 – $160 / hr',
        dataSource: 'FP&A InfoSec + engineering blended wage table.',
      },
      avoided_penalty_expected: {
        guidance: 'Probability-weighted annual expected penalty reduction (Probability x Fine/Dispute Exposure, NOT the worst-case single headline fine).',
        typicalRange: '$10,000 – $120,000 / yr',
        dataSource: 'Enterprise risk register & past audit finding remediation memos.',
      },
    },
    modelingTips: {
      schedule: 'Activate once automated evidence collection / controls pass internal audit readiness (Y2 onward).',
      ramp: 'Often immediate once automated audit pipelines are certified.',
      uncertainty: 'Triangular on avoided_penalty_expected (wide range, e.g., $5K–$80K) reflects inherently uncertain enforcement/dispute risk.',
      correlation: 'Audit labor often correlates mildly with ops_adoption; penalty risk is usually mostly independent.',
    },
    guardrailDeepDive: [
      'Enter EXPECTED annualized penalty avoided (Probability × Exposure), not the maximum statutory fine.',
      'Keep SLA downtime credits in BEN-QUAL-01 out of avoided_penalty_expected to prevent double counting.',
    ],
    examples: [
      {
        id: 'comp-ex-audit',
        title: 'Automated Billing Audit Trail & Dispute Reduction',
        domain: 'operations',
        valueStream: 'Compliance',
        summary:
          'Immutable invoice validation saves 240 compliance/engineering audit hours ($110/hr) plus $45,000 expected annual dispute write-offs across Years 2–5.',
        horizonYears: 5,
        discountRate: 0.06,
        startYear: 2,
        endYear: 5,
        rampProfile: 'immediate',
        paramValues: {
          audit_hours_saved: 240,
          hourly_rate: 110,
          avoided_penalty_expected: 45000,
        },
        uncertaintySummary: 'Triangular ($5K, $45K, $80K) on avoided_penalty_expected reflecting annual dispute variance.',
        uncertaintySpec: {
          correlation_group: 'ops_adoption',
          correlation_rho: 0.5,
          parameters: {
            avoided_penalty_expected: {
              distribution: 'triangular',
              low: 5000,
              mode: 45000,
              high: 80000,
            },
          },
        },
      },
      {
        id: 'comp-ex-policy',
        title: 'Continuous Policy-as-Code Cloud Controls (7-Yr)',
        domain: 'infrastructure',
        valueStream: 'Core Infrastructure',
        summary:
          'Automated cloud posture guardrails eliminate 450 senior engineering/GRC hours per year ($135/hr) and $55,000 expected compliance findings exposure from Y2–Y7.',
        horizonYears: 7,
        discountRate: 0.08,
        startYear: 2,
        endYear: 7,
        rampProfile: 'immediate',
        paramValues: {
          audit_hours_saved: 450,
          hourly_rate: 135,
          avoided_penalty_expected: 55000,
        },
        uncertaintySummary: 'Normal (std 25%) on audit_hours_saved and Triangular ($15K, $55K, $110K) on avoided_penalty_expected.',
        uncertaintySpec: {
          parameters: {
            audit_hours_saved: { distribution: 'normal', std_pct: 0.25 },
            avoided_penalty_expected: {
              distribution: 'triangular',
              low: 15000,
              mode: 55000,
              high: 110000,
            },
          },
        },
      },
    ],
  },
};

export function buildCustomCatalogDoc(entry: CatalogEntry): CatalogItemDoc {
  const isCost = entry.kind === 'cost';
  const defaultParams: Record<string, number> = {};
  const guidance: Record<string, ParameterGuidance> = {};

  for (const param of entry.parameters) {
    defaultParams[param.key] = param.default_value;
    const minStr = param.min_value !== null ? String(param.min_value) : '−∞';
    const maxStr = param.max_value !== null ? String(param.max_value) : '∞';
    guidance[param.key] = {
      guidance: `${param.label}${param.unit ? ` measured in ${param.unit}` : ''}. Configured on custom template ${entry.id}.`,
      typicalRange: `Default ${param.default_value} (bounds [${minStr}, ${maxStr}])`,
      dataSource: 'Custom business-case domain benchmarks.',
    };
  }

  return {
    id: entry.id,
    headline:
      entry.description ||
      `Custom ${entry.kind} formula template evaluated safely via AST arithmetic expressions.`,
    whatItMeasures:
      entry.description ||
      `${entry.name} is a custom ${entry.kind} catalog item (${entry.id}) evaluated dynamically per year using the formula ${entry.formula_description}.`,
    economicRationale: isCost
      ? 'Tracks a domain-specific cost driver cleanly inside the standardized PV, NPV, BCR, and Monte Carlo framework.'
      : 'Captures a domain-specific value driver cleanly inside the standardized PV, NPV, BCR, and Monte Carlo framework.',
    whenToUse: [
      `When modeling ${entry.name.toLowerCase()} within ${entry.domains.join(', ') || 'cross-domain'} initiatives.`,
      `Default value stream stage: ${entry.value_stream_stage || 'Core'}.`,
    ],
    whenNotToUse: [
      {
        text: 'Inspect existing built-in catalog formulas first to ensure this custom item does not duplicate core labor, quality, or run costs.',
        linkSlug: 'overview',
        linkLabel: 'Browse Catalog Index',
      },
    ],
    formulaPlainEnglish: `Safe AST arithmetic evaluation of: ${entry.formula_description}`,
    parameterGuidance: guidance,
    modelingTips: {
      schedule: isCost
        ? 'Restrict active years to the true expenditure window.'
        : 'Begin benefits after enabling capabilities go live.',
      ramp: isCost
        ? 'Use immediate or custom_weights matching spend phasing.'
        : 'Use linear or s_curve when realization depends on progressive adoption.',
      uncertainty: 'Apply PERT or Normal uncertainty to the highest-leverage input parameters.',
      correlation: 'Share correlation_group names with upstream/downstream dependent line items.',
    },
    guardrailDeepDive: entry.guardrail_notes
      ? [entry.guardrail_notes]
      : ['Verify units align across all expression operands so the formula outputs annualized currency ($/yr).'],
    examples: [
      {
        id: `${entry.id.toLowerCase()}-default-ex`,
        title: `${entry.name} — Default Parameter Baseline`,
        domain: entry.domains[0] || 'software',
        valueStream: entry.value_stream_stage || 'Core',
        summary:
          'Illustrates the live deterministic multi-year PV schedule generated from this custom template’s default parameter values across a 5-year horizon at 7% discount rate.',
        horizonYears: 5,
        discountRate: 0.07,
        startYear: isCost ? 1 : 2,
        endYear: 5,
        rampProfile: isCost ? 'immediate' : 'linear',
        paramValues: defaultParams,
        uncertaintySummary: 'Recommended: add ±15%–25% PERT or Normal uncertainty on key driver parameters.',
        uncertaintySpec: {
          item_multiplier: { distribution: 'triangular', low: 0.85, mode: 1.0, high: 1.2 },
          parameters: {},
        },
      },
    ],
  };
}

export function getCatalogItemDoc(entry: CatalogEntry): CatalogItemDoc {
  return CATALOG_ITEM_DOCS[entry.id] || buildCustomCatalogDoc(entry);
}

export function getKindLabel(kind: CatalogKind): string {
  return kind === 'cost' ? 'Cost' : 'Benefit';
}
