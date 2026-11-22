import { useEffect, useMemo, useState } from 'react';
import {
  Accordion,
  Alert,
  Autocomplete,
  Box,
  Button,
  Drawer,
  Group,
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
  Slider,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconAlertCircle, IconBook } from '@tabler/icons-react';
import { evaluateCatalogFormula } from '../data/catalogDocs';
import type {
  CatalogEntry,
  DistributionKind,
  DistributionSpec,
  InitiativeItemCreate,
  InitiativeItemOut,
  RampProfile,
  UncertaintySpec,
} from '../types/api';
import { formatCurrency } from '../utils/format';

interface Props {
  opened: boolean;
  onClose: () => void;
  horizonYears: number;
  catalog: CatalogEntry[];
  existingValueStreams: string[];
  editingItem: InitiativeItemOut | null;
  initialDraft?: Partial<InitiativeItemCreate> | null;
  onOpenDoc?: (catalogId: string) => void;
  onSubmit: (payload: InitiativeItemCreate, existingId?: string) => Promise<void>;
}

const DIST_OPTIONS: { value: DistributionKind; label: string }[] = [
  { value: 'fixed', label: 'Fixed (Deterministic)' },
  { value: 'normal', label: 'Normal (Gaussian)' },
  { value: 'lognormal', label: 'Lognormal (Right-Skewed)' },
  { value: 'triangular', label: 'Triangular (Low / Mode / High)' },
  { value: 'pert', label: 'PERT (Smooth Beta)' },
];

const RAMP_OPTIONS: { value: RampProfile; label: string }[] = [
  { value: 'immediate', label: 'Immediate (100% each active year)' },
  { value: 'linear', label: 'Linear Ramp (scales up to 100%)' },
  { value: 's_curve', label: 'S-Curve Adoption Ramp' },
  { value: 'custom_weights', label: 'Custom Year Weights' },
];

function previewFormulaValue(entry: CatalogEntry | undefined, params: Record<string, number>): number | null {
  if (!entry) return null;
  return evaluateCatalogFormula(entry.formula_type, params);
}

function defaultDistSpec(baseVal: number, kind: DistributionKind): DistributionSpec {
  if (kind === 'fixed') return { distribution: 'fixed' };
  if (kind === 'normal' || kind === 'lognormal') {
    return { distribution: kind, std_pct: 0.15 };
  }
  const low = Number((baseVal * 0.8).toFixed(4));
  const mode = Number(baseVal.toFixed(4));
  const high = Number((baseVal * 1.25).toFixed(4));
  return { distribution: kind, low, mode, high };
}

function DistributionEditor({
  title,
  baseValue,
  spec,
  onChange,
  minVal,
  maxVal,
  isMobile,
}: {
  title: string;
  baseValue: number;
  spec: DistributionSpec;
  onChange: (next: DistributionSpec) => void;
  minVal?: number | null;
  maxVal?: number | null;
  isMobile: boolean;
}) {
  const kind = spec.distribution || 'fixed';
  const showSpread = kind === 'normal' || kind === 'lognormal';
  const showThreePoint = kind === 'triangular' || kind === 'pert';

  return (
    <Stack gap="xs">
      <SimpleGrid cols={{ base: 1, sm: showSpread ? 2 : 1 }} spacing="xs">
        <Select
          label={title}
          data={DIST_OPTIONS}
          value={kind}
          onChange={(val) => onChange(defaultDistSpec(baseValue, (val as DistributionKind) || 'fixed'))}
          size="xs"
          allowDeselect={false}
        />
        {showSpread && (
          <NumberInput
            label="Std Dev (% of base)"
            size="xs"
            min={0}
            max={300}
            step={5}
            value={Number(((spec.std_pct ?? 0.15) * 100).toFixed(1))}
            onChange={(val) =>
              onChange({
                ...spec,
                distribution: kind,
                std_pct: typeof val === 'number' ? val / 100 : 0.15,
              })
            }
          />
        )}
      </SimpleGrid>

      {showThreePoint && (
        <SimpleGrid cols={3} spacing="xs">
          <NumberInput
            label="Low"
            size="xs"
            hideControls={isMobile}
            min={minVal ?? undefined}
            max={maxVal ?? undefined}
            value={spec.low ?? Number((baseValue * 0.8).toFixed(4))}
            onChange={(val) =>
              onChange({
                ...spec,
                distribution: kind,
                low: typeof val === 'number' ? val : baseValue * 0.8,
              })
            }
          />
          <NumberInput
            label="Mode"
            size="xs"
            hideControls={isMobile}
            min={minVal ?? undefined}
            max={maxVal ?? undefined}
            value={spec.mode ?? baseValue}
            onChange={(val) =>
              onChange({
                ...spec,
                distribution: kind,
                mode: typeof val === 'number' ? val : baseValue,
              })
            }
          />
          <NumberInput
            label="High"
            size="xs"
            hideControls={isMobile}
            min={minVal ?? undefined}
            max={maxVal ?? undefined}
            value={spec.high ?? Number((baseValue * 1.25).toFixed(4))}
            onChange={(val) =>
              onChange({
                ...spec,
                distribution: kind,
                high: typeof val === 'number' ? val : baseValue * 1.25,
              })
            }
          />
        </SimpleGrid>
      )}
    </Stack>
  );
}

export function LineItemDrawer({
  opened,
  onClose,
  horizonYears,
  catalog,
  existingValueStreams,
  editingItem,
  initialDraft,
  onOpenDoc,
  onSubmit,
}: Props) {
  const isMobile = useMediaQuery('(max-width: 48em)') ?? false;
  const [catalogId, setCatalogId] = useState<string>('');
  const [label, setLabel] = useState('');
  const [valueStream, setValueStream] = useState('');
  const [startYear, setStartYear] = useState<number>(1);
  const [endYear, setEndYear] = useState<number>(horizonYears);
  const [rampProfile, setRampProfile] = useState<RampProfile>('immediate');
  const [rampWeights, setRampWeights] = useState<number[]>([]);
  const [paramValues, setParamValues] = useState<Record<string, number>>({});
  const [itemMultSpec, setItemMultSpec] = useState<DistributionSpec>({ distribution: 'fixed' });
  const [paramDistSpecs, setParamDistSpecs] = useState<Record<string, DistributionSpec>>({});
  const [correlationGroup, setCorrelationGroup] = useState('');
  const [correlationRho, setCorrelationRho] = useState(0.7);
  const [antiDoubleCountTag, setAntiDoubleCountTag] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const selectedCatalog = useMemo(
    () => catalog.find((c) => c.id === catalogId) || catalog[0],
    [catalog, catalogId]
  );

  const catalogSelectData = useMemo(() => {
    const costs = catalog
      .filter((c) => c.kind === 'cost')
      .map((c) => ({ value: c.id, label: `${c.id} — ${c.name}` }));
    const benefits = catalog
      .filter((c) => c.kind === 'benefit')
      .map((c) => ({ value: c.id, label: `${c.id} — ${c.name}` }));
    return [
      { group: 'Costs', items: costs },
      { group: 'Benefits', items: benefits },
    ];
  }, [catalog]);

  useEffect(() => {
    if (!opened) return;
    setFormError(null);
    if (editingItem) {
      setCatalogId(editingItem.catalog_id);
      setLabel(editingItem.label);
      setValueStream(editingItem.value_stream);
      setStartYear(editingItem.start_year);
      setEndYear(editingItem.end_year);
      setRampProfile(editingItem.ramp_profile);
      const span = editingItem.end_year - editingItem.start_year + 1;
      setRampWeights(
        editingItem.ramp_weights && editingItem.ramp_weights.length === span
          ? editingItem.ramp_weights
          : Array.from({ length: span }, () => 1.0)
      );
      setParamValues({ ...editingItem.param_values });
      setItemMultSpec(editingItem.uncertainty_spec?.item_multiplier || { distribution: 'fixed' });
      setParamDistSpecs(editingItem.uncertainty_spec?.parameters || {});
      setCorrelationGroup(editingItem.uncertainty_spec?.correlation_group || '');
      setCorrelationRho(editingItem.uncertainty_spec?.correlation_rho ?? 0.7);
      setAntiDoubleCountTag(editingItem.anti_double_count_tag || '');
    } else if (!editingItem && initialDraft && catalog.length > 0) {
      const targetCatalog =
        (initialDraft.catalog_id && catalog.find((c) => c.id === initialDraft.catalog_id)) ||
        catalog[0];
      const clampedStart = Math.min(Math.max(1, initialDraft.start_year ?? 1), horizonYears);
      const clampedEnd = Math.min(
        Math.max(clampedStart, initialDraft.end_year ?? horizonYears),
        horizonYears
      );
      const span = Math.max(1, clampedEnd - clampedStart + 1);
      const sourceWeights = initialDraft.ramp_weights;
      const alignedWeights =
        sourceWeights && sourceWeights.length > 0
          ? Array.from({ length: span }, (_, idx) => sourceWeights[idx] ?? 1.0)
          : Array.from({ length: span }, () => 1.0);
      const defaults: Record<string, number> = {};
      for (const p of targetCatalog.parameters) defaults[p.key] = p.default_value;

      setCatalogId(targetCatalog.id);
      setLabel(initialDraft.label || targetCatalog.name);
      setValueStream(
        initialDraft.value_stream ||
          targetCatalog.value_stream_stage ||
          existingValueStreams[0] ||
          'Core'
      );
      setStartYear(clampedStart);
      setEndYear(clampedEnd);
      setRampProfile(initialDraft.ramp_profile || 'immediate');
      setRampWeights(alignedWeights);
      setParamValues({ ...defaults, ...(initialDraft.param_values || {}) });
      setItemMultSpec(initialDraft.uncertainty_spec?.item_multiplier || { distribution: 'fixed' });
      setParamDistSpecs(initialDraft.uncertainty_spec?.parameters || {});
      setCorrelationGroup(initialDraft.uncertainty_spec?.correlation_group || '');
      setCorrelationRho(initialDraft.uncertainty_spec?.correlation_rho ?? 0.7);
      setAntiDoubleCountTag(initialDraft.anti_double_count_tag || '');
    } else if (catalog.length > 0) {
      const first = catalog[0];
      setCatalogId(first.id);
      setLabel(first.name);
      setValueStream(existingValueStreams[0] || first.value_stream_stage || 'Core');
      setStartYear(1);
      setEndYear(horizonYears);
      setRampProfile('immediate');
      setRampWeights(Array.from({ length: horizonYears }, () => 1.0));
      const defaults: Record<string, number> = {};
      for (const p of first.parameters) defaults[p.key] = p.default_value;
      setParamValues(defaults);
      setItemMultSpec({ distribution: 'fixed' });
      setParamDistSpecs({});
      setCorrelationGroup('');
      setCorrelationRho(0.7);
      setAntiDoubleCountTag('');
    }
  }, [opened, editingItem, initialDraft, catalog, horizonYears, existingValueStreams]);

  const handleCatalogChange = (nextId: string | null) => {
    if (!nextId) return;
    const nextEntry = catalog.find((c) => c.id === nextId);
    if (!nextEntry) return;
    setCatalogId(nextId);
    if (!editingItem) {
      setLabel(nextEntry.name);
      if (!valueStream || catalog.some((c) => c.value_stream_stage === valueStream)) {
        setValueStream(nextEntry.value_stream_stage || existingValueStreams[0] || 'Core');
      }
    }
    const nextParams: Record<string, number> = {};
    for (const p of nextEntry.parameters) {
      nextParams[p.key] = p.default_value;
    }
    setParamValues(nextParams);
    setParamDistSpecs({});
  };

  useEffect(() => {
    if (rampProfile !== 'custom_weights') return;
    const span = Math.max(1, endYear - startYear + 1);
    setRampWeights((prev) => {
      if (prev.length === span) return prev;
      return Array.from({ length: span }, (_, idx) => prev[idx] ?? 1.0);
    });
  }, [startYear, endYear, rampProfile]);

  const estimatedAnnual = useMemo(
    () => previewFormulaValue(selectedCatalog, paramValues),
    [selectedCatalog, paramValues]
  );

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!selectedCatalog) {
      setFormError('Please select a catalog template.');
      return;
    }
    if (!label.trim()) {
      setFormError('Line item label is required.');
      return;
    }
    if (!valueStream.trim()) {
      setFormError('Value stream is required.');
      return;
    }
    if (startYear < 1 || endYear > horizonYears || startYear > endYear) {
      setFormError(`Active years must satisfy 1 <= start_year (${startYear}) <= end_year (${endYear}) <= ${horizonYears}.`);
      return;
    }

    for (const param of selectedCatalog.parameters) {
      const val = paramValues[param.key] ?? param.default_value;
      if (param.min_value !== null && val < param.min_value) {
        setFormError(`${param.label} must be >= ${param.min_value}.`);
        return;
      }
      if (param.max_value !== null && val > param.max_value) {
        setFormError(`${param.label} must be <= ${param.max_value}.`);
        return;
      }
    }

    const cleanedParamsSpec: Record<string, DistributionSpec> = {};
    for (const [k, d] of Object.entries(paramDistSpecs)) {
      if (d && d.distribution !== 'fixed') {
        if (
          (d.distribution === 'triangular' || d.distribution === 'pert') &&
          d.low !== undefined &&
          d.mode !== undefined &&
          d.high !== undefined &&
          d.low !== null &&
          d.mode !== null &&
          d.high !== null &&
          (d.low > d.mode || d.mode > d.high)
        ) {
          setFormError(`Parameter '${k}' uncertainty bounds must satisfy Low <= Mode <= High.`);
          return;
        }
        cleanedParamsSpec[k] = d;
      }
    }

    if (
      (itemMultSpec.distribution === 'triangular' || itemMultSpec.distribution === 'pert') &&
      itemMultSpec.low !== undefined &&
      itemMultSpec.mode !== undefined &&
      itemMultSpec.high !== undefined &&
      itemMultSpec.low !== null &&
      itemMultSpec.mode !== null &&
      itemMultSpec.high !== null &&
      (itemMultSpec.low > itemMultSpec.mode || itemMultSpec.mode > itemMultSpec.high)
    ) {
      setFormError('Item multiplier uncertainty bounds must satisfy Low <= Mode <= High.');
      return;
    }

    const uncertainty: UncertaintySpec = {
      item_multiplier: itemMultSpec.distribution === 'fixed' ? null : itemMultSpec,
      parameters: cleanedParamsSpec,
      correlation_group: correlationGroup.trim() || null,
      correlation_rho: correlationRho,
    };

    const payload: InitiativeItemCreate = {
      catalog_id: selectedCatalog.id,
      label: label.trim(),
      value_stream: valueStream.trim(),
      start_year: startYear,
      end_year: endYear,
      ramp_profile: rampProfile,
      ramp_weights: rampProfile === 'custom_weights' ? rampWeights : null,
      param_values: paramValues,
      uncertainty_spec: uncertainty,
      anti_double_count_tag: antiDoubleCountTag.trim() || null,
    };

    setSaving(true);
    try {
      await onSubmit(payload, editingItem?.id);
      onClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save line item.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size={isMobile ? '100%' : 'lg'}
      padding={isMobile ? 'sm' : 'md'}
      title={editingItem ? `Edit Line Item: ${editingItem.label}` : 'Add Catalog Line Item'}
    >
      <Box component="form" onSubmit={handleFormSubmit}>
        <Stack gap="md">
          {formError && (
            <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />} title="Validation Error">
              {formError}
            </Alert>
          )}

          <Select
            label="Catalog Template"
            data={catalogSelectData}
            value={selectedCatalog?.id || null}
            onChange={handleCatalogChange}
            searchable
            required
            allowDeselect={false}
          />

          {selectedCatalog && (
            <Paper withBorder p="xs" radius="sm" bg="var(--bg-subtle)">
              <Stack gap={6}>
                <Group justify="space-between" wrap="wrap" gap="xs">
                  <Group gap={6}>
                    <span
                      className="status-dot"
                      style={{
                        backgroundColor: selectedCatalog.kind === 'cost' ? 'var(--chart-neg)' : 'var(--chart-pos)',
                      }}
                    />
                    <Text
                      size="xs"
                      fw={600}
                      c={selectedCatalog.kind === 'cost' ? 'var(--text-neg)' : 'var(--text-pos)'}
                    >
                      {selectedCatalog.kind === 'cost' ? 'Cost' : 'Benefit'}
                    </Text>
                  </Group>
                  <Text
                    size="xs"
                    ff="monospace"
                    c="var(--text-muted)"
                    style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
                  >
                    {selectedCatalog.formula_description}
                  </Text>
                </Group>
                {selectedCatalog.guardrail_notes && (
                  <Text size="xs" c="var(--text-muted)">
                    <strong>Guardrail:</strong> {selectedCatalog.guardrail_notes}
                  </Text>
                )}
                {onOpenDoc && (
                  <Group justify="flex-end">
                    <Button
                      type="button"
                      variant="subtle"
                      size="compact-xs"
                      leftSection={<IconBook size={13} />}
                      onClick={() => {
                        onClose();
                        onOpenDoc(selectedCatalog.id);
                      }}
                    >
                      Template guide
                    </Button>
                  </Group>
                )}
              </Stack>
            </Paper>
          )}

          <Box component="fieldset" style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 12 }}>
            <Text component="legend" size="xs" fw={600} px={6} c="var(--text-muted)">
              Scope & Realization Schedule
            </Text>
            <Stack gap="xs">
              <TextInput
                label="Line Item Label"
                value={label}
                onChange={(e) => setLabel(e.currentTarget.value)}
                required
              />
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
                <Autocomplete
                  label="Value Stream"
                  data={existingValueStreams}
                  value={valueStream}
                  onChange={setValueStream}
                  required
                />
                <TextInput
                  label="Anti-Double-Count Tag"
                  placeholder="Optional overlap tag (e.g., eng-capacity)"
                  value={antiDoubleCountTag}
                  onChange={(e) => setAntiDoubleCountTag(e.currentTarget.value)}
                />
              </SimpleGrid>

              <SimpleGrid cols={2} spacing="xs">
                <NumberInput
                  label="Start Year"
                  min={1}
                  max={horizonYears}
                  value={startYear}
                  onChange={(v) => setStartYear(typeof v === 'number' ? v : 1)}
                  required
                />
                <NumberInput
                  label="End Year"
                  min={1}
                  max={horizonYears}
                  value={endYear}
                  onChange={(v) => setEndYear(typeof v === 'number' ? v : horizonYears)}
                  required
                />
              </SimpleGrid>

              <Select
                label="Ramp Profile"
                data={RAMP_OPTIONS}
                value={rampProfile}
                onChange={(v) => setRampProfile((v as RampProfile) || 'immediate')}
                allowDeselect={false}
              />

              {rampProfile === 'custom_weights' && (
                <Stack gap={4}>
                  <Text size="xs" fw={500} c="var(--text-body)">
                    Custom Annual Weights (Y{startYear}–Y{endYear}, normalized if &gt; 1.0)
                  </Text>
                  <SimpleGrid cols={{ base: 2, xs: 3, sm: 5 }} spacing="xs">
                    {rampWeights.map((w, idx) => (
                      <NumberInput
                        key={idx}
                        label={`Y${startYear + idx}`}
                        size="xs"
                        min={0}
                        step={0.1}
                        decimalScale={2}
                        value={w}
                        onChange={(val) => {
                          const next = [...rampWeights];
                          next[idx] = typeof val === 'number' ? val : 0;
                          setRampWeights(next);
                        }}
                      />
                    ))}
                  </SimpleGrid>
                </Stack>
              )}
            </Stack>
          </Box>

          {selectedCatalog && (
            <Box component="fieldset" style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 12 }}>
              <Text component="legend" size="xs" fw={600} px={6} c="var(--text-muted)">
                Catalog Parameters
              </Text>
              <Stack gap="xs">
                <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
                  {selectedCatalog.parameters.map((param) => (
                    <NumberInput
                      key={param.key}
                      label={`${param.label}${param.unit ? ` (${param.unit})` : ''}`}
                      description={
                        param.min_value !== null || param.max_value !== null
                          ? `Bounds: ${param.min_value ?? '−∞'} to ${param.max_value ?? '∞'}`
                          : undefined
                      }
                      min={param.min_value ?? undefined}
                      max={param.max_value ?? undefined}
                      decimalScale={4}
                      value={paramValues[param.key] ?? param.default_value}
                      onChange={(val) =>
                        setParamValues((prev) => ({
                          ...prev,
                          [param.key]: typeof val === 'number' ? val : 0,
                        }))
                      }
                      required={param.required}
                    />
                  ))}
                </SimpleGrid>
                {estimatedAnnual !== null && (
                  <Group justify="space-between" pt={4} wrap="wrap" gap="xs">
                    <Text size="xs" c="var(--text-muted)">
                      Estimated Base Annual Value (at 100% ramp):
                    </Text>
                    <Text
                      size="sm"
                      fw={600}
                      className="tabular-nums"
                      c={selectedCatalog.kind === 'cost' ? 'var(--text-neg)' : 'var(--text-pos)'}
                    >
                      {formatCurrency(estimatedAnnual)} / yr
                    </Text>
                  </Group>
                )}
              </Stack>
            </Box>
          )}

          <Box component="fieldset" style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 12 }}>
            <Text component="legend" size="xs" fw={600} px={6} c="var(--text-muted)">
              Monte Carlo Uncertainty & Correlation
            </Text>
            <Stack gap="sm">
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
                <TextInput
                  label="Correlation Group"
                  placeholder="e.g., adoption or delivery_effort"
                  value={correlationGroup}
                  onChange={(e) => setCorrelationGroup(e.currentTarget.value)}
                  size="xs"
                />
                <div>
                  <Text size="xs" fw={500} mb={4} c="var(--text-body)">
                    Correlation Strength (ρ = {correlationRho.toFixed(2)})
                  </Text>
                  <Slider
                    min={-0.95}
                    max={0.95}
                    step={0.05}
                    value={correlationRho}
                    onChange={setCorrelationRho}
                    disabled={!correlationGroup.trim()}
                  />
                </div>
              </SimpleGrid>

              <DistributionEditor
                title="Overall Item Multiplier (base = 1.0x)"
                baseValue={1.0}
                spec={itemMultSpec}
                onChange={setItemMultSpec}
                minVal={0}
                isMobile={isMobile}
              />

              {selectedCatalog && (
                <Accordion variant="separated" radius="sm">
                  <Accordion.Item value="param-uncertainty">
                    <Accordion.Control>
                      <Text size="xs" fw={600} c="var(--text-heading)">
                        Per-Parameter Uncertainty Overrides ({Object.values(paramDistSpecs).filter((d) => d.distribution !== 'fixed').length} active)
                      </Text>
                    </Accordion.Control>
                    <Accordion.Panel>
                      <Stack gap="sm">
                        {selectedCatalog.parameters.map((param) => {
                          const base = paramValues[param.key] ?? param.default_value;
                          const curSpec = paramDistSpecs[param.key] || { distribution: 'fixed' };
                          return (
                            <Paper key={param.key} withBorder p="xs" radius="sm" bg="var(--bg-surface)">
                              <DistributionEditor
                                title={`${param.label} (base: ${base})`}
                                baseValue={base}
                                spec={curSpec}
                                minVal={param.min_value}
                                maxVal={param.max_value}
                                isMobile={isMobile}
                                onChange={(next) =>
                                  setParamDistSpecs((prev) => ({ ...prev, [param.key]: next }))
                                }
                              />
                            </Paper>
                          );
                        })}
                      </Stack>
                    </Accordion.Panel>
                  </Accordion.Item>
                </Accordion>
              )}
            </Stack>
          </Box>

          <Group justify="flex-end" mt="xs" grow={isMobile}>
            <Button type="button" variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={saving}>
              {editingItem ? 'Save Changes' : 'Add Line Item'}
            </Button>
          </Group>
        </Stack>
      </Box>
    </Drawer>
  );
}
