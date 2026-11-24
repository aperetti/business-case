import type { GuideDocPage, GuideSection } from './catalogDocs';

/** Documentation for one form field: shown in the field's info popover and on the Field Reference page. */
export interface FieldDoc {
  group: string;
  label: string;
  /** One or two sentences: what the field is and what it changes. */
  help: string;
  /** Extra detail shown on the Field Reference page. */
  details?: string[];
  /** Deeper guide or template page on the same topic. */
  seeAlso?: { slug: string; label: string };
}

export const FIELD_REFERENCE_SLUG = 'field-reference';

const SEE_METHODOLOGY = { slug: 'methodology', label: 'Discounting, NPV, BCR & Payback' };
const SEE_RAMPS = { slug: 'ramps', label: 'Realization Ramps & Timing' };
const SEE_UNCERTAINTY = { slug: 'uncertainty', label: 'Monte Carlo & Uncertainty' };
const SEE_OVERVIEW = { slug: 'overview', label: 'Overview & Catalog Directory' };

export const FIELD_DOCS = {
  // --- Initiative & BCA ---------------------------------------------------------
  'initiative.name': {
    group: 'Initiative & BCA settings',
    label: 'Initiative Name',
    help: 'Short name for the program or investment being evaluated. Shown in the sidebar, approval requests, emails, and OData exports.',
  },
  'initiative.description': {
    group: 'Initiative & BCA settings',
    label: 'Initiative Description',
    help: 'What the initiative delivers and its scope. When an initiative is created, this also becomes the Baseline BCA’s scenario notes.',
  },
  'initiative.domain': {
    group: 'Initiative & BCA settings',
    label: 'Domain',
    help: 'Business domain tag (for example software, automation, infrastructure). Used to filter initiatives and match catalog templates; it does not affect any calculation.',
  },
  'initiative.cost_start_year': {
    group: 'Initiative & BCA settings',
    label: 'Cost Start Year',
    help: 'Calendar year that model year 1 represents. Optional: it only labels years in charts and tables (Y1 = this year). Discounting always uses model years 1 to the horizon.',
  },
  'initiative.horizon': {
    group: 'Initiative & BCA settings',
    label: 'Horizon (Years)',
    help: 'Number of years modeled (1–30). Cash flows after the horizon are ignored, and line items cannot extend past it. Typical business cases use 5–10 years.',
    details: [
      'You cannot shorten the horizon below the latest End Year of an existing line item; shorten those items first.',
      'Each BCA has its own horizon, so scenarios can be compared over different periods.',
    ],
    seeAlso: SEE_METHODOLOGY,
  },
  'initiative.discount_rate': {
    group: 'Initiative & BCA settings',
    label: 'Discount Rate (%)',
    help: 'Annual rate used to convert future cash flows into present value with end-of-year discounting: PV = value ÷ (1 + rate)^year. Usually your real cost of capital (WACC), typically 6–10%.',
    details: ['A higher rate shrinks the value of benefits that arrive later, which lowers NPV for back-loaded initiatives.'],
    seeAlso: SEE_METHODOLOGY,
  },
  'initiative.external_url': {
    group: 'Initiative & BCA settings',
    label: 'External Resource',
    help: 'Optional http(s) link to the source material for this business case, such as a SharePoint folder or project charter.',
  },
  'bca.name': {
    group: 'Initiative & BCA settings',
    label: 'BCA Name',
    help: 'Name of this business-case scenario (BCA). An initiative can hold several BCAs, for example a baseline and an accelerated option, to compare side by side.',
  },
  'bca.notes': {
    group: 'Initiative & BCA settings',
    label: 'BCA Scenario Notes',
    help: 'What makes this scenario different from the others: assumptions, scope changes, or vendor choices.',
  },
  'bca.source': {
    group: 'Initiative & BCA settings',
    label: 'Line Items Source',
    help: 'Start the new BCA empty, or copy every line item from an existing BCA so you can adjust only what differs.',
  },

  // --- Line items -----------------------------------------------------------------
  'item.catalog': {
    group: 'Line items',
    label: 'Catalog Template',
    help: 'The reusable cost or benefit formula this line item uses. The template decides whether the item is a cost or benefit, which parameters it needs, and how they combine into an annual value.',
    details: ['Use “Template guide” in the line item drawer for the template’s parameter guidance and worked examples.'],
    seeAlso: SEE_OVERVIEW,
  },
  'item.label': {
    group: 'Line items',
    label: 'Line Item Label',
    help: 'Display name for this line item in tables, charts, and exports. Defaults to the template name.',
  },
  'item.value_stream': {
    group: 'Line items',
    label: 'Value Stream',
    help: 'Groups line items for the value-stream breakdown charts (for example Software Delivery or Incident Response). It does not change totals.',
  },
  'item.active_years': {
    group: 'Line items',
    label: 'Start Year / End Year',
    help: 'Model years in which this item produces cash flows. Outside this window the item contributes $0. End Year cannot exceed the horizon.',
    details: ['Costs usually start in year 1; benefits often start a year later, once the capability is live.'],
    seeAlso: SEE_RAMPS,
  },
  'item.ramp': {
    group: 'Line items',
    label: 'Ramp Profile',
    help: 'How the annual value builds up over the active years: Immediate (100% every year), Linear (steady climb to 100%), S-Curve (slow start, fast middle, plateau), or Custom Year Weights.',
    seeAlso: SEE_RAMPS,
  },
  'item.ramp_weights': {
    group: 'Line items',
    label: 'Custom Year Weights',
    help: 'Multiplier applied to the annual value in each active year (1.0 = full value, 0.5 = half). Use for phased spend or uneven rollouts.',
    seeAlso: SEE_RAMPS,
  },
  'item.parameters': {
    group: 'Line items',
    label: 'Template Parameters',
    help: 'Inputs to the template’s formula, such as hours, rates, or volumes. Each must stay within the bounds set on the catalog template. The template guide explains how to estimate each one.',
    seeAlso: SEE_OVERVIEW,
  },
  'item.distribution': {
    group: 'Line items',
    label: 'Uncertainty Distribution',
    help: 'How Monte Carlo varies this value. Fixed keeps it constant; Normal is symmetric; Lognormal is right-skewed and never negative; Triangular and PERT use Low / Mode / High estimates.',
    details: [
      'The overall item multiplier scales the whole line item; per-parameter distributions vary individual inputs.',
      'Sampled values are always clamped to the parameter’s catalog bounds.',
    ],
    seeAlso: SEE_UNCERTAINTY,
  },
  'item.std_pct': {
    group: 'Line items',
    label: 'Std Dev (% of base)',
    help: 'Spread for Normal and Lognormal distributions as a share of the base value. 0.15 means about ±15% for one standard deviation.',
    seeAlso: SEE_UNCERTAINTY,
  },
  'item.three_point': {
    group: 'Line items',
    label: 'Low / Mode / High',
    help: 'Three-point estimate for Triangular and PERT: pessimistic, most likely, and optimistic values. PERT weights the mode more heavily, giving smoother results.',
    seeAlso: SEE_UNCERTAINTY,
  },
  'item.correlation_group': {
    group: 'Line items',
    label: 'Correlation Group',
    help: 'Line items with the same group name move together in Monte Carlo (via a Gaussian copula). Use it for items driven by the same underlying factor, like adoption.',
    seeAlso: SEE_UNCERTAINTY,
  },
  'item.correlation_rho': {
    group: 'Line items',
    label: 'Correlation Strength (ρ)',
    help: 'How strongly items in the same correlation group move together, from −0.99 to 0.99. 0.7 is a strong positive relationship; 0 means independent.',
    seeAlso: SEE_UNCERTAINTY,
  },
  'item.anti_double_count': {
    group: 'Line items',
    label: 'Anti-Double-Count Tag',
    help: 'Give benefit items that might claim the same savings the same tag. When two or more benefits share a tag, a review warning appears so you can confirm they don’t overlap. It does not change the numbers.',
    seeAlso: SEE_UNCERTAINTY,
  },

  // --- Monte Carlo & comparison ----------------------------------------------------
  'mc.iterations': {
    group: 'Monte Carlo & BCA comparison',
    label: 'Simulation Iterations',
    help: 'Number of random trials. More trials give more stable percentiles but take longer; 10,000 is a good default.',
    seeAlso: SEE_UNCERTAINTY,
  },
  'mc.seed': {
    group: 'Monte Carlo & BCA comparison',
    label: 'Random Seed',
    help: 'Optional. Using the same seed with the same inputs reproduces exactly the same results; leave it blank for a fresh random run.',
    seeAlso: SEE_UNCERTAINTY,
  },
  'mc.discount_override': {
    group: 'Monte Carlo & BCA comparison',
    label: 'What-If Discount Rate (%)',
    help: 'Runs the simulation with a different discount rate without changing the saved BCA. Useful for testing sensitivity to cost of capital.',
    seeAlso: SEE_UNCERTAINTY,
  },
  'mc.uncertainty_scale': {
    group: 'Monte Carlo & BCA comparison',
    label: 'Uncertainty Spread Scale',
    help: 'Widens or narrows every distribution at once. 1.00x uses the spreads as entered, 2.00x doubles them, and 0.00x makes the run deterministic.',
    seeAlso: SEE_UNCERTAINTY,
  },
  'mc.benefit_scale': {
    group: 'Monte Carlo & BCA comparison',
    label: 'What-If Benefit Scale',
    help: 'Multiplies every benefit for this run only. 0.80x asks “what if benefits come in 20% lower?”',
    seeAlso: SEE_UNCERTAINTY,
  },
  'mc.cost_scale': {
    group: 'Monte Carlo & BCA comparison',
    label: 'What-If Cost Scale',
    help: 'Multiplies every cost for this run only. 1.20x asks “what if costs overrun by 20%?”',
    seeAlso: SEE_UNCERTAINTY,
  },

  // --- Catalog templates -------------------------------------------------------------
  'catalog.id': {
    group: 'Catalog templates',
    label: 'Template ID',
    help: 'Permanent identifier, 2–64 letters, numbers, dashes, or underscores (for example BEN-SLA-01). It cannot be changed after creation.',
  },
  'catalog.kind': {
    group: 'Catalog templates',
    label: 'Kind',
    help: 'Whether line items from this template count as costs or benefits. It cannot change while line items use the template.',
  },
  'catalog.stage': {
    group: 'Catalog templates',
    label: 'Default Stage',
    help: 'Suggested value stream for line items created from this template. Users can change it per line item.',
  },
  'catalog.name': {
    group: 'Catalog templates',
    label: 'Template Name',
    help: 'Human-readable name shown in the template picker, catalog, and docs.',
  },
  'catalog.domains': {
    group: 'Catalog templates',
    label: 'Domains',
    help: 'Comma-separated domain tags that this template applies to. Used for filtering only.',
  },
  'catalog.description': {
    group: 'Catalog templates',
    label: 'Description',
    help: 'Short summary of what the template captures, shown on catalog cards and used by the Docs Agent.',
  },
  'catalog.param_key': {
    group: 'Catalog templates',
    label: 'Parameter Key',
    help: 'Name used in the formula, in snake_case starting with a lowercase letter (for example hourly_rate).',
  },
  'catalog.param_label': {
    group: 'Catalog templates',
    label: 'Parameter Label',
    help: 'Friendly name shown on line item forms.',
  },
  'catalog.param_unit': {
    group: 'Catalog templates',
    label: 'Parameter Unit',
    help: 'Unit shown next to the value, such as hrs/yr or $/hr. Make sure units multiply out to an annual dollar amount.',
  },
  'catalog.param_default': {
    group: 'Catalog templates',
    label: 'Parameter Default',
    help: 'Value pre-filled on new line items, and used when a line item doesn’t set this parameter.',
  },
  'catalog.param_bounds': {
    group: 'Catalog templates',
    label: 'Parameter Min / Max',
    help: 'Allowed range for line item values and Monte Carlo samples. Leave Max empty for no upper limit. Tightening bounds is blocked if existing line items fall outside them.',
  },
  'catalog.formula': {
    group: 'Catalog templates',
    label: 'Formula',
    help: 'Arithmetic using the parameter keys (+, −, *, /, **, min, max, abs) that yields an annual dollar value. Built-in templates may use a named formula instead.',
    details: [
      'Formulas are validated and evaluated safely; they are never run as code.',
      'Changing the formula recalculates every initiative using the template, and is blocked while any of them are under review or approved.',
    ],
    seeAlso: SEE_METHODOLOGY,
  },
  'catalog.guardrails': {
    group: 'Catalog templates',
    label: 'Guardrail Notes',
    help: 'Warnings about overlap with other templates and how to avoid double counting. Shown on the catalog card and template guide.',
  },

  // --- Approvals -----------------------------------------------------------------------
  'approval.workflow': {
    group: 'Approvals',
    label: 'Approval Workflow',
    help: 'The sequence of approval steps this initiative must pass. Administrators define workflows; the default one is pre-selected.',
  },
  'approval.comment': {
    group: 'Approvals',
    label: 'Approval Comment',
    help: 'Note recorded in the approval history. Required when rejecting, so the submitter knows what to change.',
  },

  // --- Admin: workflows & email ---------------------------------------------------------
  'workflow.name': {
    group: 'Admin: approval workflows',
    label: 'Workflow Name',
    help: 'Shown to submitters when choosing a workflow and in approval emails.',
  },
  'workflow.flags': {
    group: 'Admin: approval workflows',
    label: 'Active / Default / Email submitter',
    help: 'Inactive workflows can’t be chosen for new submissions. The default is pre-selected. “Email submitter” sends the final approve/reject decision to whoever submitted.',
  },
  'workflow.step_roles': {
    group: 'Admin: approval workflows',
    label: 'Approver Roles',
    help: 'Any user with one of these roles can approve or reject this step. Submitters can never approve their own initiative.',
  },
  'workflow.step_emails': {
    group: 'Admin: approval workflows',
    label: 'Approver Emails',
    help: 'Specific people who can approve this step, in addition to the roles. They must sign in with this email.',
  },
  'workflow.step_required': {
    group: 'Admin: approval workflows',
    label: 'Approvals Required',
    help: 'How many different approvers must approve before the request moves to the next step. Any single rejection ends the request.',
  },
  'workflow.step_notify': {
    group: 'Admin: approval workflows',
    label: 'Email Approvers',
    help: 'Email this step’s approvers when the request reaches it. Requires email notifications to be configured.',
  },
  'email.smtp': {
    group: 'Admin: email notifications',
    label: 'SMTP Server',
    help: 'Host, port, and security of your outgoing mail server. Common setups: port 587 with STARTTLS, or port 465 with SSL/TLS.',
  },
  'email.credentials': {
    group: 'Admin: email notifications',
    label: 'SMTP Username / Password',
    help: 'Login for the mail server, if it requires one. The password is stored for sending only, and is cleared if the host changes.',
  },
  'email.from': {
    group: 'Admin: email notifications',
    label: 'From Address / Name',
    help: 'Sender shown on notification emails. Your mail server must allow sending as this address.',
  },
  'email.app_url': {
    group: 'Admin: email notifications',
    label: 'App URL',
    help: 'Public address of this app, used to build the “Review it here” links in emails.',
  },
} satisfies Record<string, FieldDoc>;

export type FieldKey = keyof typeof FIELD_DOCS;

export function fieldAnchorId(key: FieldKey): string {
  return `field-${key.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
}

/** Guide page listing every documented field, one deep-linkable section per field. */
export function buildFieldReferencePage(): GuideDocPage {
  const sections: GuideSection[] = (Object.entries(FIELD_DOCS) as [FieldKey, FieldDoc][]).map(([key, doc]) => ({
    id: fieldAnchorId(key),
    heading: doc.label,
    eyebrow: doc.group,
    paragraphs: [doc.help, ...(doc.details ?? [])],
    links: doc.seeAlso ? [doc.seeAlso] : undefined,
  }));
  return {
    slug: FIELD_REFERENCE_SLUG,
    title: 'Form Field Reference',
    subtitle: 'What every input in the workspace means and how it affects the business case. The ⓘ next to a field links here.',
    sections,
  };
}
