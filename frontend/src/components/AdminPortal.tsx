import { Fragment, useCallback, useEffect, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Autocomplete,
  Badge,
  Button,
  Checkbox,
  Code,
  CopyButton,
  Divider,
  Group,
  NumberInput,
  Paper,
  PasswordInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  IconAlertCircle,
  IconArrowLeft,
  IconBook,
  IconCheck,
  IconCopy,
  IconDatabaseExport,
  IconFingerprint,
  IconKey,
  IconLock,
  IconPlugConnected,
  IconRefresh,
  IconShieldCheck,
  IconShieldLock,
  IconSparkles,
  IconTrash,
  IconUsers,
} from '@tabler/icons-react';
import { api } from '../api/client';
import type {
  AdminSection,
  ApiKeyCreatedOut,
  ApiKeyOut,
  FirebaseSignInMethod,
  KBStatusOut,
  LLMSettingsOut,
  LLMTestResponse,
  SSOProvider,
  SSOSettingsOut,
  SSOTestResponse,
} from '../types/api';
import { AdminODataPanel } from './AdminODataPanel';
import { AdminRolesPanel } from './AdminRolesPanel';
import { AdminUsersPanel } from './AdminUsersPanel';

interface Props {
  activeSection: AdminSection;
  onSelectSection: (section: AdminSection) => void;
  llmSettings: LLMSettingsOut | null;
  onSettingsUpdated: (next: LLMSettingsOut) => void;
  onOpenDocs: () => void;
  onExitAdmin: () => void;
}

const PROVIDER_PRESETS = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'Ollama (Local)', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' },
  { label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', model: 'local-model' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
];

const ENTRA_CLOUD_OPTIONS = [
  { value: 'https://login.microsoftonline.com', label: 'Global Cloud (login.microsoftonline.com)' },
  { value: 'https://login.microsoftonline.us', label: 'US Government (login.microsoftonline.us)' },
  { value: 'https://login.chinacloudapi.cn', label: 'China (login.chinacloudapi.cn)' },
];

const FIREBASE_METHOD_OPTIONS: { value: FirebaseSignInMethod; label: string }[] = [
  { value: 'google', label: 'Google' },
  { value: 'microsoft', label: 'Microsoft' },
  { value: 'email_password', label: 'Email & Password' },
  { value: 'saml', label: 'SAML' },
  { value: 'oidc', label: 'OIDC' },
];

const CODE_BLOCK_STYLE: React.CSSProperties = {
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border-subtle)',
  color: 'var(--text-body)',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  wordBreak: 'break-word',
};

export function AdminPortal({
  activeSection,
  onSelectSection,
  llmSettings,
  onSettingsUpdated,
  onOpenDocs,
  onExitAdmin,
}: Props) {
  const isMobile = useMediaQuery('(max-width: 48em)') ?? false;

  const [baseUrl, setBaseUrl] = useState(llmSettings?.base_url || '');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [clearSavedKey, setClearSavedKey] = useState(false);
  const [model, setModel] = useState(llmSettings?.model || '');
  const [temperature, setTemperature] = useState<number>(llmSettings?.temperature ?? 0.2);
  const [maxTokens, setMaxTokens] = useState<number>(llmSettings?.max_tokens ?? 1024);
  const [timeoutSec, setTimeoutSec] = useState<number>(llmSettings?.timeout_seconds ?? 45);
  const [systemPrompt, setSystemPrompt] = useState(llmSettings?.system_prompt || '');

  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<LLMTestResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [apiKeys, setApiKeys] = useState<ApiKeyOut[]>([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [creatingKey, setCreatingKey] = useState(false);
  const [createdKey, setCreatedKey] = useState<ApiKeyCreatedOut | null>(null);
  const [keysError, setKeysError] = useState<string | null>(null);

  const [kbStatus, setKbStatus] = useState<KBStatusOut | null>(null);

  // SSO configuration state (Firebase default + Entra ID option)
  const [ssoSettings, setSsoSettings] = useState<SSOSettingsOut | null>(null);
  const [ssoEnabled, setSsoEnabled] = useState(false);
  const [ssoProvider, setSsoProvider] = useState<SSOProvider>('firebase');
  const [enforceSso, setEnforceSso] = useState(false);
  const [allowedDomainsText, setAllowedDomainsText] = useState('');
  const [adminEmailsText, setAdminEmailsText] = useState('');

  const [fbProjectId, setFbProjectId] = useState('');
  const [fbAuthDomain, setFbAuthDomain] = useState('');
  const [fbApiKey, setFbApiKey] = useState('');
  const [fbAppId, setFbAppId] = useState('');
  const [fbTenantId, setFbTenantId] = useState('');
  const [fbMethods, setFbMethods] = useState<FirebaseSignInMethod[]>(['google']);

  const [entraTenantId, setEntraTenantId] = useState('');
  const [entraClientId, setEntraClientId] = useState('');
  const [entraSecretInput, setEntraSecretInput] = useState('');
  const [clearEntraSecret, setClearEntraSecret] = useState(false);
  const [entraAuthorityHost, setEntraAuthorityHost] = useState('https://login.microsoftonline.com');
  const [entraRedirectUri, setEntraRedirectUri] = useState('');
  const [entraScopes, setEntraScopes] = useState('openid profile email');

  const [ssoSaving, setSsoSaving] = useState(false);
  const [ssoSaveError, setSsoSaveError] = useState<string | null>(null);
  const [ssoTesting, setSsoTesting] = useState(false);
  const [ssoTestResult, setSsoTestResult] = useState<SSOTestResponse | null>(null);

  const ssoLocked = Boolean(ssoSettings?.managed_by_env);
  const apiKeysLocked = apiKeys.some((k) => Boolean(k.managed_by_env));

  useEffect(() => {
    if (!llmSettings) return;
    setBaseUrl(llmSettings.base_url);
    setModel(llmSettings.model);
    setTemperature(llmSettings.temperature);
    setMaxTokens(llmSettings.max_tokens);
    setTimeoutSec(llmSettings.timeout_seconds);
    setSystemPrompt(llmSettings.system_prompt);
    setApiKeyInput('');
    setClearSavedKey(false);
  }, [llmSettings]);

  const applySsoState = useCallback((s: SSOSettingsOut) => {
    setSsoSettings(s);
    setSsoEnabled(s.enabled);
    setSsoProvider(s.provider);
    setEnforceSso(s.enforce_sso);
    setAllowedDomainsText(s.allowed_domains.join(', '));
    setAdminEmailsText(s.admin_emails.join(', '));
    setFbProjectId(s.firebase_project_id);
    setFbAuthDomain(s.firebase_auth_domain);
    setFbApiKey(s.firebase_api_key);
    setFbAppId(s.firebase_app_id);
    setFbTenantId(s.firebase_tenant_id);
    setFbMethods(s.firebase_sign_in_methods.length > 0 ? s.firebase_sign_in_methods : ['google']);
    setEntraTenantId(s.entra_tenant_id);
    setEntraClientId(s.entra_client_id);
    setEntraSecretInput('');
    setClearEntraSecret(false);
    setEntraAuthorityHost(s.entra_authority_host || 'https://login.microsoftonline.com');
    setEntraRedirectUri(s.entra_redirect_uri);
    setEntraScopes(s.entra_scopes || 'openid profile email');
  }, []);

  const loadAdminExtras = useCallback(async () => {
    try {
      const [keys, status, sso] = await Promise.all([
        api.listApiKeys(),
        api.getKBStatus(),
        api.getSSOSettings(),
      ]);
      setApiKeys(keys);
      setKbStatus(status);
      applySsoState(sso);
    } catch {
      // Non-fatal initial load failure
    }
  }, [applySsoState]);

  useEffect(() => {
    loadAdminExtras();
  }, [loadAdminExtras]);

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaveError(null);
    setSaving(true);
    try {
      const updated = await api.updateLLMSettings({
        base_url: baseUrl.trim(),
        api_key: clearSavedKey ? undefined : apiKeyInput.trim() || undefined,
        clear_api_key: clearSavedKey,
        model: model.trim(),
        temperature,
        max_tokens: maxTokens,
        timeout_seconds: timeoutSec,
        system_prompt: systemPrompt,
      });
      onSettingsUpdated(updated);
      setApiKeyInput('');
      setClearSavedKey(false);
      await loadAdminExtras();
      notifications.show({
        color: 'teal',
        title: 'Admin settings saved',
        message: updated.configured
          ? `Docs Agent ready on ${updated.model}`
          : 'Settings saved (set Endpoint Base URL and Model to activate Docs Agent)',
      });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save LLM settings.');
    } finally {
      setSaving(false);
    }
  };

  const handleFetchModels = async () => {
    setModelsError(null);
    setFetchingModels(true);
    try {
      const res = await api.fetchLLMModels({
        base_url: baseUrl.trim() || undefined,
        api_key: clearSavedKey ? undefined : apiKeyInput.trim() || undefined,
        clear_api_key: clearSavedKey,
        timeout_seconds: timeoutSec,
      });
      if (res.error) {
        setModelsError(res.error);
      } else {
        setFetchedModels(res.models);
        if (res.models.length > 0 && !model.trim()) {
          setModel(res.models[0]);
        }
        notifications.show({
          color: 'teal',
          title: 'Models loaded',
          message: `Found ${res.models.length} model(s) on endpoint.`,
        });
      }
    } catch (err) {
      setModelsError(err instanceof Error ? err.message : 'Failed to fetch upstream models.');
    } finally {
      setFetchingModels(false);
    }
  };

  const handleTestConnection = async () => {
    setTestResult(null);
    setTesting(true);
    try {
      const res = await api.testLLMConnection({
        base_url: baseUrl.trim() || undefined,
        api_key: clearSavedKey ? undefined : apiKeyInput.trim() || undefined,
        clear_api_key: clearSavedKey,
        model: model.trim() || undefined,
        timeout_seconds: timeoutSec,
      });
      setTestResult(res);
    } catch (err) {
      setTestResult({
        ok: false,
        latency_ms: 0,
        model: model.trim(),
        reply_preview: '',
        error: err instanceof Error ? err.message : 'Connection test failed.',
      });
    } finally {
      setTesting(false);
    }
  };

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKeyName.trim() || apiKeysLocked) return;
    setKeysError(null);
    setCreatingKey(true);
    try {
      const created = await api.createApiKey(newKeyName.trim());
      setCreatedKey(created);
      setNewKeyName('');
      await loadAdminExtras();
    } catch (err) {
      setKeysError(err instanceof Error ? err.message : 'Failed to generate API key.');
    } finally {
      setCreatingKey(false);
    }
  };

  const handleDeleteKey = async (keyId: string) => {
    setKeysError(null);
    try {
      await api.deleteApiKey(keyId);
      if (createdKey?.id === keyId) setCreatedKey(null);
      await loadAdminExtras();
      notifications.show({
        color: 'gray',
        title: 'API key revoked',
        message: 'Inbound /v1 consumers using this key can no longer authenticate.',
      });
    } catch (err) {
      setKeysError(err instanceof Error ? err.message : 'Failed to revoke key.');
    }
  };

  const handleSaveSSO = async (e: React.FormEvent) => {
    e.preventDefault();
    if (ssoLocked) return;
    setSsoSaveError(null);
    setSsoSaving(true);
    try {
      const allowedDomains = allowedDomainsText
        .split(',')
        .map((s) => s.trim().toLowerCase().replace(/^@+/, ''))
        .filter(Boolean);
      const adminEmails = adminEmailsText
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);

      const saved = await api.updateSSOSettings({
        enabled: ssoEnabled,
        provider: ssoProvider,
        enforce_sso: enforceSso,
        allowed_domains: allowedDomains,
        admin_emails: adminEmails,
        firebase_project_id: fbProjectId.trim(),
        firebase_auth_domain: fbAuthDomain.trim(),
        firebase_api_key: fbApiKey.trim(),
        firebase_app_id: fbAppId.trim(),
        firebase_tenant_id: fbTenantId.trim(),
        firebase_sign_in_methods: fbMethods.length > 0 ? fbMethods : ['google'],
        entra_tenant_id: entraTenantId.trim(),
        entra_client_id: entraClientId.trim(),
        entra_client_secret: clearEntraSecret ? undefined : entraSecretInput.trim() || undefined,
        clear_entra_client_secret: clearEntraSecret,
        entra_authority_host: entraAuthorityHost,
        entra_redirect_uri: entraRedirectUri.trim(),
        entra_scopes: entraScopes.trim() || 'openid profile email',
      });
      applySsoState(saved);
      notifications.show({
        color: 'teal',
        title: 'SSO settings saved',
        message: `${saved.provider === 'firebase' ? 'Firebase Auth' : 'Microsoft Entra ID'} (${saved.enabled ? 'Enabled' : 'Saved / Disabled'})`,
      });
    } catch (err) {
      setSsoSaveError(err instanceof Error ? err.message : 'Failed to save SSO settings.');
    } finally {
      setSsoSaving(false);
    }
  };

  const handleTestSSO = async () => {
    setSsoTestResult(null);
    setSsoTesting(true);
    try {
      const res = await api.testSSODiscovery({
        provider: ssoProvider,
        firebase_project_id: fbProjectId.trim() || undefined,
        entra_tenant_id: entraTenantId.trim() || undefined,
        entra_client_id: entraClientId.trim() || undefined,
        entra_authority_host: entraAuthorityHost,
      });
      setSsoTestResult(res);
    } catch (err) {
      setSsoTestResult({
        ok: false,
        provider: ssoProvider,
        latency_ms: 0,
        discovery_url: '',
        issuer: '',
        jwks_uri: '',
        authorization_endpoint: '',
        error: err instanceof Error ? err.message : 'SSO discovery check failed.',
      });
    } finally {
      setSsoTesting(false);
    }
  };

  const computedDiscoveryUrl =
    ssoProvider === 'firebase'
      ? fbProjectId.trim()
        ? `https://securetoken.google.com/${fbProjectId.trim()}/.well-known/openid-configuration`
        : ''
      : entraTenantId.trim()
        ? `${entraAuthorityHost.replace(/\/$/, '')}/${entraTenantId.trim()}/v2.0/.well-known/openid-configuration`
        : '';

  const gatewayOrigin =
    typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173';
  const curlExample = `curl ${gatewayOrigin}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  ${apiKeys.length > 0 ? '-H "Authorization: Bearer YOUR_BCA_KEY" \\\n  ' : ''}-d '{
    "model": "bca-docs-agent",
    "messages": [{"role": "user", "content": "When should I use BEN-TOIL-01?"}]
  }'`;

  return (
    <Stack gap="md">
      <div className="mantine-hidden-from-sm">
        <Stack gap="xs">
          <Group justify="space-between" align="center" wrap="wrap" gap="xs">
            <div>
              <Title order={4}>Admin Portal</Title>
              <Text size="xs" c="var(--text-muted)">
                Users, roles, SSO, AI models & API keys
              </Text>
            </div>
            <Button
              type="button"
              size="xs"
              variant="default"
              leftSection={<IconArrowLeft size={13} />}
              onClick={onExitAdmin}
            >
              Back to Workspace
            </Button>
          </Group>

          <Tabs
            value={activeSection}
            onChange={(val) => val && onSelectSection(val as AdminSection)}
          >
            <Tabs.List className="tabs-scroll-list">
              <Tabs.Tab value="users" leftSection={<IconUsers size={14} />}>
                Users
              </Tabs.Tab>
              <Tabs.Tab value="roles" leftSection={<IconShieldLock size={14} />}>
                Roles
              </Tabs.Tab>
              <Tabs.Tab value="sso" leftSection={<IconFingerprint size={14} />}>
                SSO
              </Tabs.Tab>
              <Tabs.Tab value="ai" leftSection={<IconSparkles size={14} />}>
                AI
              </Tabs.Tab>
              <Tabs.Tab value="api-keys" leftSection={<IconKey size={14} />}>
                API Keys
              </Tabs.Tab>
              <Tabs.Tab value="odata" leftSection={<IconDatabaseExport size={14} />}>
                OData
              </Tabs.Tab>
            </Tabs.List>
          </Tabs>
        </Stack>
      </div>

      {activeSection === 'users' && <AdminUsersPanel />}

      {activeSection === 'roles' && <AdminRolesPanel />}

      {activeSection === 'odata' && (
        <AdminODataPanel onGoToApiKeys={() => onSelectSection('api-keys')} />
      )}

      {/* Section: Upstream LLM Provider */}
      {activeSection === 'ai' && (
        <Paper
          component="form"
          onSubmit={handleSaveSettings}
          withBorder
          p={{ base: 'sm', sm: 'md' }}
          radius="md"
          bg="var(--bg-surface)"
        >
        <Stack gap="sm">
          <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs">
            <div>
              <Title order={4}>OpenAI-Compatible Provider Configuration</Title>
              <Text size="xs" c="var(--text-muted)">
                Configure the upstream endpoint, API key, and model powering the Docs Agent and /v1 gateway
              </Text>
            </div>
            <Group gap={6} wrap="nowrap">
              <span
                className="status-dot"
                style={{
                  backgroundColor: llmSettings?.configured ? 'var(--chart-pos)' : 'var(--chart-warn)',
                }}
              />
              <Text size="xs" fw={600} c="var(--text-heading)">
                {llmSettings?.configured ? `Configured (${llmSettings.model})` : 'Not Configured'}
              </Text>
            </Group>
          </Group>

          <Group gap="xs" wrap="wrap" align="center">
            <Text size="xs" c="var(--text-muted)">
              Presets:
            </Text>
            {PROVIDER_PRESETS.map((preset) => (
              <Button
                key={preset.label}
                type="button"
                size="compact-xs"
                variant="default"
                onClick={() => {
                  setBaseUrl(preset.baseUrl);
                  if (!model.trim() || PROVIDER_PRESETS.some((p) => p.model === model.trim())) {
                    setModel(preset.model);
                  }
                }}
              >
                {preset.label}
              </Button>
            ))}
          </Group>

          {saveError && (
            <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />} title="Save error">
              {saveError}
            </Alert>
          )}

          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <TextInput
              label="Endpoint Base URL"
              description="Root URL ending in /v1 (e.g., https://api.openai.com/v1 or http://localhost:11434/v1)"
              placeholder="https://api.openai.com/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.currentTarget.value)}
            />

            <div>
              <PasswordInput
                label="Upstream API Key"
                description={
                  clearSavedKey
                    ? 'Saved key will be cleared on Save (for keyless local servers).'
                    : llmSettings?.api_key_set
                      ? `Saved key: ${llmSettings.api_key_masked} — leave blank to keep it (re-enter it if you change the Endpoint Base URL)`
                      : 'Stored securely on backend SQLite; never sent back to browser.'
                }
                placeholder={llmSettings?.api_key_set ? '•••••••• (unchanged)' : 'sk-...'}
                value={apiKeyInput}
                disabled={clearSavedKey}
                onChange={(e) => setApiKeyInput(e.currentTarget.value)}
              />
              {llmSettings?.api_key_set && (
                <Button
                  type="button"
                  size="compact-xs"
                  variant="subtle"
                  mt={4}
                  px={4}
                  onClick={() => {
                    setClearSavedKey((prev) => !prev);
                    setApiKeyInput('');
                  }}
                >
                  {clearSavedKey ? 'Undo clear saved key' : 'Clear saved API key'}
                </Button>
              )}
            </div>
          </SimpleGrid>

          <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
            <div style={{ gridColumn: isMobile ? undefined : 'span 2' }}>
              <Autocomplete
                label="Model ID"
                description="Type a model ID or click Fetch Models to list upstream /models"
                placeholder="gpt-4o-mini or llama3.2"
                data={fetchedModels}
                value={model}
                onChange={setModel}
              />
            </div>
            <Group align="flex-end">
              <Button
                type="button"
                variant="default"
                fullWidth
                loading={fetchingModels}
                leftSection={<IconRefresh size={14} />}
                onClick={handleFetchModels}
              >
                Fetch Models
              </Button>
            </Group>
          </SimpleGrid>

          {modelsError && (
            <div className="callout-note" role="note">
              Model discovery failed: {modelsError}
            </div>
          )}

          <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
            <NumberInput
              label="Temperature"
              min={0}
              max={2}
              step={0.1}
              decimalScale={2}
              value={temperature}
              onChange={(v) => setTemperature(typeof v === 'number' ? v : 0.2)}
            />
            <NumberInput
              label="Max Tokens"
              min={64}
              max={16384}
              step={128}
              value={maxTokens}
              onChange={(v) => setMaxTokens(typeof v === 'number' ? v : 1024)}
            />
            <NumberInput
              label="Timeout (seconds)"
              min={5}
              max={180}
              step={5}
              value={timeoutSec}
              onChange={(v) => setTimeoutSec(typeof v === 'number' ? v : 45)}
            />
          </SimpleGrid>

          <Textarea
            label="System Prompt Addendum (optional)"
            description="Appended after the grounded ValueStream BCA documentation index."
            placeholder="Optional organization-specific guidance, hurdle-rate policies, or tone rules..."
            autosize
            minRows={2}
            maxRows={5}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.currentTarget.value)}
          />

          {testResult && (
            <Alert
              color={testResult.ok ? 'teal' : 'red'}
              variant="light"
              title={
                testResult.ok
                  ? `Connection OK (${testResult.latency_ms.toFixed(0)} ms · ${testResult.model})`
                  : `Connection Failed (${testResult.latency_ms.toFixed(0)} ms)`
              }
            >
              <Text size="xs">
                {testResult.ok
                  ? `Reply preview: "${testResult.reply_preview}"`
                  : testResult.error}
              </Text>
            </Alert>
          )}

          <Group justify="flex-end" wrap="wrap" grow={isMobile}>
            <Button
              type="button"
              variant="default"
              loading={testing}
              leftSection={<IconPlugConnected size={14} />}
              onClick={handleTestConnection}
            >
              Test Connection
            </Button>
            <Button type="submit" loading={saving}>
              Save Settings
            </Button>
          </Group>
        </Stack>
      </Paper>
      )}

      {/* Section: Single Sign-On (SSO) Configuration */}
      {activeSection === 'sso' && (
        <Paper
          component="form"
          onSubmit={handleSaveSSO}
          withBorder
          p={{ base: 'sm', sm: 'md' }}
          radius="md"
          bg="var(--bg-surface)"
        >
        <Stack gap="sm">
          <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs">
            <div>
              <Title order={4}>Single Sign-On (SSO) Configuration</Title>
              <Text size="xs" c="var(--text-muted)">
                Configure enterprise identity federation — defaults to Firebase Auth with Microsoft Entra ID as an alternate provider
              </Text>
            </div>
            <Group gap={6} wrap="nowrap">
              {ssoLocked && (
                <Badge size="xs" variant="light" color="blue" leftSection={<IconLock size={11} />}>
                  Managed by Env
                </Badge>
              )}
              <span
                className="status-dot"
                style={{
                  backgroundColor: ssoSettings?.enabled
                    ? ssoSettings.configured
                      ? 'var(--chart-pos)'
                      : 'var(--chart-warn)'
                    : 'var(--text-muted)',
                }}
              />
              <Text size="xs" fw={600} c="var(--text-heading)">
                {ssoEnabled ? 'Enabled' : 'Disabled'} ·{' '}
                {ssoProvider === 'firebase' ? 'Firebase' : 'Microsoft Entra ID'}
              </Text>
            </Group>
          </Group>

          {ssoLocked && (
            <Alert color="blue" variant="light" icon={<IconLock size={16} />} title="Locked by Environment Variables">
              <Stack gap={6}>
                <Text size="xs">
                  SSO authentication is configured via environment variables and cannot be edited in the Admin Portal.
                  Update your <Code>.env</Code> file and restart the server to make changes.
                </Text>
                {(ssoSettings?.env_vars?.length ?? 0) > 0 && (
                  <Group gap={6} wrap="wrap">
                    {ssoSettings?.env_vars?.map((name) => (
                      <Code key={name}>{name}</Code>
                    ))}
                  </Group>
                )}
              </Stack>
            </Alert>
          )}

          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm" style={{ alignItems: 'center' }}>
            <div>
              <Text size="xs" fw={500} c="var(--text-body)" mb={4}>
                Identity Provider
              </Text>
              <SegmentedControl
                fullWidth={isMobile}
                disabled={ssoLocked}
                value={ssoProvider}
                onChange={(val) => {
                  setSsoProvider((val as SSOProvider) || 'firebase');
                  setSsoTestResult(null);
                  setSsoSaveError(null);
                }}
                data={[
                  { value: 'firebase', label: 'Firebase (Default)' },
                  { value: 'entra', label: 'Microsoft Entra ID' },
                ]}
              />
            </div>

            <Group gap="md" wrap="wrap">
              <Switch
                checked={ssoEnabled}
                disabled={ssoLocked}
                onChange={(e) => {
                  const checked = e.currentTarget.checked;
                  setSsoEnabled(checked);
                  if (!checked) setEnforceSso(false);
                }}
                label="Enable SSO"
              />
              <Switch
                checked={enforceSso}
                disabled={ssoLocked || !ssoEnabled}
                onChange={(e) => setEnforceSso(e.currentTarget.checked)}
                label="Require SSO for app access"
              />
            </Group>
          </SimpleGrid>

          {ssoSaveError && (
            <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />} title="SSO Validation Error">
              {ssoSaveError}
            </Alert>
          )}

          {ssoProvider === 'firebase' ? (
            <Stack gap="sm">
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                <TextInput
                  label="Firebase Project ID"
                  placeholder="my-bca-project"
                  disabled={ssoLocked}
                  value={fbProjectId}
                  onChange={(e) => {
                    const next = e.currentTarget.value;
                    const prevAuto = fbProjectId.trim() ? `${fbProjectId.trim()}.firebaseapp.com` : '';
                    setFbProjectId(next);
                    if (!fbAuthDomain.trim() || fbAuthDomain === prevAuto) {
                      setFbAuthDomain(next.trim() ? `${next.trim()}.firebaseapp.com` : '');
                    }
                  }}
                />
                <TextInput
                  label="Auth Domain"
                  placeholder="my-bca-project.firebaseapp.com"
                  disabled={ssoLocked}
                  value={fbAuthDomain}
                  onChange={(e) => setFbAuthDomain(e.currentTarget.value)}
                />
                <TextInput
                  label="Web API Key"
                  placeholder="AIzaSy..."
                  disabled={ssoLocked}
                  value={fbApiKey}
                  onChange={(e) => setFbApiKey(e.currentTarget.value)}
                />
                <TextInput
                  label="Web App ID (optional)"
                  placeholder="1:1234567890:web:abc123"
                  disabled={ssoLocked}
                  value={fbAppId}
                  onChange={(e) => setFbAppId(e.currentTarget.value)}
                />
                <TextInput
                  label="Identity Platform Tenant ID (optional)"
                  placeholder="Leave blank for single-tenant project"
                  disabled={ssoLocked}
                  value={fbTenantId}
                  onChange={(e) => setFbTenantId(e.currentTarget.value)}
                />
              </SimpleGrid>

              <Checkbox.Group
                label="Enabled Firebase Sign-In Methods"
                value={fbMethods}
                onChange={(vals) => {
                  const typed = vals as FirebaseSignInMethod[];
                  if (typed.length > 0) setFbMethods(typed);
                }}
              >
                <Group gap="md" wrap="wrap" mt={6}>
                  {FIREBASE_METHOD_OPTIONS.map((opt) => (
                    <Checkbox key={opt.value} value={opt.value} label={opt.label} size="sm" disabled={ssoLocked} />
                  ))}
                </Group>
              </Checkbox.Group>

              <div className="callout-note" role="note">
                <div>
                  <strong>Firebase Setup Note:</strong> Add hostnames only (no protocol or port, e.g.{' '}
                  <code>localhost</code>) under Firebase Console → Authentication → Settings → Authorized domains.
                </div>
                {computedDiscoveryUrl && (
                  <div style={{ marginTop: 4 }}>
                    <strong>OIDC Discovery:</strong> <code>{computedDiscoveryUrl}</code>
                  </div>
                )}
              </div>
            </Stack>
          ) : (
            <Stack gap="sm">
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                <TextInput
                  label="Directory (Tenant) ID"
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  disabled={ssoLocked}
                  value={entraTenantId}
                  onChange={(e) => setEntraTenantId(e.currentTarget.value)}
                />
                <TextInput
                  label="Application (Client) ID"
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  disabled={ssoLocked}
                  value={entraClientId}
                  onChange={(e) => setEntraClientId(e.currentTarget.value)}
                />
                <div>
                  <PasswordInput
                    label="Client Secret (optional for SPA PKCE)"
                    description={
                      ssoLocked
                        ? ssoSettings?.entra_client_secret_set
                          ? `Configured via ENTRA_CLIENT_SECRET (${ssoSettings.entra_client_secret_masked})`
                          : 'Not set in environment.'
                        : clearEntraSecret
                          ? 'Saved client secret will be cleared on Save.'
                          : ssoSettings?.entra_client_secret_set
                            ? `Saved secret: ${ssoSettings.entra_client_secret_masked} — leave blank to keep existing`
                            : 'Leave blank for public SPA PKCE flows; required only for confidential server exchange.'
                    }
                    placeholder={ssoSettings?.entra_client_secret_set ? '•••••••• (unchanged)' : 'Optional client secret'}
                    value={entraSecretInput}
                    disabled={ssoLocked || clearEntraSecret}
                    onChange={(e) => setEntraSecretInput(e.currentTarget.value)}
                  />
                  {!ssoLocked && ssoSettings?.entra_client_secret_set && (
                    <Button
                      type="button"
                      size="compact-xs"
                      variant="subtle"
                      mt={4}
                      px={4}
                      onClick={() => {
                        setClearEntraSecret((prev) => !prev);
                        setEntraSecretInput('');
                      }}
                    >
                      {clearEntraSecret ? 'Undo clear saved secret' : 'Clear saved client secret'}
                    </Button>
                  )}
                </div>
                <Select
                  label="Cloud Authority Host"
                  disabled={ssoLocked}
                  data={ENTRA_CLOUD_OPTIONS}
                  value={entraAuthorityHost}
                  onChange={(v) => setEntraAuthorityHost(v || 'https://login.microsoftonline.com')}
                  allowDeselect={false}
                />
                <TextInput
                  label="Redirect URI"
                  placeholder={`${gatewayOrigin}/auth/callback`}
                  disabled={ssoLocked}
                  value={entraRedirectUri}
                  onChange={(e) => setEntraRedirectUri(e.currentTarget.value)}
                />
                <TextInput
                  label="OIDC Scopes"
                  placeholder="openid profile email"
                  disabled={ssoLocked}
                  value={entraScopes}
                  onChange={(e) => setEntraScopes(e.currentTarget.value)}
                />
              </SimpleGrid>

              <div className="callout-note" role="note">
                <div>
                  <strong>Microsoft Entra ID Note:</strong> Register{' '}
                  <code>{entraRedirectUri.trim() || `${gatewayOrigin}/auth/callback`}</code> as a Single-page application or Web redirect URI in Entra App Registrations.
                </div>
                {computedDiscoveryUrl && (
                  <div style={{ marginTop: 4 }}>
                    <strong>OIDC Discovery:</strong> <code>{computedDiscoveryUrl}</code>
                  </div>
                )}
              </div>
            </Stack>
          )}

          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <TextInput
              label="Allowed Email Domains (comma-separated, optional)"
              placeholder="company.com, subsidiary.org"
              disabled={ssoLocked}
              value={allowedDomainsText}
              onChange={(e) => setAllowedDomainsText(e.currentTarget.value)}
            />
            <TextInput
              label="Admin Role Emails (comma-separated, optional)"
              placeholder="admin@company.com, lead@company.com"
              disabled={ssoLocked}
              value={adminEmailsText}
              onChange={(e) => setAdminEmailsText(e.currentTarget.value)}
            />
          </SimpleGrid>

          {ssoTestResult && (
            <Alert
              color={ssoTestResult.ok ? 'teal' : 'red'}
              variant="light"
              title={
                ssoTestResult.ok
                  ? `OIDC Discovery OK (${ssoTestResult.latency_ms.toFixed(0)} ms · ${ssoTestResult.provider === 'firebase' ? 'Firebase' : 'Entra ID'})`
                  : `OIDC Discovery Failed (${ssoTestResult.latency_ms.toFixed(0)} ms)`
              }
            >
              {ssoTestResult.ok ? (
                <Stack gap={2}>
                  <Text size="xs">
                    <strong>Issuer:</strong> {ssoTestResult.issuer}
                  </Text>
                  <Text size="xs">
                    <strong>JWKS URI:</strong> {ssoTestResult.jwks_uri}
                  </Text>
                  {ssoTestResult.authorization_endpoint && (
                    <Text size="xs">
                      <strong>Authorize URL:</strong> {ssoTestResult.authorization_endpoint}
                    </Text>
                  )}
                </Stack>
              ) : (
                <Text size="xs">{ssoTestResult.error}</Text>
              )}
            </Alert>
          )}

          <Group justify="flex-end" wrap="wrap" grow={isMobile}>
            <Button
              type="button"
              variant="default"
              loading={ssoTesting}
              leftSection={<IconShieldCheck size={14} />}
              onClick={handleTestSSO}
            >
              Test SSO Discovery
            </Button>
            <Button
              type="submit"
              loading={ssoSaving}
              disabled={ssoLocked}
              leftSection={ssoLocked ? <IconLock size={14} /> : undefined}
            >
              {ssoLocked ? 'Locked by Environment' : 'Save SSO Settings'}
            </Button>
          </Group>
        </Stack>
      </Paper>
      )}

      {/* Section: OpenAI-Compatible Gateway & Inbound Access Keys */}
      {activeSection === 'api-keys' && (
        <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
          <Stack gap="sm">
            <div>
              <Title order={4}>OpenAI-Compatible Gateway & Access Keys</Title>
              <Text size="xs" c="var(--text-muted)">
                External OpenAI SDKs, CLI tools, or LAN clients can connect directly to this server’s{' '}
                <Code>/v1</Code> API using model <Code>bca-docs-agent</Code>.
              </Text>
            </div>

          <Code block style={CODE_BLOCK_STYLE}>
            {curlExample}
          </Code>

          {apiKeysLocked && (
            <Alert color="blue" variant="light" icon={<IconLock size={16} />} title="Locked by Environment (BCA_API_KEYS)">
              <Text size="xs">
                Inbound API keys for <Code>/v1/*</Code> and <Code>/odata/*</Code> are managed via the{' '}
                <Code>BCA_API_KEYS</Code> environment variable. Creating or revoking keys in the Admin Portal is disabled.
              </Text>
            </Alert>
          )}

          <BoxCreateKeyForm
            newKeyName={newKeyName}
            setNewKeyName={setNewKeyName}
            creatingKey={creatingKey}
            onSubmit={handleCreateKey}
            isMobile={isMobile}
            disabled={apiKeysLocked}
          />

          {keysError && (
            <Alert color="red" variant="light" p="xs">
              <Text size="xs">{keysError}</Text>
            </Alert>
          )}

          {createdKey && (
            <div className="callout-note" role="note">
              <Stack gap={6}>
                <Group justify="space-between" wrap="wrap" gap="xs">
                  <Text size="xs" fw={700} c="inherit">
                    New API Key Created ({createdKey.name}) — copy now; it will not be shown again:
                  </Text>
                  <CopyButton value={createdKey.secret_key}>
                    {({ copied, copy }) => (
                      <Button
                        type="button"
                        size="compact-xs"
                        variant="default"
                        leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                        onClick={copy}
                      >
                        {copied ? 'Copied' : 'Copy Key'}
                      </Button>
                    )}
                  </CopyButton>
                </Group>
                <Code block style={CODE_BLOCK_STYLE}>
                  {createdKey.secret_key}
                </Code>
              </Stack>
            </div>
          )}

          {apiKeys.length === 0 ? (
            <Text size="xs" c="var(--text-muted)">
              No inbound API keys configured — `/v1/*` and `/odata/*` currently allow open local/LAN access without credentials. Issue a key above to require authentication across both endpoints.
            </Text>
          ) : isMobile ? (
            <Stack gap={0}>
              {apiKeys.map((k, idx) => (
                <Fragment key={k.id}>
                  {idx > 0 && <Divider color="var(--border-divider)" my="xs" />}
                  <Group justify="space-between" wrap="nowrap" gap="xs">
                    <div style={{ minWidth: 0 }}>
                      <Text size="xs" fw={600} c="var(--text-heading)">
                        {k.name}
                      </Text>
                      <Text size="xs" ff="monospace" c="var(--text-muted)">
                        {k.key_prefix || k.key_last4 ? `${k.key_prefix}••••${k.key_last4}` : '••••'}
                      </Text>
                      <Text size="xs" c="var(--text-muted)">
                        Last used: {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'Never'}
                      </Text>
                    </div>
                    {k.managed_by_env ? (
                      <Badge size="xs" variant="light" color="blue" leftSection={<IconLock size={10} />}>
                        Env
                      </Badge>
                    ) : (
                      <Button
                        type="button"
                        size="compact-xs"
                        variant="default"
                        onClick={() => handleDeleteKey(k.id)}
                      >
                        Revoke
                      </Button>
                    )}
                  </Group>
                </Fragment>
              ))}
            </Stack>
          ) : (
            <div tabIndex={0} role="region" aria-label="Inbound API keys" className="table-region">
              <Table verticalSpacing={6} horizontalSpacing="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Name</Table.Th>
                    <Table.Th>Key</Table.Th>
                    <Table.Th>Created</Table.Th>
                    <Table.Th>Last Used</Table.Th>
                    <Table.Th ta="right">Action</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {apiKeys.map((k) => (
                    <Table.Tr key={k.id}>
                      <Table.Td fw={600}>{k.name}</Table.Td>
                      <Table.Td ff="monospace">
                        {k.key_prefix || k.key_last4 ? `${k.key_prefix}••••${k.key_last4}` : '••••'}
                      </Table.Td>
                      <Table.Td>
                        {k.managed_by_env ? 'Managed via env' : new Date(k.created_at).toLocaleDateString()}
                      </Table.Td>
                      <Table.Td>
                        {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'Never'}
                      </Table.Td>
                      <Table.Td ta="right">
                        {k.managed_by_env ? (
                          <Badge size="xs" variant="light" color="blue" leftSection={<IconLock size={10} />}>
                            Env
                          </Badge>
                        ) : (
                          <ActionIcon
                            type="button"
                            variant="subtle"
                            color="gray"
                            size="sm"
                            aria-label={`Revoke key ${k.name}`}
                            onClick={() => handleDeleteKey(k.id)}
                          >
                            <IconTrash size={14} />
                          </ActionIcon>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          )}
        </Stack>
      </Paper>
      )}

      {/* Section: Knowledge Base Index (under AI Management) */}
      {activeSection === 'ai' && (
        <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
          <Stack gap="sm">
            <Group justify="space-between" align="center" wrap="wrap" gap="xs">
              <div>
                <Title order={4}>Docs Agent Knowledge Base Status</Title>
                <Text size="xs" c="var(--text-muted)">
                  Live SQLite catalog templates and initiatives indexed on every prompt automatically
                </Text>
              </div>
              <Button
                type="button"
                size="xs"
                variant="default"
                leftSection={<IconBook size={13} />}
                onClick={onOpenDocs}
              >
                Browse Documentation
              </Button>
            </Group>

            <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="xs">
              <Paper withBorder p="xs" radius="sm" bg="var(--bg-subtle)">
                <Text size="xs" c="var(--text-muted)">
                  Methodology Guides
                </Text>
                <Text size="md" fw={700} c="var(--text-heading)" className="tabular-nums">
                  {kbStatus?.guide_count ?? 5}
                </Text>
              </Paper>
              <Paper withBorder p="xs" radius="sm" bg="var(--bg-subtle)">
                <Text size="xs" c="var(--text-muted)">
                  Built-in Templates
                </Text>
                <Text size="md" fw={700} c="var(--text-heading)" className="tabular-nums">
                  {kbStatus?.builtin_catalog_count ?? 9}
                </Text>
              </Paper>
              <Paper withBorder p="xs" radius="sm" bg="var(--bg-subtle)">
                <Text size="xs" c="var(--text-muted)">
                  Custom Templates
                </Text>
                <Text size="md" fw={700} c="var(--text-heading)" className="tabular-nums">
                  {kbStatus?.custom_catalog_count ?? 0}
                </Text>
              </Paper>
              <Paper withBorder p="xs" radius="sm" bg="var(--bg-subtle)">
                <Text size="xs" c="var(--text-muted)">
                  Initiatives
                </Text>
                <Text size="md" fw={700} c="var(--text-heading)" className="tabular-nums">
                  {kbStatus?.initiative_count ?? 0}
                </Text>
              </Paper>
            </SimpleGrid>
          </Stack>
        </Paper>
      )}
    </Stack>
  );
}

function BoxCreateKeyForm({
  newKeyName,
  setNewKeyName,
  creatingKey,
  onSubmit,
  isMobile,
  disabled = false,
}: {
  newKeyName: string;
  setNewKeyName: (v: string) => void;
  creatingKey: boolean;
  onSubmit: (e: React.FormEvent) => void;
  isMobile: boolean;
  disabled?: boolean;
}) {
  return (
    <form onSubmit={onSubmit}>
      <Group gap="xs" wrap="wrap" align="flex-end">
        <TextInput
          label="Issue Inbound Client Key"
          placeholder={disabled ? 'Locked by BCA_API_KEYS' : 'Key label (e.g., Internal Bot)'}
          value={newKeyName}
          disabled={disabled}
          onChange={(e) => setNewKeyName(e.currentTarget.value)}
          style={{ flex: '1 1 200px', minWidth: 0, width: isMobile ? '100%' : undefined }}
          required
        />
        <Button
          type="submit"
          size="sm"
          variant="default"
          fullWidth={isMobile}
          loading={creatingKey}
          disabled={disabled}
          leftSection={disabled ? <IconLock size={14} /> : <IconKey size={14} />}
        >
          {disabled ? 'Locked by Env' : 'Generate Key'}
        </Button>
      </Group>
    </form>
  );
}
