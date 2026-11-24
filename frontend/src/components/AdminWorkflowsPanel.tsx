import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Divider,
  Group,
  Modal,
  MultiSelect,
  NumberInput,
  Paper,
  PasswordInput,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  IconAlertCircle,
  IconArrowDown,
  IconArrowUp,
  IconEdit,
  IconMail,
  IconPlus,
  IconRefresh,
  IconSend,
  IconTrash,
} from '@tabler/icons-react';
import { api } from '../api/client';
import type {
  EmailLogOut,
  EmailSettingsOut,
  EmailSettingsUpdate,
  RoleOut,
  SmtpSecurity,
  WorkflowOut,
  WorkflowStep,
} from '../types/api';
import { FieldInfo, FieldLabel } from './FieldInfo';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function newStep(n: number): WorkflowStep {
  return {
    id: '',
    name: n === 1 ? 'Review' : `Step ${n}`,
    approver_role_ids: [],
    approver_emails: [],
    required_approvals: 1,
    notify_approvers: true,
  };
}

interface DraftWorkflow {
  name: string;
  description: string;
  is_active: boolean;
  is_default: boolean;
  notify_submitter: boolean;
  steps: WorkflowStep[];
}

const EMPTY_DRAFT: DraftWorkflow = {
  name: '',
  description: '',
  is_active: true,
  is_default: false,
  notify_submitter: true,
  steps: [newStep(1)],
};

function draftError(d: DraftWorkflow): string | null {
  if (d.name.trim().length < 2) return 'Workflow name must be at least 2 characters.';
  if (d.steps.length === 0) return 'Add at least one step.';
  for (const [i, s] of d.steps.entries()) {
    if (!s.name.trim()) return `Step ${i + 1} needs a name.`;
    if (s.approver_role_ids.length === 0 && s.approver_emails.length === 0) {
      return `Step "${s.name}" needs at least one approver role or email.`;
    }
    const bad = s.approver_emails.find((e) => !EMAIL_RE.test(e));
    if (bad) return `"${bad}" is not a valid email address.`;
  }
  return null;
}

export function AdminWorkflowsPanel() {
  const isMobile = useMediaQuery('(max-width: 48em)') ?? false;
  const [workflows, setWorkflows] = useState<WorkflowOut[]>([]);
  const [roles, setRoles] = useState<RoleOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [opened, { open, close }] = useDisclosure(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftWorkflow>(EMPTY_DRAFT);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const roleName = useMemo(() => Object.fromEntries(roles.map((r) => [r.id, r.name])), [roles]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [wfs, rs] = await Promise.all([api.listWorkflows(), api.listRoles().catch(() => [])]);
      setWorkflows(wfs);
      setRoles(rs);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load workflows.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = () => {
    setEditingId(null);
    setDraft({ ...EMPTY_DRAFT, is_default: workflows.every((w) => !w.is_default), steps: [newStep(1)] });
    setFormError(null);
    open();
  };

  const openEdit = (wf: WorkflowOut) => {
    setEditingId(wf.id);
    setDraft({
      name: wf.name,
      description: wf.description,
      is_active: wf.is_active,
      is_default: wf.is_default,
      notify_submitter: wf.notify_submitter,
      steps: wf.steps.map((s) => ({ ...s })),
    });
    setFormError(null);
    open();
  };

  const patchStep = (idx: number, patch: Partial<WorkflowStep>) =>
    setDraft((d) => ({ ...d, steps: d.steps.map((s, i) => (i === idx ? { ...s, ...patch } : s)) }));

  const moveStep = (idx: number, dir: -1 | 1) =>
    setDraft((d) => {
      const steps = [...d.steps];
      const target = idx + dir;
      if (target < 0 || target >= steps.length) return d;
      [steps[idx], steps[target]] = [steps[target], steps[idx]];
      return { ...d, steps };
    });

  const handleSave = async () => {
    const err = draftError(draft);
    if (err) {
      setFormError(err);
      return;
    }
    setSaving(true);
    setFormError(null);
    const payload = {
      ...draft,
      name: draft.name.trim(),
      description: draft.description.trim(),
      steps: draft.steps.map((s) => ({ ...s, name: s.name.trim() })),
    };
    try {
      if (editingId) {
        await api.updateWorkflow(editingId, payload);
      } else {
        await api.createWorkflow(payload);
      }
      notifications.show({ color: 'teal', title: 'Workflow saved', message: payload.name });
      close();
      load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Failed to save workflow.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (wf: WorkflowOut) => {
    const inFlight =
      wf.in_use_count > 0
        ? `\n\n${wf.in_use_count} pending request(s) will continue using the steps they were submitted with.`
        : '';
    if (!window.confirm(`Delete workflow "${wf.name}"?${inFlight}`)) return;
    try {
      await api.deleteWorkflow(wf.id);
      load();
    } catch (e) {
      notifications.show({
        color: 'red',
        title: 'Delete failed',
        message: e instanceof Error ? e.message : 'Unexpected error',
      });
    }
  };

  const roleOptions = roles.map((r) => ({ value: r.id, label: r.name }));

  return (
    <Stack gap="md">
      <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
        <Stack gap="sm">
          <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs">
            <div>
              <Title order={4}>Approval Workflows</Title>
              <Text size="xs" c="var(--text-muted)">
                Ordered approval steps an initiative must pass. Initiatives are locked while in review.
              </Text>
            </div>
            <Button size="xs" leftSection={<IconPlus size={13} />} onClick={openCreate}>
              New Workflow
            </Button>
          </Group>

          {loadError && (
            <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>
              {loadError}
            </Alert>
          )}

          {!loading && workflows.length === 0 && !loadError && (
            <Text size="sm" c="var(--text-muted)">
              No workflows yet. Create one so initiatives can be submitted for approval.
            </Text>
          )}

          <Stack gap="xs">
            {workflows.map((wf) => (
              <Paper key={wf.id} withBorder p="sm" radius="md" bg="var(--bg-subtle)">
                <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
                  <Stack gap={4} style={{ minWidth: 0 }}>
                    <Group gap={6} wrap="wrap">
                      <Text fw={600} size="sm" c="var(--text-heading)">
                        {wf.name}
                      </Text>
                      {wf.is_default && (
                        <Badge size="xs" variant="light" color="blue">
                          Default
                        </Badge>
                      )}
                      {!wf.is_active && (
                        <Badge size="xs" variant="light" color="gray">
                          Inactive
                        </Badge>
                      )}
                      {wf.in_use_count > 0 && (
                        <Badge size="xs" variant="outline" color="yellow">
                          {wf.in_use_count} pending
                        </Badge>
                      )}
                    </Group>
                    {wf.description && (
                      <Text size="xs" c="var(--text-muted)">
                        {wf.description}
                      </Text>
                    )}
                    <Stack gap={2}>
                      {wf.steps.map((s, i) => (
                        <Text key={s.id || i} size="xs" c="var(--text-body)">
                          <b>
                            {i + 1}. {s.name}
                          </b>
                          {' — '}
                          {[
                            ...s.approver_role_ids.map((r) => roleName[r] ?? r),
                            ...s.approver_emails,
                          ].join(', ')}
                          {s.required_approvals > 1 ? ` · ${s.required_approvals} approvals` : ''}
                          {s.notify_approvers ? '' : ' · no email'}
                        </Text>
                      ))}
                    </Stack>
                  </Stack>
                  <Group gap={4} wrap="nowrap">
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      aria-label={`Edit ${wf.name}`}
                      onClick={() => openEdit(wf)}
                    >
                      <IconEdit size={16} />
                    </ActionIcon>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      aria-label={`Delete ${wf.name}`}
                      onClick={() => handleDelete(wf)}
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Group>
                </Group>
              </Paper>
            ))}
          </Stack>
        </Stack>
      </Paper>

      <EmailSettingsCard />

      <Modal
        opened={opened}
        onClose={() => !saving && close()}
        title={editingId ? 'Edit Workflow' : 'New Workflow'}
        size="xl"
        fullScreen={isMobile}
      >
        <Stack gap="sm">
          {formError && (
            <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>
              {formError}
            </Alert>
          )}
          <TextInput
            label={<FieldLabel field="workflow.name">Name</FieldLabel>}
            required
            value={draft.name}
            maxLength={120}
            onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })}
          />
          <Textarea
            label="Description"
            value={draft.description}
            maxLength={1000}
            autosize
            minRows={2}
            onChange={(e) => setDraft({ ...draft, description: e.currentTarget.value })}
          />
          <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xs">
            <Switch
              label={<FieldLabel field="workflow.flags">Active</FieldLabel>}
              checked={draft.is_active}
              onChange={(e) => setDraft({ ...draft, is_active: e.currentTarget.checked })}
            />
            <Switch
              label={<FieldLabel field="workflow.flags">Default workflow</FieldLabel>}
              checked={draft.is_default}
              disabled={!draft.is_active}
              onChange={(e) => setDraft({ ...draft, is_default: e.currentTarget.checked })}
            />
            <Switch
              label={<FieldLabel field="workflow.flags">Email submitter on decision</FieldLabel>}
              checked={draft.notify_submitter}
              onChange={(e) => setDraft({ ...draft, notify_submitter: e.currentTarget.checked })}
            />
          </SimpleGrid>

          <Divider label="Steps (run in order)" labelPosition="left" />

          {draft.steps.map((step, idx) => (
            <Paper key={idx} withBorder p="sm" radius="md" bg="var(--bg-subtle)">
              <Stack gap="xs">
                <Group justify="space-between" wrap="nowrap" gap="xs">
                  <TextInput
                    aria-label={`Step ${idx + 1} name`}
                    leftSection={
                      <Text size="xs" fw={700} c="var(--text-muted)">
                        {idx + 1}
                      </Text>
                    }
                    value={step.name}
                    maxLength={120}
                    onChange={(e) => patchStep(idx, { name: e.currentTarget.value })}
                    style={{ flex: 1 }}
                  />
                  <Group gap={2} wrap="nowrap">
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      aria-label="Move step up"
                      disabled={idx === 0}
                      onClick={() => moveStep(idx, -1)}
                    >
                      <IconArrowUp size={15} />
                    </ActionIcon>
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      aria-label="Move step down"
                      disabled={idx === draft.steps.length - 1}
                      onClick={() => moveStep(idx, 1)}
                    >
                      <IconArrowDown size={15} />
                    </ActionIcon>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      aria-label="Remove step"
                      disabled={draft.steps.length === 1}
                      onClick={() => setDraft((d) => ({ ...d, steps: d.steps.filter((_, i) => i !== idx) }))}
                    >
                      <IconTrash size={15} />
                    </ActionIcon>
                  </Group>
                </Group>
                <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
                  <MultiSelect
                    label={<FieldLabel field="workflow.step_roles">Approver roles</FieldLabel>}
                    placeholder={step.approver_role_ids.length ? undefined : 'Any member of…'}
                    data={roleOptions}
                    value={step.approver_role_ids}
                    onChange={(v) => patchStep(idx, { approver_role_ids: v })}
                    clearable
                    searchable
                  />
                  <TagsInput
                    label={<FieldLabel field="workflow.step_emails">Approver emails</FieldLabel>}
                    placeholder="Type an email, press Enter"
                    value={step.approver_emails}
                    onChange={(v) => patchStep(idx, { approver_emails: v.map((e) => e.trim().toLowerCase()) })}
                    splitChars={[',', ' ', ';']}
                    clearable
                  />
                </SimpleGrid>
                <Group gap="md" wrap="wrap" align="flex-end">
                  <NumberInput
                    label={<FieldLabel field="workflow.step_required">Approvals required</FieldLabel>}
                    min={1}
                    max={20}
                    w={160}
                    value={step.required_approvals}
                    onChange={(v) => patchStep(idx, { required_approvals: Math.max(1, Number(v) || 1) })}
                  />
                  <Switch
                    label={<FieldLabel field="workflow.step_notify">Email approvers when this step starts</FieldLabel>}
                    checked={step.notify_approvers}
                    onChange={(e) => patchStep(idx, { notify_approvers: e.currentTarget.checked })}
                    mb={6}
                  />
                </Group>
              </Stack>
            </Paper>
          ))}

          <Button
            variant="default"
            size="xs"
            w="fit-content"
            leftSection={<IconPlus size={13} />}
            disabled={draft.steps.length >= 20}
            onClick={() => setDraft((d) => ({ ...d, steps: [...d.steps, newStep(d.steps.length + 1)] }))}
          >
            Add Step
          </Button>

          <Text size="xs" c="var(--text-muted)">
            Any member of a listed role, or any listed email, can approve a step. Submitters cannot approve their
            own initiative. Editing a workflow does not change requests already in review.
          </Text>

          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={close} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} loading={saving}>
              Save Workflow
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

function EmailSettingsCard() {
  const [settings, setSettings] = useState<EmailSettingsOut | null>(null);
  const [form, setForm] = useState<EmailSettingsUpdate | null>(null);
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [log, setLog] = useState<EmailLogOut[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadLog = useCallback(async () => {
    try {
      setLog(await api.listEmailLog(25));
    } catch {
      /* log is informational */
    }
  }, []);

  const applySettings = (s: EmailSettingsOut) => {
    setSettings(s);
    setForm({
      enabled: s.enabled,
      host: s.host,
      port: s.port,
      security: s.security,
      username: s.username,
      from_address: s.from_address,
      from_name: s.from_name,
      app_base_url: s.app_base_url || (typeof window !== 'undefined' ? window.location.origin : ''),
    });
    setPassword('');
    setClearPassword(false);
  };

  useEffect(() => {
    api
      .getEmailSettings()
      .then(applySettings)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load email settings.'));
    loadLog();
  }, [loadLog]);

  if (error) {
    return (
      <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>
        {error}
      </Alert>
    );
  }
  if (!form || !settings) return null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload: EmailSettingsUpdate = {
        ...form,
        password: clearPassword ? '' : password ? password : null,
      };
      applySettings(await api.updateEmailSettings(payload));
      notifications.show({ color: 'teal', title: 'Email settings saved', message: 'SMTP configuration updated.' });
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Save failed',
        message: err instanceof Error ? err.message : 'Unexpected error',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.sendTestEmail(testTo.trim()));
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : 'Test failed.' });
    } finally {
      setTesting(false);
      loadLog();
    }
  };

  const statusColor = { sent: 'teal', failed: 'red', skipped: 'gray' } as const;

  return (
    <Paper
      component="form"
      onSubmit={handleSave}
      withBorder
      p={{ base: 'sm', sm: 'md' }}
      radius="md"
      bg="var(--bg-surface)"
    >
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs">
          <div>
            <Title order={4}>Email Notifications</Title>
            <Text size="xs" c="var(--text-muted)">
              SMTP server used to email approvers when a step needs them, and submitters when a decision is made
            </Text>
          </div>
          <Badge
            variant="light"
            color={settings.enabled && settings.configured ? 'teal' : 'gray'}
            leftSection={<IconMail size={11} />}
          >
            {settings.enabled && settings.configured ? 'Enabled' : settings.configured ? 'Disabled' : 'Not configured'}
          </Badge>
        </Group>

        <Switch
          label="Send approval emails"
          checked={form.enabled}
          onChange={(e) => setForm({ ...form, enabled: e.currentTarget.checked })}
        />

        <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xs">
          <TextInput
            label={<FieldLabel field="email.smtp">SMTP host</FieldLabel>}
            placeholder="smtp.example.com"
            value={form.host}
            onChange={(e) => setForm({ ...form, host: e.currentTarget.value })}
          />
          <NumberInput
            label={<FieldLabel field="email.smtp">Port</FieldLabel>}
            min={1}
            max={65535}
            value={form.port}
            onChange={(v) => setForm({ ...form, port: Number(v) || 587 })}
          />
          <Stack gap={4}>
            <Text size="sm" fw={500} className="field-label">
              Security
              <FieldInfo field="email.smtp" />
            </Text>
            <SegmentedControl
              size="xs"
              value={form.security}
              onChange={(v) => {
                const security = v as SmtpSecurity;
                const port = security === 'ssl' ? 465 : form.port === 465 ? 587 : form.port;
                setForm({ ...form, security, port });
              }}
              data={[
                { value: 'starttls', label: 'STARTTLS' },
                { value: 'ssl', label: 'SSL/TLS' },
                { value: 'none', label: 'None' },
              ]}
            />
          </Stack>
        </SimpleGrid>

        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
          <TextInput
            label={<FieldLabel field="email.credentials">Username</FieldLabel>}
            autoComplete="off"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.currentTarget.value })}
          />
          <PasswordInput
            label={<FieldLabel field="email.credentials">Password</FieldLabel>}
            autoComplete="new-password"
            placeholder={settings.password_set && !clearPassword ? `Saved (${settings.password_masked})` : ''}
            value={password}
            onChange={(e) => {
              setPassword(e.currentTarget.value);
              setClearPassword(false);
            }}
            description={
              settings.password_set ? (
                <Text
                  component="button"
                  type="button"
                  size="xs"
                  c="var(--accent-primary)"
                  style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer' }}
                  onClick={() => {
                    setPassword('');
                    setClearPassword(true);
                  }}
                >
                  {clearPassword ? 'Saved password will be removed' : 'Remove saved password'}
                </Text>
              ) : undefined
            }
          />
          <TextInput
            label={<FieldLabel field="email.from">From address</FieldLabel>}
            placeholder="bca-notifications@example.com"
            value={form.from_address}
            onChange={(e) => setForm({ ...form, from_address: e.currentTarget.value })}
          />
          <TextInput
            label={<FieldLabel field="email.from">From name</FieldLabel>}
            value={form.from_name}
            onChange={(e) => setForm({ ...form, from_name: e.currentTarget.value })}
          />
        </SimpleGrid>
        <TextInput
          label={<FieldLabel field="email.app_url">App URL used in email links</FieldLabel>}
          placeholder="https://bca.example.com"
          value={form.app_base_url}
          onChange={(e) => setForm({ ...form, app_base_url: e.currentTarget.value })}
        />
        <Text size="xs" c="var(--text-muted)">
          Changing the host clears the saved password so it is never sent to a different server.
        </Text>

        <Group justify="flex-end">
          <Button type="submit" size="xs" loading={saving}>
            Save Email Settings
          </Button>
        </Group>

        <Divider />

        <Group align="flex-end" gap="xs" wrap="wrap">
          <TextInput
            label="Send a test email to"
            placeholder="you@example.com"
            value={testTo}
            onChange={(e) => setTestTo(e.currentTarget.value)}
            style={{ flex: 1, minWidth: 200 }}
          />
          <Button
            size="xs"
            variant="default"
            leftSection={<IconSend size={13} />}
            loading={testing}
            disabled={!EMAIL_RE.test(testTo.trim()) || !settings.configured}
            onClick={handleTest}
            mb={2}
          >
            Send Test
          </Button>
        </Group>
        {!settings.configured && (
          <Text size="xs" c="var(--text-muted)">
            Save a host and From address before sending a test.
          </Text>
        )}
        {testResult && (
          <Alert color={testResult.ok ? 'teal' : 'red'} variant="light">
            {testResult.message}
          </Alert>
        )}

        <Group justify="space-between" mt="xs">
          <Text size="sm" fw={600} c="var(--text-heading)">
            Recent notifications
          </Text>
          <ActionIcon variant="subtle" color="gray" aria-label="Refresh notification log" onClick={loadLog}>
            <IconRefresh size={15} />
          </ActionIcon>
        </Group>
        {log.length === 0 ? (
          <Text size="xs" c="var(--text-muted)">
            No notifications yet.
          </Text>
        ) : (
          <div className="table-region" tabIndex={0} role="region" aria-label="Notification log">
            <Table striped fz="xs" verticalSpacing={4}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>When</Table.Th>
                  <Table.Th>Subject</Table.Th>
                  <Table.Th>To</Table.Th>
                  <Table.Th>Status</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {log.map((entry) => (
                  <Table.Tr key={entry.id}>
                    <Table.Td style={{ whiteSpace: 'nowrap' }}>
                      {new Date(entry.created_at).toLocaleString(undefined, {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}
                    </Table.Td>
                    <Table.Td>{entry.subject}</Table.Td>
                    <Table.Td>{entry.recipients.join(', ') || '—'}</Table.Td>
                    <Table.Td>
                      <Badge size="xs" variant="light" color={statusColor[entry.status]} title={entry.error}>
                        {entry.status}
                      </Badge>
                      {entry.error && (
                        <Text size="xs" c="var(--text-muted)">
                          {entry.error}
                        </Text>
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
  );
}
