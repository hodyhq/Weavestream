'use client';

import { useState } from 'react';
import type { IntegrationDto } from '@weavestream/shared';
import { apiFetch } from '../../../../../../lib/api';
import { Btn, Tag, useToast } from '../../../../../../components/ui';

type SyncResult = {
  enabled: boolean;
  created: number;
  updated: number;
  adopted: number;
  missing: number;
};

/**
 * Domains tab for a Cloudflare integration. The registrar sync runs on the
 * integration's schedule; this is the "do it now" button plus the setting it
 * depends on, so an operator never wonders why nothing appeared.
 */
export function DomainsSyncTab({ integration }: { integration: IntegrationDto }) {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [last, setLast] = useState<SyncResult | null>(null);
  const slug = (integration.config as { domainsCompanySlug?: string } | null)?.domainsCompanySlug;

  async function sync(): Promise<void> {
    setPending(true);
    const res = await apiFetch<SyncResult>(
      `/admin/integrations/${integration.id}/cloudflare/domains/sync`,
      { method: 'POST' },
    );
    setPending(false);
    if (!res.ok || !res.data) {
      const problem = res.problem as { detail?: string; title?: string } | undefined;
      toast.push(problem?.detail ?? problem?.title ?? 'Domain sync failed.', 'danger');
      return;
    }
    setLast(res.data);
    if (res.data.enabled) toast.push('Domains synced from Cloudflare.', 'ok');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 640 }}>
      <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13, lineHeight: 1.5 }}>
        Every domain on this Cloudflare account is kept in Domains with its registration,
        expiry, auto-renew and nameservers, marked with an orange{' '}
        <Tag tone="cloudflare">Cloudflare</Tag> tag. New domains are filed under the company
        set in Credentials; a domain you move to another company stays there. Nothing is
        ever deleted: a domain that leaves the account is flagged instead.
      </p>
      {slug ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Btn onClick={() => void sync()} disabled={pending}>
            {pending ? 'Syncing…' : 'Sync domains now'}
          </Btn>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>
            New domains go to <code>{slug}</code>
          </span>
        </div>
      ) : (
        <Tag tone="warn">
          Off. Set “Sync domains into company” under Credentials to turn it on.
        </Tag>
      )}
      {last?.enabled && (
        <div style={{ fontSize: 13, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <span>{last.created} new</span>
          <span>{last.updated} updated</span>
          <span>{last.adopted} taken over from manual entries</span>
          <span>{last.missing} no longer on the account</span>
        </div>
      )}
    </div>
  );
}
