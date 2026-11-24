import { useEffect, useState } from 'react';
import {
  Autocomplete,
  Badge,
  Box,
  Button,
  Divider,
  Grid,
  Group,
  Modal,
  NumberInput,
  Paper,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import { IconCheck, IconExternalLink, IconStar, IconTrash } from '@tabler/icons-react';
import { z } from 'zod';
import type { BCASummary, BCAUpdate, InitiativeDetail, InitiativeUpdate } from '../types/api';
import { DOMAIN_OPTIONS, isValidHttpUrl, zodFormValidate } from '../utils/format';
import { FieldLabel } from './FieldInfo';

const settingsSchema = z.object({
  name: z.string().trim().min(1, 'Initiative name is required').max(200),
  domain: z.string().trim().min(1, 'Domain is required').max(80),
  bca_name: z.string().trim().min(1, 'BCA name is required').max(160),
  horizon_years: z.number().int().min(1, 'Min 1').max(30, 'Max 30'),
  discount_rate_pct: z.number().min(0, 'Min 0%').max(50, 'Max 50%'),
  cost_start_year: z.union([
    z.literal(''),
    z.number().int('Whole year required').min(2000, 'Min 2000').max(2100, 'Max 2100'),
  ]),
  external_resource_url: z
    .string()
    .trim()
    .max(1000, 'Max 1000 characters')
    .refine((val) => !val || isValidHttpUrl(val), {
      message: 'Enter a valid http:// or https:// URL',
    }),
  description: z.string().max(2000),
  bca_description: z.string().max(2000),
});

interface Props {
  initiative: InitiativeDetail;
  activeBca: BCASummary | null;
  bcaCount: number;
  onUpdate: (id: string, payload: InitiativeUpdate) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onUpdateBca: (bcaId: string, payload: BCAUpdate) => Promise<void>;
  onDeleteBca: (bcaId: string) => Promise<void>;
  onSetBaseline: (bcaId: string) => Promise<void>;
}

export function InitiativeSettingsBar({
  initiative,
  activeBca,
  bcaCount,
  onUpdate,
  onDelete,
  onUpdateBca,
  onDeleteBca,
  onSetBaseline,
}: Props) {
  const isMobile = useMediaQuery('(max-width: 48em)') ?? false;
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletingBca, setDeletingBca] = useState(false);
  const [settingBaseline, setSettingBaseline] = useState(false);
  const [confirmOpen, { open: openConfirm, close: closeConfirm }] = useDisclosure(false);
  const [confirmBcaOpen, { open: openConfirmBca, close: closeConfirmBca }] = useDisclosure(false);

  const effectiveHorizon = activeBca?.horizon_years ?? initiative.horizon_years;
  const effectiveRate = activeBca?.discount_rate ?? initiative.discount_rate;
  const effectiveStartYear = activeBca ? activeBca.cost_start_year : initiative.cost_start_year;
  const effectiveBcaName = activeBca?.name ?? 'Baseline BCA';
  const effectiveBcaDesc = activeBca?.description ?? '';

  const form = useForm({
    initialValues: {
      name: initiative.name,
      domain: initiative.domain,
      bca_name: effectiveBcaName,
      horizon_years: effectiveHorizon,
      discount_rate_pct: Number((effectiveRate * 100).toFixed(2)),
      cost_start_year: (effectiveStartYear ?? '') as number | '',
      external_resource_url: initiative.external_resource_url ?? '',
      description: initiative.description,
      bca_description: effectiveBcaDesc,
    },
    validateInputOnBlur: true,
    validate: zodFormValidate(settingsSchema),
  });

  useEffect(() => {
    form.setValues({
      name: initiative.name,
      domain: initiative.domain,
      bca_name: effectiveBcaName,
      horizon_years: effectiveHorizon,
      discount_rate_pct: Number((effectiveRate * 100).toFixed(2)),
      cost_start_year: (effectiveStartYear ?? '') as number | '',
      external_resource_url: initiative.external_resource_url ?? '',
      description: initiative.description,
      bca_description: effectiveBcaDesc,
    });
    form.resetDirty();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    initiative.id,
    initiative.name,
    initiative.domain,
    initiative.external_resource_url,
    initiative.description,
    activeBca?.id,
    effectiveBcaName,
    effectiveHorizon,
    effectiveRate,
    effectiveStartYear,
    effectiveBcaDesc,
  ]);

  const handleSave = form.onSubmit(async (values) => {
    setSaving(true);
    try {
      const initChanged =
        values.name.trim() !== initiative.name ||
        values.domain.trim().toLowerCase() !== initiative.domain ||
        values.external_resource_url.trim() !== (initiative.external_resource_url ?? '') ||
        values.description.trim() !== initiative.description;

      const parsedStart =
        values.cost_start_year === '' ? null : Number(values.cost_start_year);
      const parsedRate = values.discount_rate_pct / 100;

      const bcaChanged =
        activeBca !== null &&
        (values.bca_name.trim() !== activeBca.name ||
          values.bca_description.trim() !== activeBca.description ||
          values.horizon_years !== activeBca.horizon_years ||
          Math.abs(parsedRate - activeBca.discount_rate) > 1e-9 ||
          parsedStart !== activeBca.cost_start_year);

      if (initChanged || !activeBca) {
        await onUpdate(initiative.id, {
          name: values.name.trim(),
          domain: values.domain.trim().toLowerCase(),
          external_resource_url: values.external_resource_url.trim(),
          description: values.description.trim(),
          ...(activeBca
            ? {}
            : {
                horizon_years: values.horizon_years,
                discount_rate: parsedRate,
                cost_start_year: parsedStart,
              }),
        });
      }

      if (activeBca && bcaChanged) {
        await onUpdateBca(activeBca.id, {
          name: values.bca_name.trim(),
          description: values.bca_description.trim(),
          horizon_years: values.horizon_years,
          discount_rate: parsedRate,
          cost_start_year: parsedStart,
        });
      }
    } finally {
      setSaving(false);
    }
  });

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await onDelete(initiative.id);
      closeConfirm();
    } finally {
      setDeleting(false);
    }
  };

  const handleDeleteBca = async () => {
    if (!activeBca) return;
    setDeletingBca(true);
    try {
      await onDeleteBca(activeBca.id);
      closeConfirmBca();
    } finally {
      setDeletingBca(false);
    }
  };

  const handleSetBaseline = async () => {
    if (!activeBca) return;
    setSettingBaseline(true);
    try {
      await onSetBaseline(activeBca.id);
    } finally {
      setSettingBaseline(false);
    }
  };

  const trimmedExternalUrl = form.values.external_resource_url.trim();
  const hasValidExternalUrl = isValidHttpUrl(trimmedExternalUrl);
  const startYearVal =
    typeof form.values.cost_start_year === 'number' &&
    form.values.cost_start_year >= 2000 &&
    form.values.cost_start_year <= 2100
      ? form.values.cost_start_year
      : null;

  return (
    <>
      <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
        <Box component="form" onSubmit={handleSave} aria-label="Initiative and active BCA assumptions">
          <Stack gap="sm">
            <Grid gutter="xs">
              <Grid.Col span={{ base: 12, sm: 6, lg: 4 }}>
                <TextInput
                  label={<FieldLabel field="initiative.name">Initiative Name</FieldLabel>}
                  required
                  {...form.getInputProps('name')}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 6, lg: 2 }}>
                <Autocomplete
                  label={<FieldLabel field="initiative.domain">Domain Tag</FieldLabel>}
                  data={DOMAIN_OPTIONS.map((d) => d.value)}
                  required
                  {...form.getInputProps('domain')}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, lg: 6 }}>
                <Group align="flex-end" gap="xs" wrap="nowrap">
                  <TextInput
                    label={<FieldLabel field="initiative.external_url">External Resource (SharePoint)</FieldLabel>}
                    placeholder="https://company.sharepoint.com/sites/..."
                    style={{ flex: 1, minWidth: 0 }}
                    {...form.getInputProps('external_resource_url')}
                  />
                  {hasValidExternalUrl && (
                    <Button
                      component="a"
                      href={trimmedExternalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      size="sm"
                      variant="default"
                      leftSection={<IconExternalLink size={14} />}
                      style={{ flexShrink: 0 }}
                    >
                      Open
                    </Button>
                  )}
                </Group>
              </Grid.Col>
            </Grid>

            <TextInput
              label={<FieldLabel field="initiative.description">Initiative Description</FieldLabel>}
              placeholder="Program scope and cross-BCA economic boundary"
              {...form.getInputProps('description')}
            />

            <Divider color="var(--border-divider)" />

            <Group justify="space-between" align="center" wrap="wrap" gap="xs">
              <Group gap="xs" wrap="wrap">
                <Text size="xs" fw={600} c="var(--text-heading)">
                  Active BCA Settings
                </Text>
                {activeBca && (
                  <Badge
                    size="xs"
                    variant="light"
                    color={activeBca.is_baseline ? 'slateIndigo' : 'teal'}
                  >
                    {activeBca.is_baseline ? 'Baseline' : 'Alternative BCA'}
                  </Badge>
                )}
              </Group>

              <Group gap="xs" wrap="wrap">
                {activeBca && !activeBca.is_baseline && (
                  <Button
                    type="button"
                    size="compact-xs"
                    variant="light"
                    color="slateIndigo"
                    leftSection={<IconStar size={12} />}
                    loading={settingBaseline}
                    onClick={handleSetBaseline}
                  >
                    Set as Baseline
                  </Button>
                )}
                {activeBca && bcaCount > 1 && (
                  <Button
                    type="button"
                    size="compact-xs"
                    variant="subtle"
                    color="gray"
                    leftSection={<IconTrash size={12} />}
                    onClick={openConfirmBca}
                  >
                    Delete BCA
                  </Button>
                )}
              </Group>
            </Group>

            <Grid gutter="xs">
              <Grid.Col span={{ base: 12, sm: 6, lg: 3 }}>
                <TextInput
                  label={<FieldLabel field="bca.name">BCA Name</FieldLabel>}
                  required
                  {...form.getInputProps('bca_name')}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 6, sm: 3, lg: 2 }}>
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
              </Grid.Col>
              <Grid.Col span={{ base: 6, sm: 3, lg: 2 }}>
                <NumberInput
                  label={<FieldLabel field="initiative.horizon">Horizon (Yrs)</FieldLabel>}
                  min={1}
                  max={30}
                  required
                  {...form.getInputProps('horizon_years')}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 4, lg: 2 }}>
                <NumberInput
                  label={<FieldLabel field="initiative.discount_rate">Discount Rate (%)</FieldLabel>}
                  min={0}
                  max={50}
                  step={0.5}
                  decimalScale={2}
                  required
                  {...form.getInputProps('discount_rate_pct')}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 8, lg: 3 }}>
                <TextInput
                  label={<FieldLabel field="bca.notes">BCA Scenario Notes</FieldLabel>}
                  placeholder="Key distinction for this BCA..."
                  {...form.getInputProps('bca_description')}
                />
              </Grid.Col>
            </Grid>

            <Group align="center" justify="space-between" wrap="wrap" gap="sm">
              <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                {startYearVal !== null
                  ? `Cost accrual window: ${startYearVal}–${startYearVal + form.values.horizon_years - 1} (Y1–Y${form.values.horizon_years})`
                  : 'Target cost start year unset (showing relative years Y1–YH).'}
              </Text>
              <Group gap="xs" grow={isMobile} w={{ base: '100%', sm: 'auto' }}>
                <Button
                  type="submit"
                  size="sm"
                  variant={form.isDirty() ? 'filled' : 'default'}
                  leftSection={<IconCheck size={15} />}
                  loading={saving}
                  disabled={!form.isDirty()}
                >
                  {isMobile ? 'Save' : 'Save Changes'}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="subtle"
                  color="gray"
                  leftSection={<IconTrash size={15} />}
                  onClick={openConfirm}
                >
                  {isMobile ? 'Delete' : 'Delete Initiative'}
                </Button>
              </Group>
            </Group>
          </Stack>
        </Box>
      </Paper>

      <Modal opened={confirmOpen} onClose={closeConfirm} title="Delete Initiative" centered>
        <Stack gap="md">
          <Text size="sm">
            Are you sure you want to permanently delete{' '}
            <Text span fw={600}>
              {initiative.name}
            </Text>
            , all of its BCAs, line items, and saved Monte Carlo runs?
          </Text>
          <Group justify="flex-end" grow={isMobile}>
            <Button type="button" variant="default" onClick={closeConfirm}>
              Cancel
            </Button>
            <Button type="button" color="red" loading={deleting} onClick={handleDelete}>
              Delete Initiative
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={confirmBcaOpen} onClose={closeConfirmBca} title="Delete BCA Scenario" centered>
        <Stack gap="md">
          <Text size="sm">
            Are you sure you want to delete{' '}
            <Text span fw={600}>
              {activeBca?.name}
            </Text>{' '}
            and its line items and Monte Carlo runs?
          </Text>
          <Group justify="flex-end" grow={isMobile}>
            <Button type="button" variant="default" onClick={closeConfirmBca}>
              Cancel
            </Button>
            <Button type="button" color="red" loading={deletingBca} onClick={handleDeleteBca}>
              Delete BCA
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
