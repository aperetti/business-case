export type CatalogKind = 'cost' | 'benefit';
export type RampProfile = 'immediate' | 'linear' | 's_curve' | 'custom_weights';
export type DistributionKind = 'fixed' | 'normal' | 'triangular' | 'lognormal' | 'pert';

export interface CatalogParameter {
  key: string;
  label: string;
  unit: string;
  default_value: number;
  min_value: number | null;
  max_value: number | null;
  required: boolean;
}

export interface CatalogEntry {
  id: string;
  kind: CatalogKind;
  name: string;
  description: string;
  domains: string[];
  value_stream_stage: string | null;
  parameters: CatalogParameter[];
  formula_type: string;
  formula_description: string;
  guardrail_notes: string;
  is_builtin: boolean;
  created_at: string;
  /** Stored doc page; null for built-ins that use the shipped docs. */
  doc?: CatalogDocOut | null;
}

export interface CatalogDocAlternative {
  text: string;
  link_slug?: string | null;
  link_label?: string | null;
}

export interface CatalogDocParameterGuidance {
  guidance: string;
  typical_range: string;
  data_source: string;
}

export interface CatalogDocContent {
  headline: string;
  what_it_measures: string;
  economic_rationale: string;
  when_to_use: string[];
  when_not_to_use: CatalogDocAlternative[];
  formula_plain_english: string;
  parameter_guidance: Record<string, CatalogDocParameterGuidance>;
  modeling_tips: { schedule: string; ramp: string; uncertainty: string; correlation: string };
  guardrail_notes: string[];
}

export interface CatalogDocOut {
  content: CatalogDocContent;
  is_template: boolean;
  updated_at: string;
  updated_by: string;
}

export type CatalogEntryUpdate = Partial<Omit<CatalogEntryCreate, 'id'>>;

export interface CatalogEntryCreate {
  id: string;
  kind: CatalogKind;
  name: string;
  description: string;
  domains: string[];
  value_stream_stage: string | null;
  parameters: CatalogParameter[];
  formula_type: string;
  guardrail_notes: string;
}

export interface DistributionSpec {
  distribution: DistributionKind;
  std_pct?: number | null;
  std?: number | null;
  low?: number | null;
  mode?: number | null;
  high?: number | null;
  low_pct?: number | null;
  high_pct?: number | null;
  correlation_group?: string | null;
  correlation_rho?: number;
}

export interface UncertaintySpec {
  item_multiplier?: DistributionSpec | null;
  parameters: Record<string, DistributionSpec>;
  correlation_group?: string | null;
  correlation_rho?: number;
}

export interface InitiativeItemCreate {
  bca_id?: string | null;
  catalog_id: string;
  label: string;
  value_stream: string;
  start_year: number;
  end_year: number;
  ramp_profile: RampProfile;
  ramp_weights?: number[] | null;
  param_values: Record<string, number>;
  uncertainty_spec: UncertaintySpec;
  anti_double_count_tag?: string | null;
}

export type InitiativeItemUpdate = Partial<InitiativeItemCreate>;

export interface InitiativeItemOut {
  id: string;
  initiative_id: string;
  bca_id?: string | null;
  catalog_id: string;
  kind: CatalogKind;
  catalog_name: string;
  formula_type: string;
  guardrail_notes: string;
  label: string;
  value_stream: string;
  start_year: number;
  end_year: number;
  ramp_profile: RampProfile;
  ramp_weights: number[] | null;
  param_values: Record<string, number>;
  uncertainty_spec: UncertaintySpec;
  anti_double_count_tag: string | null;
  base_annual_value: number;
  pv_total: number;
  created_at: string;
  updated_at: string;
}

export interface YearlyCashFlow {
  year: number;
  undiscounted_cost: number;
  undiscounted_benefit: number;
  net_undiscounted: number;
  pv_cost: number;
  pv_benefit: number;
  net_pv: number;
  cumulative_undiscounted_net: number;
  cumulative_net_pv: number;
}

export interface ValueStreamBreakdown {
  value_stream: string;
  pv_costs: number;
  pv_benefits: number;
  npv: number;
  bcr: number | null;
  item_count: number;
  sim_npv_p10?: number | null;
  sim_npv_p50?: number | null;
  sim_npv_p90?: number | null;
  sim_pv_costs_mean?: number | null;
  sim_pv_benefits_mean?: number | null;
}

export interface GuardrailWarning {
  tag: string;
  message: string;
  item_ids: string[];
  item_labels: string[];
}

export interface DeterministicMetrics {
  pv_costs: number;
  pv_benefits: number;
  npv: number;
  bcr: number | null;
  discounted_payback_year: number | null;
  yearly_cash_flows: YearlyCashFlow[];
  value_streams: ValueStreamBreakdown[];
  guardrail_warnings: GuardrailWarning[];
}

export interface InitiativeCreate {
  name: string;
  description: string;
  domain: string;
  horizon_years: number;
  discount_rate: number;
  cost_start_year?: number | null;
  external_resource_url?: string;
}

export type InitiativeUpdate = Partial<InitiativeCreate>;

export interface BCACreate {
  name: string;
  description?: string;
  horizon_years?: number | null;
  discount_rate?: number | null;
  cost_start_year?: number | null;
  clone_from_bca_id?: string | null;
}

export interface BCAUpdate {
  name?: string;
  description?: string;
  horizon_years?: number;
  discount_rate?: number;
  cost_start_year?: number | null;
  is_baseline?: boolean;
}

export type MeasureDirection = 'higher_is_better' | 'lower_is_better';

/** Non-monetary measure (e.g. CSAT, MTTR) defined on an initiative and estimated per BCA. */
export interface MeasureOut {
  id: string;
  initiative_id: string;
  name: string;
  unit: string;
  direction: MeasureDirection;
  description: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface MeasureCreate {
  name: string;
  unit?: string;
  direction?: MeasureDirection;
  description?: string;
}

export type MeasureUpdate = Partial<MeasureCreate>;

export interface MeasureValueIn {
  value: number;
  low?: number | null;
  high?: number | null;
  note?: string;
}

export interface MeasureValueOut {
  measure_id: string;
  value: number;
  low: number | null;
  high: number | null;
  note: string;
  updated_at: string;
}

export interface BCASummary {
  id: string;
  initiative_id: string;
  name: string;
  description: string;
  horizon_years: number;
  discount_rate: number;
  cost_start_year: number | null;
  is_baseline: boolean;
  sort_order: number;
  item_count: number;
  pv_costs: number;
  pv_benefits: number;
  npv: number;
  bcr: number | null;
  discounted_payback_year: number | null;
  guardrail_warning_count: number;
  latest_run_id: string | null;
  latest_run_created_at: string | null;
  latest_prob_npv_positive: number | null;
  latest_prob_bcr_ge_one: number | null;
  latest_npv_p10: number | null;
  latest_npv_p50: number | null;
  latest_npv_p90: number | null;
  latest_bcr_p50: number | null;
  /** Non-monetary measure estimates keyed by measure id. */
  measure_values: Record<string, MeasureValueOut>;
  created_at: string;
  updated_at: string;
}

export interface BCADetail {
  id: string;
  initiative_id: string;
  name: string;
  description: string;
  horizon_years: number;
  discount_rate: number;
  cost_start_year: number | null;
  is_baseline: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  items: InitiativeItemOut[];
  deterministic: DeterministicMetrics;
  latest_simulation: SimulationResult | null;
}

export interface InitiativeSummary {
  id: string;
  name: string;
  description: string;
  domain: string;
  horizon_years: number;
  discount_rate: number;
  cost_start_year: number | null;
  external_resource_url: string;
  item_count: number;
  pv_costs: number;
  pv_benefits: number;
  npv: number;
  bcr: number | null;
  bca_count: number;
  baseline_bca_id: string | null;
  bcas: BCASummary[];
  status: InitiativeStatus;
  created_at: string;
  updated_at: string;
}

export interface InitiativeDetail {
  id: string;
  name: string;
  description: string;
  domain: string;
  horizon_years: number;
  discount_rate: number;
  cost_start_year: number | null;
  external_resource_url: string;
  status: InitiativeStatus;
  created_at: string;
  updated_at: string;
  active_bca_id: string | null;
  active_bca: BCASummary | null;
  bcas: BCASummary[];
  measures: MeasureOut[];
  items: InitiativeItemOut[];
  deterministic: DeterministicMetrics;
}

export interface SimulationRequest {
  bca_id?: string | null;
  n_simulations: number;
  seed?: number | null;
  discount_rate_override?: number | null;
  horizon_years_override?: number | null;
  uncertainty_scale?: number;
  benefit_scale?: number;
  cost_scale?: number;
  persist?: boolean;
}

export interface DistributionStats {
  mean: number;
  std: number;
  min: number;
  max: number;
  p5: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
}

export interface HistogramBin {
  bin_start: number;
  bin_end: number;
  bin_mid: number;
  count: number;
  density: number;
  cumulative_prob: number;
}

export interface YearlyPercentileBand {
  year: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  mean: number;
}

export interface SensitivityDriver {
  item_id: string;
  item_label: string;
  parameter_key: string;
  driver_label: string;
  kind: CatalogKind;
  spearman_corr: number;
  variance_share_pct: number;
}

export interface MonteCarloSummary {
  n_simulations: number;
  seed: number | null;
  prob_npv_positive: number;
  prob_bcr_ge_one: number;
  npv_stats: DistributionStats;
  bcr_stats: DistributionStats | null;
  npv_histogram: HistogramBin[];
  yearly_cumulative_npv_bands: YearlyPercentileBand[];
  sensitivity_drivers: SensitivityDriver[];
  value_streams: ValueStreamBreakdown[];
}

export interface SimulationResult {
  run_id: string | null;
  initiative_id: string;
  bca_id?: string | null;
  bca_name?: string | null;
  created_at: string;
  n_simulations: number;
  discount_rate: number;
  horizon_years: number;
  seed: number | null;
  uncertainty_scale: number;
  benefit_scale: number;
  cost_scale: number;
  duration_ms: number;
  deterministic: DeterministicMetrics;
  monte_carlo: MonteCarloSummary;
}

export interface SimulationRunRecord {
  id: string;
  initiative_id: string;
  bca_id?: string | null;
  bca_name?: string | null;
  n_simulations: number;
  discount_rate: number;
  horizon_years: number;
  seed: number | null;
  created_at: string;
  summary: SimulationResult;
}

export interface BCACompareRequest {
  bca_a_id: string;
  bca_b_id: string;
  n_simulations: number;
  seed?: number | null;
  discount_rate_override?: number | null;
  horizon_years_override?: number | null;
  uncertainty_scale?: number;
  benefit_scale?: number;
  cost_scale?: number;
  persist?: boolean;
}

export interface AlignedHistogramBin {
  bin_start: number;
  bin_end: number;
  bin_mid: number;
  count_a: number;
  density_a: number;
  cdf_a: number;
  count_b: number;
  density_b: number;
  cdf_b: number;
}

export interface YearlyComparisonRow {
  year: number;
  a_p10: number | null;
  a_p50: number | null;
  a_p90: number | null;
  b_p10: number | null;
  b_p50: number | null;
  b_p90: number | null;
  delta_p10: number | null;
  delta_p50: number | null;
  delta_p90: number | null;
}

export interface ValueStreamComparisonRow {
  value_stream: string;
  a_pv_costs: number;
  a_pv_benefits: number;
  a_npv: number;
  a_sim_npv_p50: number | null;
  b_pv_costs: number;
  b_pv_benefits: number;
  b_npv: number;
  b_sim_npv_p50: number | null;
  delta_npv: number;
  delta_sim_npv_p50: number | null;
}

export interface BCAComparisonPairedMetrics {
  prob_b_beats_a_npv: number;
  prob_a_beats_b_npv: number;
  prob_b_beats_a_bcr: number | null;
  delta_npv_stats: DistributionStats;
  delta_npv_histogram: HistogramBin[];
  delta_pv_costs_mean: number;
  delta_pv_benefits_mean: number;
  aligned_npv_distribution: AlignedHistogramBin[];
  yearly_comparison: YearlyComparisonRow[];
  value_stream_comparison: ValueStreamComparisonRow[];
}

export interface BCAComparisonResult {
  comparison_id: string | null;
  initiative_id: string;
  bca_a_id: string;
  bca_a_name: string;
  bca_b_id: string;
  bca_b_name: string;
  created_at: string;
  n_simulations: number;
  seed: number | null;
  duration_ms: number;
  result_a: SimulationResult;
  result_b: SimulationResult;
  paired: BCAComparisonPairedMetrics;
}

export interface BCAComparisonRecord {
  id: string;
  initiative_id: string;
  bca_a_id: string;
  bca_b_id: string;
  n_simulations: number;
  seed: number | null;
  created_at: string;
  summary: BCAComparisonResult;
}

export interface HealthResponse {
  status: string;
  database: string;
  catalog_count: number;
}

export interface LLMSettingsOut {
  base_url: string;
  model: string;
  temperature: number;
  max_tokens: number;
  timeout_seconds: number;
  system_prompt: string;
  api_key_set: boolean;
  api_key_masked: string;
  configured: boolean;
  verified?: boolean;
  verified_at?: string | null;
  updated_at: string | null;
}

export interface DocsAgentStatusOut {
  configured: boolean;
  verified: boolean;
  available: boolean;
  model: string;
}

export interface LLMSettingsUpdate {
  base_url: string;
  api_key?: string | null;
  clear_api_key?: boolean;
  model: string;
  temperature: number;
  max_tokens: number;
  timeout_seconds: number;
  system_prompt: string;
}

export interface LLMTestRequest {
  base_url?: string | null;
  api_key?: string | null;
  clear_api_key?: boolean;
  model?: string | null;
  timeout_seconds?: number | null;
}

export interface LLMTestResponse {
  ok: boolean;
  latency_ms: number;
  model: string;
  reply_preview: string;
  error: string | null;
}

export interface LLMModelsFetchRequest {
  base_url?: string | null;
  api_key?: string | null;
  clear_api_key?: boolean;
  timeout_seconds?: number | null;
}

export interface LLMModelsFetchResponse {
  models: string[];
  error: string | null;
}

export interface ApiKeyOut {
  id: string;
  name: string;
  key_prefix: string;
  key_last4: string;
  created_at: string;
  last_used_at: string | null;
  managed_by_env?: boolean;
}

export interface ApiKeyCreatedOut extends ApiKeyOut {
  secret_key: string;
}

export interface KBStatusOut {
  guide_count: number;
  builtin_catalog_count: number;
  custom_catalog_count: number;
  initiative_count: number;
  configured: boolean;
  active_model: string;
  inbound_key_count: number;
}

export interface DocCitation {
  slug: string;
  title: string;
  kind: 'guide' | 'cost' | 'benefit';
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number | null;
  max_tokens?: number | null;
  stream?: boolean;
  doc_slug?: string | null;
  initiative_id?: string | null;
  include_initiative_context?: boolean;
}

export interface OpenAIChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: 'assistant';
      content: string;
    };
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  citations?: DocCitation[];
}

export type SSOProvider = 'firebase' | 'entra';
export type FirebaseSignInMethod = 'google' | 'microsoft' | 'email_password' | 'saml' | 'oidc';

export interface SSOSettingsOut {
  enabled: boolean;
  provider: SSOProvider;
  enforce_sso: boolean;
  allowed_domains: string[];
  admin_emails: string[];
  firebase_project_id: string;
  firebase_auth_domain: string;
  firebase_api_key: string;
  firebase_app_id: string;
  firebase_tenant_id: string;
  firebase_sign_in_methods: FirebaseSignInMethod[];
  entra_tenant_id: string;
  entra_client_id: string;
  entra_client_secret_set: boolean;
  entra_client_secret_masked: string;
  entra_authority_host: string;
  entra_redirect_uri: string;
  entra_scopes: string;
  configured: boolean;
  oidc_discovery_url: string;
  updated_at: string | null;
  managed_by_env?: boolean;
  env_vars?: string[];
}

export interface SSOSettingsUpdate {
  enabled: boolean;
  provider: SSOProvider;
  enforce_sso: boolean;
  allowed_domains: string[];
  admin_emails: string[];
  firebase_project_id: string;
  firebase_auth_domain: string;
  firebase_api_key: string;
  firebase_app_id: string;
  firebase_tenant_id: string;
  firebase_sign_in_methods: FirebaseSignInMethod[];
  entra_tenant_id: string;
  entra_client_id: string;
  entra_client_secret?: string | null;
  clear_entra_client_secret?: boolean;
  entra_authority_host: string;
  entra_redirect_uri: string;
  entra_scopes: string;
}

export interface SSOTestRequest {
  provider?: SSOProvider | null;
  firebase_project_id?: string | null;
  entra_tenant_id?: string | null;
  entra_client_id?: string | null;
  entra_authority_host?: string | null;
  timeout_seconds?: number;
}

export interface SSOTestResponse {
  ok: boolean;
  provider: SSOProvider;
  latency_ms: number;
  discovery_url: string;
  issuer: string;
  jwks_uri: string;
  authorization_endpoint: string;
  error: string | null;
}

export interface SSOPublicConfigOut {
  enabled: boolean;
  provider: SSOProvider;
  enforce_sso: boolean;
  configured: boolean;
  oidc_discovery_url: string;
  firebase_project_id: string;
  firebase_auth_domain: string;
  firebase_api_key: string;
  firebase_app_id: string;
  firebase_tenant_id: string;
  firebase_sign_in_methods: FirebaseSignInMethod[];
  entra_tenant_id: string;
  entra_client_id: string;
  entra_authority_host: string;
  entra_redirect_uri: string;
  entra_scopes: string;
}

export type AdminSection = 'users' | 'roles' | 'sso' | 'ai' | 'api-keys' | 'odata' | 'workflows';

export type PermissionKey =
  | 'initiatives:read'
  | 'initiatives:write'
  | 'simulations:run'
  | 'catalog:manage'
  | 'docs:ask'
  | 'admin:users'
  | 'admin:roles'
  | 'admin:ai'
  | 'admin:sso'
  | 'admin:workflows';

export type UserStatus = 'active' | 'invited' | 'disabled';
export type UserAuthProvider = 'local' | 'firebase' | 'entra';

export interface RoleOut {
  id: string;
  name: string;
  description: string;
  permissions: PermissionKey[];
  is_system: boolean;
  user_count: number;
  created_at: string;
  updated_at: string;
}

export interface RoleCreate {
  name: string;
  description: string;
  permissions: PermissionKey[];
}

export interface RoleUpdate {
  name?: string;
  description?: string;
  permissions?: PermissionKey[];
}

export interface UserOut {
  id: string;
  email: string;
  display_name: string;
  role_id: string;
  role_name: string;
  status: UserStatus;
  auth_provider: UserAuthProvider;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserCreate {
  email: string;
  display_name: string;
  role_id: string;
  status: UserStatus;
  auth_provider: UserAuthProvider;
}

export interface UserUpdate {
  email?: string;
  display_name?: string;
  role_id?: string;
  status?: UserStatus;
  auth_provider?: UserAuthProvider;
}

export interface ODataEntitySetSummary {
  name: string;
  entity_type: string;
  key_property: string;
  description: string;
  row_count: number;
  navigation_properties: string[];
}

export interface ODataStatusOut {
  service_root_path: string;
  alias_path: string;
  metadata_path: string;
  odata_version: string;
  auth_mode: 'open' | 'api_key_required';
  inbound_key_count: number;
  entity_sets: ODataEntitySetSummary[];
}

export interface ODataPreviewResponse {
  '@odata.context': string;
  '@odata.count'?: number;
  '@odata.nextLink'?: string;
  value: Array<Record<string, unknown>>;
}

export interface AuthUserOut {
  id: string;
  email: string;
  display_name: string;
  role_id: string;
  role_name: string;
  permissions: PermissionKey[];
  is_admin: boolean;
  photo_url: string;
  auth_provider: UserAuthProvider;
}

export interface AuthMeOut {
  authenticated: boolean;
  auth_required: boolean;
  sso_enabled: boolean;
  provider: SSOProvider;
  user: AuthUserOut | null;
}

// --- Approval workflows ---------------------------------------------------------

export type InitiativeStatus = 'draft' | 'in_review' | 'approved' | 'rejected';
export type ApprovalRequestStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';
export type ApprovalActionKind = 'submit' | 'approve' | 'reject' | 'withdraw' | 'reopen';
export type SmtpSecurity = 'starttls' | 'ssl' | 'none';

export interface WorkflowStep {
  id: string;
  name: string;
  approver_role_ids: string[];
  approver_emails: string[];
  required_approvals: number;
  notify_approvers: boolean;
}

export interface WorkflowOut {
  id: string;
  name: string;
  description: string;
  is_active: boolean;
  is_default: boolean;
  notify_submitter: boolean;
  steps: WorkflowStep[];
  in_use_count: number;
  created_at: string;
  updated_at: string;
}

export interface WorkflowCreate {
  name: string;
  description?: string;
  is_active?: boolean;
  is_default?: boolean;
  notify_submitter?: boolean;
  steps: WorkflowStep[];
}

export type WorkflowUpdate = Partial<WorkflowCreate>;

export interface WorkflowSummaryOut {
  id: string;
  name: string;
  description: string;
  is_default: boolean;
  step_names: string[];
}

export interface ApprovalActionOut {
  id: string;
  action: ApprovalActionKind;
  step_index: number | null;
  step_name: string | null;
  actor_email: string;
  actor_name: string;
  comment: string;
  created_at: string;
}

export interface ApprovalStepProgress {
  index: number;
  name: string;
  required_approvals: number;
  approvals: number;
  state: 'pending' | 'active' | 'approved' | 'rejected' | 'skipped';
  approvers: string[];
}

export interface ApprovalRequestOut {
  id: string;
  initiative_id: string;
  workflow_id: string | null;
  workflow_name: string;
  status: ApprovalRequestStatus;
  current_step_index: number | null;
  submitted_by_email: string;
  submitted_by_name: string;
  submitted_at: string;
  completed_at: string | null;
  steps: ApprovalStepProgress[];
  actions: ApprovalActionOut[];
}

export interface InitiativeApprovalOut {
  initiative_id: string;
  status: InitiativeStatus;
  current_request: ApprovalRequestOut | null;
  history: ApprovalActionOut[];
  can_submit: boolean;
  can_decide: boolean;
  can_withdraw: boolean;
  can_reopen: boolean;
  decide_blocked_reason: string | null;
}

export interface PendingApprovalOut {
  request_id: string;
  initiative_id: string;
  initiative_name: string;
  workflow_name: string;
  step_name: string;
  submitted_by_name: string;
  submitted_at: string;
}

export interface EmailSettingsOut {
  enabled: boolean;
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password_set: boolean;
  password_masked: string;
  from_address: string;
  from_name: string;
  app_base_url: string;
  configured: boolean;
  updated_at: string | null;
}

export interface EmailSettingsUpdate {
  enabled: boolean;
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password?: string | null;
  from_address: string;
  from_name: string;
  app_base_url: string;
}

export interface EmailTestResponse {
  ok: boolean;
  message: string;
}

export interface EmailLogOut {
  id: string;
  recipients: string[];
  subject: string;
  status: 'sent' | 'failed' | 'skipped';
  error: string;
  initiative_id: string | null;
  created_at: string;
}
