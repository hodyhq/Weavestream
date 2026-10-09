'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  problemMessage,
  type IntegrationCompanyMappingDto,
  type IntegrationDifferenceRowDto,
  type IntegrationDifferencesPage,
} from '@weavestream/shared';
import { apiFetch } from '../../../../../lib/api';
import { Btn, DataTable, Field, MobileCardRow, Select, Tag, type DataColumn } from '../../../../../components/ui';
import { FormattedDateTime } from '../../../../../lib/timezone-context';
import { DifferenceActions } from '../../../../../components/integrations/integration-differences';

type Row = IntegrationDifferenceRowDto & { id: string };

function differencesPath(integrationId: string, companyId: string, cursor: string | null): string {
  const params = new URLSearchParams();
  if (companyId) params.set('companyId', companyId);
  if (cursor) params.set('cursor', cursor);
  const query = params.toString();
  return `/admin/integrations/${integrationId}/differences${query ? `?${query}` : ''}`;
}

/**
 * Every open difference of this integration: standard fields a person
 * changed that now differ from the source, across all mapped companies,
 * with the same Use source / Keep ours actions as the asset page.
 */
export function DifferencesTab({
  integrationId,
  mappings,
  sourceLabel,
}: {
  integrationId: string;
  mappings: IntegrationCompanyMappingDto[];
  sourceLabel: string;
}) {
  const [companyId, setCompanyId] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every reload so a slow page for an old filter is dropped.
  const scopeRef = useRef(0);

  const load = useCallback(async (cursor: string | null) => {
    const scope = cursor ? scopeRef.current : (scopeRef.current += 1);
    try {
      const res = await apiFetch<IntegrationDifferencesPage>(differencesPath(integrationId, companyId, cursor));
      if (scope !== scopeRef.current) return;
      setError(null);
      if (!res.ok || !res.data) {
        setError(problemMessage(res.problem) ?? 'Could not load the differences.');
        return;
      }
      const page = res.data.items.map((item) => ({ ...item, id: `${item.syncRecordId}:${item.assetFieldId}` }));
      setRows((prev) => (cursor ? [...prev, ...page] : page));
      if (!cursor) setTotal(res.data.total);
      setNextCursor(res.data.nextCursor);
    } catch {
      if (scope === scopeRef.current) setError('Could not load the differences. Check your connection and try again.');
    } finally {
      if (scope === scopeRef.current) setLoading(false);
    }
  }, [integrationId, companyId]);

  useEffect(() => {
    void (async () => {
      await load(null);
    })();
  }, [load]);

  const companies = [...new Map(mappings.map((m) => [m.companyId, m.companyName ?? m.companyId])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));

  const actions = (row: Row) => (
    <DifferenceActions
      companyId={row.companyId}
      assetId={row.assetId}
      difference={row}
      sourceLabel={sourceLabel}
      onResolved={() => void load(null)}
    />
  );
  const assetLink = (row: Row) => (
    <Link href={`/admin/companies/${row.companyId}/assets/${row.assetId}`}>{row.assetName}</Link>
  );
  const columns: DataColumn<Row>[] = [
    { id: 'asset', header: 'Asset', width: 200, render: assetLink },
    { id: 'company', header: 'Company', width: 160, render: (row) => row.companyName },
    { id: 'field', header: 'Field', width: 140, render: (row) => row.fieldLabel },
    { id: 'local', header: 'Weavestream value', width: 180, render: (row) => row.localValue ?? 'empty' },
    { id: 'source', header: `${sourceLabel} value`, width: 180, render: (row) => row.sourceValue ?? 'empty' },
    {
      id: 'detected',
      header: 'Detected',
      width: 150,
      render: (row) => <FormattedDateTime value={row.detectedAt} />,
    },
    { id: 'actions', header: '', width: 260, render: actions },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h3 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 600 }}>Differences</h3>
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)' }}>
          Fields someone changed in Weavestream that now differ from {sourceLabel}. Syncs leave them alone.
          Use the {sourceLabel} value to make the field follow {sourceLabel} again, or keep ours to stop
          flagging it until the {sourceLabel} value changes.
        </p>
      </header>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 }}>
        <Field label="Company" htmlFor="differences-company" style={{ flex: '0 1 260px', minWidth: 0 }}>
          <Select
            id="differences-company"
            value={companyId}
            onChange={(e) => {
              setLoading(true);
              setCompanyId(e.target.value);
            }}
          >
            <option value="">All companies</option>
            {companies.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        </Field>
        {total !== null && <Tag tone={total > 0 ? 'warn' : 'ok'}>{`${total} open`}</Tag>}
      </div>
      {error && <Tag tone="danger">{error}</Tag>}
      <DataTable
        columns={columns}
        rows={rows}
        empty={loading ? 'Loading differences...' : 'No open differences.'}
        disableSort
        renderMobileCard={(row) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <MobileCardRow label="Asset">{assetLink(row)}</MobileCardRow>
            <MobileCardRow label="Company">{row.companyName}</MobileCardRow>
            <MobileCardRow label="Field">{row.fieldLabel}</MobileCardRow>
            <MobileCardRow label="Weavestream">{row.localValue ?? 'empty'}</MobileCardRow>
            <MobileCardRow label={sourceLabel}>{row.sourceValue ?? 'empty'}</MobileCardRow>
            <div style={{ paddingTop: 4 }}>{actions(row)}</div>
          </div>
        )}
      />
      {nextCursor && (
        <div>
          <Btn
            onClick={() => {
              setLoading(true);
              void load(nextCursor);
            }}
            loading={loading}
          >
            Load more
          </Btn>
        </div>
      )}
    </div>
  );
}
