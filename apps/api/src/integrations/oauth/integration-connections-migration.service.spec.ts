import { Logger } from '@nestjs/common';
import {
  integrationConnectionSecretAad,
  integrationOAuthAppSecretAad,
  integrationSecretAad,
  legacyIntegrationOAuthAppSecretAad,
} from '../../crypto/integration-secret-encryption.service.js';
import { IntegrationConnectionsMigrationService } from './integration-connections-migration.service.js';
import { IntegrationOAuthAppService } from './integration-oauth-app.service.js';

const GW = '00000000-0000-4000-8000-0000000000a1';
const MS = '00000000-0000-4000-8000-0000000000b1';
const MS_SECOND = '00000000-0000-4000-8000-0000000000b2';
const RMM = '00000000-0000-4000-8000-0000000000c1';
const TENANT = '11111111-2222-4333-8444-555555555555';

const crypto = {
  encrypt: (plaintext: string, aad: string) => `enc[${aad}]${plaintext}`,
  decrypt: (blob: string, aad: string) => {
    const prefix = `enc[${aad}]`;
    if (!blob.startsWith(prefix)) throw new Error('aad mismatch');
    return blob.slice(prefix.length);
  },
};

const DRIVERS = [
  { key: 'google-workspace', oauth: { provider: 'google', scopes: [] } },
  { key: 'microsoft-365', oauth: { provider: 'microsoft', scopes: [], consentFlow: 'admin_consent' } },
  { key: 'level' },
];

interface Integration {
  id: string;
  driver: string;
  createdAt: Date;
  secret: { id: string; ciphertext: string } | null;
}

function fakeDb(input: {
  integrations: Integration[];
  apps: Array<{ id: string; provider: string; integrationId: string | null; secretCiphertext: string }>;
  mappings: Array<{ integrationId: string; externalOrgId: string; externalOrgName: string | null }>;
}) {
  const connections: Array<Record<string, unknown>> = [];
  const db = {
    $executeRaw: jest.fn(async () => 1),
    integration: {
      findMany: jest.fn(async ({ where }: { where: { driver: { in: string[] } } }) =>
        input.integrations
          .filter((i) => where.driver.in.includes(i.driver))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((i) => ({ id: i.id, secret: i.secret }))),
    },
    integrationOAuthApp: {
      findFirst: jest.fn(async ({ where }: { where: { provider: string; integrationId: null } }) =>
        input.apps.find((a) => a.provider === where.provider && a.integrationId === null) ?? null),
      updateMany: jest.fn(async ({ where, data }: { where: { id: string }; data: { integrationId: string; secretCiphertext: string } }) => {
        const app = input.apps.find((a) => a.id === where.id && a.integrationId === null);
        if (!app) return { count: 0 };
        Object.assign(app, data);
        return { count: 1 };
      }),
    },
    integrationCompanyMapping: {
      findMany: jest.fn(async ({ where }: { where: { integrationId: string } }) =>
        input.mappings.filter((m) => m.integrationId === where.integrationId)),
    },
    integrationConnection: {
      findUnique: jest.fn(async ({ where }: { where: { integrationId_externalOrgId: { integrationId: string; externalOrgId: string } } }) =>
        connections.find((c) => c.integrationId === where.integrationId_externalOrgId.integrationId
          && c.externalOrgId === where.integrationId_externalOrgId.externalOrgId) ?? null),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        connections.push(data);
        return data;
      }),
    },
    integrationSecret: {
      deleteMany: jest.fn(async ({ where }: { where: { id: string } }) => {
        for (const i of input.integrations) if (i.secret?.id === where.id) i.secret = null;
        return { count: 1 };
      }),
    },
  };
  const prisma = { ...db, $transaction: jest.fn(async (fn: (tx: typeof db) => Promise<void>) => fn(db)) };
  return { prisma, connections, db };
}

function service(prisma: unknown) {
  const drivers = { list: () => DRIVERS };
  const audit = { log: jest.fn(async () => undefined) };
  const apps = new IntegrationOAuthAppService(prisma as never, crypto as never, audit as never, {} as never, drivers as never);
  return { svc: new IntegrationConnectionsMigrationService(prisma as never, crypto as never, drivers as never, apps, audit as never), audit };
}

const googleGrant = { refreshToken: 'test-refresh-gw', grantedScopes: ['scope.read'], connectedAs: 'admin@example.test', connectedAt: '2026-09-01T00:00:00.000Z' };
const consent = { tenantId: TENANT, tenantName: 'Example Tenant', grantedRoles: ['User.Read.All'], consentedAt: '2026-09-02T00:00:00.000Z', reportNames: 'shown' };

function opsLike() {
  return fakeDb({
    integrations: [
      { id: GW, driver: 'google-workspace', createdAt: new Date('2026-08-01'), secret: { id: 's-gw', ciphertext: crypto.encrypt(JSON.stringify(googleGrant), integrationSecretAad(GW)) } },
      { id: MS, driver: 'microsoft-365', createdAt: new Date('2026-08-02'), secret: { id: 's-ms', ciphertext: crypto.encrypt(JSON.stringify(consent), integrationSecretAad(MS)) } },
      { id: RMM, driver: 'level', createdAt: new Date('2026-08-03'), secret: { id: 's-rmm', ciphertext: crypto.encrypt('{"apiKey":"test-key"}', integrationSecretAad(RMM)) } },
    ],
    apps: [
      { id: 'app-g', provider: 'google', integrationId: null, secretCiphertext: crypto.encrypt('test-google-secret', legacyIntegrationOAuthAppSecretAad('google')) },
      { id: 'app-m', provider: 'microsoft', integrationId: null, secretCiphertext: crypto.encrypt('test-ms-secret', legacyIntegrationOAuthAppSecretAad('microsoft')) },
    ],
    mappings: [
      { integrationId: GW, externalOrgId: 'C0example1', externalOrgName: 'example.com' },
      { integrationId: MS, externalOrgId: TENANT, externalOrgName: 'Example Tenant' },
    ],
  });
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

describe('IntegrationConnectionsMigrationService', () => {
  it('moves the Google and Microsoft grants into connections and attaches the apps, under a lock', async () => {
    const fake = opsLike();
    const { svc, audit } = service(fake.prisma);
    const report = await svc.run();

    expect(fake.db.$executeRaw).toHaveBeenCalled();
    expect(report.appsAdopted.sort()).toEqual([GW, MS].sort());
    expect(report.skipped).toEqual([]);
    // One pass per OAuth provider; non-OAuth drivers are never queried.
    expect(fake.db.integration.findMany).toHaveBeenCalledTimes(2);

    const gw = fake.connections.find((c) => c.integrationId === GW)!;
    expect(gw).toMatchObject({ externalOrgId: 'C0example1', displayName: 'example.com', status: 'ok' });
    expect(JSON.parse(crypto.decrypt(gw.secretCiphertext as string, integrationConnectionSecretAad(GW, gw.id as string)))).toEqual(googleGrant);
    expect(gw.connectedAt).toEqual(new Date('2026-09-01T00:00:00.000Z'));

    const ms = fake.connections.find((c) => c.integrationId === MS)!;
    expect(ms).toMatchObject({ externalOrgId: TENANT, displayName: 'Example Tenant' });
    // The report-names choice travels with the consent.
    expect(JSON.parse(crypto.decrypt(ms.secretCiphertext as string, integrationConnectionSecretAad(MS, ms.id as string)))).toMatchObject({ reportNames: 'shown' });

    expect(fake.db.integrationSecret.deleteMany).toHaveBeenCalledTimes(2);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'integration.connection.migrated', entityId: GW, actorId: null }));
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain('test-refresh-gw');
  });

  it('re-encrypts the app secrets under the integration-bound AAD', async () => {
    const fake = opsLike();
    await service(fake.prisma).svc.run();
    const updates = (fake.db.integrationOAuthApp.updateMany as jest.Mock).mock.calls.map((c) => c[0].data);
    expect(updates).toContainEqual({ integrationId: GW, secretCiphertext: crypto.encrypt('test-google-secret', integrationOAuthAppSecretAad(GW)) });
    expect(updates).toContainEqual({ integrationId: MS, secretCiphertext: crypto.encrypt('test-ms-secret', integrationOAuthAppSecretAad(MS)) });
  });

  it('is idempotent: a second run changes nothing', async () => {
    const fake = opsLike();
    const { svc } = service(fake.prisma);
    await svc.run();
    const report = await svc.run();
    expect(report).toEqual({ appsAdopted: [], connectionsCreated: [], skipped: [] });
    expect(fake.connections).toHaveLength(2);
  });

  it('leaves non-OAuth integrations alone', async () => {
    const fake = opsLike();
    await service(fake.prisma).svc.run();
    expect(fake.db.integration.findMany).not.toHaveBeenCalledWith({ where: { driver: { in: ['level'] } } });
    expect(fake.db.integrationSecret.deleteMany).not.toHaveBeenCalledWith({ where: { id: 's-rmm' } });
    expect(fake.connections.some((c) => c.integrationId === RMM)).toBe(false);
  });

  it('converts the oldest Microsoft integration and leaves a second one untouched and reported', async () => {
    const fake = fakeDb({
      integrations: [
        { id: MS, driver: 'microsoft-365', createdAt: new Date('2026-08-02'), secret: { id: 's-ms', ciphertext: crypto.encrypt(JSON.stringify(consent), integrationSecretAad(MS)) } },
        {
          id: MS_SECOND, driver: 'microsoft-365', createdAt: new Date('2026-09-02'),
          secret: { id: 's-ms2', ciphertext: crypto.encrypt(JSON.stringify({ ...consent, tenantId: '99999999-2222-4333-8444-555555555555' }), integrationSecretAad(MS_SECOND)) },
        },
      ],
      apps: [],
      mappings: [],
    });
    const report = await service(fake.prisma).svc.run();
    expect(fake.connections.map((c) => c.integrationId)).toEqual([MS]);
    expect(report.skipped).toEqual([{ integrationId: MS_SECOND, provider: 'microsoft', reason: 'another_integration_of_provider' }]);
    expect(fake.db.integrationSecret.deleteMany).not.toHaveBeenCalledWith({ where: { id: 's-ms2' } });
  });

  it.each([
    ['no mapping', [], 'no_mapping_to_key_by'],
    ['several mappings', [
      { integrationId: GW, externalOrgId: 'C0example1', externalOrgName: null },
      { integrationId: GW, externalOrgId: 'C0example2', externalOrgName: null },
    ], 'several_mappings'],
  ])('keeps a Google grant it cannot key safely (%s) and reports it', async (_label, mappings, reason) => {
    const fake = fakeDb({
      integrations: [{ id: GW, driver: 'google-workspace', createdAt: new Date(), secret: { id: 's-gw', ciphertext: crypto.encrypt(JSON.stringify(googleGrant), integrationSecretAad(GW)) } }],
      apps: [],
      mappings,
    });
    const report = await service(fake.prisma).svc.run();
    expect(report.skipped).toEqual([{ integrationId: GW, provider: 'google', reason }]);
    expect(fake.connections).toHaveLength(0);
    expect(fake.db.integrationSecret.deleteMany).not.toHaveBeenCalled();
  });

  it('keeps an unreadable grant and a consent mapped to another tenant', async () => {
    const fake = fakeDb({
      integrations: [
        { id: GW, driver: 'google-workspace', createdAt: new Date(), secret: { id: 's-gw', ciphertext: 'damaged' } },
        { id: MS, driver: 'microsoft-365', createdAt: new Date(), secret: { id: 's-ms', ciphertext: crypto.encrypt(JSON.stringify(consent), integrationSecretAad(MS)) } },
      ],
      apps: [],
      mappings: [{ integrationId: MS, externalOrgId: '99999999-2222-4333-8444-555555555555', externalOrgName: null }],
    });
    const report = await service(fake.prisma).svc.run();
    expect(report.skipped).toEqual([
      { integrationId: GW, provider: 'google', reason: 'secret_unreadable' },
      { integrationId: MS, provider: 'microsoft', reason: 'mapping_on_other_tenant' },
    ]);
    expect(fake.connections).toHaveLength(0);
  });

  it('never blocks boot when the migration fails', async () => {
    const fake = opsLike();
    fake.prisma.$transaction.mockRejectedValueOnce(new Error('db down'));
    await expect(service(fake.prisma).svc.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
