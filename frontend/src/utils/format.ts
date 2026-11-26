import type { ZodTypeAny } from 'zod';
import type { UncertaintySpec } from '../types/api';

export function formatCompactCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  if (abs >= 1_000) return `${sign}$${Math.round(abs).toLocaleString('en-US')}`;
  return `${sign}$${abs.toFixed(0)}`;
}

export function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.round(Math.abs(value)).toLocaleString('en-US')}`;
}

export function formatPercent(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function formatRatio(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
  return `${value.toFixed(2)}x`;
}

export function formatPayback(years: number | null | undefined): string {
  if (years === null || years === undefined || !Number.isFinite(years)) return 'No payback';
  if (years === 0) return 'Immediate';
  return `${years.toFixed(1)} yrs`;
}

export function summarizeUncertainty(spec: UncertaintySpec | null | undefined): string {
  if (!spec) return 'Deterministic';
  const parts: string[] = [];
  if (spec.item_multiplier && spec.item_multiplier.distribution !== 'fixed') {
    parts.push(`Item: ${spec.item_multiplier.distribution}`);
  }
  const paramCount = Object.values(spec.parameters || {}).filter(
    (d) => d && d.distribution !== 'fixed'
  ).length;
  if (paramCount > 0) {
    parts.push(`${paramCount} param${paramCount > 1 ? 's' : ''}`);
  }
  if (spec.correlation_group) {
    parts.push(`ρ:${spec.correlation_group}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'Deterministic';
}

export function zodFormValidate<T extends Record<string, unknown>>(schema: ZodTypeAny) {
  return (values: T): Record<string, string> => {
    const res = schema.safeParse(values);
    if (res.success) return {};
    const errors: Record<string, string> = {};
    for (const issue of res.error.issues) {
      const path = issue.path.join('.');
      if (path && !errors[path]) {
        errors[path] = issue.message;
      }
    }
    return errors;
  };
}

export function isValidHttpUrl(raw: string): boolean {
  const cleaned = raw.trim();
  if (!cleaned) return false;
  try {
    const parsed = new URL(cleaned);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.host);
  } catch {
    return false;
  }
}

export function formatYearLabel(
  year: number,
  costStartYear?: number | null,
  mode: 'short' | 'full' = 'full'
): string {
  if (costStartYear == null) return `Y${year}`;
  const calYear = costStartYear + year - 1;
  return mode === 'short' ? String(calYear) : `Y${year} (${calYear})`;
}

export function formatYearRange(
  startYear: number,
  endYear: number,
  costStartYear?: number | null
): string {
  const rel = startYear === endYear ? `Y${startYear}` : `Y${startYear}–Y${endYear}`;
  if (costStartYear == null) return rel;
  const calStart = costStartYear + startYear - 1;
  const calEnd = costStartYear + endYear - 1;
  const cal = startYear === endYear ? String(calStart) : `${calStart}–${calEnd}`;
  return `${rel} (${cal})`;
}

export const DOMAIN_OPTIONS = [
  { value: 'software', label: 'Software Delivery' },
  { value: 'automation', label: 'Automation' },
  { value: 'capability', label: 'Shared Capability' },
  { value: 'infrastructure', label: 'Infrastructure & Cloud' },
  { value: 'operations', label: 'Operations & SRE' },
  { value: 'energy', label: 'Energy & Utilities' },
];
