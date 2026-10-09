import type { IntegrationSectionGroup, IntegrationSectionRow } from '@weavestream/shared';

/**
 * Row builders shared by the drivers that emit integration sections
 * (integrationSectionSchema). Each returns null for a missing value, so a
 * group simply drops it; strings are cleaned to the plain text the schema
 * accepts.
 */

export type Row = IntegrationSectionRow | null;

/** A lookup that may be unavailable (missing permission, API off, too large); the reason is fixed text. */
export type Lookup<T> = { ok: true; value: T } | { ok: false; reason: string };

const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Plain text the section schema accepts: no controls, nothing tag-shaped, capped. */
export function clean(value: string, max: number): string {
  return value.replace(CONTROL_RE, '').replace(/<(?=[a-z!/?])/gi, '< ').slice(0, max);
}

export function text(label: string, value: string | null | undefined): Row {
  return value ? { kind: 'text', label, value: clean(value, 1_000) } : null;
}

export function num(label: string, value: number | null | undefined): Row {
  return typeof value === 'number' && Number.isFinite(value) ? { kind: 'number', label, value } : null;
}

export function bool(label: string, value: boolean | null | undefined): Row {
  return typeof value === 'boolean' ? { kind: 'boolean', label, value } : null;
}

export function badge(label: string, value: string, tone: 'neutral' | 'success' | 'warning' | 'danger'): Row {
  return { kind: 'badge', label, value: clean(value, 64), tone };
}

/** ISO string, or an epoch-milliseconds string, as an ISO datetime. */
export function toIso(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' || /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function datetime(label: string, value: string | number | null | undefined): Row {
  const iso = toIso(value);
  return iso ? { kind: 'datetime', label, value: iso } : null;
}

export function date(label: string, value: string | number | null | undefined): Row {
  const iso = toIso(value);
  return iso ? { kind: 'date', label, value: iso.slice(0, 10) } : null;
}

export function list(label: string, values: string[]): Row {
  return { kind: 'list', label, value: values.slice(0, 50).map((value) => clean(value, 200)) };
}


export function group(
  key: string,
  title: string,
  icon: IntegrationSectionGroup['icon'],
  rows: Row[],
): IntegrationSectionGroup {
  return { key, title, ...(icon ? { icon } : {}), rows: rows.filter((row): row is IntegrationSectionRow => row !== null).slice(0, 40) };
}

