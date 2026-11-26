import { Fragment, useEffect, useMemo, useState } from 'react';
import { Chip, Group, Loader, Paper, SegmentedControl, Stack, Table, Text, Title } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { api } from '../api/client';
import type { BCASummary, MeasureOut, PairwiseCaseSamples } from '../types/api';
import { formatCompactCurrency, formatPercent } from '../utils/format';
import { formatMeasureNumber } from './NonMonetaryBenefitsPanel';

interface Props {
  initiativeId: string;
  bcas: BCASummary[];
  measures: MeasureOut[];
}

interface Estimate {
  value: number;
  low: number | null;
  high: number | null;
}

interface PairVar {
  id: string;
  label: string;
  unit: string;
  better: 'higher' | 'lower';
  /** Monetary measures come from the cost/benefit model; the rest are user-defined. */
  monetary: boolean;
  format: (v: number) => string;
  get: (b: BCASummary) => Estimate | null;
  /** Monte Carlo draws for this variable, or undefined when it has none (e.g. P(NPV > 0)). */
  draws?: (s: PairwiseCaseSamples) => (number | null)[] | undefined;
}

type Mode = 'mc' | 'estimates';

/** Distribution summary of one variable's draws for one case. */
interface DrawStats {
  p10: number;
  p50: number;
  p90: number;
  /** Finite draws, in draw order (aligned with the other variables only via `raw`). */
  values: number[];
  raw: (number | null)[];
  missing: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function drawStats(raw: (number | null)[]): DrawStats | null {
  const values = raw.filter((v): v is number => v !== null && Number.isFinite(v));
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p10: quantile(sorted, 0.1),
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    values: sorted,
    raw,
    missing: raw.length - values.length,
  };
}

/** Gaussian kernel density on `n` grid points over [min, max]; null when the draws are constant. */
function density(sorted: number[], min: number, max: number, n = 48): number[] | null {
  const m = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / m;
  const sd = Math.sqrt(sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(m - 1, 1));
  const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
  const spread = Math.min(sd, iqr > 0 ? iqr / 1.34 : sd);
  if (!(spread > 0)) return null;
  const h = 0.9 * spread * m ** -0.2;
  const out: number[] = [];
  for (let g = 0; g < n; g += 1) {
    const x = min + ((max - min) * g) / (n - 1);
    let sum = 0;
    for (const v of sorted) {
      const z = (x - v) / h;
      if (z > -4 && z < 4) sum += Math.exp(-0.5 * z * z);
    }
    out.push(sum);
  }
  return out;
}

/** One SVG path of small dots: far cheaper than an element per draw. */
function dotsPath(points: [number, number][], r: number): string {
  let d = '';
  for (const [x, y] of points) d += `M${(x - r).toFixed(1)},${y.toFixed(1)}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0`;
  return d;
}

const SHAPES = ['circle', 'square', 'triangle', 'diamond', 'triangleDown', 'plus', 'hexagon', 'star'] as const;
type Shape = (typeof SHAPES)[number];
const MAX_CASES = SHAPES.length;
const MAX_DEFAULT_VARS = 6;

function caseColor(idx: number): string {
  return `var(--case-${(idx % MAX_CASES) + 1})`;
}

function markerPath(shape: Shape, r: number): string {
  const p = (pts: [number, number][]) => `M${pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join('L')}Z`;
  const poly = (n: number, rot: number, rad = r) =>
    p(Array.from({ length: n }, (_, i) => {
      const a = rot + (i * 2 * Math.PI) / n;
      return [rad * Math.cos(a), rad * Math.sin(a)] as [number, number];
    }));
  switch (shape) {
    case 'circle':
      return `M${-r},0a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0`;
    case 'square':
      return p([[-r * 0.85, -r * 0.85], [r * 0.85, -r * 0.85], [r * 0.85, r * 0.85], [-r * 0.85, r * 0.85]]);
    case 'triangle':
      return poly(3, -Math.PI / 2, r * 1.15);
    case 'triangleDown':
      return poly(3, Math.PI / 2, r * 1.15);
    case 'diamond':
      return poly(4, -Math.PI / 2, r * 1.15);
    case 'hexagon':
      return poly(6, 0, r);
    case 'plus': {
      const t = r * 0.38;
      return p([[-t, -r], [t, -r], [t, -t], [r, -t], [r, t], [t, t], [t, r], [-t, r], [-t, t], [-r, t], [-r, -t], [-t, -t]]);
    }
    case 'star':
      return p(Array.from({ length: 10 }, (_, i) => {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rad = i % 2 === 0 ? r * 1.2 : r * 0.5;
        return [rad * Math.cos(a), rad * Math.sin(a)] as [number, number];
      }));
  }
}

function Marker({ shape, color, r = 5, ring = true }: { shape: Shape; color: string; r?: number; ring?: boolean }) {
  return (
    <path
      d={markerPath(shape, r)}
      fill={color}
      stroke={ring ? 'var(--bg-surface)' : 'none'}
      strokeWidth={ring ? 2 : 0}
      paintOrder="stroke"
    />
  );
}

function niceStep(span: number, count: number): number {
  const raw = span / Math.max(count, 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
}

/** Padded domain and ~3 round ticks covering every value and range end. */
function scaleFor(values: number[]): { min: number; max: number; ticks: number[] } {
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (lo === hi) {
    const pad = Math.abs(lo) * 0.1 || 1;
    lo -= pad;
    hi += pad;
  }
  const pad = (hi - lo) * 0.08;
  lo -= pad;
  hi += pad;
  const step = niceStep(hi - lo, 3);
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) ticks.push(Math.abs(t) < step * 1e-9 ? 0 : t);
  return { min: lo, max: hi, ticks };
}

function buildVariables(bcas: BCASummary[], measures: MeasureOut[]): PairVar[] {
  const point = (value: number | null | undefined, low?: number | null, high?: number | null): Estimate | null =>
    value === null || value === undefined || !Number.isFinite(value)
      ? null
      : { value, low: low ?? null, high: high ?? null };
  const vars: PairVar[] = [
    {
      id: 'npv',
      label: 'NPV',
      unit: '',
      better: 'higher',
      monetary: true,
      format: formatCompactCurrency,
      get: (b) => point(b.npv, b.latest_npv_p10, b.latest_npv_p90),
      draws: (s) => s.npv,
    },
    {
      id: 'bcr',
      label: 'Benefit-cost ratio',
      unit: '',
      better: 'higher',
      monetary: true,
      format: (v) => `${v.toFixed(2)}x`,
      get: (b) => point(b.bcr),
      draws: (s) => s.bcr,
    },
    {
      id: 'pv_benefits',
      label: 'PV benefits',
      unit: '',
      better: 'higher',
      monetary: true,
      format: formatCompactCurrency,
      get: (b) => point(b.pv_benefits),
      draws: (s) => s.pv_benefits,
    },
    {
      id: 'pv_costs',
      label: 'PV costs',
      unit: '',
      better: 'lower',
      monetary: true,
      format: formatCompactCurrency,
      get: (b) => point(b.pv_costs),
      draws: (s) => s.pv_costs,
    },
    {
      id: 'payback',
      label: 'Discounted payback',
      unit: 'years',
      better: 'lower',
      monetary: true,
      format: (v) => `${v.toFixed(1)} yr`,
      get: (b) => point(b.discounted_payback_year),
      draws: (s) => s.payback,
    },
  ];
  if (bcas.some((b) => b.latest_prob_npv_positive !== null)) {
    vars.push({
      id: 'p_npv',
      label: 'P(NPV > 0)',
      unit: '',
      better: 'higher',
      monetary: true,
      format: (v) => formatPercent(v, 0),
      get: (b) => point(b.latest_prob_npv_positive),
    });
  }
  for (const m of measures) {
    vars.push({
      id: `m:${m.id}`,
      label: m.name,
      unit: m.unit,
      better: m.direction === 'higher_is_better' ? 'higher' : 'lower',
      monetary: false,
      format: formatMeasureNumber,
      get: (b) => {
        const v = b.measure_values[m.id];
        return v ? point(v.value, v.low, v.high) : null;
      },
      draws: (s) => s.measures[m.id],
    });
  }
  return vars;
}

function defaultSelection(vars: PairVar[]): string[] {
  const nonMonetary = vars.filter((v) => !v.monetary).map((v) => v.id);
  return ['npv', 'bcr', ...nonMonetary].slice(0, MAX_DEFAULT_VARS);
}

const LEFT = 66;
const BOTTOM = 26;
const INSET = 10;

interface Hover {
  left: number;
  top: number;
  bca: BCASummary;
  lines: string[];
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(max - 1, 1))}…` : text;
}

function statsText(v: PairVar, st: DrawStats): string {
  const unit = v.unit && !v.monetary ? ` ${v.unit}` : '';
  return `${v.format(st.p50)}${unit} (P10–P90 ${v.format(st.p10)}–${v.format(st.p90)})`;
}

function rangeText(v: PairVar, e: Estimate): string {
  const main = v.format(e.value) + (v.unit && !v.monetary ? ` ${v.unit}` : '');
  if (e.low === null && e.high === null) return main;
  return `${main} (${v.format(e.low ?? e.value)}–${v.format(e.high ?? e.value)})`;
}

/**
 * Scatter-plot matrix (corner layout) of financial and non-monetary measures, with each
 * business case as a category: lower cells plot one measure against another, the diagonal
 * shows each measure on its own. Whiskers show low–high ranges where known.
 */
export function PairwisePlot({ initiativeId, bcas, measures }: Props) {
  const [mode, setMode] = useState<Mode>('mc');
  const allVariables = useMemo(() => buildVariables(bcas, measures), [bcas, measures]);
  const variables = mode === 'mc' ? allVariables.filter((v) => v.draws) : allVariables;
  const [picked, setPicked] = useState<string[] | null>(null);
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [samples, setSamples] = useState<Record<string, PairwiseCaseSamples> | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Refetch only when something that feeds the simulation changes, not on every new array.
  const dataKey = useMemo(
    () =>
      JSON.stringify([
        initiativeId,
        bcas.map((b) => [b.id, b.npv, b.pv_costs, b.pv_benefits, b.horizon_years, b.discount_rate, b.updated_at, b.measure_values]),
      ]),
    [initiativeId, bcas]
  );
  useEffect(() => {
    if (mode !== 'mc') return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    api
      .getPairwiseSamples(initiativeId)
      .then((res) => {
        if (cancelled) return;
        setSamples(Object.fromEntries(res.cases.map((c) => [c.bca_id, c])));
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Could not run the simulation.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // dataKey captures initiativeId and the case inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey, mode]);
  const useMc = mode === 'mc' && samples !== null;
  const [hover, setHover] = useState<Hover | null>(null);
  const [hiddenCases, setHiddenCases] = useState<Set<string>>(new Set());
  const { ref, width } = useElementSize();

  const validIds = new Set(variables.map((v) => v.id));
  const selectedIds = (picked ?? defaultSelection(variables)).filter((id) => validIds.has(id));
  const selected = variables.filter((v) => selectedIds.includes(v.id));
  const cases = bcas.slice(0, MAX_CASES).map((b, idx) => ({ bca: b, idx, shape: SHAPES[idx] }));
  const visibleCases = cases.filter((c) => !hiddenCases.has(c.bca.id));

  const k = selected.length;
  const cell = k > 0 ? Math.max(104, Math.min(210, Math.floor(((width || 640) - LEFT - 4) / k))) : 0;
  const plotSize = cell * k;

  const selectedKey = selected.map((v) => v.id).join('|');
  /** stats[varId][bcaId] from the Monte Carlo draws. */
  const stats = useMemo(() => {
    const out: Record<string, Record<string, DrawStats | null>> = {};
    if (!samples) return out;
    for (const v of allVariables) {
      if (!v.draws) continue;
      out[v.id] = {};
      for (const b of bcas) {
        const s = samples[b.id];
        const raw = s ? v.draws(s) : undefined;
        out[v.id][b.id] = raw ? drawStats(raw) : null;
      }
    }
    return out;
  }, [samples, allVariables, bcas]);
  const statFor = (v: PairVar, b: BCASummary): DrawStats | null => stats[v.id]?.[b.id] ?? null;

  const scales = useMemo(
    () =>
      selected.map((v) => {
        const vals: number[] = [];
        if (useMc) {
          // 1st–99th percentile per case keeps a few extreme draws from flattening the cloud.
          for (const c of cases) {
            const st = statFor(v, c.bca);
            if (!st) continue;
            vals.push(quantile(st.values, 0.01), quantile(st.values, 0.99));
          }
          return vals.length ? scaleFor(vals) : null;
        }
        for (const c of cases) {
          const e = v.get(c.bca);
          if (!e) continue;
          vals.push(e.value);
          if (e.low !== null) vals.push(e.low);
          if (e.high !== null) vals.push(e.high);
        }
        return vals.length ? scaleFor(vals) : null;
      }),
    // `selected` is rebuilt each render; key the memo on the chosen ids instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedKey, bcas, useMc, stats]
  );

  const toX = (j: number, value: number) => {
    const s = scales[j]!;
    return j * cell + INSET + ((value - s.min) / (s.max - s.min)) * (cell - 2 * INSET);
  };
  const toY = (i: number, value: number) => {
    const s = scales[i]!;
    return i * cell + cell - INSET - ((value - s.min) / (s.max - s.min)) * (cell - 2 * INSET);
  };

  const showHover = (evt: React.MouseEvent, bca: BCASummary, lines: string[]) => {
    const box = (evt.currentTarget as SVGElement).ownerSVGElement?.getBoundingClientRect();
    if (!box) return;
    setHover({ left: evt.clientX - box.left + LEFT, top: evt.clientY - box.top, bca, lines });
  };

  const toggleCase = (id: string) =>
    setHiddenCases((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const measureCount = measures.length;

  return (
    <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
      <div ref={ref}>
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs" mb="sm">
          <div style={{ minWidth: 0, flex: '1 1 320px' }}>
            <Title order={5}>Pair-wise Measures</Title>
            <Text size="xs" c="var(--text-muted)">
              {mode === 'mc'
                ? `Each business case is a category. Lower cells show ${samples ? Object.values(samples)[0]?.npv.length ?? '' : ''} Monte Carlo draws per case, one measure against another, with the median marked; the diagonal shows each measure's distribution. Financial results in a draw come from the same simulated future. Non-monetary measures are drawn independently from their low–expected–high range.`
                : 'Each business case is a category. Lower cells plot one measure against another; the diagonal shows a single measure. Whiskers show the low–high range (Monte Carlo P10–P90 for NPV once simulated).'}
            </Text>
          </div>
          <Group gap="xs" wrap="wrap">
            <SegmentedControl
              size="xs"
              value={mode}
              onChange={(v) => setMode(v as Mode)}
              aria-label="Values to plot"
              data={[
                { value: 'mc', label: 'Monte Carlo' },
                { value: 'estimates', label: 'Estimates' },
              ]}
            />
            <SegmentedControl
              size="xs"
              value={view}
              onChange={(v) => setView(v as 'chart' | 'table')}
              aria-label="Chart or table"
              data={[
                { value: 'chart', label: 'Chart' },
                { value: 'table', label: 'Table' },
              ]}
            />
          </Group>
        </Group>

        <Stack gap={6} mb="sm">
          <Text size="xs" fw={600} c="var(--text-muted)">
            Measures
          </Text>
          <Chip.Group multiple value={selectedIds} onChange={setPicked}>
            <Group gap={6} wrap="wrap">
              {variables.map((v) => (
                <Chip key={v.id} value={v.id} size="xs" variant={v.monetary ? 'outline' : 'light'}>
                  {v.label}
                </Chip>
              ))}
            </Group>
          </Chip.Group>
          {measureCount === 0 && (
            <Text size="xs" c="var(--text-muted)">
              Add non-monetary measures under Initiatives &amp; Assumptions → Non-Monetary Benefits to plot them here.
            </Text>
          )}
        </Stack>

        <Group gap="sm" wrap="wrap" mb="xs" role="list" aria-label="Business cases">
          {cases.map((c) => {
            const hidden = hiddenCases.has(c.bca.id);
            return (
              <button
                key={c.bca.id}
                type="button"
                role="listitem"
                className="pairplot-legend-item"
                aria-pressed={!hidden}
                title={hidden ? 'Show this case' : 'Hide this case'}
                onClick={() => toggleCase(c.bca.id)}
                style={{ opacity: hidden ? 0.45 : 1 }}
              >
                <svg width={14} height={14} viewBox="-7 -7 14 14" aria-hidden>
                  <Marker shape={c.shape} color={caseColor(c.idx)} r={5} ring={false} />
                </svg>
                <Text span size="xs" c="var(--text-heading)" td={hidden ? 'line-through' : undefined}>
                  {c.bca.name}
                </Text>
              </button>
            );
          })}
          {bcas.length > MAX_CASES && (
            <Text size="xs" c="var(--text-muted)">
              Showing the first {MAX_CASES} of {bcas.length} cases.
            </Text>
          )}
        </Group>

        {mode === 'mc' && (loading || loadError) && (
          <Group gap="xs" mb="xs">
            {loading && <Loader size="xs" />}
            <Text size="xs" c={loadError ? 'red' : 'var(--text-muted)'}>
              {loadError ? `Monte Carlo draws unavailable: ${loadError}` : 'Running Monte Carlo…'}
            </Text>
          </Group>
        )}

        {k === 0 ? (
          <Text size="sm" c="var(--text-muted)" py="lg" ta="center">
            Pick at least one measure.
          </Text>
        ) : view === 'table' ? (
          <Table.ScrollContainer minWidth={Math.max(420, 140 + 120 * k)}>
            <Table verticalSpacing={6} fz="xs" striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Business case</Table.Th>
                  {selected.map((v) => (
                    <Table.Th key={v.id}>
                      {v.label}
                      {v.unit ? ` (${v.unit})` : ''} {v.better === 'higher' ? '↑' : '↓'}
                    </Table.Th>
                  ))}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {cases.map((c) => (
                  <Table.Tr key={c.bca.id}>
                    <Table.Td>
                      <Group gap={6} wrap="nowrap">
                        <svg width={12} height={12} viewBox="-7 -7 14 14" aria-hidden>
                          <Marker shape={c.shape} color={caseColor(c.idx)} r={5} ring={false} />
                        </svg>
                        {c.bca.name}
                      </Group>
                    </Table.Td>
                    {selected.map((v) => {
                      if (useMc) {
                        const st = statFor(v, c.bca);
                        return <Table.Td key={v.id}>{st ? statsText(v, st) : '—'}</Table.Td>;
                      }
                      const e = v.get(c.bca);
                      return <Table.Td key={v.id}>{e ? rangeText(v, e) : '—'}</Table.Td>;
                    })}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        ) : (
          <div style={{ width: '100%' }}>
            <div className="pairplot-scroll" style={{ position: 'relative' }}>
              <svg
                width={LEFT + plotSize + 4}
                height={plotSize + BOTTOM}
                role="img"
                aria-label={`Pair-wise plot of ${selected.map((v) => v.label).join(', ')} across ${cases.length} business cases`}
                onMouseLeave={() => setHover(null)}
                style={{ display: 'block' }}
              >
                <g transform={`translate(${LEFT},0)`}>
                  {selected.map((vy, i) =>
                    selected.map((vx, j) => {
                      if (j > i) return null;
                      const sx = scales[j];
                      const sy = scales[i];
                      const x0 = j * cell;
                      const y0 = i * cell;
                      const isDiag = i === j;
                      return (
                        <g key={`${vy.id}-${vx.id}`}>
                          <rect
                            x={x0 + 2}
                            y={y0 + 2}
                            width={cell - 4}
                            height={cell - 4}
                            rx={4}
                            fill={isDiag ? 'var(--chart-track)' : 'none'}
                            stroke="var(--chart-grid)"
                          />
                          {/* x gridlines (shared by the column) */}
                          {sx?.ticks.map((t) => (
                            <line
                              key={`gx${t}`}
                              x1={toX(j, t)}
                              x2={toX(j, t)}
                              y1={y0 + 2}
                              y2={y0 + cell - 2}
                              stroke="var(--chart-grid)"
                            />
                          ))}
                          {!isDiag &&
                            sy?.ticks.map((t) => (
                              <line
                                key={`gy${t}`}
                                x1={x0 + 2}
                                x2={x0 + cell - 2}
                                y1={toY(i, t)}
                                y2={toY(i, t)}
                                stroke="var(--chart-grid)"
                              />
                            ))}

                          {isDiag ? (
                            <>
                              <foreignObject x={x0 + 6} y={y0 + 6} width={cell - 12} height={cell * 0.55}>
                                <div className="pairplot-diag-label">
                                  <strong>{vx.label}</strong>
                                  {vx.unit && <span> · {vx.unit}</span>}
                                  <div className="pairplot-better">
                                    {vx.better === 'higher' ? '↑ higher is better' : '↓ lower is better'}
                                  </div>
                                </div>
                              </foreignObject>
                              {sx &&
                                useMc &&
                                (() => {
                                  const base = y0 + cell - INSET;
                                  const height = cell * 0.42;
                                  const curves = visibleCases.map((c) => {
                                    const st = statFor(vx, c.bca);
                                    return { c, st, dens: st ? density(st.values, sx.min, sx.max) : null };
                                  });
                                  const peak = Math.max(1e-12, ...curves.flatMap((cv) => cv.dens ?? []));
                                  return curves.map(({ c, st, dens }) => {
                                    if (!st) return null;
                                    const hoverLines = [
                                      `${vx.label}: ${statsText(vx, st)}`,
                                      ...(st.missing > 0
                                        ? [`${st.missing} of ${st.raw.length} draws have no value${vx.id === 'payback' ? ' (never pay back in the horizon)' : ''}`]
                                        : []),
                                    ];
                                    const xm = toX(j, st.p50);
                                    if (!dens) {
                                      // Constant estimate (no range): a single tick.
                                      return (
                                        <g key={c.bca.id} onMouseEnter={(evt) => showHover(evt, c.bca, hoverLines)}>
                                          <line x1={xm} x2={xm} y1={base} y2={base - height} stroke={caseColor(c.idx)} strokeWidth={2} />
                                          <g transform={`translate(${xm},${base})`}>
                                            <Marker shape={c.shape} color={caseColor(c.idx)} r={4} />
                                          </g>
                                        </g>
                                      );
                                    }
                                    const pts = dens.map((d, g) => {
                                      const x = toX(j, sx.min + ((sx.max - sx.min) * g) / (dens.length - 1));
                                      return `${x.toFixed(1)},${(base - (d / peak) * height).toFixed(1)}`;
                                    });
                                    const xFirst = toX(j, sx.min);
                                    const xLast = toX(j, sx.max);
                                    return (
                                      <g key={c.bca.id} onMouseEnter={(evt) => showHover(evt, c.bca, hoverLines)}>
                                        <path
                                          d={`M${xFirst},${base}L${pts.join('L')}L${xLast},${base}Z`}
                                          fill={caseColor(c.idx)}
                                          fillOpacity={0.16}
                                          stroke={caseColor(c.idx)}
                                          strokeWidth={1.5}
                                        />
                                        <g transform={`translate(${xm},${base})`}>
                                          <Marker shape={c.shape} color={caseColor(c.idx)} r={4} />
                                        </g>
                                      </g>
                                    );
                                  });
                                })()}
                              {sx &&
                                !useMc &&
                                visibleCases.map((c, n) => {
                                  const e = vx.get(c.bca);
                                  if (!e) return null;
                                  const lanes = Math.max(visibleCases.length, 1);
                                  const y =
                                    y0 + cell * 0.6 + ((cell * 0.4 - INSET) * (n + 0.5)) / lanes;
                                  const x = toX(j, e.value);
                                  return (
                                    <g
                                      key={c.bca.id}
                                      onMouseEnter={(evt) => showHover(evt, c.bca, [`${vx.label}: ${rangeText(vx, e)}`])}
                                      style={{ cursor: 'default' }}
                                    >
                                      {(e.low !== null || e.high !== null) && (
                                        <line
                                          x1={toX(j, e.low ?? e.value)}
                                          x2={toX(j, e.high ?? e.value)}
                                          y1={y}
                                          y2={y}
                                          stroke={caseColor(c.idx)}
                                          strokeWidth={2}
                                          strokeLinecap="round"
                                          opacity={0.6}
                                        />
                                      )}
                                      <circle cx={x} cy={y} r={9} fill="transparent" />
                                      <g transform={`translate(${x},${y})`}>
                                        <Marker shape={c.shape} color={caseColor(c.idx)} />
                                      </g>
                                    </g>
                                  );
                                })}
                              {!sx && (
                                <text x={x0 + cell / 2} y={y0 + cell * 0.78} textAnchor="middle" className="pairplot-tick">
                                  Not scored
                                </text>
                              )}
                            </>
                          ) : useMc ? (
                            sx &&
                            sy && (
                              <>
                                {visibleCases.map((c) => {
                                  const stx = statFor(vx, c.bca);
                                  const sty = statFor(vy, c.bca);
                                  if (!stx || !sty) return null;
                                  const pts: [number, number][] = [];
                                  const n = Math.min(stx.raw.length, sty.raw.length);
                                  for (let d = 0; d < n; d += 1) {
                                    const a = stx.raw[d];
                                    const b = sty.raw[d];
                                    if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b)) continue;
                                    if (a < sx.min || a > sx.max || b < sy.min || b > sy.max) continue;
                                    pts.push([toX(j, a), toY(i, b)]);
                                  }
                                  return (
                                    <path
                                      key={`cloud-${c.bca.id}`}
                                      d={dotsPath(pts, 1.6)}
                                      fill={caseColor(c.idx)}
                                      fillOpacity={0.3}
                                      pointerEvents="none"
                                    />
                                  );
                                })}
                                {/* Medians on top of every cloud so no case hides another's marker. */}
                                {visibleCases.map((c) => {
                                  const stx = statFor(vx, c.bca);
                                  const sty = statFor(vy, c.bca);
                                  if (!stx || !sty) return null;
                                  const x = toX(j, stx.p50);
                                  const y = toY(i, sty.p50);
                                  return (
                                    <g
                                      key={`med-${c.bca.id}`}
                                      onMouseEnter={(evt) =>
                                        showHover(evt, c.bca, [
                                          `${vx.label}: ${statsText(vx, stx)}`,
                                          `${vy.label}: ${statsText(vy, sty)}`,
                                        ])
                                      }
                                    >
                                      <circle cx={x} cy={y} r={10} fill="transparent" />
                                      <g transform={`translate(${x},${y})`}>
                                        <Marker shape={c.shape} color={caseColor(c.idx)} r={5.5} />
                                      </g>
                                    </g>
                                  );
                                })}
                              </>
                            )
                          ) : (
                            sx &&
                            sy &&
                            visibleCases.map((c) => {
                              const ex = vx.get(c.bca);
                              const ey = vy.get(c.bca);
                              if (!ex || !ey) return null;
                              const x = toX(j, ex.value);
                              const y = toY(i, ey.value);
                              return (
                                <g
                                  key={c.bca.id}
                                  onMouseEnter={(evt) =>
                                    showHover(evt, c.bca, [
                                      `${vx.label}: ${rangeText(vx, ex)}`,
                                      `${vy.label}: ${rangeText(vy, ey)}`,
                                    ])
                                  }
                                >
                                  {(ex.low !== null || ex.high !== null) && (
                                    <line
                                      x1={toX(j, ex.low ?? ex.value)}
                                      x2={toX(j, ex.high ?? ex.value)}
                                      y1={y}
                                      y2={y}
                                      stroke={caseColor(c.idx)}
                                      strokeWidth={2}
                                      strokeLinecap="round"
                                      opacity={0.55}
                                    />
                                  )}
                                  {(ey.low !== null || ey.high !== null) && (
                                    <line
                                      x1={x}
                                      x2={x}
                                      y1={toY(i, ey.low ?? ey.value)}
                                      y2={toY(i, ey.high ?? ey.value)}
                                      stroke={caseColor(c.idx)}
                                      strokeWidth={2}
                                      strokeLinecap="round"
                                      opacity={0.55}
                                    />
                                  )}
                                  <circle cx={x} cy={y} r={10} fill="transparent" />
                                  <g transform={`translate(${x},${y})`}>
                                    <Marker shape={c.shape} color={caseColor(c.idx)} />
                                  </g>
                                </g>
                              );
                            })
                          )}

                          {/* y ticks on the first column (skip the diagonal cell, whose y is not a scale) */}
                          {j === 0 && !isDiag &&
                            sy?.ticks.map((t) => (
                              <text key={`ty${t}`} x={-6} y={toY(i, t) + 3} textAnchor="end" className="pairplot-tick">
                                {vy.format(t)}
                              </text>
                            ))}
                          {/* x ticks under the bottom row */}
                          {i === k - 1 &&
                            sx?.ticks.map((t) => (
                              <text key={`tx${t}`} x={toX(j, t)} y={plotSize + 14} textAnchor="middle" className="pairplot-tick">
                                {vx.format(t)}
                              </text>
                            ))}
                        </g>
                      );
                    })
                  )}
                  {/* Row labels for the y axis of each row, next to the ticks. */}
                  {selected.map((v, i) =>
                    i === 0 ? null : (
                      <Fragment key={`rl${v.id}`}>
                        <text
                          transform={`translate(${-LEFT + 9},${i * cell + cell / 2}) rotate(-90)`}
                          textAnchor="middle"
                          className="pairplot-axis-label"
                        >
                          <title>{v.label}</title>
                          {truncate(v.label, Math.floor((cell - 12) / 6.6))}
                        </text>
                      </Fragment>
                    )
                  )}
                </g>
              </svg>
              {hover && (
                <div
                  className="pairplot-tooltip"
                  style={{
                    left: Math.min(hover.left + 12, LEFT + plotSize - 200),
                    top: hover.top + 12,
                  }}
                >
                  <Text size="xs" fw={700} c="var(--text-heading)">
                    {hover.bca.name}
                  </Text>
                  {hover.lines.map((l) => (
                    <Text key={l} size="xs" c="var(--text-body)">
                      {l}
                    </Text>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </Paper>
  );
}
