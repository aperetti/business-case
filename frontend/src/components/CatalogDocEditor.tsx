import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Button,
  Code,
  Divider,
  Group,
  Modal,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle, IconPlus, IconTrash } from '@tabler/icons-react';
import { api } from '../api/client';
import { GUIDE_PAGES, getCatalogItemDoc, toStoredDoc } from '../data/catalogDocs';
import type { CatalogDocContent, CatalogEntry } from '../types/api';

const linesToList = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

interface Props {
  entry: CatalogEntry;
  catalog: CatalogEntry[];
  opened: boolean;
  onClose: () => void;
  onSaved: (entry: CatalogEntry) => void;
}

/** Edit the documentation page for one catalog template. */
export function CatalogDocEditor({ entry, catalog, opened, onClose, onSaved }: Props) {
  const isMobile = useMediaQuery('(max-width: 48em)') ?? false;
  const [content, setContent] = useState<CatalogDocContent | null>(null);
  const [whenToUse, setWhenToUse] = useState('');
  const [guardrails, setGuardrails] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!opened) return;
    const base = entry.doc?.content ?? toStoredDoc(entry, getCatalogItemDoc(entry));
    // Make sure every current parameter has a guidance row.
    const guidance = { ...base.parameter_guidance };
    for (const p of entry.parameters) {
      guidance[p.key] = guidance[p.key] ?? { guidance: '', typical_range: '', data_source: '' };
    }
    setContent({ ...base, parameter_guidance: guidance });
    setWhenToUse(base.when_to_use.join('\n'));
    setGuardrails(base.guardrail_notes.join('\n'));
    setError(null);
  }, [opened, entry]);

  const linkOptions = useMemo(
    () => [
      ...GUIDE_PAGES.map((g) => ({ value: g.slug, label: `Guide: ${g.title}` })),
      ...catalog.filter((c) => c.id !== entry.id).map((c) => ({ value: c.id, label: `${c.id} · ${c.name}` })),
    ],
    [catalog, entry.id]
  );

  if (!content) return null;

  const set = (patch: Partial<CatalogDocContent>) => setContent({ ...content, ...patch });
  const setTip = (key: keyof CatalogDocContent['modeling_tips'], value: string) =>
    set({ modeling_tips: { ...content.modeling_tips, [key]: value } });

  const handleSave = async () => {
    if (!content.headline.trim() || !content.what_it_measures.trim()) {
      setError('Headline and "What it measures" are required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const keys = new Set(entry.parameters.map((p) => p.key));
      const payload: CatalogDocContent = {
        ...content,
        when_to_use: linesToList(whenToUse),
        guardrail_notes: linesToList(guardrails),
        when_not_to_use: content.when_not_to_use.filter((a) => a.text.trim()),
        parameter_guidance: Object.fromEntries(
          Object.entries(content.parameter_guidance).filter(([k]) => keys.has(k))
        ),
      };
      const saved = await api.saveCatalogDoc(entry.id, payload);
      notifications.show({ color: 'teal', title: 'Documentation saved', message: `${entry.id} · ${entry.name}` });
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save documentation.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={() => !saving && onClose()}
      title={`Edit documentation · ${entry.id}`}
      size="xl"
      fullScreen={isMobile}
    >
      <Stack gap="sm">
        {error && (
          <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>
            {error}
          </Alert>
        )}
        {entry.doc?.is_template && (
          <Alert color="yellow" variant="light">
            This page was created automatically and hasn't been written yet. Fill in each section; the prompts
            under each field describe what belongs there.
          </Alert>
        )}

        <TextInput
          label="Headline"
          description="One sentence summarising what this template captures."
          required
          maxLength={400}
          value={content.headline}
          onChange={(e) => set({ headline: e.currentTarget.value })}
        />
        <Textarea
          label="What it measures"
          description="The quantity being valued, its unit, and where the numbers come from."
          required
          autosize
          minRows={3}
          maxLength={5000}
          value={content.what_it_measures}
          onChange={(e) => set({ what_it_measures: e.currentTarget.value })}
        />
        <Textarea
          label="Economic rationale"
          description="Why this is a real cost or benefit to the business, and how it shows up in financials."
          autosize
          minRows={3}
          maxLength={5000}
          value={content.economic_rationale}
          onChange={(e) => set({ economic_rationale: e.currentTarget.value })}
        />
        <Textarea
          label="When to use"
          description="One situation per line."
          autosize
          minRows={3}
          value={whenToUse}
          onChange={(e) => setWhenToUse(e.currentTarget.value)}
        />

        <div>
          <Text size="sm" fw={500}>
            When to use another template
          </Text>
          <Text size="xs" c="var(--text-muted)" mb={6}>
            Cases this template should not cover, optionally linking to the template or guide to use instead.
          </Text>
          <Stack gap={6}>
            {content.when_not_to_use.map((alt, idx) => (
              <Group key={idx} gap="xs" wrap={isMobile ? 'wrap' : 'nowrap'} align="flex-start">
                <TextInput
                  aria-label={`Alternative ${idx + 1}`}
                  value={alt.text}
                  maxLength={1000}
                  style={{ flex: 2, minWidth: 200 }}
                  onChange={(e) => {
                    const next = [...content.when_not_to_use];
                    next[idx] = { ...alt, text: e.currentTarget.value };
                    set({ when_not_to_use: next });
                  }}
                />
                <Select
                  aria-label={`Link for alternative ${idx + 1}`}
                  placeholder="No link"
                  data={linkOptions}
                  value={alt.link_slug ?? null}
                  searchable
                  clearable
                  style={{ flex: 1, minWidth: 180 }}
                  onChange={(v) => {
                    const next = [...content.when_not_to_use];
                    const label = v ? (linkOptions.find((o) => o.value === v)?.label ?? v) : null;
                    next[idx] = { ...alt, link_slug: v, link_label: v ? label?.replace(/^Guide: /, '') : null };
                    set({ when_not_to_use: next });
                  }}
                />
                <ActionIcon
                  variant="subtle"
                  color="red"
                  aria-label={`Remove alternative ${idx + 1}`}
                  mt={4}
                  onClick={() => set({ when_not_to_use: content.when_not_to_use.filter((_, i) => i !== idx) })}
                >
                  <IconTrash size={15} />
                </ActionIcon>
              </Group>
            ))}
            <Button
              size="xs"
              variant="default"
              w="fit-content"
              leftSection={<IconPlus size={13} />}
              onClick={() => set({ when_not_to_use: [...content.when_not_to_use, { text: '' }] })}
            >
              Add Alternative
            </Button>
          </Stack>
        </div>

        <Divider label="Formula & parameters" labelPosition="left" />
        <Code block>{entry.formula_description}</Code>
        <Textarea
          label="Formula in plain English"
          description="Explain the calculation above in words."
          autosize
          minRows={2}
          maxLength={3000}
          value={content.formula_plain_english}
          onChange={(e) => set({ formula_plain_english: e.currentTarget.value })}
        />
        {entry.parameters.map((p) => {
          const g = content.parameter_guidance[p.key];
          const setG = (patch: Partial<typeof g>) =>
            set({ parameter_guidance: { ...content.parameter_guidance, [p.key]: { ...g, ...patch } } });
          return (
            <Paper key={p.key} withBorder p="xs" radius="sm" bg="var(--bg-subtle)">
              <Title order={6} mb={4}>
                <Code>{p.key}</Code> {p.label}
                {p.unit ? ` (${p.unit})` : ''}
              </Title>
              <Stack gap={6}>
                <Textarea
                  label="Estimation guidance"
                  description="How to estimate this value."
                  autosize
                  minRows={2}
                  maxLength={1500}
                  value={g.guidance}
                  onChange={(e) => setG({ guidance: e.currentTarget.value })}
                />
                <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
                  <TextInput
                    label="Typical range"
                    placeholder="e.g. 500–2,000 hrs/yr"
                    maxLength={300}
                    value={g.typical_range}
                    onChange={(e) => setG({ typical_range: e.currentTarget.value })}
                  />
                  <TextInput
                    label="Data source"
                    placeholder="e.g. ITSM ticket export"
                    maxLength={500}
                    value={g.data_source}
                    onChange={(e) => setG({ data_source: e.currentTarget.value })}
                  />
                </SimpleGrid>
              </Stack>
            </Paper>
          );
        })}

        <Divider label="Modeling tips" labelPosition="left" />
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
          <Textarea
            label="Active years"
            description="Which years this item should be active."
            autosize
            minRows={2}
            value={content.modeling_tips.schedule}
            onChange={(e) => setTip('schedule', e.currentTarget.value)}
          />
          <Textarea
            label="Ramp profile"
            description="Which ramp fits how this value builds up."
            autosize
            minRows={2}
            value={content.modeling_tips.ramp}
            onChange={(e) => setTip('ramp', e.currentTarget.value)}
          />
          <Textarea
            label="Monte Carlo distribution"
            description="Which inputs are uncertain and how to model them."
            autosize
            minRows={2}
            value={content.modeling_tips.uncertainty}
            onChange={(e) => setTip('uncertainty', e.currentTarget.value)}
          />
          <Textarea
            label="Correlation group"
            description="Which other line items move together with this one."
            autosize
            minRows={2}
            value={content.modeling_tips.correlation}
            onChange={(e) => setTip('correlation', e.currentTarget.value)}
          />
        </SimpleGrid>

        <Textarea
          label="Guardrails & double-counting notes"
          description="One note per line. What overlaps with other templates, and how to avoid counting it twice."
          autosize
          minRows={2}
          value={guardrails}
          onChange={(e) => setGuardrails(e.currentTarget.value)}
        />

        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving}>
            Save Documentation
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
