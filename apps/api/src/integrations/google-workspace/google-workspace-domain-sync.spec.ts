import { Logger } from '@nestjs/common';
import { Prisma, type MonitoredDomain } from '@prisma/client';
import { DriverAuthError } from '../drivers/integration-driver.js';
import type { WorkspaceDomain } from '../drivers/google-workspace/google-workspace.driver.js';
import {
  GoogleWorkspaceDomainSyncService,
  matchWorkspaceRow,
  workspaceDomainSyncWarning,
} from './google-workspace-domain-sync.service.js';

const mockListWorkspaceDomains = jest.fn<Promise<WorkspaceDomain[]>, unknown[]>();
jest.mock('../drivers/google-workspace/google-workspace.driver.js', () => ({
  listWorkspaceDomains: (...args: unknown[]) => mockListWorkspaceDomains(...args),
}));

const INT = 'int-google';
const MAPPING = 'map-1';
const CO = '00000000-0000-4000-8000-0000000000aa';
const OTHER = '00000000-0000-4000-8000-0000000000bb';

function row(p: Partial<MonitoredDomain>): MonitoredDomain {
  return {
    id: p.id ?? `d-${Math.random()}`,
    companyId: CO,
    hostname: 'example.com',
    source: 'MANUAL',
    integrationId: null,
    archivedAt: null,
    checkWhois: true,
    registrar: null,
    registrarMissingSince: null,
    workspaceIntegrationId: null,
    workspaceRole: null,
    workspaceAliasOf: null,
    workspaceSyncedAt: null,
    workspaceMissingSince: null,
    ...p,
  } as MonitoredDomain;
}

const ws = (hostname: string, role: WorkspaceDomain['role'] = 'SECONDARY', aliasOf: string | null = null): WorkspaceDomain => ({
  hostname,
  role,
  aliasOf,
});

/** Postgres advisory locks: `$executeRaw` in a transaction waits for the key. */
function advisoryLocks() {
  const held = new Map<string, Promise<void>>();
  return {
    async acquire(key: string): Promise<() => void> {
      while (held.has(key)) await held.get(key);
      let release!: () => void;
      held.set(key, new Promise<void>((r) => (release = r)));
      return () => {
        held.delete(key);
        release();
      };
    },
  };
}

function matches(r: object, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    const actual = (r as Record<string, unknown>)[k];
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const op = v as { in?: unknown[]; equals?: string; mode?: string };
      if (op.in) return op.in.includes(actual);
      if (op.equals !== undefined) {
        return op.mode === 'insensitive'
          ? String(actual).toLowerCase() === op.equals.toLowerCase()
          : actual === op.equals;
      }
    }
    return actual === v;
  });
}

function harness(rows: MonitoredDomain[], opts: { companyId?: string; uniqueViolation?: boolean } = {}) {
  const locks = advisoryLocks();
  const tick = () => new Promise((r) => setImmediate(r));
  const monitoredDomain = {
    findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      await tick();
      return rows.filter((r) => matches(r, where));
    }),
    updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: object }) => {
      const hits = rows.filter((r) => matches(r, where));
      for (const r of hits) Object.assign(r, data);
      return { count: hits.length };
    }),
    create: jest.fn(async ({ data }: { data: Partial<MonitoredDomain> }) => {
      await tick();
      // The partial unique index (company_id, hostname) WHERE archived_at IS NULL.
      if (opts.uniqueViolation || rows.some((r) => r.companyId === data.companyId && r.hostname === data.hostname && !r.archivedAt)) {
        throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });
      }
      const r = row({ id: `new-${rows.length}`, ...data });
      rows.push(r);
      return r;
    }),
  };
  const prisma = {
    integrationCompanyMapping: {
      findUnique: jest.fn(async () => ({
        id: MAPPING,
        companyId: opts.companyId ?? CO,
        externalOrgId: 'C0example1',
        integrationId: INT,
        integration: { driver: 'google-workspace' },
        company: { archivedAt: null },
      })),
    },
    monitoredDomain,
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const releases: Array<() => void> = [];
      const tx = {
        monitoredDomain,
        $executeRaw: jest.fn(async (_sql: TemplateStringsArray, ...values: unknown[]) => {
          releases.push(await locks.acquire(values.join('|')));
          return 1;
        }),
      };
      try {
        return await fn(tx);
      } finally {
        for (const release of releases) release();
      }
    }),
  };
  const integrations = { loadDriverContext: jest.fn(async () => ({ config: {}, secret: {}, integrationId: INT })) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const env = { values: { INTEGRATION_HTTP_TIMEOUT_MS: 1000, INTEGRATION_HTTP_MAX_RETRIES: 0, INTEGRATION_HTTP_BACKOFF_MS: 0 } };
  const enqueueDomainCheck = jest.fn().mockResolvedValue('job-1');
  const svc = new GoogleWorkspaceDomainSyncService(
    prisma as never,
    integrations as never,
    audit as never,
    env as never,
    { enqueueDomainCheck } as never,
  );
  return { svc, rows, audit, enqueueDomainCheck, monitoredDomain };
}

beforeEach(() => {
  mockListWorkspaceDomains.mockReset();
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

describe('matchWorkspaceRow', () => {
  it('matches the active row, skips when only archived rows exist, creates otherwise', () => {
    const active = row({ id: 'a' });
    const archived = row({ id: 'x', archivedAt: new Date() });
    expect(matchWorkspaceRow([archived, active])).toEqual({ kind: 'match', row: active });
    expect(matchWorkspaceRow([archived])).toEqual({ kind: 'skip', reason: 'archived' });
    expect(matchWorkspaceRow([])).toEqual({ kind: 'create' });
  });
});

describe('GoogleWorkspaceDomainSyncService.syncMapping', () => {
  it('matches existing rows case-insensitively and writes only the workspace columns', async () => {
    const cloudflare = row({
      id: 'cf',
      hostname: 'example.com',
      source: 'CLOUDFLARE',
      integrationId: 'int-cf',
      registrar: 'Cloudflare',
      checkWhois: false,
    });
    const manual = row({ id: 'manual', hostname: 'Example.ORG' });
    const { svc, rows, enqueueDomainCheck } = harness([cloudflare, manual]);
    mockListWorkspaceDomains.mockResolvedValue([ws('example.com', 'PRIMARY'), ws('example.org', 'ALIAS', 'example.com')]);

    await expect(svc.syncMapping(MAPPING, 'u-1')).resolves.toEqual({ created: 0, matched: 2, missing: 0, skipped: 0 });

    expect(rows).toHaveLength(2);
    // Cloudflare keeps everything it owns; only the workspace columns change.
    expect(cloudflare).toMatchObject({
      source: 'CLOUDFLARE',
      integrationId: 'int-cf',
      registrar: 'Cloudflare',
      checkWhois: false,
      workspaceIntegrationId: INT,
      workspaceRole: 'PRIMARY',
      workspaceAliasOf: null,
      workspaceMissingSince: null,
    });
    expect(cloudflare.workspaceSyncedAt).toBeInstanceOf(Date);
    expect(manual).toMatchObject({ source: 'MANUAL', integrationId: null, workspaceRole: 'ALIAS', workspaceAliasOf: 'example.com' });
    expect(enqueueDomainCheck).not.toHaveBeenCalled();
  });

  it('accepts a trailing dot and odd case from Google as the same hostname', async () => {
    const manual = row({ id: 'manual', hostname: 'example.com' });
    const { svc, rows } = harness([manual]);
    // The driver normalizes; the service still parses through the hostname schema.
    mockListWorkspaceDomains.mockResolvedValue([ws('EXAMPLE.com', 'PRIMARY')]);
    await svc.syncMapping(MAPPING, 'u-1');
    expect(rows).toHaveLength(1);
    expect(manual.workspaceRole).toBe('PRIMARY');
  });

  it('leaves an archived row alone and does not create a duplicate beside it', async () => {
    const archivedAt = new Date('2026-01-01');
    const archived = row({ id: 'arch', hostname: 'example.net', archivedAt });
    const { svc, rows } = harness([archived]);
    mockListWorkspaceDomains.mockResolvedValue([ws('example.net')]);

    await expect(svc.syncMapping(MAPPING, 'u-1')).resolves.toMatchObject({ skipped: 1, created: 0 });
    expect(rows).toHaveLength(1);
    expect(archived).toMatchObject({ archivedAt, workspaceRole: null, workspaceIntegrationId: null });
  });

  it('creates an unmatched domain in the mapped company and queues its first check', async () => {
    const { svc, rows, enqueueDomainCheck } = harness([]);
    mockListWorkspaceDomains.mockResolvedValue([ws('example.com', 'PRIMARY')]);

    await expect(svc.syncMapping(MAPPING, 'u-1')).resolves.toMatchObject({ created: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId: CO,
      hostname: 'example.com',
      source: 'GOOGLE_WORKSPACE',
      integrationId: INT,
      workspaceIntegrationId: INT,
      workspaceRole: 'PRIMARY',
      createdBy: 'u-1',
    });
    expect(enqueueDomainCheck).toHaveBeenCalledWith({ kind: 'single', domainId: rows[0]!.id, actorId: 'u-1' });
  });

  it('never creates duplicates when two runs overlap', async () => {
    const { svc, rows } = harness([]);
    mockListWorkspaceDomains.mockResolvedValue([ws('example.com', 'PRIMARY')]);
    await Promise.all([svc.syncMapping(MAPPING, 'u-1'), svc.syncMapping(MAPPING, null)]);
    expect(rows.filter((r) => r.hostname === 'example.com')).toHaveLength(1);
  });

  it('skips a domain added by hand mid-run instead of failing (unique index)', async () => {
    const { svc, rows } = harness([], { uniqueViolation: true });
    mockListWorkspaceDomains.mockResolvedValue([ws('example.com')]);
    await expect(svc.syncMapping(MAPPING, 'u-1')).resolves.toMatchObject({ skipped: 1, created: 0 });
    expect(rows).toHaveLength(0);
  });

  it('only ever touches the mapped company (tenant isolation)', async () => {
    const elsewhere = row({ id: 'other', companyId: OTHER, hostname: 'example.com' });
    const elsewhereLinked = row({ id: 'other-linked', companyId: OTHER, hostname: 'gone.example', workspaceIntegrationId: INT, workspaceRole: 'SECONDARY' });
    const { svc, rows } = harness([elsewhere, elsewhereLinked]);
    mockListWorkspaceDomains.mockResolvedValue([ws('example.com', 'PRIMARY')]);

    await svc.syncMapping(MAPPING, 'u-1');
    expect(elsewhere.workspaceRole).toBeNull();
    // The other company's linked row is not stamped missing by this mapping.
    expect(elsewhereLinked).toMatchObject({ workspaceRole: 'SECONDARY', workspaceMissingSince: null });
    expect(rows.filter((r) => r.companyId === CO)).toHaveLength(1);
  });

  it('stamps a domain that left Workspace once, clears its role, and never deletes it', async () => {
    const gone = row({ id: 'gone', hostname: 'old.example', source: 'GOOGLE_WORKSPACE', integrationId: INT, workspaceIntegrationId: INT, workspaceRole: 'ALIAS', workspaceAliasOf: 'example.com' });
    const { svc, rows } = harness([gone]);
    mockListWorkspaceDomains.mockResolvedValue([]);

    await expect(svc.syncMapping(MAPPING, null)).resolves.toMatchObject({ missing: 1 });
    expect(rows).toHaveLength(1);
    expect(gone).toMatchObject({ workspaceRole: null, workspaceAliasOf: null });
    const stamped = gone.workspaceMissingSince;
    expect(stamped).toBeInstanceOf(Date);

    await expect(svc.syncMapping(MAPPING, null)).resolves.toMatchObject({ missing: 0 });
    expect(gone.workspaceMissingSince).toBe(stamped);

    // It comes back: role restored, stamp cleared.
    mockListWorkspaceDomains.mockResolvedValue([ws('old.example', 'SECONDARY')]);
    await svc.syncMapping(MAPPING, null);
    expect(gone).toMatchObject({ workspaceRole: 'SECONDARY', workspaceMissingSince: null });
  });

  it('audits the run against the mapping and its company', async () => {
    const { svc, audit } = harness([]);
    mockListWorkspaceDomains.mockResolvedValue([ws('example.com', 'PRIMARY')]);
    await svc.syncMapping(MAPPING, 'u-1');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'integration.google_workspace.domain_sync',
      entityId: MAPPING,
      companyId: CO,
      after: expect.objectContaining({ created: 1, createdHostnames: ['example.com'] }),
    }));
  });
});

describe('workspaceDomainSyncWarning', () => {
  it('keeps driver messages and hides anything else', () => {
    expect(workspaceDomainSyncWarning(new DriverAuthError('Wrong tenant.'))).toContain('Wrong tenant.');
    const internal = workspaceDomainSyncWarning(new Error('relation "x" does not exist'));
    expect(internal).not.toContain('relation');
    expect(internal).toContain('internal error');
  });
});
