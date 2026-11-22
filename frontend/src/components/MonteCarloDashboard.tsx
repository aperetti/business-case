import { Fragment, useEffect, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Divider,
  Group,
  NumberInput,
  Paper,
  RingProgress,
  SegmentedControl,
  SimpleGrid,
  Slider,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
  IconHistory,
  IconPlayerPlay,
  IconRefresh,
  IconScale,
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
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  BCASummary,
  InitiativeDetail,
  SimulationRequest,
  SimulationResult,
  SimulationRunRecord,
} from '../types/api';
import {
  formatCompactCurrency,
  formatCurrency,
  formatPercent,
  formatRatio,
  formatYearLabel,
} from '../utils/format';

interface Props {
  initiative: InitiativeDetail;
  activeBca?: BCASummary | null;
  bcaCount?: number;
  activeResult: SimulationResult | null;
  runs: SimulationRunRecord[];
  running: boolean;
  onRunSimulation: (req: SimulationRequest) => Promise<void>;
  onSelectHistoricalRun: (record: SimulationRunRecord) => void;
  onOpenCompare?: () => void;
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

function MultiLineTick({
  x = 0,
  y = 0,
  payload,
}: {
  x?: number | string;
  y?: number | string;
  payload?: { value?: string };
}) {
  const words = String(payload?.value || '').split(/\s+/).filter(Boolean);
  return (
    <g transform={`translate(${x},${y})`}>
      <text x={0} y={0} dy={12} textAnchor="middle" fill="var(--text-muted)" fontSize={10.5}>
        {words.map((word, idx) => (
          <tspan key={idx} x={0} dy={idx === 0 ? 0 : 12}>
            {word}
          </tspan>
        ))}
      </text>
    </g>
  );
}

export function MonteCarloDashboard({
  initiative,
  activeBca,
  bcaCount = 1,
  activeResult,
  runs,
  running,
  onRunSimulation,
  onSelectHistoricalRun,
  onOpenCompare,
}: Props) {
  const isMobile = useMediaQuery('(max-width: 48em)') ?? false;
  const [nSimulations, setNSimulations] = useState<number>(10000);
  const [seed, setSeed] = useState<number | ''>(42);
  const [discountRatePct, setDiscountRatePct] = useState<number>(
    Number((initiative.discount_rate * 100).toFixed(2))
  );
  const [uncertaintyScale, setUncertaintyScale] = useState<number>(1.0);
  const [benefitScale, setBenefitScale] = useState<number>(1.0);
  const [costScale, setCostScale] = useState<number>(1.0);
  const [chartType, setChartType] = useState<'histogram' | 'cdf'>('histogram');

  useEffect(() => {
    setDiscountRatePct(Number((initiative.discount_rate * 100).toFixed(2)));
    setUncertaintyScale(1.0);
    setBenefitScale(1.0);
    setCostScale(1.0);
  }, [initiative.id, initiative.discount_rate]);

  const handleResetWhatIf = () => {
    setDiscountRatePct(Number((initiative.discount_rate * 100).toFixed(2)));
    setUncertaintyScale(1.0);
    setBenefitScale(1.0);
    setCostScale(1.0);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onRunSimulation({
      n_simulations: nSimulations,
      seed: typeof seed === 'number' ? seed : null,
      discount_rate_override: discountRatePct / 100,
      uncertainty_scale: uncertaintyScale,
      benefit_scale: benefitScale,
      cost_scale: costScale,
      persist: true,
    });
  };

  const mc = activeResult?.monte_carlo;
  const probPos = mc ? mc.prob_npv_positive : 0;
  const probBcr = mc ? mc.prob_bcr_ge_one : 0;
  const probStroke = probPos >= 0.8 ? '#5eb894' : probPos >= 0.5 ? '#d9a85b' : '#d97c7c';
  const bcrStroke = probBcr >= 0.8 ? '#8fa2d4' : probBcr >= 0.5 ? '#d9a85b' : '#d97c7c';

  const histData = (mc?.npv_histogram || []).map((b) => ({
    ...b,
    cdfPct: Number((b.cumulative_prob * 100).toFixed(2)),
    rangeLabel: `${formatCompactCurrency(b.bin_start)} to ${formatCompactCurrency(b.bin_end)}`,
  }));

  const drivers = mc?.sensitivity_drivers || [];

  return (
    <Stack gap="md">
      <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
        <Box component="form" onSubmit={handleSubmit} aria-label="Monte Carlo simulation controls">
          <Stack gap="md">
            <Group justify="space-between" align="center" wrap="wrap" gap="xs">
              <div>
                <Group gap="xs" wrap="wrap">
                  <Title order={5}>Monte Carlo Simulation & What-If Controls</Title>
                  {activeBca && (
                    <Badge size="sm" variant="light" color={activeBca.is_baseline ? 'slateIndigo' : 'teal'}>
                      {activeBca.name}
                    </Badge>
                  )}
                </Group>
                <Text size="xs" c="var(--text-muted)">
                  Vectorized NumPy sampling across line-item distributions and correlation groups
                </Text>
              </div>
              <Group gap="sm" wrap="wrap" w={{ base: '100%', sm: 'auto' }} justify="flex-end">
                {activeResult && (
                  <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                    {activeResult.n_simulations.toLocaleString()} runs · {activeResult.duration_ms.toFixed(0)} ms
                  </Text>
                )}
                {bcaCount >= 2 && onOpenCompare && (
                  <Button
                    type="button"
                    variant="light"
                    color="slateIndigo"
                    fullWidth={isMobile}
                    leftSection={<IconScale size={15} />}
                    onClick={onOpenCompare}
                  >
                    Compare BCAs
                  </Button>
                )}
                <Button
                  type="submit"
                  fullWidth={isMobile}
                  loading={running}
                  leftSection={<IconPlayerPlay size={15} />}
                  disabled={initiative.items.length === 0}
                >
                  Run Simulation
                </Button>
              </Group>
            </Group>

            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
              <div>
                <Group justify="space-between" mb={4}>
                  <Text size="xs" fw={600} c="var(--text-body)">
                    Simulation Iterations
                  </Text>
                  <Text size="xs" fw={600} className="tabular-nums" c="var(--text-heading)">
                    {nSimulations.toLocaleString()}
                  </Text>
                </Group>
                <Slider
                  min={1000}
                  max={50000}
                  step={1000}
                  value={nSimulations}
                  onChange={setNSimulations}
                  marks={[
                    { value: 1000, label: '1k' },
                    { value: 10000, label: '10k' },
                    { value: 25000, label: '25k' },
                    { value: 50000, label: '50k' },
                  ]}
                  mb="md"
                />
              </div>

              <NumberInput
                label="Random Seed (optional)"
                description="Set fixed seed for reproducible runs"
                placeholder="Random"
                min={0}
                max={2147483647}
                value={seed}
                onChange={(v) => setSeed(typeof v === 'number' ? v : '')}
              />

              <NumberInput
                label="What-If Discount Rate (%)"
                description={`Initiative baseline: ${(initiative.discount_rate * 100).toFixed(1)}%`}
                min={0}
                max={50}
                step={0.5}
                decimalScale={2}
                value={discountRatePct}
                onChange={(v) => setDiscountRatePct(typeof v === 'number' ? v : 6)}
              />
            </SimpleGrid>

            <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
              <div>
                <Group justify="space-between" mb={2}>
                  <Text size="xs" fw={600} c="var(--text-body)">
                    Uncertainty Spread Scale
                  </Text>
                  <Text size="xs" fw={600} className="tabular-nums" c="var(--text-heading)">
                    {uncertaintyScale.toFixed(2)}×
                  </Text>
                </Group>
                <Slider
                  min={0}
                  max={2.5}
                  step={0.1}
                  value={uncertaintyScale}
                  onChange={setUncertaintyScale}
                />
              </div>

              <div>
                <Group justify="space-between" mb={2}>
                  <Text size="xs" fw={600} c="var(--text-body)">
                    What-If Benefit Scale
                  </Text>
                  <Text size="xs" fw={600} className="tabular-nums" c="var(--text-heading)">
                    {benefitScale.toFixed(2)}×
                  </Text>
                </Group>
                <Slider
                  min={0.5}
                  max={1.5}
                  step={0.05}
                  value={benefitScale}
                  onChange={setBenefitScale}
                />
              </div>

              <div>
                <Group justify="space-between" mb={2}>
                  <Text size="xs" fw={600} c="var(--text-body)">
                    What-If Cost Scale
                  </Text>
                  <Text size="xs" fw={600} className="tabular-nums" c="var(--text-heading)">
                    {costScale.toFixed(2)}×
                  </Text>
                </Group>
                <Slider
                  min={0.7}
                  max={1.5}
                  step={0.05}
                  value={costScale}
                  onChange={setCostScale}
                />
              </div>
            </SimpleGrid>

            <Group justify="flex-end">
              <Button
                type="button"
                size="xs"
                variant="subtle"
                color="gray"
                leftSection={<IconRefresh size={13} />}
                onClick={handleResetWhatIf}
              >
                Reset What-If Sliders
              </Button>
            </Group>
          </Stack>
        </Box>
      </Paper>

      {initiative.items.length === 0 && (
        <Paper withBorder p="md" bg="var(--bg-surface)">
          <Text size="sm" c="var(--text-muted)">
            This initiative currently has no cost or benefit line items. Add items in the Assumptions tab first.
          </Text>
        </Paper>
      )}

      {mc && (
        <>
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="xs">
            <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
              <Group justify="space-between" wrap="nowrap">
                <div>
                  <Text size="xs" fw={500} c="var(--text-muted)">
                    P(NPV &gt; $0)
                  </Text>
                  <Text size="xl" fw={700} mt={4} className="tabular-nums" c="var(--text-heading)">
                    {formatPercent(mc.prob_npv_positive)}
                  </Text>
                  <Text
                    size="xs"
                    c={probPos >= 0.8 ? 'var(--text-pos)' : probPos >= 0.5 ? 'var(--text-warn)' : 'var(--text-neg)'}
                    mt={4}
                  >
                    {probPos >= 0.8
                      ? 'High certainty'
                      : probPos >= 0.5
                      ? 'Moderate certainty'
                      : 'Downside risk'}
                  </Text>
                </div>
                <RingProgress
                  size={68}
                  thickness={5}
                  roundCaps
                  rootColor="var(--chart-track)"
                  sections={[{ value: Math.round(probPos * 100), color: probStroke }]}
                  label={
                    <Text size="xs" ta="center" fw={600} className="tabular-nums" c="var(--text-body)">
                      {Math.round(probPos * 100)}%
                    </Text>
                  }
                />
              </Group>
            </Paper>

            <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
              <Group justify="space-between" wrap="nowrap">
                <div>
                  <Text size="xs" fw={500} c="var(--text-muted)">
                    P(BCR ≥ 1.0x)
                  </Text>
                  <Text size="xl" fw={700} mt={4} className="tabular-nums" c="var(--text-heading)">
                    {formatPercent(mc.prob_bcr_ge_one)}
                  </Text>
                  <Text size="xs" c="var(--text-muted)" mt={4}>
                    Benefits cover costs
                  </Text>
                </div>
                <RingProgress
                  size={68}
                  thickness={5}
                  roundCaps
                  rootColor="var(--chart-track)"
                  sections={[{ value: Math.round(probBcr * 100), color: bcrStroke }]}
                  label={
                    <Text size="xs" ta="center" fw={600} className="tabular-nums" c="var(--text-body)">
                      {Math.round(probBcr * 100)}%
                    </Text>
                  }
                />
              </Group>
            </Paper>

            <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
              <Text size="xs" fw={500} c="var(--text-muted)">
                NPV Percentiles (P50 median)
              </Text>
              <Text
                size="xl"
                fw={700}
                mt={4}
                className="tabular-nums"
                c={mc.npv_stats.p50 >= 0 ? 'var(--text-pos)' : 'var(--text-neg)'}
              >
                {formatCompactCurrency(mc.npv_stats.p50)}
              </Text>
              <Text size="xs" c="var(--text-muted)" mt={4} className="tabular-nums">
                P10 {formatCompactCurrency(mc.npv_stats.p10)} · P90 {formatCompactCurrency(mc.npv_stats.p90)}
              </Text>
              <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                Mean {formatCompactCurrency(mc.npv_stats.mean)} · σ {formatCompactCurrency(mc.npv_stats.std)}
              </Text>
            </Paper>

            <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
              <Text size="xs" fw={500} c="var(--text-muted)">
                BCR Percentiles (P50 median)
              </Text>
              <Text size="xl" fw={700} mt={4} className="tabular-nums" c="var(--text-heading)">
                {formatRatio(mc.bcr_stats?.p50)}
              </Text>
              <Text size="xs" c="var(--text-muted)" mt={4} className="tabular-nums">
                P10 {formatRatio(mc.bcr_stats?.p10)} · P90 {formatRatio(mc.bcr_stats?.p90)}
              </Text>
              <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                Mean {formatRatio(mc.bcr_stats?.mean)}
              </Text>
            </Paper>
          </SimpleGrid>

          <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
            <Group justify="space-between" align="center" mb="xs" wrap="wrap" gap="xs">
              <div>
                <Title order={5}>Simulated NPV Distribution</Title>
                <Text size="xs" c="var(--text-muted)">
                  Markers show $0 breakeven alongside P10, P50, and P90 outcomes
                </Text>
              </div>
              <SegmentedControl
                size="xs"
                fullWidth={isMobile}
                value={chartType}
                onChange={(v) => setChartType(v as 'histogram' | 'cdf')}
                data={[
                  { label: 'Histogram', value: 'histogram' },
                  { label: 'Cumulative CDF', value: 'cdf' },
                ]}
              />
            </Group>

            <Group gap="md" wrap="wrap" mb="xs">
              <Group gap={6} wrap="nowrap">
                <span style={{ display: 'inline-block', width: 14, borderTop: '2px solid var(--chart-zero)' }} />
                <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                  $0 Breakeven
                </Text>
              </Group>
              <Group gap={6} wrap="nowrap">
                <span style={{ display: 'inline-block', width: 14, borderTop: '2px dashed var(--chart-warn)' }} />
                <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                  P10 {formatCompactCurrency(mc.npv_stats.p10)}
                </Text>
              </Group>
              <Group gap={6} wrap="nowrap">
                <span style={{ display: 'inline-block', width: 14, borderTop: '2px dashed var(--chart-line)' }} />
                <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                  P50 {formatCompactCurrency(mc.npv_stats.p50)}
                </Text>
              </Group>
              <Group gap={6} wrap="nowrap">
                <span style={{ display: 'inline-block', width: 14, borderTop: '2px dashed var(--chart-pos)' }} />
                <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                  P90 {formatCompactCurrency(mc.npv_stats.p90)}
                </Text>
              </Group>
            </Group>

            <div style={{ width: '100%', height: isMobile ? 240 : 300 }}>
              <ResponsiveContainer>
                {chartType === 'histogram' ? (
                  <BarChart
                    data={histData}
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
                      labelFormatter={(_label, payload) => {
                        const row = payload?.[0]?.payload as { rangeLabel?: string } | undefined;
                        return row?.rangeLabel || '';
                      }}
                      formatter={(value: unknown) => [Number(value).toLocaleString(), 'Simulations']}
                    />
                    <Bar dataKey="count" name="Simulations" radius={[2, 2, 0, 0]}>
                      {histData.map((entry, idx) => (
                        <Cell
                          key={idx}
                          fill={entry.bin_mid >= 0 ? 'var(--chart-pos)' : 'var(--chart-neg)'}
                          fillOpacity={0.9}
                        />
                      ))}
                    </Bar>
                    <ReferenceLine x={0} stroke="var(--chart-zero)" strokeWidth={1.75} />
                    <ReferenceLine x={mc.npv_stats.p10} stroke="var(--chart-warn)" strokeDasharray="4 4" />
                    <ReferenceLine x={mc.npv_stats.p50} stroke="var(--chart-line)" strokeDasharray="4 4" />
                    <ReferenceLine x={mc.npv_stats.p90} stroke="var(--chart-pos)" strokeDasharray="4 4" />
                  </BarChart>
                ) : (
                  <AreaChart
                    data={histData}
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
                      formatter={(v: unknown) => [`${Number(v).toFixed(1)}%`, 'Cumulative Prob']}
                    />
                    <Area
                      type="monotone"
                      dataKey="cdfPct"
                      stroke="var(--chart-line)"
                      fill="var(--bg-active)"
                      strokeWidth={2}
                    />
                    <ReferenceLine x={0} stroke="var(--chart-zero)" strokeWidth={1.75} />
                    <ReferenceLine x={mc.npv_stats.p10} stroke="var(--chart-warn)" strokeDasharray="4 4" />
                    <ReferenceLine x={mc.npv_stats.p50} stroke="var(--chart-line)" strokeDasharray="4 4" />
                    <ReferenceLine x={mc.npv_stats.p90} stroke="var(--chart-pos)" strokeDasharray="4 4" />
                  </AreaChart>
                )}
              </ResponsiveContainer>
            </div>

            <Paper withBorder p="xs" radius="md" bg="var(--bg-subtle)" mt="sm">
              <SimpleGrid cols={{ base: 3, xs: 4, sm: 7 }} spacing="xs">
                {[
                  ['P5', mc.npv_stats.p5],
                  ['P10', mc.npv_stats.p10],
                  ['P25', mc.npv_stats.p25],
                  ['P50', mc.npv_stats.p50],
                  ['P75', mc.npv_stats.p75],
                  ['P90', mc.npv_stats.p90],
                  ['P95', mc.npv_stats.p95],
                ].map(([lbl, val]) => (
                  <div key={String(lbl)}>
                    <Text size="xs" c="var(--text-muted)" fw={500}>
                      {lbl}
                    </Text>
                    <Text size="sm" fw={600} className="tabular-nums" c="var(--text-heading)">
                      {formatCompactCurrency(Number(val))}
                    </Text>
                  </div>
                ))}
              </SimpleGrid>
            </Paper>
          </Paper>

          <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
            <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
              <Title order={5}>Cumulative Discounted NPV Trajectory (P10–P90)</Title>
              <Text size="xs" c="var(--text-muted)" mb="sm">
                Evolution of cumulative discounted net cash flow quantiles across the horizon
              </Text>
              <div style={{ width: '100%', height: isMobile ? 240 : 270 }}>
                <ResponsiveContainer>
                  <ComposedChart
                    data={mc.yearly_cumulative_npv_bands.map((y) => ({
                      ...y,
                      yearLabel: formatYearLabel(y.year, initiative.cost_start_year, 'short'),
                      fullYearLabel: formatYearLabel(y.year, initiative.cost_start_year, 'full'),
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
                      labelFormatter={(_label, payload) => {
                        const row = payload?.[0]?.payload as { fullYearLabel?: string } | undefined;
                        return row?.fullYearLabel || '';
                      }}
                      formatter={(value: unknown, name: string) => [
                        formatCurrency(Number(value)),
                        name,
                      ]}
                    />
                    <Legend wrapperStyle={{ paddingTop: 6 }} />
                    <ReferenceLine y={0} stroke="var(--chart-zero)" strokeDasharray="3 3" />
                    <Line
                      type="monotone"
                      dataKey="p90"
                      name="P90 Optimistic"
                      stroke="var(--chart-pos)"
                      strokeDasharray="4 4"
                      strokeWidth={1.8}
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="p50"
                      name="P50 Median"
                      stroke="var(--chart-line)"
                      strokeWidth={2.2}
                      dot={{ r: 2.5 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="p10"
                      name="P10 Conservative"
                      stroke="var(--chart-warn)"
                      strokeDasharray="4 4"
                      strokeWidth={1.8}
                      dot={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </Paper>

            <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
              <Title order={5}>Top Uncertainty & Sensitivity Drivers</Title>
              <Text size="xs" c="var(--text-muted)" mb="sm">
                Spearman rank correlation (ρ) with simulated NPV and share of explained variance
              </Text>
              {drivers.length === 0 ? (
                <Text size="sm" c="var(--text-muted)" py="xl" ta="center">
                  All parameters are currently fixed (deterministic). Configure parameter distributions on line items to see sensitivity drivers.
                </Text>
              ) : (
                <Stack gap="sm">
                  {drivers.map((d) => {
                    const positive = d.spearman_corr >= 0;
                    const magPct = Math.min(50, Math.abs(d.spearman_corr) * 50);
                    return (
                      <Box key={`${d.item_id}-${d.parameter_key}`}>
                        <Group justify="space-between" align="baseline" wrap="wrap" gap={6} mb={4}>
                          <Text size="xs" fw={500} c="var(--text-body)" style={{ flex: '1 1 170px', minWidth: 0 }}>
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
                  <Group justify="space-between" pt={2}>
                    <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                      -1.0 (Cost / Risk)
                    </Text>
                    <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                      0
                    </Text>
                    <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                      +1.0 (Value Upside)
                    </Text>
                  </Group>
                </Stack>
              )}
            </Paper>
          </SimpleGrid>

          <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
            <Title order={5}>Value-Stream Comparison (Deterministic & Simulated NPV)</Title>
            <Text size="xs" c="var(--text-muted)" mb="sm">
              Where costs, benefits, and Monte Carlo uncertainty originate across value streams
            </Text>

            <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md" style={{ alignItems: 'start' }}>
              <div style={{ width: '100%', height: isMobile ? 250 : 260 }}>
                <ResponsiveContainer>
                  <BarChart
                    data={mc.value_streams}
                    margin={{ top: 10, right: isMobile ? 8 : 16, left: 0, bottom: 6 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
                    <XAxis
                      dataKey="value_stream"
                      interval={0}
                      height={46}
                      tick={<MultiLineTick />}
                    />
                    <YAxis
                      tickFormatter={(v) => formatCompactCurrency(Number(v))}
                      tick={{ fontSize: 10.5, fill: 'var(--text-muted)' }}
                      width={isMobile ? 54 : 74}
                    />
                    <Tooltip
                      {...TOOLTIP_PROPS}
                      formatter={(v: unknown, name: string) => [formatCurrency(Number(v)), name]}
                    />
                    <Legend wrapperStyle={{ paddingTop: 4 }} />
                    <ReferenceLine y={0} stroke="var(--chart-zero)" />
                    <Bar dataKey="pv_costs" name="PV Costs" fill="var(--chart-neg)" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="pv_benefits" name="PV Benefits" fill="var(--chart-pos)" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="sim_npv_p50" name="Sim. P50 NPV" fill="var(--chart-line)" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {isMobile ? (
                <Stack gap={0}>
                  {mc.value_streams.map((vs, idx) => (
                    <Fragment key={vs.value_stream}>
                      {idx > 0 && <Divider color="var(--border-divider)" my="sm" />}
                      <Stack gap={6}>
                        <Group justify="space-between">
                          <Text size="sm" fw={600} c="var(--text-heading)">
                            {vs.value_stream}
                          </Text>
                          <Text size="xs" c="var(--text-muted)">
                            {vs.item_count} items
                          </Text>
                        </Group>
                        <SimpleGrid cols={2} spacing="xs">
                          <div>
                            <Text size="xs" c="var(--text-muted)">
                              PV Costs
                            </Text>
                            <Text size="sm" fw={600} c="var(--text-neg)" className="tabular-nums">
                              {formatCompactCurrency(vs.pv_costs)}
                            </Text>
                          </div>
                          <div>
                            <Text size="xs" c="var(--text-muted)">
                              PV Benefits
                            </Text>
                            <Text size="sm" fw={600} c="var(--text-pos)" className="tabular-nums">
                              {formatCompactCurrency(vs.pv_benefits)}
                            </Text>
                          </div>
                        </SimpleGrid>
                        <SimpleGrid cols={3} spacing="xs">
                          <div>
                            <Text size="xs" c="var(--text-muted)">
                              P10 NPV
                            </Text>
                            <Text size="xs" fw={500} className="tabular-nums" c="var(--text-body)">
                              {formatCompactCurrency(vs.sim_npv_p10)}
                            </Text>
                          </div>
                          <div>
                            <Text size="xs" c="var(--text-muted)">
                              P50 NPV
                            </Text>
                            <Text
                              size="xs"
                              fw={600}
                              className="tabular-nums"
                              c={(vs.sim_npv_p50 ?? 0) >= 0 ? 'var(--text-pos)' : 'var(--text-neg)'}
                            >
                              {formatCompactCurrency(vs.sim_npv_p50)}
                            </Text>
                          </div>
                          <div>
                            <Text size="xs" c="var(--text-muted)">
                              P90 NPV
                            </Text>
                            <Text size="xs" fw={500} className="tabular-nums" c="var(--text-body)">
                              {formatCompactCurrency(vs.sim_npv_p90)}
                            </Text>
                          </div>
                        </SimpleGrid>
                      </Stack>
                    </Fragment>
                  ))}
                </Stack>
              ) : (
                <div
                  tabIndex={0}
                  role="region"
                  aria-label="Value stream simulation breakdown"
                  className="table-region"
                >
                  <Table verticalSpacing="xs" horizontalSpacing="sm">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Value Stream</Table.Th>
                        <Table.Th ta="right">PV Costs</Table.Th>
                        <Table.Th ta="right">PV Benefits</Table.Th>
                        <Table.Th ta="right">P10 NPV</Table.Th>
                        <Table.Th ta="right">P50 NPV</Table.Th>
                        <Table.Th ta="right">P90 NPV</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {mc.value_streams.map((vs) => (
                        <Table.Tr key={vs.value_stream}>
                          <Table.Td fw={600} c="var(--text-heading)">
                            {vs.value_stream} ({vs.item_count})
                          </Table.Td>
                          <Table.Td ta="right" className="tabular-nums" c="var(--text-neg)">
                            {formatCompactCurrency(vs.pv_costs)}
                          </Table.Td>
                          <Table.Td ta="right" className="tabular-nums" c="var(--text-pos)">
                            {formatCompactCurrency(vs.pv_benefits)}
                          </Table.Td>
                          <Table.Td ta="right" className="tabular-nums">
                            {formatCompactCurrency(vs.sim_npv_p10)}
                          </Table.Td>
                          <Table.Td
                            ta="right"
                            className="tabular-nums"
                            fw={600}
                            c={(vs.sim_npv_p50 ?? 0) >= 0 ? 'var(--text-pos)' : 'var(--text-neg)'}
                          >
                            {formatCompactCurrency(vs.sim_npv_p50)}
                          </Table.Td>
                          <Table.Td ta="right" className="tabular-nums">
                            {formatCompactCurrency(vs.sim_npv_p90)}
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </div>
              )}
            </SimpleGrid>
          </Paper>
        </>
      )}

      <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
        <Group justify="space-between" mb="xs" wrap="wrap" gap="xs">
          <Group gap="xs">
            <IconHistory size={17} color="var(--text-muted)" />
            <Title order={5}>Saved Simulation History ({runs.length})</Title>
          </Group>
          <Text size="xs" c="var(--text-muted)">
            Inspect and compare past sensitivity & what-if runs
          </Text>
        </Group>

        {runs.length === 0 ? (
          <Text size="sm" c="var(--text-muted)" py="md">
            No simulation runs persisted yet for this initiative.
          </Text>
        ) : isMobile ? (
          <Stack gap={0}>
            {runs.map((rec, idx) => {
              const isActive = activeResult?.run_id === rec.id;
              return (
                <Fragment key={rec.id}>
                  {idx > 0 && <Divider color="var(--border-divider)" my="sm" />}
                  <Box
                    p={isActive ? 'xs' : 0}
                    style={
                      isActive
                        ? { backgroundColor: 'var(--bg-active)', borderRadius: 6 }
                        : undefined
                    }
                  >
                    <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs" mb={6}>
                      <div>
                        <Text size="xs" fw={600} className="tabular-nums" c="var(--text-heading)">
                          {new Date(rec.created_at).toLocaleString()}
                        </Text>
                        <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                          {rec.n_simulations.toLocaleString()} runs · Seed {rec.seed ?? 'Random'} · {(rec.discount_rate * 100).toFixed(1)}% · {rec.summary.duration_ms.toFixed(0)} ms
                        </Text>
                      </div>
                      <Button
                        type="button"
                        size="xs"
                        variant={isActive ? 'light' : 'subtle'}
                        color={isActive ? 'slateIndigo' : 'gray'}
                        onClick={() => onSelectHistoricalRun(rec)}
                      >
                        {isActive ? 'Viewing' : 'View'}
                      </Button>
                    </Group>
                    <SimpleGrid cols={2} spacing="xs">
                      <div>
                        <Text size="xs" c="var(--text-muted)">
                          P(NPV &gt; 0)
                        </Text>
                        <Text size="sm" fw={600} className="tabular-nums" c="var(--text-heading)">
                          {formatPercent(rec.summary.monte_carlo.prob_npv_positive)}
                        </Text>
                      </div>
                      <div>
                        <Text size="xs" c="var(--text-muted)">
                          P50 NPV
                        </Text>
                        <Text size="sm" fw={600} className="tabular-nums" c="var(--text-heading)">
                          {formatCompactCurrency(rec.summary.monte_carlo.npv_stats.p50)}
                        </Text>
                      </div>
                    </SimpleGrid>
                  </Box>
                </Fragment>
              );
            })}
          </Stack>
        ) : (
          <div
            tabIndex={0}
            role="region"
            aria-label="Persisted simulation run history"
            className="table-region"
          >
            <Table verticalSpacing="xs" horizontalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Timestamp</Table.Th>
                  <Table.Th ta="right">Runs</Table.Th>
                  <Table.Th ta="right">Seed</Table.Th>
                  <Table.Th ta="right">Disc. Rate</Table.Th>
                  <Table.Th ta="right">P(NPV &gt; 0)</Table.Th>
                  <Table.Th ta="right">P50 NPV</Table.Th>
                  <Table.Th ta="right">Time</Table.Th>
                  <Table.Th ta="right">Inspect</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {runs.map((rec) => {
                  const isActive = activeResult?.run_id === rec.id;
                  return (
                    <Table.Tr
                      key={rec.id}
                      style={isActive ? { backgroundColor: 'var(--bg-active)' } : undefined}
                    >
                      <Table.Td className="tabular-nums">
                        {new Date(rec.created_at).toLocaleString()}
                      </Table.Td>
                      <Table.Td ta="right" className="tabular-nums">
                        {rec.n_simulations.toLocaleString()}
                      </Table.Td>
                      <Table.Td ta="right" className="tabular-nums">
                        {rec.seed ?? 'Random'}
                      </Table.Td>
                      <Table.Td ta="right" className="tabular-nums">
                        {(rec.discount_rate * 100).toFixed(1)}%
                      </Table.Td>
                      <Table.Td ta="right" className="tabular-nums" fw={600}>
                        {formatPercent(rec.summary.monte_carlo.prob_npv_positive)}
                      </Table.Td>
                      <Table.Td ta="right" className="tabular-nums" fw={600}>
                        {formatCompactCurrency(rec.summary.monte_carlo.npv_stats.p50)}
                      </Table.Td>
                      <Table.Td ta="right" className="tabular-nums">
                        {rec.summary.duration_ms.toFixed(0)} ms
                      </Table.Td>
                      <Table.Td ta="right">
                        <Button
                          type="button"
                          size="xs"
                          variant={isActive ? 'light' : 'subtle'}
                          color={isActive ? 'slateIndigo' : 'gray'}
                          onClick={() => onSelectHistoricalRun(rec)}
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
