import type { MonitoredDomain } from '@prisma/client';
import type { CloudflareRegistrarDomain } from '../drivers/cloudflare/cloudflare-api.client.js';
import { CloudflareRegistrarSyncService, pickRow } from './cloudflare-registrar-sync.service.js';

const INT = 'int-1';
const HODY = 'co-hody';

function row(p: Partial<MonitoredDomain>): MonitoredDomain {
  return {
    id: p.id ?? `d-${Math.random()}`,
    companyId: HODY,
    hostname: 'example.com',
    source: 'MANUAL',
    integrationId: null,
    archivedAt: null,
    registrarMissingSince: null,
    ...p,
  } as MonitoredDomain;
}

function cf(name: string, p: Partial<CloudflareRegistrarDomain> = {}): CloudflareRegistrarDomain {
  return {
    name,
    cloudflareRegistration: true,
    registrar: 'Cloudflare',
    autoRenew: true,
    locked: true,
    registeredAt: new Date('2020-01-01'),
    expiresAt: new Date('2027-01-01'),
    registryStatuses: ['clientTransferProhibited'],
    nameservers: ['a.ns.cloudflare.com'],
    hasZone: true,
    ...p,
  };
}

function harness(opts: {
  rows: MonitoredDomain[];
  cfDomains: CloudflareRegistrarDomain[];
  slug?: string;
}) {
  const rows = opts.rows;
  const matches = (r: MonitoredDomain, w: Record<string, unknown>) =>
    Object.entries(w).every(([k, v]) => (r as never)[k] === v);
  const prisma = {
    integration: {
      findUnique: jest.fn(async () => ({ id: INT, driver: 'cloudflare', status: 'ACTIVE' })),
    },
    company: { findUnique: jest.fn(async () => ({ id: HODY, archivedAt: null })) },
    monitoredDomain: {
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((r) => matches(r, where)),
      ),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: object }) => {
        const r = rows.find((x) => x.id === where.id)!;
        Object.assign(r, data);
        return r;
      }),
      create: jest.fn(async ({ data }: { data: Partial<MonitoredDomain> }) => {
        const r = row({ id: `new-${rows.length}`, ...data });
        rows.push(r);
        return r;
      }),
      updateMany: jest.fn(
        async ({ where, data }: { where: { id: { in: string[] } }; data: object }) => {
          for (const r of rows) if (where.id.in.includes(r.id)) Object.assign(r, data);
          return { count: where.id.in.length };
        },
      ),
    },
  };
  const integrations = {
    loadDriverContext: jest.fn(async () => ({
      config: { accountId: 'acct', domainsCompanySlug: opts.slug ?? 'hody' },
      secret: { apiToken: 't' },
    })),
  };
  const driver = { listRegistrarDomains: jest.fn(async () => opts.cfDomains) };
  const drivers = { getSecurity: jest.fn(() => driver) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const env = {
    values: {
      INTEGRATION_HTTP_TIMEOUT_MS: 1000,
      INTEGRATION_HTTP_MAX_RETRIES: 0,
      INTEGRATION_HTTP_BACKOFF_MS: 0,
    },
  };
  const kv = new Map<string, string>();
  const redis = {
    client: {
      set: jest.fn(async (k: string, v: string, ..._rest: unknown[]) => {
        if (kv.has(k)) return null;
        kv.set(k, v);
        return 'OK';
      }),
      // Mirrors the compare-and-delete Lua script.
      eval: jest.fn(async (_script: string, _n: number, k: string, token: string) =>
        kv.get(k) === token ? (kv.delete(k), 1) : 0,
      ),
    },
  };
  const svc = new CloudflareRegistrarSyncService(
    prisma as never,
    integrations as never,
    drivers as never,
    audit as never,
    env as never,
    redis as never,
  );
  return { svc, rows, audit, driver, kv };
}

describe('pickRow', () => {
  it('prefers the row this integration owns, then default-company MANUAL, then any MANUAL', () => {
    const owned = row({ id: 'owned', source: 'CLOUDFLARE', integrationId: INT, companyId: 'co-client' });
    const manualHody = row({ id: 'mh' });
    const manualClient = row({ id: 'mc', companyId: 'co-client' });
    expect(pickRow([manualClient, manualHody, owned], INT, HODY)?.id).toBe('owned');
    expect(pickRow([manualClient, manualHody], INT, HODY)?.id).toBe('mh');
    expect(pickRow([manualClient], INT, HODY)?.id).toBe('mc');
  });

  it('never takes a row another Cloudflare integration owns', () => {
    const other = row({ source: 'CLOUDFLARE', integrationId: 'int-2' });
    expect(pickRow([other], INT, HODY)).toBeUndefined();
  });
});

describe('CloudflareRegistrarSyncService.sync', () => {
  it('is a no-op when no domains company is configured', async () => {
    const { svc, driver } = harness({ rows: [], cfDomains: [], slug: '' });
    await expect(svc.sync(INT, null)).resolves.toMatchObject({ enabled: false });
    expect(driver.listRegistrarDomains).not.toHaveBeenCalled();
  });

  it('creates new domains in the default company, adopts manual rows, and leaves company assignment alone', async () => {
    const moved = row({
      id: 'moved',
      hostname: 'client.com',
      companyId: 'co-client',
      source: 'CLOUDFLARE',
      integrationId: INT,
    });
    const manual = row({ id: 'manual', hostname: 'acme.dev' });
    const { svc, rows } = harness({
      rows: [moved, manual],
      cfDomains: [cf('client.com'), cf('acme.dev'), cf('New.Example.ORG')],
    });

    const res = await svc.sync(INT, 'u-1');

    expect(res).toEqual({ enabled: true, created: 1, updated: 1, adopted: 1, missing: 0 });
    expect(moved.companyId).toBe('co-client');
    expect(manual).toMatchObject({ source: 'CLOUDFLARE', integrationId: INT, registrarAutoRenew: true });
    const created = rows.find((r) => r.hostname === 'new.example.org');
    expect(created).toMatchObject({ companyId: HODY, source: 'CLOUDFLARE', createdBy: 'u-1' });
  });

  it('stamps missing once and never deletes', async () => {
    const gone = row({ id: 'gone', hostname: 'old.com', source: 'CLOUDFLARE', integrationId: INT });
    const { svc, rows } = harness({ rows: [gone], cfDomains: [] });

    await expect(svc.sync(INT, null)).resolves.toMatchObject({ missing: 1 });
    const stamped = gone.registrarMissingSince;
    expect(stamped).toBeInstanceOf(Date);
    expect(rows).toHaveLength(1);

    // A later sweep must not move the date forward.
    await expect(svc.sync(INT, null)).resolves.toMatchObject({ missing: 0 });
    expect(gone.registrarMissingSince).toBe(stamped);
  });

  it('clears the missing stamp when the domain comes back', async () => {
    const back = row({
      hostname: 'back.com',
      source: 'CLOUDFLARE',
      integrationId: INT,
      registrarMissingSince: new Date('2026-01-01'),
    });
    const { svc } = harness({ rows: [back], cfDomains: [cf('back.com')] });
    await svc.sync(INT, null);
    expect(back.registrarMissingSince).toBeNull();
  });

  it('skips a hostname another Cloudflare integration already owns instead of duplicating it', async () => {
    const theirs = row({ hostname: 'shared.com', source: 'CLOUDFLARE', integrationId: 'int-2' });
    const { svc, rows } = harness({ rows: [theirs], cfDomains: [cf('shared.com')] });
    await expect(svc.sync(INT, null)).resolves.toMatchObject({ created: 0, updated: 0 });
    expect(rows).toHaveLength(1);
  });

  it('audits one summary row by hostname, with no token or account secrets', async () => {
    const { svc, audit } = harness({ rows: [], cfDomains: [cf('a.com')] });
    await svc.sync(INT, null);
    const entry = audit.log.mock.calls[0][0];
    expect(entry).toMatchObject({
      action: 'integration.cloudflare.registrar_sync',
      entityId: INT,
      after: expect.objectContaining({ createdHostnames: ['a.com'] }),
    });
    expect(JSON.stringify(entry)).not.toContain('apiToken');
  });

  it('refuses to run twice at once for one integration, and releases the lock after', async () => {
    const { svc, kv } = harness({ rows: [], cfDomains: [cf('a.com')] });
    kv.set(`lock:cf-registrar-sync:${INT}`, 'someone-else');
    await expect(svc.sync(INT, null)).rejects.toThrow(/already running/);
    // The other run's lock is untouched.
    expect(kv.get(`lock:cf-registrar-sync:${INT}`)).toBe('someone-else');

    kv.clear();
    await svc.sync(INT, null);
    expect(kv.size).toBe(0);
  });
});
