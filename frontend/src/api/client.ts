import type {
  ApiKeyCreatedOut,
  ApiKeyOut,
  AuthMeOut,
  BCACompareRequest,
  BCAComparisonRecord,
  BCAComparisonResult,
  BCACreate,
  BCADetail,
  BCASummary,
  BCAUpdate,
  CatalogEntry,
  CatalogEntryCreate,
  CatalogKind,
  DocCitation,
  HealthResponse,
  InitiativeCreate,
  InitiativeDetail,
  InitiativeItemCreate,
  InitiativeItemOut,
  InitiativeItemUpdate,
  InitiativeSummary,
  InitiativeUpdate,
  KBStatusOut,
  LLMModelsFetchRequest,
  LLMModelsFetchResponse,
  LLMSettingsOut,
  LLMSettingsUpdate,
  LLMTestRequest,
  LLMTestResponse,
  ODataPreviewResponse,
  ODataStatusOut,
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionResponse,
  RoleCreate,
  RoleOut,
  RoleUpdate,
  SSOPublicConfigOut,
  SSOSettingsOut,
  SSOSettingsUpdate,
  SSOTestRequest,
  SSOTestResponse,
  SimulationRequest,
  SimulationResult,
  SimulationRunRecord,
  UserCreate,
  UserOut,
  UserStatus,
  UserUpdate,
} from '../types/api';

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

type AuthTokenProvider = (forceRefresh?: boolean) => Promise<string | null>;
let authTokenProvider: AuthTokenProvider | null = null;

export function setAuthTokenProvider(provider: AuthTokenProvider | null): void {
  authTokenProvider = provider;
}

function shouldAttachAuthHeader(path: string): boolean {
  return path !== '/health' && path !== '/api/auth/sso/public';
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function extractErrorMessage(body: unknown, status: number): string {
  if (!body || typeof body !== 'object') {
    return `Request failed with status ${status}`;
  }
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail === 'string') {
    return detail;
  }
  if (Array.isArray(detail)) {
    const msgs = detail
      .map((entry) => {
        if (entry && typeof entry === 'object' && 'msg' in entry) {
          const loc = Array.isArray((entry as { loc?: unknown[] }).loc)
            ? (entry as { loc: unknown[] }).loc.slice(1).join('.')
            : '';
          const msg = String((entry as { msg: unknown }).msg);
          return loc ? `${loc}: ${msg}` : msg;
        }
        return JSON.stringify(entry);
      })
      .filter(Boolean);
    if (msgs.length > 0) {
      return msgs.join('; ');
    }
  }
  return `Request failed with status ${status}`;
}

async function buildRequestHeaders(
  path: string,
  extraHeaders?: HeadersInit,
  forceRefreshToken = false
): Promise<Headers> {
  const headers = new Headers(extraHeaders);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (authTokenProvider && shouldAttachAuthHeader(path)) {
    const token = await authTokenProvider(forceRefreshToken);
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
  }
  return headers;
}

async function request<T>(path: string, init?: RequestInit, hasRetried = false): Promise<T> {
  const headers = await buildRequestHeaders(path, init?.headers, hasRetried);
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  });

  if (
    res.status === 401 &&
    !hasRetried &&
    authTokenProvider &&
    shouldAttachAuthHeader(path)
  ) {
    return request<T>(path, init, true);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  let parsed: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    throw new ApiError(res.status, extractErrorMessage(parsed, res.status));
  }

  return parsed as T;
}

export const api = {
  health: () => request<HealthResponse>('/health'),

  listCatalog: (params?: { domain?: string; kind?: CatalogKind; search?: string }) => {
    const qs = new URLSearchParams();
    if (params?.domain) qs.set('domain', params.domain);
    if (params?.kind) qs.set('kind', params.kind);
    if (params?.search) qs.set('search', params.search);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<CatalogEntry[]>(`/api/catalog${suffix}`);
  },

  createCatalogEntry: (payload: CatalogEntryCreate) =>
    request<CatalogEntry>('/api/catalog', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  listInitiatives: () => request<InitiativeSummary[]>('/api/initiatives'),

  createInitiative: (payload: InitiativeCreate) =>
    request<InitiativeDetail>('/api/initiatives', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getInitiative: (id: string, bcaId?: string | null) => {
    const suffix = bcaId ? `?bca_id=${encodeURIComponent(bcaId)}` : '';
    return request<InitiativeDetail>(`/api/initiatives/${encodeURIComponent(id)}${suffix}`);
  },

  updateInitiative: (id: string, payload: InitiativeUpdate) =>
    request<InitiativeDetail>(`/api/initiatives/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteInitiative: (id: string) =>
    request<void>(`/api/initiatives/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  listBCAs: (initiativeId: string) =>
    request<BCASummary[]>(`/api/initiatives/${encodeURIComponent(initiativeId)}/bcas`),

  createBCA: (initiativeId: string, payload: BCACreate) =>
    request<BCADetail>(`/api/initiatives/${encodeURIComponent(initiativeId)}/bcas`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getBCA: (initiativeId: string, bcaId: string) =>
    request<BCADetail>(
      `/api/initiatives/${encodeURIComponent(initiativeId)}/bcas/${encodeURIComponent(bcaId)}`
    ),

  updateBCA: (initiativeId: string, bcaId: string, payload: BCAUpdate) =>
    request<BCADetail>(
      `/api/initiatives/${encodeURIComponent(initiativeId)}/bcas/${encodeURIComponent(bcaId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }
    ),

  deleteBCA: (initiativeId: string, bcaId: string) =>
    request<void>(
      `/api/initiatives/${encodeURIComponent(initiativeId)}/bcas/${encodeURIComponent(bcaId)}`,
      { method: 'DELETE' }
    ),

  addItem: (initiativeId: string, payload: InitiativeItemCreate, bcaId?: string | null) => {
    const suffix = bcaId ? `?bca_id=${encodeURIComponent(bcaId)}` : '';
    return request<InitiativeItemOut>(
      `/api/initiatives/${encodeURIComponent(initiativeId)}/items${suffix}`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
  },

  updateItem: (itemId: string, payload: InitiativeItemUpdate) =>
    request<InitiativeItemOut>(`/api/items/${encodeURIComponent(itemId)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteItem: (itemId: string) =>
    request<void>(`/api/items/${encodeURIComponent(itemId)}`, {
      method: 'DELETE',
    }),

  simulate: (initiativeId: string, payload: SimulationRequest, bcaId?: string | null) => {
    const suffix = bcaId ? `?bca_id=${encodeURIComponent(bcaId)}` : '';
    return request<SimulationResult>(
      `/api/initiatives/${encodeURIComponent(initiativeId)}/simulate${suffix}`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
  },

  listRuns: (initiativeId: string, bcaId?: string | null) => {
    const suffix = bcaId ? `?bca_id=${encodeURIComponent(bcaId)}` : '';
    return request<SimulationRunRecord[]>(
      `/api/initiatives/${encodeURIComponent(initiativeId)}/runs${suffix}`
    );
  },

  compareBCAs: (initiativeId: string, payload: BCACompareRequest) =>
    request<BCAComparisonResult>(
      `/api/initiatives/${encodeURIComponent(initiativeId)}/bcas/compare`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),

  listComparisons: (initiativeId: string) =>
    request<BCAComparisonRecord[]>(
      `/api/initiatives/${encodeURIComponent(initiativeId)}/bcas/comparisons`
    ),

  getLLMSettings: () => request<LLMSettingsOut>('/api/admin/llm'),

  updateLLMSettings: (payload: LLMSettingsUpdate) =>
    request<LLMSettingsOut>('/api/admin/llm', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  testLLMConnection: (payload: LLMTestRequest) =>
    request<LLMTestResponse>('/api/admin/llm/test', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  fetchLLMModels: (payload: LLMModelsFetchRequest) =>
    request<LLMModelsFetchResponse>('/api/admin/llm/models', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  listApiKeys: () => request<ApiKeyOut[]>('/api/admin/api-keys'),

  createApiKey: (name: string) =>
    request<ApiKeyCreatedOut>('/api/admin/api-keys', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  deleteApiKey: (keyId: string) =>
    request<void>(`/api/admin/api-keys/${encodeURIComponent(keyId)}`, {
      method: 'DELETE',
    }),

  getKBStatus: () => request<KBStatusOut>('/api/admin/kb-status'),

  getSSOSettings: () => request<SSOSettingsOut>('/api/admin/sso'),

  updateSSOSettings: (payload: SSOSettingsUpdate) =>
    request<SSOSettingsOut>('/api/admin/sso', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  testSSODiscovery: (payload: SSOTestRequest) =>
    request<SSOTestResponse>('/api/admin/sso/test', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getSSOPublicConfig: () => request<SSOPublicConfigOut>('/api/auth/sso/public'),

  getAuthMe: () => request<AuthMeOut>('/api/auth/me'),

  listRoles: () => request<RoleOut[]>('/api/admin/roles'),

  createRole: (payload: RoleCreate) =>
    request<RoleOut>('/api/admin/roles', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateRole: (roleId: string, payload: RoleUpdate) =>
    request<RoleOut>(`/api/admin/roles/${encodeURIComponent(roleId)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteRole: (roleId: string) =>
    request<void>(`/api/admin/roles/${encodeURIComponent(roleId)}`, {
      method: 'DELETE',
    }),

  listUsers: (params?: { search?: string; role_id?: string; status?: UserStatus }) => {
    const qs = new URLSearchParams();
    if (params?.search) qs.set('search', params.search);
    if (params?.role_id) qs.set('role_id', params.role_id);
    if (params?.status) qs.set('status_filter', params.status);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<UserOut[]>(`/api/admin/users${suffix}`);
  },

  createUser: (payload: UserCreate) =>
    request<UserOut>('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateUser: (userId: string, payload: UserUpdate) =>
    request<UserOut>(`/api/admin/users/${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteUser: (userId: string) =>
    request<void>(`/api/admin/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    }),

  getODataStatus: () => request<ODataStatusOut>('/api/admin/odata/status'),

  previewOData: (params: {
    entity_set: string;
    filter?: string;
    select?: string;
    orderby?: string;
    expand?: string;
    top?: number;
    skip?: number;
    count?: boolean;
  }) => {
    const qs = new URLSearchParams();
    qs.set('entity_set', params.entity_set);
    if (params.filter?.trim()) qs.set('filter', params.filter.trim());
    if (params.select?.trim()) qs.set('select', params.select.trim());
    if (params.orderby?.trim()) qs.set('orderby', params.orderby.trim());
    if (params.expand?.trim()) qs.set('expand', params.expand.trim());
    if (params.top !== undefined) qs.set('top', String(params.top));
    if (params.skip !== undefined) qs.set('skip', String(params.skip));
    if (params.count !== undefined) qs.set('count', params.count ? 'true' : 'false');
    return request<ODataPreviewResponse>(`/api/admin/odata/preview?${qs.toString()}`);
  },

  streamDocsChat: async (
    payload: OpenAIChatCompletionRequest,
    handlers: {
      onDelta: (chunk: string) => void;
      onCitations?: (citations: DocCitation[]) => void;
      signal?: AbortSignal;
    }
  ): Promise<{ content: string; citations: DocCitation[] }> => {
    const path = '/api/docs-agent/chat/completions';
    let headers = await buildRequestHeaders(path, undefined, false);
    let res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...payload, stream: payload.stream ?? true }),
      signal: handlers.signal,
    });

    if (res.status === 401 && authTokenProvider) {
      headers = await buildRequestHeaders(path, undefined, true);
      res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...payload, stream: payload.stream ?? true }),
        signal: handlers.signal,
      });
    }

    if (!res.ok) {
      let parsed: unknown = null;
      const errText = await res.text();
      if (errText) {
        try {
          parsed = JSON.parse(errText);
        } catch {
          parsed = null;
        }
      }
      throw new ApiError(res.status, extractErrorMessage(parsed, res.status));
    }

    let citations: DocCitation[] = [];
    const rawCitHeader = res.headers.get('X-Docs-Citations');
    if (rawCitHeader) {
      try {
        const parsedCit = JSON.parse(decodeURIComponent(rawCitHeader));
        if (Array.isArray(parsedCit)) {
          citations = parsedCit as DocCitation[];
          handlers.onCitations?.(citations);
        }
      } catch {
        // Ignore malformed optional citation header
      }
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json') || !res.body) {
      const json = (await res.json()) as OpenAIChatCompletionResponse;
      const content = json.choices?.[0]?.message?.content || '';
      const bodyCitations = json.citations || citations;
      if (bodyCitations.length > 0) handlers.onCitations?.(bodyCitations);
      if (content) handlers.onDelta(content);
      return { content, citations: bodyCitations };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';

    const processLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const dataStr = trimmed.slice(5).trim();
      if (!dataStr || dataStr === '[DONE]') return;
      try {
        const chunk = JSON.parse(dataStr) as {
          choices?: Array<{
            delta?: { content?: unknown };
            message?: { content?: unknown };
          }>;
        };
        const choice = chunk.choices?.[0];
        const piece = choice?.delta?.content ?? choice?.message?.content;
        if (typeof piece === 'string' && piece.length > 0) {
          fullContent += piece;
          handlers.onDelta(piece);
        }
      } catch {
        // Ignore keepalive or partial non-JSON lines
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        processLine(line);
      }
    }
    if (buffer.trim()) {
      processLine(buffer);
    }

    return { content: fullContent, citations };
  },
};
