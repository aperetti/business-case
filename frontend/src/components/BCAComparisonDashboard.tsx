import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Collapse,
  Divider,
  Group,
  NumberInput,
  Paper,
  RingProgress,
  SegmentedControl,
  Select,
  SimpleGrid,
  Slider,
  Stack,
  Switch,
  Table,
  Text,
  Title,
  Tooltip as MantineTooltip,
} from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import {
  IconAdjustments,
  IconArrowsExchange,
  IconCopy,
  IconHistory,
  IconInfoCircle,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconScale,
  IconTrophy,
} from '@tabler/icons-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  AlignedHistogramBin,
  BCACompareRequest,
  BCAComparisonPairedMetrics,
  BCAComparisonRecord,
  BCAComparisonResult,
  BCASummary,
  HistogramBin,
  InitiativeDetail,
  SensitivityDriver,
  SimulationResult,
  SimulationRunRecord,
  ValueStreamComparisonRow,
  YearlyComparisonRow,
} from '../types/api';
import {
  formatCompactCurrency,
  formatCurrency,
  formatPayback,
  formatPercent,
  formatRatio,
  formatYearLabel,
} from '../utils/format';

interface Props {
  initiative: InitiativeDetail;
  bcas: BCASummary[];
  runs: SimulationRunRecord[];
  comparisons: BCAComparisonRecord[];
  activeComparison: BCAComparisonResult | null;
  running: boolean;
  onRunComparison: (req: BCACompareRequest) => Promise<void>;
  onSelectComparison: (record: BCAComparisonRecord) => void;
  onOpenCreateBca: (cloneFromId?: string | null) => void;
}

const TOOLTIP_PROPS = {
  contentStyle: {
    backgroundColor: 'var(--bg-surface)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 8,
    color: 'var(--text-heading)',
    fontSize: 12,
  },
  labelStyle: { color: 'var(--text-heading)', fontWeight: 600 },
  itemStyle: { color: 'var(--text-body)' },
};

function interpolateCdf(bins: HistogramBin[], x: number): number {
  if (bins.length === 0) return 0;
  if (x <= bins[0].bin_start) return 0;
  if (x >= bins[bins.length - 1].bin_end) return 1;
  let prevCum = 0;
  for (const bin of bins) {
    if (x <= bin.bin_end) {
      const span = bin.bin_end - bin.bin_start;
      const frac = span > 0 ? (x - bin.bin_start) / span : 1;
      return Math.min(1, Math.max(0, prevCum + frac * (bin.cumulative_prob - prevCum)));
    }
    prevCum = bin.cumulative_prob;
  }
  return 1;
}

function buildAlignedFromIndividualRuns(
  resA: SimulationResult,
  resB: SimulationResult,
  bins = 32
): AlignedHistogramBin[] {
  const hA = resA.monte_carlo.npv_histogram;
  const hB = resB.monte_carlo.npv_histogram;
  if (hA.length === 0 || hB.length === 0) return [];

  const minV = Math.min(hA[0].bin_start, hB[0].bin_start);
  const maxV = Math.max(hA[hA.length - 1].bin_end, hB[hB.length - 1].bin_end);
  if (Math.abs(maxV - minV) < 1e-6) {
    return [
      {
        bin_start: minV - 1,
        bin_end: maxV + 1,
        bin_mid: minV,
        count_a: resA.n_simulations,
        density_a: 1,
        cdf_a: 1,
        count_b: resB.n_simulations,
        density_b: 1,
        cdf_b: 1,
      },
    ];
  }

  const step = (maxV - minV) / bins;
  const out: AlignedHistogramBin[] = [];
  let prevCdfA = 0;
  let prevCdfB = 0;

  for (let i = 0; i < bins; i++) {
    const start = minV + i * step;
    const end = i === bins - 1 ? maxV : start + step;
    const cdfA = i === bins - 1 ? 1 : interpolateCdf(hA, end);
    const cdfB = i === bins - 1 ? 1 : interpolateCdf(hB, end);
    const densA = Math.max(0, cdfA - prevCdfA);
    const densB = Math.max(0, cdfB - prevCdfB);
    out.push({
      bin_start: start,
      bin_end: end,
      bin_mid: 0.5 * (start + end),
      count_a: Math.round(densA * resA.n_simulations),
      density_a: densA,
      cdf_a: cdfA,
      count_b: Math.round(densB * resB.n_simulations),
      density_b: densB,
      cdf_b: cdfB,
    });
    prevCdfA = cdfA;
    prevCdfB = cdfB;
  }
  return out;
}

function buildYearlyFromRuns(resA: SimulationResult, resB: SimulationResult): YearlyComparisonRow[] {
  const byYrA = new Map(resA.monte_carlo.yearly_cumulative_npv_bands.map((y) => [y.year, y]));
  const byYrB = new Map(resB.monte_carlo.yearly_cumulative_npv_bands.map((y) => [y.year, y]));
  const maxYr = Math.max(resA.horizon_years, resB.horizon_years);
  const rows: YearlyComparisonRow[] = [];
  for (let yr = 1; yr <= maxYr; yr++) {
    const ba = byYrA.get(yr);
    const bb = byYrB.get(yr);
    rows.push({
      year: yr,
      a_p10: ba?.p10 ?? null,
      a_p50: ba?.p50 ?? null,
      a_p90: ba?.p90 ?? null,
      b_p10: bb?.p10 ?? null,
      b_p50: bb?.p50 ?? null,
      b_p90: bb?.p90 ?? null,
      delta_p10: null,
      delta_p50: ba && bb ? bb.p50 - ba.p50 : null,
      delta_p90: null,
    });
  }
  return rows;
}

function buildValueStreamsFromRuns(
  resA: SimulationResult,
  resB: SimulationResult
): ValueStreamComparisonRow[] {
  const mapA = new Map(resA.monte_carlo.value_streams.map((v) => [v.value_stream, v]));
  const mapB = new Map(resB.monte_carlo.value_streams.map((v) => [v.value_stream, v]));
  const names = Array.from(new Set([...mapA.keys(), ...mapB.keys()])).sort();
  return names.map((name) => {
    const va = mapA.get(name);
    const vb = mapB.get(name);
    const aCosts = va?.pv_costs ?? 0;
    const aBen = va?.pv_benefits ?? 0;
    const aNpv = va?.npv ?? 0;
    const aP50 = va?.sim_npv_p50 ?? 0;
    const bCosts = vb?.pv_costs ?? 0;
    const bBen = vb?.pv_benefits ?? 0;
    const bNpv = vb?.npv ?? 0;
    const bP50 = vb?.sim_npv_p50 ?? 0;
    return {
      value_stream: name,
      a_pv_costs: aCosts,
      a_pv_benefits: aBen,
      a_npv: aNpv,
      a_sim_npv_p50: aP50,
      b_pv_costs: bCosts,
      b_pv_benefits: bBen,
      b_npv: bNpv,
      b_sim_npv_p50: bP50,
      delta_npv: bNpv - aNpv,
      delta_sim_npv_p50: bP50 - aP50,
    };
  });
}

function formatSignedCurrency(val: number | null | undefined, compact = true): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return '—';
  const formatted = compact ? formatCompactCurrency(val) : formatCurrency(val);
  return val > 0 ? `+${formatted}` : formatted;
}

function formatSignedPp(deltaRatio: number | null | undefined): string {
  if (deltaRatio === null || deltaRatio === undefined || !Number.isFinite(deltaRatio)) return '—';
  const pp = deltaRatio * 100;
  return `${pp > 0 ? '+' : ''}${pp.toFixed(1)} pp`;
}

function DriverBars({
  title,
  accentColor,
  drivers,
}: {
  title: string;
  accentColor: string;
  drivers: SensitivityDriver[];
}) {
  return (
    <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
      <Group gap={6} mb={4}>
        <span className="status-dot" style={{ backgroundColor: accentColor }} />
        <Title order={6}>{title}</Title>
      </Group>
      <Text size="xs" c="var(--text-muted)" mb="sm">
        Top Spearman ρ drivers of simulated NPV
      </Text>
      {drivers.length === 0 ? (
        <Text size="xs" c="var(--text-muted)" py="md">
          No stochastic parameter uncertainty configured on this BCA.
        </Text>
      ) : (
        <Stack gap="xs">
          {drivers.slice(0, 6).map((d) => {
            const positive = d.spearman_corr >= 0;
            const magPct = Math.min(50, Math.abs(d.spearman_corr) * 50);
            return (
              <Box key={`${d.item_id}-${d.parameter_key}`}>
                <Group justify="space-between" align="baseline" wrap="wrap" gap={6} mb={3}>
                  <Text size="xs" fw={500} c="var(--text-body)" style={{ flex: '1 1 150px', minWidth: 0 }}>
                    {d.driver_label}
                  </Text>
                  <Text size="xs" className="tabular-nums" c="var(--text-muted)" style={{ whiteSpace: 'nowrap' }}>
                    <Text span fw={600} c={positive ? 'var(--text-pos)' : 'var(--text-neg)'}>
                      ρ {positive ? '+' : ''}
                      {d.spearman_corr.toFixed(2)}
                    </Text>
                    {' · '}
                    {d.variance_share_pct.toFixed(1)}%
                  </Text>
                </Group>
                <div
                  style={{
                    position: 'relative',
                    height: 6,
                    borderRadius: 3,
                    background: 'var(--chart-track)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      left: '50%',
                      top: 0,
                      bottom: 0,
                      width: 1,
                      background: 'var(--border-input)',
                      zIndex: 2,
                    }}
                  />
                  <div
                    style={{
                      position: 'absolute',
                      top: 0,
                      bottom: 0,
                      left: positive ? '50%' : `${50 - magPct}%`,
                      width: `${magPct}%`,
                      background: positive ? 'var(--chart-pos)' : 'var(--chart-neg)',
                      borderRadius: 3,
                    }}
                  />
                </div>
              </Box>
            );
          })}
        </Stack>
      )}
    </Paper>
  );
}

export function BCAComparisonDashboard({
  initiative,
  bcas,
  runs,
  comparisons,
  activeComparison,
  running,
  onRunComparison,
  onSelectComparison,
  onOpenCreateBca,
}: Props) {
  const isMobile = useMediaQuery('(max-width: 48em)') ?? false;
  const [whatIfOpen, { toggle: toggleWhatIf }] = useDisclosure(false);

  const baselineBca = useMemo(
    () => bcas.find((b) => b.is_baseline) ?? bcas[0] ?? null,
    [bcas]
  );

  const [bcaAId, setBcaAId] = useState<string>('');
  const [bcaBId, setBcaBId] = useState<string>('');
  const [nSimulations, setNSimulations] = useState<number>(10000);
  const [seed, setSeed] = useState<number | ''>(42);
  const [discountRatePct, setDiscountRatePct] = useState<number | ''>('');
  const [uncertaintyScale, setUncertaintyScale] = useState<number>(1.0);
  const [benefitScale, setBenefitScale] = useState<number>(1.0);
  const [costScale, setCostScale] = useState<number>(1.0);

  const [distChartMode, setDistChartMode] = useState<'density' | 'cdf' | 'delta'>('density');
  const [showEnvelopes, setShowEnvelopes] = useState<boolean>(false);
  const [vsMetric, setVsMetric] = useState<'sim_p50' | 'benefits' | 'costs'>('sim_p50');

  useEffect(() => {
    if (bcas.length === 0) {
      setBcaAId('');
      setBcaBId('');
      return;
    }
    const validIds = new Set(bcas.map((b) => b.id));
    const nextA = validIds.has(bcaAId) ? bcaAId : (baselineBca?.id ?? bcas[0].id);
    let nextB = validIds.has(bcaBId) && bcaBId !== nextA ? bcaBId : '';
    if (!nextB) {
      nextB = bcas.find((b) => b.id !== nextA)?.id ?? '';
    }
    if (nextA !== bcaAId) setBcaAId(nextA);
    if (nextB !== bcaBId) setBcaBId(nextB);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initiative.id, bcas]);

  useEffect(() => {
    if (!activeComparison) return;
    if (
      bcas.some((b) => b.id === activeComparison.bca_a_id) &&
      bcas.some((b) => b.id === activeComparison.bca_b_id)
    ) {
      setBcaAId(activeComparison.bca_a_id);
      setBcaBId(activeComparison.bca_b_id);
    }
  }, [activeComparison, bcas]);

  const bcaA = useMemo(() => bcas.find((b) => b.id === bcaAId) ?? null, [bcas, bcaAId]);
  const bcaB = useMemo(() => bcas.find((b) => b.id === bcaBId) ?? null, [bcas, bcaBId]);

  const bcaSelectOptions = useMemo(
    () =>
      bcas.map((b) => ({
        value: b.id,
        label: `${b.name}${b.is_baseline ? ' (Baseline)' : ''}`,
      })),
    [bcas]
  );

  const handleSelectA = (val: string | null) => {
    if (!val) return;
    if (val === bcaBId) {
      setBcaBId(bcaAId);
    }
    setBcaAId(val);
  };

  const handleSelectB = (val: string | null) => {
    if (!val) return;
    if (val === bcaAId) {
      setBcaAId(bcaBId);
    }
    setBcaBId(val);
  };

  const handleSwap = () => {
    const prevA = bcaAId;
    setBcaAId(bcaBId);
    setBcaBId(prevA);
  };

  const handleResetWhatIf = () => {
    setDiscountRatePct('');
    setUncertaintyScale(1.0);
    setBenefitScale(1.0);
    setCostScale(1.0);
  };

  const triggerComparison = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!bcaAId || !bcaBId || bcaAId === bcaBId) return;
    await onRunComparison({
      bca_a_id: bcaAId,
      bca_b_id: bcaBId,
      n_simulations: nSimulations,
      seed: typeof seed === 'number' ? seed : null,
      discount_rate_override:
        typeof discountRatePct === 'number' ? discountRatePct / 100 : null,
      uncertainty_scale: uncertaintyScale,
      benefit_scale: benefitScale,
      cost_scale: costScale,
      persist: true,
    });
  };

  const matchedComparison: BCAComparisonResult | null = useMemo(() => {
    if (!bcaAId || !bcaBId) return null;
    if (
      activeComparison &&
      activeComparison.bca_a_id === bcaAId &&
      activeComparison.bca_b_id === bcaBId
    ) {
      return activeComparison;
    }
    const found = comparisons.find(
      (c) => c.bca_a_id === bcaAId && c.bca_b_id === bcaBId
    );
    return found?.summary ?? null;
  }, [activeComparison, comparisons, bcaAId, bcaBId]);

  const latestRunA = useMemo(() => {
    if (!bcaAId) return null;
    const match = runs.find((r) => (r.bca_id ?? baselineBca?.id) === bcaAId);
    return match?.summary ?? null;
  }, [runs, bcaAId, baselineBca?.id]);

  const latestRunB = useMemo(() => {
    if (!bcaBId) return null;
    const match = runs.find((r) => (r.bca_id ?? baselineBca?.id) === bcaBId);
    return match?.summary ?? null;
  }, [runs, bcaBId, baselineBca?.id]);

  const resA: SimulationResult | null = matchedComparison?.result_a ?? latestRunA;
  const resB: SimulationResult | null = matchedComparison?.result_b ?? latestRunB;
  const paired: BCAComparisonPairedMetrics | null = matchedComparison?.paired ?? null;

  useEffect(() => {
    if (!paired && distChartMode === 'delta') {
      setDistChartMode('density');
    }
  }, [paired, distChartMode]);

  const alignedDist = useMemo(() => {
    if (paired) return paired.aligned_npv_distribution;
    if (resA && resB) return buildAlignedFromIndividualRuns(resA, resB, 32);
    return [];
  }, [paired, resA, resB]);

  const yearlyComparison = useMemo(() => {
    if (paired) return paired.yearly_comparison;
    if (resA && resB) return buildYearlyFromRuns(resA, resB);
    return [];
  }, [paired, resA, resB]);

  const vsComparison = useMemo(() => {
    if (paired) return paired.value_stream_comparison;
    if (resA && resB) return buildValueStreamsFromRuns(resA, resB);
    return [];
  }, [paired, resA, resB]);

  if (bcas.length < 2) {
    return (
      <Paper withBorder p={{ base: 'md', sm: 'xl' }} radius="md" bg="var(--bg-surface)">
        <Stack align="center" gap="sm" ta="center" maw={560} mx="auto">
          <IconScale size={32} color="var(--accent-primary)" />
          <Title order={4}>Add a Second BCA to Compare Options</Title>
          <Text size="sm" c="var(--text-muted)">
            This initiative currently has{' '}
            <Text span fw={600} c="var(--text-heading)">
              {bcas[0]?.name || '1 BCA'}
            </Text>
            . Duplicate your baseline or create an alternative BCA scenario (e.g., Build vs. Buy,
            Phased vs. Accelerated), then run Monte Carlo simulations to compare distributions,
            win probabilities, and trajectories side-by-side.
          </Text>
          <Group gap="sm" mt="xs" wrap="wrap" justify="center">
            <Button
              type="button"
              leftSection={<IconCopy size={15} />}
              onClick={() => onOpenCreateBca(bcas[0]?.id ?? null)}
            >
              Clone Baseline BCA to Compare
            </Button>
            <Button
              type="button"
              variant="default"
              leftSection={<IconPlus size={15} />}
              onClick={() => onOpenCreateBca(null)}
            >
              Create Blank BCA
            </Button>
          </Group>
        </Stack>
      </Paper>
    );
  }

  const nameA = bcaA?.name || 'BCA A';
  const nameB = bcaB?.name || 'BCA B';
  const mcA = resA?.monte_carlo ?? null;
  const mcB = resB?.monte_carlo ?? null;

  const p50A = mcA?.npv_stats.p50 ?? null;
  const p50B = mcB?.npv_stats.p50 ?? null;
  const deltaP50 = p50A !== null && p50B !== null ? p50B - p50A : null;
  const leaderSide: 'A' | 'B' | 'tie' =
    deltaP50 === null || Math.abs(deltaP50) < 1 ? 'tie' : deltaP50 > 0 ? 'B' : 'A';
  const leaderName = leaderSide === 'B' ? nameB : nameA;

  const p10Diff =
    mcA && mcB ? mcB.npv_stats.p10 - mcA.npv_stats.p10 : null;
  const probPosDiff =
    mcA && mcB ? mcB.prob_npv_positive - mcA.prob_npv_positive : null;

  let riskInsight = '';
  if (mcA && mcB && deltaP50 !== null && p10Diff !== null && probPosDiff !== null) {
    if (leaderSide === 'B') {
      riskInsight =
        p10Diff >= 0 && probPosDiff >= 0
          ? `Strict advantage: ${nameB} delivers higher median NPV with stronger P10 downside protection and higher certainty.`
          : `${nameB} leads on median NPV (${formatSignedCurrency(deltaP50)}), though ${nameA} has ${p10Diff < 0 ? 'higher P10 downside floor' : 'higher P(NPV > 0)'} — weigh risk appetite.`;
    } else if (leaderSide === 'A') {
      riskInsight =
        p10Diff <= 0 && probPosDiff <= 0
          ? `Strict advantage: ${nameA} delivers higher median NPV with stronger P10 downside protection and higher certainty.`
          : `${nameA} leads on median NPV (${formatSignedCurrency(-deltaP50)}), though ${nameB} shows ${p10Diff > 0 ? 'stronger P10 downside floor' : 'higher P(NPV > 0)'}.`;
    } else {
      riskInsight = 'Both BCAs produce virtually identical median simulated NPV.';
    }
  }

  const sharedCostStart =
    bcaA?.cost_start_year != null && bcaA.cost_start_year === bcaB?.cost_start_year
      ? bcaA.cost_start_year
      : null;

  const vsChartData = vsComparison.map((row) => ({
    value_stream: row.value_stream,
    valA:
      vsMetric === 'sim_p50'
        ? (row.a_sim_npv_p50 ?? row.a_npv)
        : vsMetric === 'benefits'
        ? row.a_pv_benefits
        : row.a_pv_costs,
    valB:
      vsMetric === 'sim_p50'
        ? (row.b_sim_npv_p50 ?? row.b_npv)
        : vsMetric === 'benefits'
        ? row.b_pv_benefits
        : row.b_pv_costs,
  }));

  const canRunCompare =
    Boolean(bcaA && bcaB && bcaA.item_count > 0 && bcaB.item_count > 0);

  return (
    <Stack gap="md">
      {/* Comparison Selector & Simulation Controls */}
      <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
        <Box component="form" onSubmit={triggerComparison} aria-label="Compare two BCAs">
          <Stack gap="sm">
            <Group justify="space-between" align="center" wrap="wrap" gap="xs">
              <div>
                <Title order={5}>BCA Monte Carlo Comparison Dashboard</Title>
                <Text size="xs" c="var(--text-muted)">
                  Select any two BCAs under this initiative to compare stochastic distributions, risk-return, and value streams
                </Text>
              </div>
              <Group gap="xs" wrap="wrap" w={{ base: '100%', sm: 'auto' }} justify="flex-end">
                <Button
                  type="button"
                  size="xs"
                  variant="subtle"
                  color="gray"
                  leftSection={<IconAdjustments size={14} />}
                  onClick={toggleWhatIf}
                >
                  {whatIfOpen ? 'Hide What-If' : 'What-If Overrides'}
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  fullWidth={isMobile}
                  loading={running}
                  disabled={!canRunCompare}
                  leftSection={<IconPlayerPlay size={15} />}
                >
                  Run Monte Carlo Comparison
                </Button>
              </Group>
            </Group>

            <Group align="flex-end" gap="xs" wrap="wrap">
              <Select
                label={
                  <Group gap={6} wrap="nowrap">
                    <span className="status-dot" style={{ backgroundColor: 'var(--compare-a)' }} />
                    <span>BCA A (Reference)</span>
                  </Group>
                }
                data={bcaSelectOptions}
                value={bcaAId}
                onChange={handleSelectA}
                allowDeselect={false}
                style={{ flex: '1 1 220px', minWidth: 0 }}
              />
              <MantineTooltip label="Swap BCA A and BCA B" withArrow position="top">
                <ActionIcon
                  type="button"
                  variant="default"
                  size="lg"
                  aria-label="Swap BCA A and BCA B"
                  onClick={handleSwap}
                >
                  <IconArrowsExchange size={16} />
                </ActionIcon>
              </MantineTooltip>
              <Select
                label={
                  <Group gap={6} wrap="nowrap">
                    <span className="status-dot" style={{ backgroundColor: 'var(--compare-b)' }} />
                    <span>BCA B (Challenger)</span>
                  </Group>
                }
                data={bcaSelectOptions}
                value={bcaBId}
                onChange={handleSelectB}
                allowDeselect={false}
                style={{ flex: '1 1 220px', minWidth: 0 }}
              />
              <NumberInput
                label="Iterations"
                min={1000}
                max={50000}
                step={1000}
                value={nSimulations}
                onChange={(v) => setNSimulations(typeof v === 'number' ? v : 10000)}
                w={{ base: '48%', sm: 130 }}
              />
              <NumberInput
                label="Seed"
                placeholder="Random"
                min={0}
                max={2147483647}
                value={seed}
                onChange={(v) => setSeed(typeof v === 'number' ? v : '')}
                w={{ base: '48%', sm: 110 }}
              />
            </Group>

            <Collapse in={whatIfOpen}>
              <Paper withBorder p="sm" radius="sm" bg="var(--bg-subtle)" mt={4}>
                <Stack gap="sm">
                  <Group justify="space-between" align="center">
                    <Text size="xs" fw={600} c="var(--text-heading)">
                      Shared What-If Stress Test (applies equally to both BCAs)
                    </Text>
                    <Button
                      type="button"
                      size="compact-xs"
                      variant="subtle"
                      color="gray"
                      leftSection={<IconRefresh size={12} />}
                      onClick={handleResetWhatIf}
                    >
                      Reset
                    </Button>
                  </Group>
                  <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md">
                    <NumberInput
                      label="Override Discount Rate (%)"
                      placeholder="Use each BCA's rate"
                      min={0}
                      max={50}
                      step={0.5}
                      decimalScale={2}
                      value={discountRatePct}
                      onChange={(v) => setDiscountRatePct(typeof v === 'number' ? v : '')}
                    />
                    <div>
                      <Group justify="space-between" mb={4}>
                        <Text size="xs" fw={600}>Uncertainty Spread</Text>
                        <Text size="xs" fw={600} className="tabular-nums">{uncertaintyScale.toFixed(2)}×</Text>
                      </Group>
                      <Slider min={0} max={2.5} step={0.1} value={uncertaintyScale} onChange={setUncertaintyScale} />
                    </div>
                    <div>
                      <Group justify="space-between" mb={4}>
                        <Text size="xs" fw={600}>Benefit Scale</Text>
                        <Text size="xs" fw={600} className="tabular-nums">{benefitScale.toFixed(2)}×</Text>
                      </Group>
                      <Slider min={0.5} max={1.5} step={0.05} value={benefitScale} onChange={setBenefitScale} />
                    </div>
                    <div>
                      <Group justify="space-between" mb={4}>
                        <Text size="xs" fw={600}>Cost Scale</Text>
                        <Text size="xs" fw={600} className="tabular-nums">{costScale.toFixed(2)}×</Text>
                      </Group>
                      <Slider min={0.7} max={1.5} step={0.05} value={costScale} onChange={setCostScale} />
                    </div>
                  </SimpleGrid>
                </Stack>
              </Paper>
            </Collapse>
          </Stack>
        </Box>
      </Paper>

      {!canRunCompare && (
        <Alert color="gray" variant="light" icon={<IconInfoCircle size={16} />}>
          Both selected BCAs need at least one cost or benefit line item before running a Monte Carlo comparison.
        </Alert>
      )}

      {/* Readiness banner when at least one BCA has no MC run yet */}
      {canRunCompare && (!mcA || !mcB) && (
        <Alert
          color="slateIndigo"
          variant="light"
          icon={<IconInfoCircle size={16} />}
          title="Monte Carlo comparison ready to run"
        >
          <Group justify="space-between" align="center" wrap="wrap" gap="sm">
            <Text size="xs">
              {!mcA && !mcB
                ? `Neither "${nameA}" nor "${nameB}" has saved Monte Carlo runs yet.`
                : !mcA
                ? `"${nameA}" has not been simulated yet.`
                : `"${nameB}" has not been simulated yet.`}{' '}
              Run the paired comparison to unlock overlaid NPV distributions, P(B &gt; A) win probability, and ΔNPV percentiles.
            </Text>
            <Button
              type="button"
              size="xs"
              loading={running}
              leftSection={<IconPlayerPlay size={13} />}
              onClick={() => triggerComparison()}
            >
              Run Monte Carlo on Both & Compare
            </Button>
          </Group>
        </Alert>
      )}

      {/* Individual runs exist, but not yet paired */}
      {mcA && mcB && !paired && (
        <Alert
          color="gray"
          variant="light"
          icon={<IconInfoCircle size={16} />}
        >
          <Group justify="space-between" align="center" wrap="wrap" gap="sm">
            <Text size="xs">
              Showing latest individual Monte Carlo runs for <strong style={{ color: 'var(--compare-a)' }}>{nameA}</strong> and{' '}
              <strong style={{ color: 'var(--compare-b)' }}>{nameB}</strong>. Run a paired comparison to compute exact head-to-head{' '}
              <strong>P(B beats A)</strong> and the <strong>ΔNPV (B − A)</strong> distribution.
            </Text>
            <Button
              type="button"
              size="xs"
              variant="default"
              loading={running}
              leftSection={<IconPlayerPlay size={13} />}
              onClick={() => triggerComparison()}
            >
              Run Paired Comparison
            </Button>
          </Group>
        </Alert>
      )}

      {/* Executive Comparison Dashboard (when both BCAs have MC results) */}
      {resA && resB && mcA && mcB && (
        <>
          {/* 1. Decision Verdict & Head-to-Head Win Probability Banner */}
          <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
            <Stack gap="sm">
              <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
                <Group gap="xs" align="flex-start" wrap="nowrap" style={{ flex: '1 1 320px' }}>
                  <IconTrophy
                    size={20}
                    color={leaderSide === 'B' ? 'var(--compare-b)' : 'var(--compare-a)'}
                    style={{ marginTop: 2, flexShrink: 0 }}
                  />
                  <div>
                    <Group gap="xs" wrap="wrap">
                      <Title order={5}>
                        {leaderSide === 'tie'
                          ? 'Median NPV Parity'
                          : `${leaderName} leads by ${formatCompactCurrency(Math.abs(deltaP50 ?? 0))} Median NPV`}
                      </Title>
                      {paired && (
                        <Badge
                          size="sm"
                          variant="light"
                          color={paired.prob_b_beats_a_npv >= 0.5 ? 'teal' : 'slateIndigo'}
                        >
                          P({nameB} &gt; {nameA}) = {formatPercent(paired.prob_b_beats_a_npv)}
                        </Badge>
                      )}
                    </Group>
                    <Text size="xs" c="var(--text-muted)" mt={2}>
                      {riskInsight}
                    </Text>
                  </div>
                </Group>

                {paired && (
                  <Group gap="lg" wrap="wrap">
                    <div>
                      <Text size="xs" c="var(--text-muted)">
                        Median ΔNPV (B − A)
                      </Text>
                      <Text
                        size="md"
                        fw={700}
                        className="tabular-nums"
                        c={paired.delta_npv_stats.p50 >= 0 ? 'var(--text-pos)' : 'var(--text-neg)'}
                      >
                        {formatSignedCurrency(paired.delta_npv_stats.p50)}
                      </Text>
                      <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                        P10..P90: [{formatSignedCurrency(paired.delta_npv_stats.p10)},{' '}
                        {formatSignedCurrency(paired.delta_npv_stats.p90)}]
                      </Text>
                    </div>
                    {paired.prob_b_beats_a_bcr !== null && (
                      <div>
                        <Text size="xs" c="var(--text-muted)">
                          P(BCR B &gt; BCR A)
                        </Text>
                        <Text size="md" fw={700} className="tabular-nums" c="var(--text-heading)">
                          {formatPercent(paired.prob_b_beats_a_bcr)}
                        </Text>
                        <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                          {paired.delta_pv_costs_mean >= 0 ? '+' : ''}
                          {formatCompactCurrency(paired.delta_pv_costs_mean)} avg cost Δ
                        </Text>
                      </div>
                    )}
                  </Group>
                )}
              </Group>

              {paired && (
                <div>
                  <Group justify="space-between" mb={4} wrap="wrap" gap="xs">
                    <Text size="xs" fw={600} c="var(--compare-a)" className="tabular-nums">
                      {nameA} wins: {formatPercent(paired.prob_a_beats_b_npv)}
                    </Text>
                    <Text size="xs" fw={600} c="var(--compare-b)" className="tabular-nums">
                      {nameB} wins: {formatPercent(paired.prob_b_beats_a_npv)}
                    </Text>
                  </Group>
                  <div className="compare-win-bar" role="img" aria-label={`Win probability split: ${nameA} ${formatPercent(paired.prob_a_beats_b_npv)}, ${nameB} ${formatPercent(paired.prob_b_beats_a_npv)}`}>
                    <div
                      className="compare-win-a"
                      style={{ width: `${Math.round(paired.prob_a_beats_b_npv * 1000) / 10}%` }}
                    />
                    <div
                      className="compare-win-b"
                      style={{ width: `${Math.round(paired.prob_b_beats_a_npv * 1000) / 10}%` }}
                    />
                  </div>
                </div>
              )}
            </Stack>
          </Paper>

          {/* 2. 4-Card Side-by-Side KPI Scorecard */}
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="xs">
            <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
              <Text size="xs" fw={500} c="var(--text-muted)" mb={6}>
                Certainty: P(NPV &gt; $0)
              </Text>
              <Group justify="space-around" wrap="nowrap" gap="xs">
                <Stack align="center" gap={2}>
                  <RingProgress
                    size={62}
                    thickness={5}
                    roundCaps
                    rootColor="var(--chart-track)"
                    sections={[{ value: Math.round(mcA.prob_npv_positive * 100), color: 'var(--compare-a)' }]}
                    label={
                      <Text size="xs" ta="center" fw={700} className="tabular-nums" c="var(--text-heading)">
                        {Math.round(mcA.prob_npv_positive * 100)}%
                      </Text>
                    }
                  />
                  <Text size="xs" fw={600} c="var(--compare-a)" lineClamp={1} maw={100}>
                    {nameA}
                  </Text>
                </Stack>
                <Stack align="center" gap={2}>
                  <RingProgress
                    size={62}
                    thickness={5}
                    roundCaps
                    rootColor="var(--chart-track)"
                    sections={[{ value: Math.round(mcB.prob_npv_positive * 100), color: 'var(--compare-b)' }]}
                    label={
                      <Text size="xs" ta="center" fw={700} className="tabular-nums" c="var(--text-heading)">
                        {Math.round(mcB.prob_npv_positive * 100)}%
                      </Text>
                    }
                  />
                  <Text size="xs" fw={600} c="var(--compare-b)" lineClamp={1} maw={100}>
                    {nameB}
                  </Text>
                </Stack>
              </Group>
              <Text size="xs" c="var(--text-muted)" ta="center" mt={6} className="tabular-nums">
                Δ (B − A): {formatSignedPp(mcB.prob_npv_positive - mcA.prob_npv_positive)} · P(BCR ≥ 1):{' '}
                {formatPercent(mcA.prob_bcr_ge_one, 0)} vs {formatPercent(mcB.prob_bcr_ge_one, 0)}
              </Text>
            </Paper>

            <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
              <Text size="xs" fw={500} c="var(--text-muted)" mb={6}>
                Simulated Median NPV (P50)
              </Text>
              <Stack gap={4}>
                <Group justify="space-between" wrap="nowrap">
                  <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                    <span className="status-dot" style={{ backgroundColor: 'var(--compare-a)' }} />
                    <Text size="xs" c="var(--text-body)" lineClamp={1}>{nameA}</Text>
                  </Group>
                  <Text size="sm" fw={700} className="tabular-nums" c="var(--text-heading)">
                    {formatCompactCurrency(mcA.npv_stats.p50)}
                  </Text>
                </Group>
                <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                  P10 {formatCompactCurrency(mcA.npv_stats.p10)} · P90 {formatCompactCurrency(mcA.npv_stats.p90)}
                </Text>
                <Divider color="var(--border-divider)" my={2} />
                <Group justify="space-between" wrap="nowrap">
                  <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                    <span className="status-dot" style={{ backgroundColor: 'var(--compare-b)' }} />
                    <Text size="xs" c="var(--text-body)" lineClamp={1}>{nameB}</Text>
                  </Group>
                  <Text size="sm" fw={700} className="tabular-nums" c="var(--text-heading)">
                    {formatCompactCurrency(mcB.npv_stats.p50)}
                  </Text>
                </Group>
                <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                  P10 {formatCompactCurrency(mcB.npv_stats.p10)} · P90 {formatCompactCurrency(mcB.npv_stats.p90)}
                </Text>
                <Text
                  size="xs"
                  fw={600}
                  className="tabular-nums"
                  c={(deltaP50 ?? 0) >= 0 ? 'var(--text-pos)' : 'var(--text-neg)'}
                >
                  P50 Δ (B − A): {formatSignedCurrency(deltaP50)}
                </Text>
              </Stack>
            </Paper>

            <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
              <Text size="xs" fw={500} c="var(--text-muted)" mb={6}>
                Deterministic Baseline (PV)
              </Text>
              <Stack gap={4}>
                <Group justify="space-between" wrap="nowrap">
                  <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                    <span className="status-dot" style={{ backgroundColor: 'var(--compare-a)' }} />
                    <Text size="xs" c="var(--text-body)" lineClamp={1}>{nameA}</Text>
                  </Group>
                  <Text size="sm" fw={700} className="tabular-nums" c="var(--text-heading)">
                    {formatCompactCurrency(resA.deterministic.npv)}
                  </Text>
                </Group>
                <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                  Cost {formatCompactCurrency(resA.deterministic.pv_costs)} · Ben {formatCompactCurrency(resA.deterministic.pv_benefits)}
                </Text>
                <Divider color="var(--border-divider)" my={2} />
                <Group justify="space-between" wrap="nowrap">
                  <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                    <span className="status-dot" style={{ backgroundColor: 'var(--compare-b)' }} />
                    <Text size="xs" c="var(--text-body)" lineClamp={1}>{nameB}</Text>
                  </Group>
                  <Text size="sm" fw={700} className="tabular-nums" c="var(--text-heading)">
                    {formatCompactCurrency(resB.deterministic.npv)}
                  </Text>
                </Group>
                <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                  Cost {formatCompactCurrency(resB.deterministic.pv_costs)} · Ben {formatCompactCurrency(resB.deterministic.pv_benefits)}
                </Text>
                <Text
                  size="xs"
                  fw={600}
                  className="tabular-nums"
                  c={resB.deterministic.npv - resA.deterministic.npv >= 0 ? 'var(--text-pos)' : 'var(--text-neg)'}
                >
                  Det. NPV Δ: {formatSignedCurrency(resB.deterministic.npv - resA.deterministic.npv)}
                </Text>
              </Stack>
            </Paper>

            <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
              <Text size="xs" fw={500} c="var(--text-muted)" mb={6}>
                Capital Efficiency & Payback
              </Text>
              <Stack gap={4}>
                <Group justify="space-between" wrap="nowrap">
                  <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                    <span className="status-dot" style={{ backgroundColor: 'var(--compare-a)' }} />
                    <Text size="xs" c="var(--text-body)" lineClamp={1}>{nameA}</Text>
                  </Group>
                  <Text size="sm" fw={700} className="tabular-nums" c="var(--text-heading)">
                    {formatRatio(mcA.bcr_stats?.p50)}
                  </Text>
                </Group>
                <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                  Payback {formatPayback(resA.deterministic.discounted_payback_year)} · {resA.horizon_years}y @ {(resA.discount_rate * 100).toFixed(1)}%
                </Text>
                <Divider color="var(--border-divider)" my={2} />
                <Group justify="space-between" wrap="nowrap">
                  <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                    <span className="status-dot" style={{ backgroundColor: 'var(--compare-b)' }} />
                    <Text size="xs" c="var(--text-body)" lineClamp={1}>{nameB}</Text>
                  </Group>
                  <Text size="sm" fw={700} className="tabular-nums" c="var(--text-heading)">
                    {formatRatio(mcB.bcr_stats?.p50)}
                  </Text>
                </Group>
                <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                  Payback {formatPayback(resB.deterministic.discounted_payback_year)} · {resB.horizon_years}y @ {(resB.discount_rate * 100).toFixed(1)}%
                </Text>
                {mcA.bcr_stats && mcB.bcr_stats && (
                  <Text
                    size="xs"
                    fw={600}
                    className="tabular-nums"
                    c={mcB.bcr_stats.p50 - mcA.bcr_stats.p50 >= 0 ? 'var(--text-pos)' : 'var(--text-neg)'}
                  >
                    P50 BCR Δ: {mcB.bcr_stats.p50 - mcA.bcr_stats.p50 >= 0 ? '+' : ''}
                    {(mcB.bcr_stats.p50 - mcA.bcr_stats.p50).toFixed(2)}x
                  </Text>
                )}
              </Stack>
            </Paper>
          </SimpleGrid>

          {/* 3. Overlaid NPV Distribution / CDF / Delta NPV Histogram */}
          <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
            <Group justify="space-between" align="center" mb="xs" wrap="wrap" gap="xs">
              <div>
                <Title order={5}>Simulated NPV Distribution Comparison</Title>
                <Text size="xs" c="var(--text-muted)">
                  {distChartMode === 'delta'
                    ? `Distribution of ΔNPV = ${nameB} − ${nameA} across paired simulation draws`
                    : `Overlaid probability distribution with $0 breakeven and P50 median markers`}
                </Text>
              </div>
              <SegmentedControl
                size="xs"
                fullWidth={isMobile}
                value={distChartMode}
                onChange={(v) => setDistChartMode(v as 'density' | 'cdf' | 'delta')}
                data={[
                  { label: 'Overlaid Density', value: 'density' },
                  { label: 'Cumulative CDF', value: 'cdf' },
                  ...(paired ? [{ label: 'ΔNPV (B − A)', value: 'delta' }] : []),
                ]}
              />
            </Group>

            <Group gap="md" wrap="wrap" mb="xs">
              <Group gap={6} wrap="nowrap">
                <span style={{ display: 'inline-block', width: 14, borderTop: '2px solid var(--chart-zero)' }} />
                <Text size="xs" c="var(--text-muted)">
                  {distChartMode === 'delta' ? '$0 Parity' : '$0 Breakeven'}
                </Text>
              </Group>
              {distChartMode !== 'delta' ? (
                <>
                  <Group gap={6} wrap="nowrap">
                    <span style={{ display: 'inline-block', width: 14, borderTop: '2.5px solid var(--compare-a)' }} />
                    <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                      {nameA} (P50 {formatCompactCurrency(mcA.npv_stats.p50)})
                    </Text>
                  </Group>
                  <Group gap={6} wrap="nowrap">
                    <span style={{ display: 'inline-block', width: 14, borderTop: '2.5px solid var(--compare-b)' }} />
                    <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                      {nameB} (P50 {formatCompactCurrency(mcB.npv_stats.p50)})
                    </Text>
                  </Group>
                </>
              ) : paired ? (
                <Group gap={6} wrap="nowrap">
                  <span style={{ display: 'inline-block', width: 14, borderTop: '2px dashed var(--chart-line)' }} />
                  <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                    Median Δ {formatSignedCurrency(paired.delta_npv_stats.p50)}
                  </Text>
                </Group>
              ) : null}
            </Group>

            <div style={{ width: '100%', height: isMobile ? 250 : 310 }}>
              <ResponsiveContainer>
                {distChartMode === 'density' ? (
                  <AreaChart
                    data={alignedDist.map((b) => ({
                      ...b,
                      pctA: Number((b.density_a * 100).toFixed(2)),
                      pctB: Number((b.density_b * 100).toFixed(2)),
                      rangeLabel: `${formatCompactCurrency(b.bin_start)} to ${formatCompactCurrency(b.bin_end)}`,
                    }))}
                    margin={{ top: 12, right: isMobile ? 8 : 20, left: 0, bottom: 4 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
                    <XAxis
                      dataKey="bin_mid"
                      type="number"
                      domain={['dataMin', 'dataMax']}
                      tickFormatter={(v) => formatCompactCurrency(Number(v))}
                      tick={{ fontSize: 10.5, fill: 'var(--text-muted)' }}
                    />
                    <YAxis
                      width={isMobile ? 42 : 52}
                      tickFormatter={(v) => `${v}%`}
                      tick={{ fontSize: 10.5, fill: 'var(--text-muted)' }}
                    />
                    <Tooltip
                      {...TOOLTIP_PROPS}
                      labelFormatter={(_lbl, payload) => {
                        const row = payload?.[0]?.payload as { rangeLabel?: string } | undefined;
                        return row?.rangeLabel || '';
                      }}
                      formatter={(v: unknown, name: string) => [`${Number(v).toFixed(2)}%`, name]}
                    />
                    <Area
                      type="monotone"
                      dataKey="pctA"
                      name={nameA}
                      stroke="var(--compare-a)"
                      fill="var(--compare-a-fill)"
                      strokeWidth={2}
                    />
                    <Area
                      type="monotone"
                      dataKey="pctB"
                      name={nameB}
                      stroke="var(--compare-b)"
                      fill="var(--compare-b-fill)"
                      strokeWidth={2}
                    />
                    <ReferenceLine x={0} stroke="var(--chart-zero)" strokeWidth={1.75} />
                    <ReferenceLine x={mcA.npv_stats.p50} stroke="var(--compare-a)" strokeDasharray="4 4" />
                    <ReferenceLine x={mcB.npv_stats.p50} stroke="var(--compare-b)" strokeDasharray="4 4" />
                  </AreaChart>
                ) : distChartMode === 'cdf' ? (
                  <LineChart
                    data={alignedDist.map((b) => ({
                      ...b,
                      cdfPctA: Number((b.cdf_a * 100).toFixed(2)),
                      cdfPctB: Number((b.cdf_b * 100).toFixed(2)),
                    }))}
                    margin={{ top: 12, right: isMobile ? 8 : 20, left: 0, bottom: 4 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
                    <XAxis
                      dataKey="bin_end"
                      type="number"
                      domain={['dataMin', 'dataMax']}
                      tickFormatter={(v) => formatCompactCurrency(Number(v))}
                      tick={{ fontSize: 10.5, fill: 'var(--text-muted)' }}
                    />
                    <YAxis
                      width={isMobile ? 42 : 52}
                      domain={[0, 100]}
                      tickFormatter={(v) => `${v}%`}
                      tick={{ fontSize: 10.5, fill: 'var(--text-muted)' }}
                    />
                    <Tooltip
                      {...TOOLTIP_PROPS}
                      labelFormatter={(v) => `NPV ≤ ${formatCurrency(Number(v))}`}
                      formatter={(v: unknown, name: string) => [`${Number(v).toFixed(1)}%`, name]}
                    />
                    <Line
                      type="monotone"
                      dataKey="cdfPctA"
                      name={`${nameA} CDF`}
                      stroke="var(--compare-a)"
                      strokeWidth={2.2}
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="cdfPctB"
                      name={`${nameB} CDF`}
                      stroke="var(--compare-b)"
                      strokeWidth={2.2}
                      dot={false}
                    />
                    <ReferenceLine x={0} stroke="var(--chart-zero)" strokeWidth={1.75} />
                    <ReferenceLine x={mcA.npv_stats.p50} stroke="var(--compare-a)" strokeDasharray="4 4" />
                    <ReferenceLine x={mcB.npv_stats.p50} stroke="var(--compare-b)" strokeDasharray="4 4" />
                  </LineChart>
                ) : (
                  <BarChart
                    data={(paired?.delta_npv_histogram || []).map((b) => ({
                      ...b,
                      rangeLabel: `${formatSignedCurrency(b.bin_start)} to ${formatSignedCurrency(b.bin_end)}`,
                    }))}
                    margin={{ top: 12, right: isMobile ? 8 : 20, left: 0, bottom: 4 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
                    <XAxis
                      dataKey="bin_mid"
                      type="number"
                      domain={['dataMin', 'dataMax']}
                      tickFormatter={(v) => formatCompactCurrency(Number(v))}
                      tick={{ fontSize: 10.5, fill: 'var(--text-muted)' }}
                    />
                    <YAxis width={isMobile ? 42 : 52} tick={{ fontSize: 10.5, fill: 'var(--text-muted)' }} />
                    <Tooltip
                      {...TOOLTIP_PROPS}
                      labelFormatter={(_lbl, payload) => {
                        const row = payload?.[0]?.payload as { rangeLabel?: string } | undefined;
                        return row?.rangeLabel || '';
                      }}
                      formatter={(v: unknown) => [Number(v).toLocaleString(), 'Paired Draws']}
                    />
                    <Bar dataKey="count" name="Draws" radius={[2, 2, 0, 0]}>
                      {(paired?.delta_npv_histogram || []).map((entry, idx) => (
                        <Cell
                          key={idx}
                          fill={entry.bin_mid >= 0 ? 'var(--chart-pos)' : 'var(--chart-neg)'}
                          fillOpacity={0.9}
                        />
                      ))}
                    </Bar>
                    <ReferenceLine x={0} stroke="var(--chart-zero)" strokeWidth={1.75} />
                    {paired && (
                      <ReferenceLine
                        x={paired.delta_npv_stats.p50}
                        stroke="var(--chart-line)"
                        strokeDasharray="4 4"
                      />
                    )}
                  </BarChart>
                )}
              </ResponsiveContainer>
            </div>

            {/* Percentile Comparison Table */}
            <div tabIndex={0} role="region" aria-label="NPV percentile comparison" className="table-region" style={{ marginTop: 12 }}>
              <Table verticalSpacing={5} horizontalSpacing="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>BCA</Table.Th>
                    <Table.Th ta="right">P5</Table.Th>
                    <Table.Th ta="right">P10</Table.Th>
                    <Table.Th ta="right">P25</Table.Th>
                    <Table.Th ta="right">P50</Table.Th>
                    <Table.Th ta="right">P75</Table.Th>
                    <Table.Th ta="right">P90</Table.Th>
                    <Table.Th ta="right">P95</Table.Th>
                    <Table.Th ta="right">Mean</Table.Th>
                    <Table.Th ta="right">Std Dev</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  <Table.Tr>
                    <Table.Td fw={600} c="var(--compare-a)">{nameA}</Table.Td>
                    <Table.Td ta="right" className="tabular-nums">{formatCompactCurrency(mcA.npv_stats.p5)}</Table.Td>
                    <Table.Td ta="right" className="tabular-nums">{formatCompactCurrency(mcA.npv_stats.p10)}</Table.Td>
                    <Table.Td ta="right" className="tabular-nums">{formatCompactCurrency(mcA.npv_stats.p25)}</Table.Td>
                    <Table.Td ta="right" className="tabular-nums" fw={700}>{formatCompactCurrency(mcA.npv_stats.p50)}</Table.Td>
                    <Table.Td ta="right" className="tabular-nums">{formatCompactCurrency(mcA.npv_stats.p75)}</Table.Td>
                    <Table.Td ta="right" className="tabular-nums">{formatCompactCurrency(mcA.npv_stats.p90)}</Table.Td>
                    <Table.Td ta="right" className="tabular-nums">{formatCompactCurrency(mcA.npv_stats.p95)}</Table.Td>
                    <Table.Td ta="right" className="tabular-nums">{formatCompactCurrency(mcA.npv_stats.mean)}</Table.Td>
                    <Table.Td ta="right" className="tabular-nums">{formatCompactCurrency(mcA.npv_stats.std)}</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td fw={600} c="var(--compare-b)">{nameB}</Table.Td>
                    <Table.Td ta="right" className="tabular-nums">{formatCompactCurrency(mcB.npv_stats.p5)}</Table.Td>
                    <Table.Td ta="right" className="tabular-nums">{formatCompactCurrency(mcB.npv_stats.p10)}</Table.Td>
                    <Table.Td ta="right" className="tabular-nums">{formatCompactCurrency(mcB.npv_stats.p25)}</Table.Td>
                    <Table.Td ta="right" className="tabular-nums" fw={700}>{formatCompactCurrency(mcB.npv_stats.p50)}</Table.Td>
                    <Table.Td ta="right" className="tabular-nums">{formatCompactCurrency(mcB.npv_stats.p75)}</Table.Td>
                    <Table.Td ta="right" className="tabular-nums">{formatCompactCurrency(mcB.npv_stats.p90)}</Table.Td>
                    <Table.Td ta="right" className="tabular-nums">{formatCompactCurrency(mcB.npv_stats.p95)}</Table.Td>
                    <Table.Td ta="right" className="tabular-nums">{formatCompactCurrency(mcB.npv_stats.mean)}</Table.Td>
                    <Table.Td ta="right" className="tabular-nums">{formatCompactCurrency(mcB.npv_stats.std)}</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td fw={600} c="var(--text-muted)">Δ (B − A)</Table.Td>
                    {(['p5', 'p10', 'p25', 'p50', 'p75', 'p90', 'p95', 'mean'] as const).map((k) => {
                      const diff = mcB.npv_stats[k] - mcA.npv_stats[k];
                      return (
                        <Table.Td
                          key={k}
                          ta="right"
                          className="tabular-nums"
                          fw={k === 'p50' ? 700 : 500}
                          c={diff >= 0 ? 'var(--text-pos)' : 'var(--text-neg)'}
                        >
                          {formatSignedCurrency(diff)}
                        </Table.Td>
                      );
                    })}
                    <Table.Td ta="right" className="tabular-nums" c="var(--text-muted)">
                      {formatSignedCurrency(mcB.npv_stats.std - mcA.npv_stats.std)}
                    </Table.Td>
                  </Table.Tr>
                </Table.Tbody>
              </Table>
            </div>
          </Paper>

          {/* 4. Two-Column Deep Dive: Trajectory & Value Streams */}
          <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
            <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
              <Group justify="space-between" align="center" mb={4} wrap="wrap" gap="xs">
                <div>
                  <Title order={5}>Cumulative Discounted NPV Trajectory</Title>
                  <Text size="xs" c="var(--text-muted)">
                    Median P50 cumulative net PV trajectory across the horizon
                  </Text>
                </div>
                <Switch
                  size="xs"
                  label="P10–P90 bands"
                  checked={showEnvelopes}
                  onChange={(e) => setShowEnvelopes(e.currentTarget.checked)}
                />
              </Group>

              <div style={{ width: '100%', height: isMobile ? 240 : 280 }}>
                <ResponsiveContainer>
                  <ComposedChart
                    data={yearlyComparison.map((r) => ({
                      ...r,
                      yearLabel: formatYearLabel(r.year, sharedCostStart, 'short'),
                      fullYearLabel: formatYearLabel(r.year, sharedCostStart, 'full'),
                    }))}
                    margin={{ top: 10, right: isMobile ? 8 : 16, left: 0, bottom: 4 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
                    <XAxis dataKey="yearLabel" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                    <YAxis
                      tickFormatter={(v) => formatCompactCurrency(Number(v))}
                      tick={{ fontSize: 10.5, fill: 'var(--text-muted)' }}
                      width={isMobile ? 54 : 74}
                    />
                    <Tooltip
                      {...TOOLTIP_PROPS}
                      labelFormatter={(_lbl, payload) => {
                        const row = payload?.[0]?.payload as { fullYearLabel?: string } | undefined;
                        return row?.fullYearLabel || '';
                      }}
                      formatter={(v: unknown, name: string) => [
                        v === null || v === undefined ? '—' : formatCurrency(Number(v)),
                        name,
                      ]}
                    />
                    <Legend wrapperStyle={{ paddingTop: 6 }} />
                    <ReferenceLine y={0} stroke="var(--chart-zero)" strokeDasharray="3 3" />
                    {showEnvelopes && (
                      <>
                        <Line type="monotone" dataKey="a_p90" name={`${nameA} P90`} stroke="var(--compare-a)" strokeDasharray="3 3" strokeWidth={1.3} dot={false} strokeOpacity={0.65} connectNulls={false} />
                        <Line type="monotone" dataKey="a_p10" name={`${nameA} P10`} stroke="var(--compare-a)" strokeDasharray="3 3" strokeWidth={1.3} dot={false} strokeOpacity={0.65} connectNulls={false} />
                        <Line type="monotone" dataKey="b_p90" name={`${nameB} P90`} stroke="var(--compare-b)" strokeDasharray="3 3" strokeWidth={1.3} dot={false} strokeOpacity={0.65} connectNulls={false} />
                        <Line type="monotone" dataKey="b_p10" name={`${nameB} P10`} stroke="var(--compare-b)" strokeDasharray="3 3" strokeWidth={1.3} dot={false} strokeOpacity={0.65} connectNulls={false} />
                      </>
                    )}
                    <Line
                      type="monotone"
                      dataKey="a_p50"
                      name={`${nameA} P50`}
                      stroke="var(--compare-a)"
                      strokeWidth={2.4}
                      dot={{ r: 2.5 }}
                      connectNulls={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="b_p50"
                      name={`${nameB} P50`}
                      stroke="var(--compare-b)"
                      strokeWidth={2.4}
                      dot={{ r: 2.5 }}
                      connectNulls={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </Paper>

            <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
              <Group justify="space-between" align="center" mb="xs" wrap="wrap" gap="xs">
                <div>
                  <Title order={5}>Value-Stream Comparison</Title>
                  <Text size="xs" c="var(--text-muted)">
                    Where NPV, benefits, and costs diverge across value streams
                  </Text>
                </div>
                <SegmentedControl
                  size="xs"
                  value={vsMetric}
                  onChange={(v) => setVsMetric(v as 'sim_p50' | 'benefits' | 'costs')}
                  data={[
                    { label: 'P50 NPV', value: 'sim_p50' },
                    { label: 'Benefits', value: 'benefits' },
                    { label: 'Costs', value: 'costs' },
                  ]}
                />
              </Group>

              <div style={{ width: '100%', height: isMobile ? 220 : 230 }}>
                <ResponsiveContainer>
                  <BarChart data={vsChartData} margin={{ top: 8, right: isMobile ? 8 : 14, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
                    <XAxis dataKey="value_stream" tick={{ fontSize: 10.5, fill: 'var(--text-muted)' }} />
                    <YAxis
                      tickFormatter={(v) => formatCompactCurrency(Number(v))}
                      tick={{ fontSize: 10.5, fill: 'var(--text-muted)' }}
                      width={isMobile ? 54 : 70}
                    />
                    <Tooltip
                      {...TOOLTIP_PROPS}
                      formatter={(v: unknown, name: string) => [formatCurrency(Number(v)), name]}
                    />
                    <Legend wrapperStyle={{ paddingTop: 4 }} />
                    <ReferenceLine y={0} stroke="var(--chart-zero)" />
                    <Bar dataKey="valA" name={nameA} fill="var(--compare-a)" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="valB" name={nameB} fill="var(--compare-b)" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div tabIndex={0} role="region" aria-label="Value stream delta breakdown" className="table-region" style={{ marginTop: 8 }}>
                <Table verticalSpacing={4} horizontalSpacing="xs">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Value Stream</Table.Th>
                      <Table.Th ta="right">{nameA} P50</Table.Th>
                      <Table.Th ta="right">{nameB} P50</Table.Th>
                      <Table.Th ta="right">Δ (B − A)</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {vsComparison.map((vs) => {
                      const d = vs.delta_sim_npv_p50 ?? vs.delta_npv;
                      return (
                        <Table.Tr key={vs.value_stream}>
                          <Table.Td fw={600}>{vs.value_stream}</Table.Td>
                          <Table.Td ta="right" className="tabular-nums">
                            {formatCompactCurrency(vs.a_sim_npv_p50 ?? vs.a_npv)}
                          </Table.Td>
                          <Table.Td ta="right" className="tabular-nums">
                            {formatCompactCurrency(vs.b_sim_npv_p50 ?? vs.b_npv)}
                          </Table.Td>
                          <Table.Td
                            ta="right"
                            className="tabular-nums"
                            fw={600}
                            c={d >= 0 ? 'var(--text-pos)' : 'var(--text-neg)'}
                          >
                            {formatSignedCurrency(d)}
                          </Table.Td>
                        </Table.Tr>
                      );
                    })}
                  </Table.Tbody>
                </Table>
              </div>
            </Paper>
          </SimpleGrid>

          {/* 5. Side-by-Side Uncertainty Drivers */}
          <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
            <DriverBars
              title={`${nameA} — Uncertainty Drivers`}
              accentColor="var(--compare-a)"
              drivers={mcA.sensitivity_drivers}
            />
            <DriverBars
              title={`${nameB} — Uncertainty Drivers`}
              accentColor="var(--compare-b)"
              drivers={mcB.sensitivity_drivers}
            />
          </SimpleGrid>

          {/* 6. Complete Metric-by-Metric Comparison Table */}
          <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
            <Title order={5} mb={4}>
              Complete Metric Comparison
            </Title>
            <Text size="xs" c="var(--text-muted)" mb="sm">
              Side-by-side summary of baseline assumptions, deterministic valuation, and Monte Carlo percentiles
            </Text>
            <div tabIndex={0} role="region" aria-label="Full BCA metric comparison" className="table-region">
              <Table verticalSpacing="xs" horizontalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Metric</Table.Th>
                    <Table.Th ta="right">{nameA}</Table.Th>
                    <Table.Th ta="right">{nameB}</Table.Th>
                    <Table.Th ta="right">Δ (B − A)</Table.Th>
                    <Table.Th ta="right">Leader</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {[
                    {
                      label: 'Horizon / Discount Rate',
                      aStr: `${resA.horizon_years} yrs · ${(resA.discount_rate * 100).toFixed(1)}%`,
                      bStr: `${resB.horizon_years} yrs · ${(resB.discount_rate * 100).toFixed(1)}%`,
                      deltaStr: `${resB.horizon_years - resA.horizon_years >= 0 ? '+' : ''}${resB.horizon_years - resA.horizon_years}y · ${((resB.discount_rate - resA.discount_rate) * 100).toFixed(1)} pp`,
                      leader: '—',
                      deltaPos: null as boolean | null,
                    },
                    {
                      label: 'Deterministic PV Costs (lower better)',
                      aStr: formatCurrency(resA.deterministic.pv_costs),
                      bStr: formatCurrency(resB.deterministic.pv_costs),
                      deltaStr: formatSignedCurrency(resB.deterministic.pv_costs - resA.deterministic.pv_costs, false),
                      leader:
                        Math.abs(resB.deterministic.pv_costs - resA.deterministic.pv_costs) < 1
                          ? 'Tie'
                          : resB.deterministic.pv_costs < resA.deterministic.pv_costs
                          ? nameB
                          : nameA,
                      deltaPos: resB.deterministic.pv_costs <= resA.deterministic.pv_costs,
                    },
                    {
                      label: 'Deterministic PV Benefits',
                      aStr: formatCurrency(resA.deterministic.pv_benefits),
                      bStr: formatCurrency(resB.deterministic.pv_benefits),
                      deltaStr: formatSignedCurrency(resB.deterministic.pv_benefits - resA.deterministic.pv_benefits, false),
                      leader:
                        Math.abs(resB.deterministic.pv_benefits - resA.deterministic.pv_benefits) < 1
                          ? 'Tie'
                          : resB.deterministic.pv_benefits > resA.deterministic.pv_benefits
                          ? nameB
                          : nameA,
                      deltaPos: resB.deterministic.pv_benefits >= resA.deterministic.pv_benefits,
                    },
                    {
                      label: 'Deterministic NPV',
                      aStr: formatCurrency(resA.deterministic.npv),
                      bStr: formatCurrency(resB.deterministic.npv),
                      deltaStr: formatSignedCurrency(resB.deterministic.npv - resA.deterministic.npv, false),
                      leader:
                        Math.abs(resB.deterministic.npv - resA.deterministic.npv) < 1
                          ? 'Tie'
                          : resB.deterministic.npv > resA.deterministic.npv
                          ? nameB
                          : nameA,
                      deltaPos: resB.deterministic.npv >= resA.deterministic.npv,
                    },
                    {
                      label: 'Discounted Payback (shorter better)',
                      aStr: formatPayback(resA.deterministic.discounted_payback_year),
                      bStr: formatPayback(resB.deterministic.discounted_payback_year),
                      deltaStr:
                        resA.deterministic.discounted_payback_year != null &&
                        resB.deterministic.discounted_payback_year != null
                          ? `${resB.deterministic.discounted_payback_year - resA.deterministic.discounted_payback_year >= 0 ? '+' : ''}${(resB.deterministic.discounted_payback_year - resA.deterministic.discounted_payback_year).toFixed(1)} yrs`
                          : '—',
                      leader:
                        resA.deterministic.discounted_payback_year != null &&
                        resB.deterministic.discounted_payback_year != null
                          ? resB.deterministic.discounted_payback_year < resA.deterministic.discounted_payback_year
                            ? nameB
                            : resA.deterministic.discounted_payback_year < resB.deterministic.discounted_payback_year
                            ? nameA
                            : 'Tie'
                          : '—',
                      deltaPos:
                        resA.deterministic.discounted_payback_year != null &&
                        resB.deterministic.discounted_payback_year != null
                          ? resB.deterministic.discounted_payback_year <= resA.deterministic.discounted_payback_year
                          : null,
                    },
                    {
                      label: 'Monte Carlo P(NPV > $0)',
                      aStr: formatPercent(mcA.prob_npv_positive),
                      bStr: formatPercent(mcB.prob_npv_positive),
                      deltaStr: formatSignedPp(mcB.prob_npv_positive - mcA.prob_npv_positive),
                      leader:
                        Math.abs(mcB.prob_npv_positive - mcA.prob_npv_positive) < 0.001
                          ? 'Tie'
                          : mcB.prob_npv_positive > mcA.prob_npv_positive
                          ? nameB
                          : nameA,
                      deltaPos: mcB.prob_npv_positive >= mcA.prob_npv_positive,
                    },
                    {
                      label: 'Simulated P10 NPV (Downside)',
                      aStr: formatCurrency(mcA.npv_stats.p10),
                      bStr: formatCurrency(mcB.npv_stats.p10),
                      deltaStr: formatSignedCurrency(mcB.npv_stats.p10 - mcA.npv_stats.p10, false),
                      leader: mcB.npv_stats.p10 > mcA.npv_stats.p10 ? nameB : nameA,
                      deltaPos: mcB.npv_stats.p10 >= mcA.npv_stats.p10,
                    },
                    {
                      label: 'Simulated P50 NPV (Median)',
                      aStr: formatCurrency(mcA.npv_stats.p50),
                      bStr: formatCurrency(mcB.npv_stats.p50),
                      deltaStr: formatSignedCurrency(mcB.npv_stats.p50 - mcA.npv_stats.p50, false),
                      leader: mcB.npv_stats.p50 > mcA.npv_stats.p50 ? nameB : nameA,
                      deltaPos: mcB.npv_stats.p50 >= mcA.npv_stats.p50,
                    },
                    {
                      label: 'Simulated P90 NPV (Upside)',
                      aStr: formatCurrency(mcA.npv_stats.p90),
                      bStr: formatCurrency(mcB.npv_stats.p90),
                      deltaStr: formatSignedCurrency(mcB.npv_stats.p90 - mcA.npv_stats.p90, false),
                      leader: mcB.npv_stats.p90 > mcA.npv_stats.p90 ? nameB : nameA,
                      deltaPos: mcB.npv_stats.p90 >= mcA.npv_stats.p90,
                    },
                    {
                      label: 'Simulated P50 BCR',
                      aStr: formatRatio(mcA.bcr_stats?.p50),
                      bStr: formatRatio(mcB.bcr_stats?.p50),
                      deltaStr:
                        mcA.bcr_stats && mcB.bcr_stats
                          ? `${mcB.bcr_stats.p50 - mcA.bcr_stats.p50 >= 0 ? '+' : ''}${(mcB.bcr_stats.p50 - mcA.bcr_stats.p50).toFixed(2)}x`
                          : '—',
                      leader:
                        mcA.bcr_stats && mcB.bcr_stats
                          ? mcB.bcr_stats.p50 > mcA.bcr_stats.p50
                            ? nameB
                            : nameA
                          : '—',
                      deltaPos:
                        mcA.bcr_stats && mcB.bcr_stats ? mcB.bcr_stats.p50 >= mcA.bcr_stats.p50 : null,
                    },
                  ].map((row) => (
                    <Table.Tr key={row.label}>
                      <Table.Td fw={500}>{row.label}</Table.Td>
                      <Table.Td ta="right" className="tabular-nums">{row.aStr}</Table.Td>
                      <Table.Td ta="right" className="tabular-nums">{row.bStr}</Table.Td>
                      <Table.Td
                        ta="right"
                        className="tabular-nums"
                        fw={600}
                        c={
                          row.deltaPos === null
                            ? 'var(--text-muted)'
                            : row.deltaPos
                            ? 'var(--text-pos)'
                            : 'var(--text-neg)'
                        }
                      >
                        {row.deltaStr}
                      </Table.Td>
                      <Table.Td ta="right">
                        {row.leader === '—' || row.leader === 'Tie' ? (
                          <Text size="xs" c="var(--text-muted)">{row.leader}</Text>
                        ) : (
                          <Badge
                            size="xs"
                            variant="light"
                            color={row.leader === nameB ? 'teal' : 'slateIndigo'}
                          >
                            {row.leader}
                          </Badge>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          </Paper>
        </>
      )}

      {/* Deterministic-only fallback preview when MC hasn't run on both yet */}
      {(!resA || !resB) && bcaA && bcaB && (
        <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
          <Title order={5} mb="xs">
            Deterministic Pre-Simulation Snapshot
          </Title>
          <div tabIndex={0} role="region" aria-label="Deterministic comparison" className="table-region">
            <Table verticalSpacing="xs" horizontalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Metric</Table.Th>
                  <Table.Th ta="right">{nameA}</Table.Th>
                  <Table.Th ta="right">{nameB}</Table.Th>
                  <Table.Th ta="right">Δ (B − A)</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                <Table.Tr>
                  <Table.Td fw={500}>Line Items</Table.Td>
                  <Table.Td ta="right" className="tabular-nums">{bcaA.item_count}</Table.Td>
                  <Table.Td ta="right" className="tabular-nums">{bcaB.item_count}</Table.Td>
                  <Table.Td ta="right" className="tabular-nums">{bcaB.item_count - bcaA.item_count}</Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Td fw={500}>PV Costs</Table.Td>
                  <Table.Td ta="right" className="tabular-nums">{formatCurrency(bcaA.pv_costs)}</Table.Td>
                  <Table.Td ta="right" className="tabular-nums">{formatCurrency(bcaB.pv_costs)}</Table.Td>
                  <Table.Td ta="right" className="tabular-nums">{formatSignedCurrency(bcaB.pv_costs - bcaA.pv_costs, false)}</Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Td fw={500}>PV Benefits</Table.Td>
                  <Table.Td ta="right" className="tabular-nums">{formatCurrency(bcaA.pv_benefits)}</Table.Td>
                  <Table.Td ta="right" className="tabular-nums">{formatCurrency(bcaB.pv_benefits)}</Table.Td>
                  <Table.Td ta="right" className="tabular-nums">{formatSignedCurrency(bcaB.pv_benefits - bcaA.pv_benefits, false)}</Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Td fw={600}>Deterministic NPV</Table.Td>
                  <Table.Td ta="right" className="tabular-nums" fw={600}>{formatCurrency(bcaA.npv)}</Table.Td>
                  <Table.Td ta="right" className="tabular-nums" fw={600}>{formatCurrency(bcaB.npv)}</Table.Td>
                  <Table.Td
                    ta="right"
                    className="tabular-nums"
                    fw={700}
                    c={bcaB.npv - bcaA.npv >= 0 ? 'var(--text-pos)' : 'var(--text-neg)'}
                  >
                    {formatSignedCurrency(bcaB.npv - bcaA.npv, false)}
                  </Table.Td>
                </Table.Tr>
              </Table.Tbody>
            </Table>
          </div>
        </Paper>
      )}

      {/* Saved Comparison History */}
      <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
        <Group justify="space-between" mb="xs" wrap="wrap" gap="xs">
          <Group gap="xs">
            <IconHistory size={17} color="var(--text-muted)" />
            <Title order={5}>Saved Paired Comparisons ({comparisons.length})</Title>
          </Group>
          <Text size="xs" c="var(--text-muted)">
            Reload past Monte Carlo comparisons between BCAs
          </Text>
        </Group>

        {comparisons.length === 0 ? (
          <Text size="sm" c="var(--text-muted)" py="sm">
            No paired Monte Carlo comparisons saved yet. Click “Run Monte Carlo Comparison” above to persist one.
          </Text>
        ) : isMobile ? (
          <Stack gap={0}>
            {comparisons.map((rec, idx) => {
              const isActive = matchedComparison?.comparison_id === rec.id;
              return (
                <Fragment key={rec.id}>
                  {idx > 0 && <Divider color="var(--border-divider)" my="sm" />}
                  <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs">
                    <div>
                      <Text size="xs" fw={600} c="var(--text-heading)">
                        {rec.summary.bca_a_name} vs {rec.summary.bca_b_name}
                      </Text>
                      <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                        {new Date(rec.created_at).toLocaleString()} · {rec.n_simulations.toLocaleString()} runs · P(B &gt; A){' '}
                        {formatPercent(rec.summary.paired.prob_b_beats_a_npv)}
                      </Text>
                    </div>
                    <Button
                      type="button"
                      size="xs"
                      variant={isActive ? 'light' : 'subtle'}
                      color={isActive ? 'slateIndigo' : 'gray'}
                      onClick={() => onSelectComparison(rec)}
                    >
                      {isActive ? 'Viewing' : 'View'}
                    </Button>
                  </Group>
                </Fragment>
              );
            })}
          </Stack>
        ) : (
          <div tabIndex={0} role="region" aria-label="Saved BCA comparisons" className="table-region">
            <Table verticalSpacing="xs" horizontalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Timestamp</Table.Th>
                  <Table.Th>BCA A</Table.Th>
                  <Table.Th>BCA B</Table.Th>
                  <Table.Th ta="right">Runs</Table.Th>
                  <Table.Th ta="right">P(B &gt; A)</Table.Th>
                  <Table.Th ta="right">Median ΔNPV</Table.Th>
                  <Table.Th ta="right">Inspect</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {comparisons.map((rec) => {
                  const isActive = matchedComparison?.comparison_id === rec.id;
                  return (
                    <Table.Tr
                      key={rec.id}
                      style={isActive ? { backgroundColor: 'var(--bg-active)' } : undefined}
                    >
                      <Table.Td className="tabular-nums">
                        {new Date(rec.created_at).toLocaleString()}
                      </Table.Td>
                      <Table.Td>{rec.summary.bca_a_name}</Table.Td>
                      <Table.Td>{rec.summary.bca_b_name}</Table.Td>
                      <Table.Td ta="right" className="tabular-nums">
                        {rec.n_simulations.toLocaleString()}
                      </Table.Td>
                      <Table.Td ta="right" className="tabular-nums" fw={600}>
                        {formatPercent(rec.summary.paired.prob_b_beats_a_npv)}
                      </Table.Td>
                      <Table.Td
                        ta="right"
                        className="tabular-nums"
                        fw={600}
                        c={rec.summary.paired.delta_npv_stats.p50 >= 0 ? 'var(--text-pos)' : 'var(--text-neg)'}
                      >
                        {formatSignedCurrency(rec.summary.paired.delta_npv_stats.p50)}
                      </Table.Td>
                      <Table.Td ta="right">
                        <Button
                          type="button"
                          size="xs"
                          variant={isActive ? 'light' : 'subtle'}
                          color={isActive ? 'slateIndigo' : 'gray'}
                          onClick={() => onSelectComparison(rec)}
                        >
                          {isActive ? 'Viewing' : 'View'}
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </div>
        )}
      </Paper>
    </Stack>
  );
}
