import { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Group,
  Modal,
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useMediaQuery } from '@mantine/hooks';
import { IconCopy, IconPlus, IconScale } from '@tabler/icons-react';
import { z } from 'zod';
import type { BCACreate, BCASummary } from '../types/api';
import { formatCompactCurrency, formatPercent, zodFormValidate } from '../utils/format';
import { FieldLabel } from './FieldInfo';
import { ReportDownloadButton } from './ReportDownloadButton';

interface BarProps {
  bcas: BCASummary[];
  activeBcaId: string | null;
  onSelectBca: (bcaId: string) => void;
  onOpenCreateBca: (cloneFromId?: string | null) => void;
  onOpenCompare: () => void;
  /** Download the PDF report for the active BCA. */
  onDownloadReport?: () => Promise<void>;
  /** Download every BCA of the initiative as an Excel workbook. */
  onExportExcel?: () => Promise<void>;
}

export function BCASelectorBar({
  bcas,
  activeBcaId,
  onSelectBca,
  onOpenCreateBca,
  onOpenCompare,
  onDownloadReport,
  onExportExcel,
}: BarProps) {

  if (bcas.length === 0) return null;

  return (
    <Paper withBorder p={{ base: 'xs', sm: 'sm' }} radius="md" bg="var(--bg-surface)">
      <Stack gap="xs">
        <Group justify="space-between" align="center" wrap="wrap" gap="xs">
          <Group gap={8} wrap="wrap">
            <Text size="xs" fw={600} c="var(--text-heading)">
              Business Cases ({bcas.length})
            </Text>
            <Text size="xs" c="var(--text-muted)">
              Model multiple scenarios under this initiative and compare Monte Carlo outcomes
            </Text>
          </Group>

          <Group gap="xs" wrap="wrap" w={{ base: '100%', sm: 'auto' }}>
            <Button
              type="button"
              size="xs"
              variant="default"
              leftSection={<IconPlus size={14} />}
              onClick={() => onOpenCreateBca(null)}
            >
              New BCA
            </Button>
            {activeBcaId && (
              <Button
                type="button"
                size="xs"
                variant="default"
                leftSection={<IconCopy size={14} />}
                onClick={() => onOpenCreateBca(activeBcaId)}
              >
                Duplicate
              </Button>
            )}
            {activeBcaId && onDownloadReport && (
              <ReportDownloadButton size="xs" download={onDownloadReport} />
            )}
            {onExportExcel && (
              <ReportDownloadButton
                size="xs"
                fileType="excel"
                label="Export to Excel"
                title="Download every business case as an Excel workbook"
                download={onExportExcel}
              />
            )}
            {bcas.length >= 2 && (
              <Button
                type="button"
                size="xs"
                variant="light"
                color="slateIndigo"
                leftSection={<IconScale size={14} />}
                onClick={onOpenCompare}
              >
                Compare ({bcas.length})
              </Button>
            )}
          </Group>
        </Group>

        <div className="bca-strip" role="listbox" aria-label="Business cases under this initiative">
          {bcas.map((bca) => {
            const active = bca.id === activeBcaId;
            const detPos = bca.npv >= 0;
            const hasMc = bca.latest_npv_p50 !== null;
            return (
              <UnstyledButton
                key={bca.id}
                type="button"
                role="option"
                aria-selected={active}
                data-active={active ? 'true' : undefined}
                className="bca-pill"
                onClick={() => onSelectBca(bca.id)}
              >
                <Stack gap={4}>
                  <Group justify="space-between" align="center" gap={6} wrap="nowrap">
                    <Text size="xs" fw={600} c="var(--text-heading)" lineClamp={1}>
                      {bca.name}
                    </Text>
                    {bca.is_baseline && (
                      <Badge size="xs" variant="light" color="slateIndigo" style={{ flexShrink: 0 }}>
                        Baseline
                      </Badge>
                    )}
                  </Group>

                  <Group justify="space-between" align="center" gap={8} wrap="nowrap">
                    <Text
                      size="xs"
                      fw={600}
                      className="tabular-nums"
                      c={detPos ? 'var(--text-pos)' : 'var(--text-neg)'}
                    >
                      Det. {detPos ? '+' : ''}
                      {formatCompactCurrency(bca.npv)}
                    </Text>
                    <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                      {bca.item_count} items · {bca.horizon_years}y
                    </Text>
                  </Group>

                  <Group gap={6} align="center" wrap="nowrap">
                    <span
                      className="status-dot"
                      style={{
                        backgroundColor: hasMc ? 'var(--chart-pos)' : 'var(--border-input)',
                      }}
                    />
                    <Text size="xs" c="var(--text-muted)" className="tabular-nums" lineClamp={1}>
                      {hasMc
                        ? `MC P50 ${formatCompactCurrency(bca.latest_npv_p50)} (${formatPercent(bca.latest_prob_npv_positive, 0)})`
                        : 'MC not run yet'}
                    </Text>
                  </Group>
                </Stack>
              </UnstyledButton>
            );
          })}
        </div>
      </Stack>
    </Paper>
  );
}

const createBcaSchema = z.object({
  name: z.string().trim().min(1, 'BCA name is required').max(160),
  description: z.string().max(2000),
  clone_from_bca_id: z.string(),
  horizon_years: z.number().int().min(1, 'Min 1').max(30, 'Max 30'),
  discount_rate_pct: z.number().min(0, 'Min 0%').max(50, 'Max 50%'),
  cost_start_year: z.union([
    z.literal(''),
    z.number().int('Whole year required').min(2000, 'Min 2000').max(2100, 'Max 2100'),
  ]),
});

interface ModalProps {
  opened: boolean;
  onClose: () => void;
  bcas: BCASummary[];
  initialCloneFromId: string | null;
  onSubmit: (payload: BCACreate) => Promise<void>;
}

export function CreateBCAModal({
  opened,
  onClose,
  bcas,
  initialCloneFromId,
  onSubmit,
}: ModalProps) {
  const isMobile = useMediaQuery('(max-width: 48em)') ?? false;
  const [submitting, setSubmitting] = useState(false);

  const baselineBca = useMemo(
    () => bcas.find((b) => b.is_baseline) ?? bcas[0] ?? null,
    [bcas]
  );

  const form = useForm({
    initialValues: {
      name: '',
      description: '',
      clone_from_bca_id: '',
      horizon_years: baselineBca?.horizon_years ?? 7,
      discount_rate_pct: Number(((baselineBca?.discount_rate ?? 0.07) * 100).toFixed(2)),
      cost_start_year: (baselineBca?.cost_start_year ?? '') as number | '',
    },
    validateInputOnBlur: true,
    validate: zodFormValidate(createBcaSchema),
  });

  useEffect(() => {
    if (!opened) return;
    const source =
      (initialCloneFromId ? bcas.find((b) => b.id === initialCloneFromId) : null) ?? baselineBca;
    form.setValues({
      name: initialCloneFromId && source ? `${source.name} (Alternative)` : '',
      description: source && initialCloneFromId ? source.description : '',
      clone_from_bca_id: initialCloneFromId || '',
      horizon_years: source?.horizon_years ?? 7,
      discount_rate_pct: Number(((source?.discount_rate ?? 0.07) * 100).toFixed(2)),
      cost_start_year: (source?.cost_start_year ?? '') as number | '',
    });
    form.clearErrors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, initialCloneFromId, baselineBca?.id]);

  const cloneOptions = useMemo(
    () => [
      { value: '', label: 'Start blank (0 line items)' },
      ...bcas.map((b) => ({
        value: b.id,
        label: `Clone from: ${b.name} (${b.item_count} items)`,
      })),
    ],
    [bcas]
  );

  const handleCloneChange = (val: string | null) => {
    const nextId = val || '';
    form.setFieldValue('clone_from_bca_id', nextId);
    const src = bcas.find((b) => b.id === nextId);
    if (src) {
      form.setFieldValue('horizon_years', src.horizon_years);
      form.setFieldValue('discount_rate_pct', Number((src.discount_rate * 100).toFixed(2)));
      form.setFieldValue('cost_start_year', (src.cost_start_year ?? '') as number | '');
    }
  };

  const handleSubmit = form.onSubmit(async (values) => {
    setSubmitting(true);
    try {
      await onSubmit({
        name: values.name.trim(),
        description: values.description.trim(),
        horizon_years: values.horizon_years,
        discount_rate: values.discount_rate_pct / 100,
        cost_start_year: values.cost_start_year === '' ? null : Number(values.cost_start_year),
        clone_from_bca_id: values.clone_from_bca_id || null,
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={initialCloneFromId ? 'Duplicate / Clone BCA Scenario' : 'Create New BCA Scenario'}
      centered
      fullScreen={isMobile}
    >
      <Box component="form" onSubmit={handleSubmit}>
        <Stack gap="sm">
          <TextInput
            label={<FieldLabel field="bca.name">BCA Name</FieldLabel>}
            placeholder="e.g., Managed Cloud Option B"
            required
            {...form.getInputProps('name')}
          />
          <Select
            label={<FieldLabel field="bca.source">Line Items Source</FieldLabel>}
            data={cloneOptions}
            value={form.values.clone_from_bca_id}
            onChange={handleCloneChange}
            allowDeselect={false}
          />
          <SimpleGrid cols={{ base: 1, xs: 3 }} spacing="xs">
            <NumberInput
              label={<FieldLabel field="initiative.cost_start_year">Cost Start Year</FieldLabel>}
              placeholder="e.g. 2026"
              min={2000}
              max={2100}
              allowDecimal={false}
              allowNegative={false}
              thousandSeparator={false}
              {...form.getInputProps('cost_start_year')}
            />
            <NumberInput
              label={<FieldLabel field="initiative.horizon">Horizon (Years)</FieldLabel>}
              min={1}
              max={30}
              required
              {...form.getInputProps('horizon_years')}
            />
            <NumberInput
              label={<FieldLabel field="initiative.discount_rate">Discount Rate (%)</FieldLabel>}
              min={0}
              max={50}
              step={0.5}
              decimalScale={2}
              required
              {...form.getInputProps('discount_rate_pct')}
            />
          </SimpleGrid>
          <Textarea
            label={<FieldLabel field="bca.notes">Scenario Notes</FieldLabel>}
            placeholder="How this BCA differs from the baseline (e.g., vendor SaaS vs. internal build)..."
            minRows={2}
            autosize
            {...form.getInputProps('description')}
          />
          <Group justify="flex-end" mt="sm" grow={isMobile}>
            <Button type="button" variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              {form.values.clone_from_bca_id ? 'Clone & Open BCA' : 'Create BCA'}
            </Button>
          </Group>
        </Stack>
      </Box>
    </Modal>
  );
}
