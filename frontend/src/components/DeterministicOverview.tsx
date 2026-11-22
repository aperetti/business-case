import { useState } from 'react';
import {
  Group,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { DeterministicMetrics } from '../types/api';
import {
  formatCompactCurrency,
  formatCurrency,
  formatPayback,
  formatRatio,
  formatYearLabel,
} from '../utils/format';

interface Props {
  metrics: DeterministicMetrics;
  costStartYear?: number | null;
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

export function DeterministicOverview({ metrics, costStartYear }: Props) {
  const isMobile = useMediaQuery('(max-width: 48em)') ?? false;
  const [viewMode, setViewMode] = useState<'pv' | 'undiscounted'>('pv');

  const npvPositive = metrics.npv >= 0;

  const chartData = metrics.yearly_cash_flows.map((row) => ({
    yearLabel: formatYearLabel(row.year, costStartYear, 'short'),
    fullYearLabel: formatYearLabel(row.year, costStartYear, 'full'),
    cost: viewMode === 'pv' ? row.pv_cost : row.undiscounted_cost,
    benefit: viewMode === 'pv' ? row.pv_benefit : row.undiscounted_benefit,
    cumulativeNet: viewMode === 'pv' ? row.cumulative_net_pv : row.cumulative_undiscounted_net,
  }));

  return (
    <Stack gap="md">
      {metrics.guardrail_warnings.map((w) => (
        <div key={w.tag} className="callout-note" role="note">
          <strong>Double-counting guardrail ({w.tag}):</strong> {w.message}
        </div>
      ))}

      <SimpleGrid cols={{ base: 2, md: 5 }} spacing="xs">
        <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
          <Group gap={6} wrap="nowrap">
            <span className="status-dot" style={{ backgroundColor: 'var(--chart-neg)' }} />
            <Text size="xs" fw={500} c="var(--text-muted)">
              PV of Costs
            </Text>
          </Group>
          <Text size={isMobile ? 'lg' : 'xl'} fw={700} mt={6} className="tabular-nums" c="var(--text-heading)">
            {formatCompactCurrency(metrics.pv_costs)}
          </Text>
          <Text size="xs" c="var(--text-muted)" mt={2} className="tabular-nums">
            {formatCurrency(metrics.pv_costs)}
          </Text>
        </Paper>

        <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
          <Group gap={6} wrap="nowrap">
            <span className="status-dot" style={{ backgroundColor: 'var(--chart-pos)' }} />
            <Text size="xs" fw={500} c="var(--text-muted)">
              PV of Benefits
            </Text>
          </Group>
          <Text size={isMobile ? 'lg' : 'xl'} fw={700} mt={6} className="tabular-nums" c="var(--text-heading)">
            {formatCompactCurrency(metrics.pv_benefits)}
          </Text>
          <Text size="xs" c="var(--text-muted)" mt={2} className="tabular-nums">
            {formatCurrency(metrics.pv_benefits)}
          </Text>
        </Paper>

        <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
          <Text size="xs" fw={500} c="var(--text-muted)">
            Deterministic NPV
          </Text>
          <Text
            size={isMobile ? 'lg' : 'xl'}
            fw={700}
            mt={6}
            className="tabular-nums"
            c={npvPositive ? 'var(--text-pos)' : 'var(--text-neg)'}
          >
            {npvPositive ? '+' : ''}
            {formatCompactCurrency(metrics.npv)}
          </Text>
          <Text size="xs" c="var(--text-muted)" mt={2} className="tabular-nums">
            {formatCurrency(metrics.npv)} · {npvPositive ? 'Net positive' : 'Net negative'}
          </Text>
        </Paper>

        <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
          <Text size="xs" fw={500} c="var(--text-muted)">
            Benefit-Cost Ratio
          </Text>
          <Text size={isMobile ? 'lg' : 'xl'} fw={700} mt={6} className="tabular-nums" c="var(--text-heading)">
            {formatRatio(metrics.bcr)}
          </Text>
          <Text size="xs" c="var(--text-muted)" mt={2}>
            Target ≥ 1.00x
          </Text>
        </Paper>

        <Paper
          withBorder
          p={{ base: 'sm', sm: 'md' }}
          radius="md"
          bg="var(--bg-surface)"
          style={isMobile ? { gridColumn: '1 / -1' } : undefined}
        >
          <Text size="xs" fw={500} c="var(--text-muted)">
            Discounted Payback
          </Text>
          <Text size={isMobile ? 'lg' : 'xl'} fw={700} mt={6} className="tabular-nums" c="var(--text-heading)">
            {formatPayback(metrics.discounted_payback_year)}
          </Text>
          <Text size="xs" c="var(--text-muted)" mt={2}>
            Interpolated breakeven
          </Text>
        </Paper>
      </SimpleGrid>

      <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
        <Group justify="space-between" align="center" mb="sm" wrap="wrap" gap="xs">
          <div>
            <Title order={5}>Year-by-Year Cost vs. Benefit Curve</Title>
            <Text size="xs" c="var(--text-muted)">
              Annual costs, realized benefits, and cumulative net cash flow trajectory
            </Text>
          </div>
          <SegmentedControl
            size="xs"
            fullWidth={isMobile}
            value={viewMode}
            onChange={(v) => setViewMode(v as 'pv' | 'undiscounted')}
            data={[
              { label: 'Discounted (PV)', value: 'pv' },
              { label: 'Undiscounted ($)', value: 'undiscounted' },
            ]}
          />
        </Group>

        <div style={{ width: '100%', height: isMobile ? 250 : 290 }}>
          <ResponsiveContainer>
            <ComposedChart
              data={chartData}
              margin={{ top: 10, right: isMobile ? 8 : 20, left: 0, bottom: 4 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
              <XAxis dataKey="yearLabel" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
              <YAxis
                tickFormatter={(v) => formatCompactCurrency(Number(v))}
                tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                width={isMobile ? 54 : 76}
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
              <Bar dataKey="cost" name="Costs" fill="var(--chart-neg)" radius={[3, 3, 0, 0]} />
              <Bar dataKey="benefit" name="Benefits" fill="var(--chart-pos)" radius={[3, 3, 0, 0]} />
              <Line
                type="monotone"
                dataKey="cumulativeNet"
                name="Cumulative Net"
                stroke="var(--chart-line)"
                strokeWidth={2.2}
                dot={{ r: 2.5 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Paper>

      <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
        <Group justify="space-between" align="baseline" mb="xs" wrap="wrap" gap="xs">
          <Title order={5}>Annual Cash-Flow Schedule</Title>
          <Text size="xs" c="var(--text-muted)" hiddenFrom="sm">
            Swipe horizontally to view all columns
          </Text>
        </Group>
        <div
          tabIndex={0}
          role="region"
          aria-label="Annual deterministic cash-flow breakdown"
          className="table-region table-sticky-first"
        >
          <Table verticalSpacing="xs" horizontalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Year</Table.Th>
                <Table.Th ta="right">Undisc. Cost</Table.Th>
                <Table.Th ta="right">Undisc. Benefit</Table.Th>
                <Table.Th ta="right">PV Cost</Table.Th>
                <Table.Th ta="right">PV Benefit</Table.Th>
                <Table.Th ta="right">Net PV</Table.Th>
                <Table.Th ta="right">Cum. Net PV</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {metrics.yearly_cash_flows.map((row) => (
                <Table.Tr key={row.year}>
                  <Table.Td fw={600} c="var(--text-heading)" className="tabular-nums">
                    {formatYearLabel(row.year, costStartYear, 'full')}
                  </Table.Td>
                  <Table.Td ta="right" className="tabular-nums">
                    {formatCurrency(row.undiscounted_cost)}
                  </Table.Td>
                  <Table.Td ta="right" className="tabular-nums">
                    {formatCurrency(row.undiscounted_benefit)}
                  </Table.Td>
                  <Table.Td ta="right" className="tabular-nums" c="var(--text-neg)">
                    {formatCurrency(row.pv_cost)}
                  </Table.Td>
                  <Table.Td ta="right" className="tabular-nums" c="var(--text-pos)">
                    {formatCurrency(row.pv_benefit)}
                  </Table.Td>
                  <Table.Td
                    ta="right"
                    className="tabular-nums"
                    fw={600}
                    c={row.net_pv >= 0 ? 'var(--text-pos)' : 'var(--text-neg)'}
                  >
                    {formatCurrency(row.net_pv)}
                  </Table.Td>
                  <Table.Td
                    ta="right"
                    className="tabular-nums"
                    fw={600}
                    c={row.cumulative_net_pv >= 0 ? 'var(--text-pos)' : 'var(--text-neg)'}
                  >
                    {formatCurrency(row.cumulative_net_pv)}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      </Paper>
    </Stack>
  );
}
