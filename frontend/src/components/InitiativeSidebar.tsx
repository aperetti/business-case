import { useMemo, useState } from 'react';
import {
  Box,
  Button,
  Group,
  Modal,
  NumberInput,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import { IconBellRinging, IconPlus, IconSearch } from '@tabler/icons-react';
import { z } from 'zod';
import type { InitiativeCreate, InitiativeSummary } from '../types/api';
import {
  DOMAIN_OPTIONS,
  formatCompactCurrency,
  isValidHttpUrl,
  zodFormValidate,
} from '../utils/format';
import { ApprovalStatusBadge } from './ApprovalStatusBadge';
import { FieldLabel } from './FieldInfo';

const createInitiativeSchema = z.object({
  name: z.string().trim().min(1, 'Initiative name is required').max(200),
  description: z.string().max(2000),
  domain: z.string().trim().min(1, 'Domain is required').max(80),
  cost_start_year: z.union([
    z.literal(''),
    z.number().int('Whole year required').min(2000, 'Min 2000').max(2100, 'Max 2100'),
  ]),
  horizon_years: z.number().int().min(1, 'Min 1 year').max(30, 'Max 30 years'),
  discount_rate_pct: z.number().min(0, 'Min 0%').max(50, 'Max 50%'),
  external_resource_url: z
    .string()
    .trim()
    .max(1000, 'Max 1000 characters')
    .refine((val) => !val || isValidHttpUrl(val), {
      message: 'Enter a valid http:// or https:// URL',
    }),
});

interface Props {
  initiatives: InitiativeSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: (payload: InitiativeCreate) => Promise<void>;
  /** Initiatives with an approval step the current user can act on. */
  pendingApprovalIds?: Set<string>;
}

const DEFAULT_START_YEAR = Math.min(2100, Math.max(2000, new Date().getFullYear()));

export function InitiativeSidebar({
  initiatives,
  selectedId,
  onSelect,
  onCreate,
  pendingApprovalIds,
}: Props) {
  const isMobile = useMediaQuery('(max-width: 48em)') ?? false;
  const [searchText, setSearchText] = useState('');
  const [domainFilter, setDomainFilter] = useState<string>('all');
  const [opened, { open, close }] = useDisclosure(false);
  const [submitting, setSubmitting] = useState(false);

  const form = useForm({
    initialValues: {
      name: '',
      description: '',
      domain: 'software',
      cost_start_year: DEFAULT_START_YEAR as number | '',
      horizon_years: 7,
      discount_rate_pct: 6.0,
      external_resource_url: '',
    },
    validateInputOnBlur: true,
    validate: zodFormValidate(createInitiativeSchema),
  });

  const domainOptions = useMemo(() => {
    const set = new Set<string>(DOMAIN_OPTIONS.map((d) => d.value));
    for (const item of initiatives) {
      if (item.domain) set.add(item.domain);
    }
    return [
      { value: 'all', label: 'All domains' },
      ...Array.from(set)
        .sort()
        .map((d) => ({
          value: d,
          label: DOMAIN_OPTIONS.find((opt) => opt.value === d)?.label || d,
        })),
    ];
  }, [initiatives]);

  const filtered = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return initiatives.filter((item) => {
      if (domainFilter !== 'all' && item.domain !== domainFilter) return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.domain.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q)
      );
    });
  }, [initiatives, searchText, domainFilter]);

  const handleSubmit = form.onSubmit(async (values) => {
    setSubmitting(true);
    try {
      await onCreate({
        name: values.name.trim(),
        description: values.description.trim(),
        domain: values.domain.trim().toLowerCase(),
        horizon_years: values.horizon_years,
        discount_rate: values.discount_rate_pct / 100,
        cost_start_year: values.cost_start_year === '' ? null : Number(values.cost_start_year),
        external_resource_url: values.external_resource_url.trim(),
      });
      form.reset();
      close();
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <Stack h="100%" gap="sm" style={{ minWidth: 0 }}>
      <Group justify="space-between" align="center">
        <Title order={5}>Initiatives</Title>
        <Button
          type="button"
          size="xs"
          variant="default"
          leftSection={<IconPlus size={14} />}
          onClick={open}
        >
          New
        </Button>
      </Group>

      <search>
        <Stack gap="xs">
          <TextInput
            aria-label="Filter initiatives by name"
            placeholder="Filter initiatives..."
            leftSection={<IconSearch size={14} />}
            value={searchText}
            onChange={(e) => setSearchText(e.currentTarget.value)}
            size="xs"
          />
          <Select
            aria-label="Filter initiatives by domain"
            data={domainOptions}
            value={domainFilter}
            onChange={(val) => setDomainFilter(val || 'all')}
            size="xs"
            allowDeselect={false}
          />
        </Stack>
      </search>

      <ScrollArea style={{ flex: 1 }} offsetScrollbars>
        <Stack gap="xs">
          {filtered.length === 0 ? (
            <Text size="xs" c="var(--text-muted)" py="md" ta="center">
              No initiatives match your filter.
            </Text>
          ) : (
            filtered.map((item) => {
              const active = item.id === selectedId;
              const positive = item.npv >= 0;
              return (
                <UnstyledButton
                  key={item.id}
                  type="button"
                  onClick={() => onSelect(item.id)}
                  className="card-interactive"
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    borderRadius: 'var(--mantine-radius-md)',
                    border: '1px solid var(--border-subtle)',
                    borderLeft: active
                      ? '3px solid var(--accent-primary)'
                      : '1px solid var(--border-subtle)',
                    backgroundColor: active ? 'var(--bg-active)' : 'var(--bg-surface)',
                  }}
                >
                  <Stack gap={5}>
                    <Group justify="space-between" align="flex-start" wrap="nowrap" gap={6}>
                      <Text fw={600} size="sm" c="var(--text-heading)" lineClamp={2}>
                        {item.name}
                      </Text>
                      {item.status && item.status !== 'draft' && (
                        <ApprovalStatusBadge status={item.status} size="xs" />
                      )}
                    </Group>
                    {pendingApprovalIds?.has(item.id) && (
                      <Group gap={4} wrap="nowrap">
                        <IconBellRinging size={12} color="var(--text-warn)" />
                        <Text size="xs" fw={600} c="var(--text-warn)">
                          Awaiting your approval
                        </Text>
                      </Group>
                    )}
                    <Text size="xs" c="var(--text-muted)" tt="capitalize">
                      {item.domain} ·{' '}
                      {item.cost_start_year != null
                        ? `${item.cost_start_year}–${item.cost_start_year + item.horizon_years - 1}`
                        : `${item.horizon_years} yrs`}{' '}
                      · {item.item_count} items
                      {item.bca_count > 1 ? ` · ${item.bca_count} BCAs` : ''}
                    </Text>
                    <Group justify="space-between" align="center" pt={2}>
                      <Text size="xs" c="var(--text-muted)">
                        Det. NPV
                      </Text>
                      <Text
                        size="xs"
                        fw={600}
                        className="tabular-nums"
                        c={positive ? 'var(--text-pos)' : 'var(--text-neg)'}
                      >
                        {positive ? '+' : ''}
                        {formatCompactCurrency(item.npv)}
                      </Text>
                    </Group>
                  </Stack>
                </UnstyledButton>
              );
            })
          )}
        </Stack>
      </ScrollArea>

      <Modal
        opened={opened}
        onClose={close}
        title="Create Initiative"
        centered
        fullScreen={isMobile}
      >
        <Box component="form" onSubmit={handleSubmit}>
          <Stack gap="sm">
            <TextInput
              label={<FieldLabel field="initiative.name">Initiative Name</FieldLabel>}
              placeholder="e.g., Automated Field Dispatch Modernization"
              required
              {...form.getInputProps('name')}
            />
            <Select
              label={<FieldLabel field="initiative.domain">Domain</FieldLabel>}
              data={DOMAIN_OPTIONS}
              searchable
              required
              {...form.getInputProps('domain')}
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
            <TextInput
              label={<FieldLabel field="initiative.external_url">External Resource (SharePoint)</FieldLabel>}
              placeholder="https://company.sharepoint.com/sites/..."
              {...form.getInputProps('external_resource_url')}
            />
            <Textarea
              label={<FieldLabel field="initiative.description">Description</FieldLabel>}
              placeholder="Scope, key capability outcomes, and investment context..."
              minRows={3}
              autosize
              {...form.getInputProps('description')}
            />
            <Group justify="flex-end" mt="sm" grow={isMobile}>
              <Button type="button" variant="default" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" loading={submitting}>
                Create Initiative
              </Button>
            </Group>
          </Stack>
        </Box>
      </Modal>
    </Stack>
  );
}
