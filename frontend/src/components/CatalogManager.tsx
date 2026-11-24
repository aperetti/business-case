import { Fragment, useMemo, useRef, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Code,
  Divider,
  Group,
  Modal,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconArrowBackUp,
  IconBook,
  IconEdit,
  IconInfoCircle,
  IconPlus,
  IconSearch,
  IconTrash,
} from '@tabler/icons-react';
import { getCatalogItemDoc } from '../data/catalogDocs';
import type {
  CatalogEntry,
  CatalogEntryCreate,
  CatalogEntryUpdate,
  CatalogKind,
  CatalogParameter,
} from '../types/api';
import { DOMAIN_OPTIONS } from '../utils/format';
import { FieldLabel } from './FieldInfo';

interface Props {
  catalog: CatalogEntry[];
  onCreateEntry: (payload: CatalogEntryCreate) => Promise<void>;
  onUpdateEntry?: (id: string, payload: CatalogEntryUpdate) => Promise<void>;
  canManage?: boolean;
  onOpenDoc?: (catalogId: string) => void;
}

interface CatalogCardProps {
  entry: CatalogEntry;
  isMobile: boolean;
  onOpenDoc?: (catalogId: string) => void;
  onEdit?: (entry: CatalogEntry) => void;
}

function CatalogCard({ entry, isMobile, onOpenDoc, onEdit }: CatalogCardProps) {
  const [flipped, setFlipped] = useState(false);
  const frontFlipBtnRef = useRef<HTMLButtonElement>(null);
  const backFlipBtnRef = useRef<HTMLButtonElement>(null);
  const isCost = entry.kind === 'cost';

  const doc = useMemo(() => getCatalogItemDoc(entry), [entry]);
  const primaryNote = entry.guardrail_notes.trim();
  const extraNotes = doc.guardrailDeepDive.filter((n) => n.trim() && n.trim() !== primaryNote);
  const hasNotes = Boolean(primaryNote || extraNotes.length > 0 || doc.whenNotToUse.length > 0);

  const flipToBack = () => {
    setFlipped(true);
    requestAnimationFrame(() => backFlipBtnRef.current?.focus({ preventScroll: true }));
  };

  const flipToFront = () => {
    setFlipped(false);
    requestAnimationFrame(() => frontFlipBtnRef.current?.focus({ preventScroll: true }));
  };

  return (
    <div className="catalog-flip-scene">
      <div className="catalog-flip-inner" data-flipped={flipped ? 'true' : undefined}>
        <div className="catalog-flip-face catalog-flip-front" aria-hidden={flipped}>
          <Paper
            withBorder
            p={{ base: 'sm', sm: 'md' }}
            radius="md"
            bg="var(--bg-surface)"
            h="100%"
            style={{ minWidth: 0 }}
          >
            <Stack gap="sm" style={{ minWidth: 0 }}>
              <div>
                <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs" mb={4}>
                  <Group gap={6} wrap="wrap" style={{ minWidth: 0 }}>
                    <span
                      className="status-dot"
                      style={{ backgroundColor: isCost ? 'var(--chart-neg)' : 'var(--chart-pos)' }}
                    />
                    <Text size="xs" fw={600} c={isCost ? 'var(--text-neg)' : 'var(--text-pos)'}>
                      {isCost ? 'Cost' : 'Benefit'}
                    </Text>
                    <Text size="xs" ff="monospace" c="var(--text-body)" fw={600}>
                      · {entry.id}
                    </Text>
                    <Text size="xs" c="var(--text-muted)">
                      · {entry.is_builtin ? 'Built-in' : 'Custom'}
                      {entry.value_stream_stage ? ` · Stage: ${entry.value_stream_stage}` : ''}
                    </Text>
                  </Group>
                  {(hasNotes || onOpenDoc || onEdit) && (
                    <Group gap={4} wrap="nowrap" align="center" style={{ flexShrink: 0 }}>
                      {onEdit && (
                        <Tooltip label="Edit template" withArrow position="top">
                          <ActionIcon
                            type="button"
                            variant="subtle"
                            color="gray"
                            size="sm"
                            aria-label={`Edit ${entry.id}`}
                            onClick={() => onEdit(entry)}
                          >
                            <IconEdit size={14} />
                          </ActionIcon>
                        </Tooltip>
                      )}
                      {hasNotes && (
                        <Tooltip label="Warnings & guardrail notes" withArrow position="top">
                          <ActionIcon
                            ref={frontFlipBtnRef}
                            type="button"
                            variant="subtle"
                            color="gray"
                            size="sm"
                            className="catalog-flip-trigger"
                            aria-label={`Show warnings and notes for ${entry.id}`}
                            aria-expanded={false}
                            onClick={flipToBack}
                          >
                            <IconAlertTriangle size={14} />
                          </ActionIcon>
                        </Tooltip>
                      )}
                      {onOpenDoc && (
                        <Button
                          type="button"
                          variant="subtle"
                          size="compact-xs"
                          leftSection={<IconBook size={13} />}
                          onClick={() => onOpenDoc(entry.id)}
                          style={{ flexShrink: 0 }}
                        >
                          Docs
                        </Button>
                      )}
                    </Group>
                  )}
                </Group>
                <Group gap={6} wrap="wrap">
                  <Title order={5}>{entry.name}</Title>
                  {entry.doc?.is_template && (
                    <Badge
                      size="xs"
                      variant="light"
                      color="yellow"
                      style={{ cursor: onOpenDoc ? 'pointer' : undefined }}
                      onClick={() => onOpenDoc?.(entry.id)}
                    >
                      Needs docs
                    </Badge>
                  )}
                </Group>
              </div>

              {entry.description && (
                <Text size="sm" c="var(--text-muted)">
                  {entry.description}
                </Text>
              )}

              {entry.domains.length > 0 && (
                <Text size="xs" c="var(--text-muted)">
                  Domains: {entry.domains.join(', ')}
                </Text>
              )}

              <div>
                <Text size="xs" fw={600} c="var(--text-muted)" mb={4}>
                  Formula ({entry.formula_type})
                </Text>
                <Code
                  block
                  style={{
                    background: 'var(--bg-subtle)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--text-body)',
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere',
                    wordBreak: 'break-word',
                  }}
                >
                  {entry.formula_description}
                </Code>
              </div>

              {isMobile ? (
                <Stack gap={0}>
                  <Text size="xs" fw={600} c="var(--text-muted)" mb={4}>
                    Parameters ({entry.parameters.length})
                  </Text>
                  {entry.parameters.map((p, idx) => (
                    <Fragment key={p.key}>
                      {idx > 0 && <Divider color="var(--border-divider)" my={6} />}
                      <div>
                        <Group justify="space-between" wrap="wrap" gap={4}>
                          <Code style={{ background: 'var(--bg-subtle)', color: 'var(--text-heading)' }}>
                            {p.key}
                          </Code>
                          <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                            Default {p.default_value} {p.unit}
                          </Text>
                        </Group>
                        <Text size="xs" fw={500} c="var(--text-body)" mt={2}>
                          {p.label}
                        </Text>
                        <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                          Bounds [{p.min_value ?? '−∞'}, {p.max_value ?? '∞'}]
                        </Text>
                      </div>
                    </Fragment>
                  ))}
                </Stack>
              ) : (
                <div
                  tabIndex={0}
                  role="region"
                  aria-label={`${entry.id} parameters`}
                  className="table-region"
                >
                  <Table verticalSpacing={4} horizontalSpacing="xs">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Key</Table.Th>
                        <Table.Th>Label</Table.Th>
                        <Table.Th>Unit</Table.Th>
                        <Table.Th ta="right">Default</Table.Th>
                        <Table.Th ta="right">Bounds</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {entry.parameters.map((p) => (
                        <Table.Tr key={p.key}>
                          <Table.Td>
                            <Code style={{ background: 'var(--bg-subtle)', color: 'var(--text-heading)' }}>
                              {p.key}
                            </Code>
                          </Table.Td>
                          <Table.Td className="cell-wrap">{p.label}</Table.Td>
                          <Table.Td>{p.unit || '—'}</Table.Td>
                          <Table.Td ta="right" className="tabular-nums">
                            {p.default_value}
                          </Table.Td>
                          <Table.Td ta="right" className="tabular-nums">
                            [{p.min_value ?? '−∞'}, {p.max_value ?? '∞'}]
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </div>
              )}
            </Stack>
          </Paper>
        </div>

        <div
          className="catalog-flip-face catalog-flip-back"
          aria-hidden={!flipped}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              flipToFront();
            }
          }}
        >
          <Paper
            withBorder
            p={{ base: 'sm', sm: 'md' }}
            radius="md"
            bg="var(--bg-surface)"
            h="100%"
            style={{ minWidth: 0 }}
          >
            <Stack gap="sm" h="100%" style={{ minWidth: 0 }}>
              <div>
                <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs" mb={4}>
                  <Group gap={6} wrap="wrap" style={{ minWidth: 0 }}>
                    <span
                      className="status-dot"
                      style={{ backgroundColor: isCost ? 'var(--chart-neg)' : 'var(--chart-pos)' }}
                    />
                    <Text size="xs" fw={600} c={isCost ? 'var(--text-neg)' : 'var(--text-pos)'}>
                      {isCost ? 'Cost' : 'Benefit'}
                    </Text>
                    <Text size="xs" ff="monospace" c="var(--text-body)" fw={600}>
                      · {entry.id}
                    </Text>
                    <Text size="xs" fw={500} c="var(--text-warn)">
                      · Warnings & Notes
                    </Text>
                  </Group>
                  <Group gap={4} wrap="nowrap" align="center" style={{ flexShrink: 0 }}>
                    <Tooltip label="Back to formula & parameters" withArrow position="top">
                      <ActionIcon
                        ref={backFlipBtnRef}
                        type="button"
                        variant="light"
                        color="gray"
                        size="sm"
                        className="catalog-flip-trigger"
                        aria-label={`Back to formula and parameters for ${entry.id}`}
                        aria-expanded={true}
                        onClick={flipToFront}
                      >
                        <IconArrowBackUp size={14} />
                      </ActionIcon>
                    </Tooltip>
                    {onOpenDoc && (
                      <Button
                        type="button"
                        variant="subtle"
                        size="compact-xs"
                        leftSection={<IconBook size={13} />}
                        onClick={() => onOpenDoc(entry.id)}
                        style={{ flexShrink: 0 }}
                      >
                        Docs
                      </Button>
                    )}
                  </Group>
                </Group>
                <Title order={5}>{entry.name}</Title>
              </div>

              {primaryNote && (
                <div className="callout-note" role="note">
                  {primaryNote}
                </div>
              )}

              {extraNotes.length > 0 && (
                <div>
                  <Text size="xs" fw={600} c="var(--text-muted)" mb={4}>
                    Guardrail Notes
                  </Text>
                  <ul className="docs-list catalog-notes-list">
                    {extraNotes.map((note, idx) => (
                      <li key={idx}>{note}</li>
                    ))}
                  </ul>
                </div>
              )}

              {doc.whenNotToUse.length > 0 && (
                <div>
                  <Text size="xs" fw={600} c="var(--text-muted)" mb={4}>
                    Avoid Overlap / When Not to Use
                  </Text>
                  <ul className="docs-list catalog-notes-list">
                    {doc.whenNotToUse.map((alt, idx) => (
                      <li key={idx}>
                        {alt.text}
                        {onOpenDoc && alt.linkSlug && (
                          <button
                            type="button"
                            className="catalog-inline-link"
                            onClick={() => onOpenDoc(alt.linkSlug!)}
                          >
                            {alt.linkLabel || alt.linkSlug}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <Group justify="space-between" align="center" mt="auto" pt={4}>
                <Button
                  type="button"
                  variant="subtle"
                  size="compact-xs"
                  leftSection={<IconArrowBackUp size={13} />}
                  onClick={flipToFront}
                >
                  Back to formula
                </Button>
              </Group>
            </Stack>
          </Paper>
        </div>
      </div>
    </div>
  );
}

const EMPTY_PARAM: CatalogParameter = {
  key: 'volume',
  label: 'Annual Volume',
  unit: 'units/yr',
  default_value: 100,
  min_value: 0,
  max_value: null,
  required: true,
};

export function CatalogManager({ catalog, onCreateEntry, onUpdateEntry, canManage = true, onOpenDoc }: Props) {
  const isMobile = useMediaQuery('(max-width: 48em)') ?? false;
  const [searchText, setSearchText] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | CatalogKind>('all');
  const [domainFilter, setDomainFilter] = useState<string>('all');
  const [opened, { open, close }] = useDisclosure(false);

  const [id, setId] = useState('');
  const [kind, setKind] = useState<CatalogKind>('benefit');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [domainsText, setDomainsText] = useState('software, automation');
  const [stage, setStage] = useState('Automate');
  const [formulaExpr, setFormulaExpr] = useState('volume * unit_value');
  const [guardrailNotes, setGuardrailNotes] = useState('');
  const [parameters, setParameters] = useState<CatalogParameter[]>([
    { ...EMPTY_PARAM },
    {
      key: 'unit_value',
      label: 'Value per Unit',
      unit: '$/unit',
      default_value: 250,
      min_value: 0,
      max_value: null,
      required: true,
    },
  ]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [editingEntry, setEditingEntry] = useState<CatalogEntry | null>(null);

  const openCreate = () => {
    setEditingEntry(null);
    setErrorMsg(null);
    open();
  };

  const openEdit = (entry: CatalogEntry) => {
    setEditingEntry(entry);
    setId(entry.id);
    setKind(entry.kind);
    setName(entry.name);
    setDescription(entry.description);
    setDomainsText(entry.domains.join(', '));
    setStage(entry.value_stream_stage ?? '');
    // Registered built-in formulas are shown by key; custom ones without the expr: prefix.
    setFormulaExpr(entry.formula_type.startsWith('expr:') ? entry.formula_type.slice(5).trim() : entry.formula_type);
    setGuardrailNotes(entry.guardrail_notes);
    setParameters(entry.parameters.map((p) => ({ ...p })));
    setErrorMsg(null);
    open();
  };

  const closeModal = () => {
    close();
    if (editingEntry) {
      // Don't leave an edited template's values in the "new template" form.
      setEditingEntry(null);
      setId('');
      setKind('benefit');
      setName('');
      setDescription('');
      setDomainsText('software, automation');
      setStage('Automate');
      setGuardrailNotes('');
      setFormulaExpr('volume * unit_value');
      setParameters([
        { ...EMPTY_PARAM },
        { key: 'unit_value', label: 'Value per Unit', unit: '$/unit', default_value: 250, min_value: 0, max_value: null, required: true },
      ]);
    }
  };

  const domainOptions = useMemo(() => {
    const all = new Set<string>(DOMAIN_OPTIONS.map((d) => d.value));
    for (const entry of catalog) {
      for (const d of entry.domains) all.add(d);
    }
    return [
      { value: 'all', label: 'All domains' },
      ...Array.from(all)
        .sort()
        .map((d) => ({ value: d, label: d })),
    ];
  }, [catalog]);

  const filtered = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return catalog.filter((entry) => {
      if (kindFilter !== 'all' && entry.kind !== kindFilter) return false;
      if (domainFilter !== 'all' && !entry.domains.includes(domainFilter)) return false;
      if (!q) return true;
      return (
        entry.id.toLowerCase().includes(q) ||
        entry.name.toLowerCase().includes(q) ||
        entry.description.toLowerCase().includes(q)
      );
    });
  }, [catalog, searchText, kindFilter, domainFilter]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    const trimmedId = id.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/.test(trimmedId)) {
      setErrorMsg('Template ID must be 2–64 alphanumeric, dash, or underscore characters (e.g., BEN-CUSTOM-01).');
      return;
    }
    if (!name.trim()) {
      setErrorMsg('Template name is required.');
      return;
    }
    if (parameters.length === 0) {
      setErrorMsg('At least one parameter is required.');
      return;
    }
    for (const p of parameters) {
      if (!/^[a-z][a-z0-9_]*$/.test(p.key)) {
        setErrorMsg(`Parameter key '${p.key}' must be snake_case starting with a lowercase letter.`);
        return;
      }
      if (!p.label.trim()) {
        setErrorMsg(`Parameter '${p.key}' needs a label.`);
        return;
      }
    }

    const rawFormula = formulaExpr.trim();
    const formula =
      editingEntry && !editingEntry.formula_type.startsWith('expr:') && rawFormula === editingEntry.formula_type
        ? editingEntry.formula_type
        : rawFormula.startsWith('expr:')
          ? rawFormula
          : `expr:${rawFormula}`;

    const domains = domainsText
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    setSubmitting(true);
    if (editingEntry && onUpdateEntry) {
      try {
        await onUpdateEntry(editingEntry.id, {
          kind,
          name: name.trim(),
          description: description.trim(),
          domains,
          value_stream_stage: stage.trim() || null,
          parameters,
          formula_type: formula,
          guardrail_notes: guardrailNotes.trim(),
        });
        closeModal();
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Failed to update catalog template.');
      } finally {
        setSubmitting(false);
      }
      return;
    }
    try {
      await onCreateEntry({
        id: trimmedId,
        kind,
        name: name.trim(),
        description: description.trim(),
        domains,
        value_stream_stage: stage.trim() || null,
        parameters,
        formula_type: formula,
        guardrail_notes: guardrailNotes.trim(),
      });
      setId('');
      setName('');
      setDescription('');
      setGuardrailNotes('');
      close();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to create catalog template.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Stack gap="md">
      <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
        <Group justify="space-between" align="center" wrap="wrap" gap="sm">
          <div>
            <Title order={4}>Reusable Cost & Benefit Catalog ({filtered.length})</Title>
            <Text size="xs" c="var(--text-muted)">
              Inspect built-in formulas, guardrails, and safe custom AST expression templates
            </Text>
          </div>
          {canManage && (
            <Button
              type="button"
              variant="default"
              fullWidth={isMobile}
              leftSection={<IconPlus size={15} />}
              onClick={openCreate}
            >
              New Catalog Template
            </Button>
          )}
        </Group>

        <search>
          <Group mt="md" gap="sm" wrap="wrap">
            <TextInput
              aria-label="Search catalog templates"
              placeholder="Search ID, name, or description..."
              leftSection={<IconSearch size={15} />}
              value={searchText}
              onChange={(e) => setSearchText(e.currentTarget.value)}
              style={{ flex: '1 1 200px', minWidth: 0, width: isMobile ? '100%' : undefined }}
            />
            <SegmentedControl
              fullWidth={isMobile}
              value={kindFilter}
              onChange={(v) => setKindFilter(v as 'all' | CatalogKind)}
              data={[
                { label: 'All', value: 'all' },
                { label: 'Costs', value: 'cost' },
                { label: 'Benefits', value: 'benefit' },
              ]}
            />
            <Select
              aria-label="Filter catalog by domain"
              data={domainOptions}
              value={domainFilter}
              onChange={(v) => setDomainFilter(v || 'all')}
              allowDeselect={false}
              w={{ base: '100%', sm: 190 }}
            />
          </Group>
        </search>
      </Paper>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
        {filtered.map((entry) => (
          <CatalogCard
            key={entry.id}
            entry={entry}
            isMobile={isMobile}
            onOpenDoc={onOpenDoc}
            onEdit={canManage && onUpdateEntry ? openEdit : undefined}
          />
        ))}
      </SimpleGrid>

      <Modal
        opened={opened}
        onClose={closeModal}
        title={editingEntry ? `Edit ${editingEntry.id}` : 'Create Custom Catalog Template'}
        size="lg"
        fullScreen={isMobile}
      >
        <Box component="form" onSubmit={handleSubmit}>
          <Stack gap="sm">
            {errorMsg && (
              <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />} title="Validation Error">
                {errorMsg}
              </Alert>
            )}

            {editingEntry && (
              <Alert color="gray" variant="light" icon={<IconInfoCircle size={16} />} p="xs">
                <Text size="xs">
                  Changes to the kind, formula, or parameters recalculate every initiative using this template, and
                  are blocked while any of those initiatives are under review or approved. Name, description,
                  domains, and notes can always be edited.
                  {editingEntry.is_builtin ? ' This is a built-in template.' : ''}
                </Text>
              </Alert>
            )}

            <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xs">
              <TextInput
                label={<FieldLabel field="catalog.id">Template ID</FieldLabel>}
                placeholder="BEN-CUSTOM-01"
                value={id}
                onChange={(e) => setId(e.currentTarget.value)}
                disabled={Boolean(editingEntry)}
                required
              />
              <Select
                label={<FieldLabel field="catalog.kind">Kind</FieldLabel>}
                data={[
                  { value: 'benefit', label: 'Benefit' },
                  { value: 'cost', label: 'Cost' },
                ]}
                value={kind}
                onChange={(v) => setKind((v as CatalogKind) || 'benefit')}
                allowDeselect={false}
              />
              <TextInput
                label={<FieldLabel field="catalog.stage">Default Stage</FieldLabel>}
                placeholder="Automate"
                value={stage}
                onChange={(e) => setStage(e.currentTarget.value)}
              />
            </SimpleGrid>

            <TextInput
              label={<FieldLabel field="catalog.name">Template Name</FieldLabel>}
              placeholder="e.g., SLA Latency Penalty Avoidance"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              required
            />

            <TextInput
              label={<FieldLabel field="catalog.domains">Domains (comma-separated)</FieldLabel>}
              value={domainsText}
              onChange={(e) => setDomainsText(e.currentTarget.value)}
            />

            <Textarea
              label={<FieldLabel field="catalog.description">Description</FieldLabel>}
              minRows={2}
              autosize
              value={description}
              onChange={(e) => setDescription(e.currentTarget.value)}
            />

            <Box
              component="fieldset"
              style={{
                border: '1px solid var(--border-subtle)',
                borderRadius: 8,
                padding: 10,
              }}
            >
              <Text component="legend" size="xs" fw={600} px={6} c="var(--text-muted)">
                Parameters
              </Text>

              <Stack gap="xs">
                {parameters.map((param, idx) => (
                  <Paper key={idx} withBorder p="xs" radius="sm" bg="var(--bg-subtle)">
                    <Group justify="space-between" mb={4}>
                      <Text size="xs" fw={600} c="var(--text-muted)">
                        Parameter #{idx + 1}
                      </Text>
                      <ActionIcon
                        type="button"
                        color="gray"
                        variant="subtle"
                        size="sm"
                        aria-label={`Remove parameter ${param.key}`}
                        disabled={parameters.length <= 1}
                        onClick={() => setParameters((prev) => prev.filter((_, i) => i !== idx))}
                      >
                        <IconTrash size={14} />
                      </ActionIcon>
                    </Group>
                    <SimpleGrid cols={{ base: 2, sm: 6 }} spacing="xs">
                      <TextInput
                        label={<FieldLabel field="catalog.param_key">Key</FieldLabel>}
                        size="xs"
                        value={param.key}
                        onChange={(e) => {
                          const next = [...parameters];
                          next[idx] = { ...next[idx], key: e.currentTarget.value };
                          setParameters(next);
                        }}
                      />
                      <TextInput
                        label={<FieldLabel field="catalog.param_label">Label</FieldLabel>}
                        size="xs"
                        value={param.label}
                        onChange={(e) => {
                          const next = [...parameters];
                          next[idx] = { ...next[idx], label: e.currentTarget.value };
                          setParameters(next);
                        }}
                      />
                      <TextInput
                        label={<FieldLabel field="catalog.param_unit">Unit</FieldLabel>}
                        size="xs"
                        value={param.unit}
                        onChange={(e) => {
                          const next = [...parameters];
                          next[idx] = { ...next[idx], unit: e.currentTarget.value };
                          setParameters(next);
                        }}
                      />
                      <NumberInput
                        label={<FieldLabel field="catalog.param_default">Default</FieldLabel>}
                        size="xs"
                        value={param.default_value}
                        onChange={(v) => {
                          const next = [...parameters];
                          next[idx] = {
                            ...next[idx],
                            default_value: typeof v === 'number' ? v : 0,
                          };
                          setParameters(next);
                        }}
                      />
                      <NumberInput
                        label={<FieldLabel field="catalog.param_bounds">Min</FieldLabel>}
                        size="xs"
                        value={param.min_value ?? undefined}
                        onChange={(v) => {
                          const next = [...parameters];
                          next[idx] = {
                            ...next[idx],
                            min_value: typeof v === 'number' ? v : null,
                          };
                          setParameters(next);
                        }}
                      />
                      <NumberInput
                        label={<FieldLabel field="catalog.param_bounds">Max</FieldLabel>}
                        size="xs"
                        placeholder="None"
                        value={param.max_value ?? undefined}
                        onChange={(v) => {
                          const next = [...parameters];
                          next[idx] = {
                            ...next[idx],
                            max_value: typeof v === 'number' ? v : null,
                          };
                          setParameters(next);
                        }}
                      />
                    </SimpleGrid>
                  </Paper>
                ))}

                <Button
                  type="button"
                  size="xs"
                  variant="default"
                  leftSection={<IconPlus size={13} />}
                  onClick={() =>
                    setParameters((prev) => [
                      ...prev,
                      {
                        key: `param_${prev.length + 1}`,
                        label: `Parameter ${prev.length + 1}`,
                        unit: '',
                        default_value: 1,
                        min_value: 0,
                        max_value: null,
                        required: true,
                      },
                    ])
                  }
                >
                  Add Parameter
                </Button>
              </Stack>
            </Box>

            <TextInput
              label={<FieldLabel field="catalog.formula">Safe Arithmetic Formula (validated AST expression)</FieldLabel>}
              description="Supports +, -, *, /, **, min(), max(), abs() referencing declared parameter keys"
              value={formulaExpr}
              onChange={(e) => setFormulaExpr(e.currentTarget.value)}
              required
            />

            <Alert color="gray" variant="light" icon={<IconInfoCircle size={16} />} p="xs">
              <Text size="xs">
                {editingEntry && !editingEntry.formula_type.startsWith('expr:') && formulaExpr.trim() === editingEntry.formula_type ? (
                  <>
                    Built-in formula <Code>{editingEntry.formula_type}</Code>: {editingEntry.formula_description}. Replace
                    it with an arithmetic expression to customise the calculation.
                  </>
                ) : (
                  <>
                    Stored safely as <Code>expr:{formulaExpr.replace(/^expr:/, '')}</Code> — never executed via eval().
                  </>
                )}
              </Text>
            </Alert>

            <Textarea
              label={<FieldLabel field="catalog.guardrails">Anti-Double-Counting Guardrail Notes</FieldLabel>}
              minRows={2}
              autosize
              value={guardrailNotes}
              onChange={(e) => setGuardrailNotes(e.currentTarget.value)}
            />

            <Group justify="flex-end" mt="xs" grow={isMobile}>
              <Button type="button" variant="default" onClick={closeModal}>
                Cancel
              </Button>
              <Button type="submit" loading={submitting}>
                {editingEntry ? 'Save Changes' : 'Create Template'}
              </Button>
            </Group>
          </Stack>
        </Box>
      </Modal>
    </Stack>
  );
}
