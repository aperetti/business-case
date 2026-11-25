import { useState } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Modal,
  NumberInput,
  Paper,
  SegmentedControl,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  IconArrowDown,
  IconArrowUp,
  IconEdit,
  IconPencil,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { api } from '../api/client';
import type { BCASummary, MeasureDirection, MeasureOut, MeasureValueOut } from '../types/api';

interface Props {
  initiativeId: string;
  measures: MeasureOut[];
  activeBca: BCASummary | null;
  bcas: BCASummary[];
  /** Reload the initiative after a change. */
  onChanged: () => Promise<void>;
}

const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

export function formatMeasureNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : numberFormat.format(value);
}

function formatEstimate(v: MeasureValueOut | undefined, unit: string): string {
  if (!v) return '—';
  const main = `${formatMeasureNumber(v.value)}${unit ? ` ${unit}` : ''}`;
  if (v.low === null && v.high === null) return main;
  return `${main} (${formatMeasureNumber(v.low ?? v.value)}–${formatMeasureNumber(v.high ?? v.value)})`;
}

function DirectionBadge({ direction }: { direction: MeasureDirection }) {
  const higher = direction === 'higher_is_better';
  return (
    <Badge
      size="sm"
      variant="light"
      color="gray"
      leftSection={higher ? <IconArrowUp size={11} /> : <IconArrowDown size={11} />}
    >
      {higher ? 'Higher is better' : 'Lower is better'}
    </Badge>
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected error';
}

type NumOrEmpty = number | '';
const toNum = (v: string | number): NumOrEmpty => (typeof v === 'number' ? v : v.trim() === '' ? '' : Number(v));

interface EstimateFields {
  value: NumOrEmpty;
  low: NumOrEmpty;
  high: NumOrEmpty;
  note: string;
}

function estimateError(f: EstimateFields): string | null {
  if (f.value === '') return f.low !== '' || f.high !== '' ? 'Enter an expected value.' : null;
  if (f.low !== '' && f.low > f.value) return 'Low cannot be above the expected value.';
  if (f.high !== '' && f.high < f.value) return 'High cannot be below the expected value.';
  return null;
}

function EstimateInputs({
  fields,
  onChange,
  unit,
}: {
  fields: EstimateFields;
  onChange: (next: EstimateFields) => void;
  unit: string;
}) {
  const suffix = unit ? ` (${unit})` : '';
  return (
    <Stack gap="xs">
      <Group grow align="flex-start" gap="xs" wrap="wrap">
        <NumberInput
          label={`Low${suffix}`}
          description="Optional"
          value={fields.low}
          onChange={(v) => onChange({ ...fields, low: toNum(v) })}
          miw={110}
        />
        <NumberInput
          label={`Expected${suffix}`}
          description="Best estimate"
          value={fields.value}
          onChange={(v) => onChange({ ...fields, value: toNum(v) })}
          miw={110}
        />
        <NumberInput
          label={`High${suffix}`}
          description="Optional"
          value={fields.high}
          onChange={(v) => onChange({ ...fields, high: toNum(v) })}
          miw={110}
        />
      </Group>
      <TextInput
        label="Basis / note"
        placeholder="e.g. Q3 user survey, vendor benchmark"
        maxLength={500}
        value={fields.note}
        onChange={(e) => onChange({ ...fields, note: e.currentTarget.value })}
      />
    </Stack>
  );
}

function fieldsFrom(v: MeasureValueOut | undefined): EstimateFields {
  return {
    value: v?.value ?? '',
    low: v?.low ?? '',
    high: v?.high ?? '',
    note: v?.note ?? '',
  };
}

function payloadFrom(f: EstimateFields) {
  return {
    value: f.value as number,
    low: f.low === '' ? null : f.low,
    high: f.high === '' ? null : f.high,
    note: f.note.trim(),
  };
}

/** Create or edit a measure definition; on create, optionally score the active BCA too. */
function MeasureModal({
  opened,
  onClose,
  initiativeId,
  measure,
  activeBca,
  onSaved,
}: {
  opened: boolean;
  onClose: () => void;
  initiativeId: string;
  measure: MeasureOut | null;
  activeBca: BCASummary | null;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(measure?.name ?? '');
  const [unit, setUnit] = useState(measure?.unit ?? '');
  const [direction, setDirection] = useState<MeasureDirection>(measure?.direction ?? 'higher_is_better');
  const [description, setDescription] = useState(measure?.description ?? '');
  const [estimate, setEstimate] = useState<EstimateFields>(fieldsFrom(undefined));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEdit = measure !== null;
  const estError = isEdit ? null : estimateError(estimate);

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError('Give the measure a name.');
      return;
    }
    if (estError) {
      setError(estError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = { name: name.trim(), unit: unit.trim(), direction, description: description.trim() };
      if (isEdit) {
        await api.updateMeasure(initiativeId, measure.id, payload);
      } else {
        const created = await api.createMeasure(initiativeId, payload);
        if (activeBca && estimate.value !== '') {
          await api.setMeasureValue(initiativeId, activeBca.id, created.id, payloadFrom(estimate));
        }
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title={isEdit ? 'Edit measure' : 'Add non-monetary measure'} size="lg">
      <Stack gap="sm">
        <TextInput
          label="Measure"
          placeholder="e.g. Customer satisfaction, Mean time to restore, Carbon footprint"
          required
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          data-autofocus
        />
        <Group grow align="flex-start" gap="xs" wrap="wrap">
          <TextInput
            label="Unit"
            placeholder="e.g. pts, hours, tCO2e, score 1-5"
            maxLength={40}
            value={unit}
            onChange={(e) => setUnit(e.currentTarget.value)}
            miw={160}
          />
          <Stack gap={4} miw={220}>
            <Text size="sm" fw={500}>
              Better when
            </Text>
            <SegmentedControl
              value={direction}
              onChange={(v) => setDirection(v as MeasureDirection)}
              data={[
                { value: 'higher_is_better', label: 'Higher' },
                { value: 'lower_is_better', label: 'Lower' },
              ]}
            />
          </Stack>
        </Group>
        <Textarea
          label="Description"
          placeholder="How it is measured and why it matters"
          autosize
          minRows={2}
          maxLength={1000}
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
        />
        {!isEdit && activeBca && (
          <Paper withBorder p="sm" radius="md" bg="var(--bg-surface)">
            <Text size="sm" fw={600} mb={4}>
              Estimate for {activeBca.name}
            </Text>
            <Text size="xs" c="var(--text-muted)" mb="xs">
              Optional. Every business case in this initiative shares the measure; score the others when you switch to them.
            </Text>
            <EstimateInputs fields={estimate} onChange={setEstimate} unit={unit.trim()} />
          </Paper>
        )}
        {error && (
          <Text size="sm" c="red">
            {error}
          </Text>
        )}
        <Group justify="flex-end" gap="xs">
          <Button type="button" variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" loading={saving} onClick={handleSubmit}>
            {isEdit ? 'Save measure' : 'Add measure'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function EstimateModal({
  opened,
  onClose,
  initiativeId,
  bca,
  measure,
  onSaved,
}: {
  opened: boolean;
  onClose: () => void;
  initiativeId: string;
  bca: BCASummary;
  measure: MeasureOut;
  onSaved: () => Promise<void>;
}) {
  const current = bca.measure_values[measure.id];
  const [fields, setFields] = useState<EstimateFields>(fieldsFrom(current));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setSaving(true);
    setError(null);
    try {
      await action();
      await onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => {
    const err = fields.value === '' ? 'Enter an expected value.' : estimateError(fields);
    if (err) {
      setError(err);
      return;
    }
    run(() => api.setMeasureValue(initiativeId, bca.id, measure.id, payloadFrom(fields)));
  };

  return (
    <Modal opened={opened} onClose={onClose} title={`${measure.name} · ${bca.name}`} size="lg">
      <Stack gap="sm">
        <Group gap="xs">
          <DirectionBadge direction={measure.direction} />
          {measure.description && (
            <Text size="xs" c="var(--text-muted)">
              {measure.description}
            </Text>
          )}
        </Group>
        <EstimateInputs fields={fields} onChange={setFields} unit={measure.unit} />
        {error && (
          <Text size="sm" c="red">
            {error}
          </Text>
        )}
        <Group justify="space-between" gap="xs">
          {current ? (
            <Button
              type="button"
              variant="subtle"
              color="red"
              disabled={saving}
              onClick={() => run(() => api.clearMeasureValue(initiativeId, bca.id, measure.id))}
            >
              Clear estimate
            </Button>
          ) : (
            <span />
          )}
          <Group gap="xs">
            <Button type="button" variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" loading={saving} onClick={handleSave}>
              Save estimate
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Non-monetary benefits: user-defined measures shared by all BCAs, scored per BCA. */
export function NonMonetaryBenefitsPanel({ initiativeId, measures, activeBca, bcas, onChanged }: Props) {
  const isMobile = useMediaQuery('(max-width: 48em)');
  // `key` bumps remount the modals so their fields reset to the record being edited.
  const [measureModal, setMeasureModal] = useState<{ key: number; measure: MeasureOut | null } | null>(null);
  const [estimateFor, setEstimateFor] = useState<MeasureOut | null>(null);

  const otherBcas = bcas.filter((b) => b.id !== activeBca?.id);

  const handleDelete = async (m: MeasureOut) => {
    if (!window.confirm(`Delete the measure "${m.name}"? Its estimates on every business case are removed too.`)) {
      return;
    }
    try {
      await api.deleteMeasure(initiativeId, m.id);
      await onChanged();
      notifications.show({ color: 'gray', title: 'Measure removed', message: m.name });
    } catch (err) {
      notifications.show({ color: 'red', title: 'Cannot delete measure', message: errorMessage(err) });
    }
  };

  const otherEstimates = (m: MeasureOut) =>
    otherBcas
      .filter((b) => b.measure_values[m.id])
      .map((b) => `${b.name}: ${formatEstimate(b.measure_values[m.id], m.unit)}`)
      .join(' · ');

  const actions = (m: MeasureOut) => (
    <Group gap={4} wrap="nowrap">
      <Tooltip label="Edit measure definition" withArrow>
        <ActionIcon
          type="button"
          variant="subtle"
          color="gray"
          aria-label={`Edit measure ${m.name}`}
          onClick={() => setMeasureModal({ key: Date.now(), measure: m })}
        >
          <IconEdit size={16} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Delete measure" withArrow>
        <ActionIcon
          type="button"
          variant="subtle"
          color="red"
          aria-label={`Delete measure ${m.name}`}
          onClick={() => handleDelete(m)}
        >
          <IconTrash size={16} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );

  const estimateButton = (m: MeasureOut) => {
    const v = activeBca?.measure_values[m.id];
    return (
      <Button
        type="button"
        size="compact-sm"
        variant={v ? 'subtle' : 'light'}
        color={v ? 'gray' : undefined}
        rightSection={<IconPencil size={13} />}
        onClick={() => setEstimateFor(m)}
        disabled={!activeBca}
        styles={{ label: { whiteSpace: 'normal', textAlign: 'left' } }}
        h="auto"
        py={4}
      >
        {v ? formatEstimate(v, m.unit) : 'Add estimate'}
      </Button>
    );
  };

  return (
    <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
      <Group justify="space-between" align="center" mb="sm" wrap="wrap" gap="xs">
        <div>
          <Title order={5}>Non-Monetary Benefits ({measures.length})</Title>
          <Text size="xs" c="var(--text-muted)">
            Outcomes that aren&rsquo;t valued in currency. Each measure is shared by every business case in this
            initiative and scored per case, so they can be compared side by side.
          </Text>
        </div>
        <Button
          type="button"
          size="sm"
          variant="default"
          leftSection={<IconPlus size={15} />}
          onClick={() => setMeasureModal({ key: Date.now(), measure: null })}
        >
          Add Measure
        </Button>
      </Group>

      {measures.length === 0 ? (
        <Text size="sm" c="var(--text-muted)" py="lg" ta="center">
          No non-monetary measures yet. Add one for outcomes like customer satisfaction, risk, or time to restore.
        </Text>
      ) : isMobile ? (
        <Stack gap="sm">
          {measures.map((m) => (
            <Paper key={m.id} withBorder p="xs" radius="sm">
              <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
                <div style={{ minWidth: 0 }}>
                  <Text size="sm" fw={600}>
                    {m.name}
                    {m.unit && (
                      <Text span size="xs" c="var(--text-muted)">
                        {' '}
                        · {m.unit}
                      </Text>
                    )}
                  </Text>
                  <DirectionBadge direction={m.direction} />
                </div>
                {actions(m)}
              </Group>
              <Group gap="xs" mt={6} wrap="nowrap">
                <Text size="xs" c="var(--text-muted)">
                  This case:
                </Text>
                {estimateButton(m)}
              </Group>
              {otherEstimates(m) && (
                <Text size="xs" c="var(--text-muted)" mt={4}>
                  {otherEstimates(m)}
                </Text>
              )}
            </Paper>
          ))}
        </Stack>
      ) : (
        <Table.ScrollContainer minWidth={640}>
          <Table verticalSpacing="xs" highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Measure</Table.Th>
                <Table.Th>Better when</Table.Th>
                <Table.Th>{activeBca ? activeBca.name : 'This case'}</Table.Th>
                {otherBcas.length > 0 && <Table.Th>Other cases</Table.Th>}
                <Table.Th w={80} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {measures.map((m) => (
                <Table.Tr key={m.id}>
                  <Table.Td>
                    <Text size="sm" fw={600}>
                      {m.name}
                      {m.unit && (
                        <Text span size="xs" c="var(--text-muted)" fw={400}>
                          {' '}
                          · {m.unit}
                        </Text>
                      )}
                    </Text>
                    {m.description && (
                      <Text size="xs" c="var(--text-muted)" lineClamp={2}>
                        {m.description}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <DirectionBadge direction={m.direction} />
                  </Table.Td>
                  <Table.Td>{estimateButton(m)}</Table.Td>
                  {otherBcas.length > 0 && (
                    <Table.Td>
                      <Text size="xs" c="var(--text-muted)">
                        {otherEstimates(m) || 'Not scored'}
                      </Text>
                    </Table.Td>
                  )}
                  <Table.Td>{actions(m)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}

      {measureModal && (
        <MeasureModal
          key={measureModal.key}
          opened
          onClose={() => setMeasureModal(null)}
          initiativeId={initiativeId}
          measure={measureModal.measure}
          activeBca={activeBca}
          onSaved={onChanged}
        />
      )}
      {estimateFor && activeBca && (
        <EstimateModal
          key={`${estimateFor.id}-${activeBca.id}`}
          opened
          onClose={() => setEstimateFor(null)}
          initiativeId={initiativeId}
          bca={activeBca}
          measure={estimateFor}
          onSaved={onChanged}
        />
      )}
    </Paper>
  );
}
