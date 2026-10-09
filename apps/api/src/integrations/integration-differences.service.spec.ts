import { createHash } from 'node:crypto';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { REQUIRE_PERMISSION_KEY } from '../rbac/require-permission.decorator.js';
import {
  AssetIntegrationDifferencesController,
  IntegrationDifferencesController,
} from './integration-differences.controller.js';

jest.mock('../uploads/uploads.service.js', () => ({ UploadsService: class UploadsService {} }));

let IntegrationDifferencesService: typeof import('./integration-differences.service.js').IntegrationDifferencesService;
beforeAll(async () => {
  ({ IntegrationDifferencesService } = await import('./integration-differences.service.js'));
});

const ADMIN = { id: 'user-1', role: 'SUPER_ADMIN' } as never;
const META = { ip: '203.0.113.1', userAgent: 'jest' };
const COMPANY = '00000000-0000-4000-8000-0000000000c1';
const ASSET = '00000000-0000-4000-8000-0000000000a1';
const RECORD = '00000000-0000-4000-8000-0000000000e1';
const FIELD = '00000000-0000-4000-8000-0000000000f1';
const UPDATED_AT = new Date('2026-10-01T00:00:00.000Z');
const checksum = (value: unknown) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: RECORD,
    updatedAt: UPDATED_AT,
    fieldDiffs: {
      [FIELD]: { sourceValue: 'host-b', sourceFingerprint: checksum('host-b'), localFingerprint: checksum('mine'), detectedAt: '2026-10-01T00:00:00.000Z' },
    },
    fieldResolutions: {},
    lastSyncedFieldChecksums: { [FIELD]: checksum('host-a') },
    integrationCompanyMappingId: 'map-1',
    resourceId: 'res-1',
    companyMapping: { integrationId: 'int-1' },
    ...overrides,
  };
}

function setup(found: unknown = record()) {
  const prisma = {
    integrationSyncRecord: {
      findFirst: jest.fn().mockResolvedValue(found),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn(),
    },
    assetField: { findFirst: jest.fn().mockResolvedValue({ slug: 'hostname' }), findMany: jest.fn() },
    assetFieldValue: { findFirst: jest.fn().mockResolvedValue({ value: 'host-b' }), findMany: jest.fn() },
    integration: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma));
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const assets = { update: jest.fn().mockResolvedValue({}) };
  const provenance = { lockScope: jest.fn().mockResolvedValue(undefined) };
  const service = new IntegrationDifferencesService(prisma as never, audit as never, assets as never, provenance as never);
  return { service, prisma, audit, assets, provenance };
}

const input = (choice: 'source' | 'local') => ({ syncRecordId: RECORD, assetFieldId: FIELD, choice });

describe('IntegrationDifferencesService.resolve', () => {
  it('Use source writes through the operator path, follows the source again and clears the difference', async () => {
    const { service, prisma, audit, assets, provenance } = setup();
    await expect(service.resolve(ADMIN, COMPANY, ASSET, input('source'), META)).resolves.toEqual({ ok: true });
    // Serialized with sync pages through the runner's scope lock, in one transaction.
    expect(provenance.lockScope).toHaveBeenCalledWith(prisma, expect.objectContaining({
      companyId: COMPANY, integrationCompanyMappingId: 'map-1', resourceId: 'res-1',
    }));
    expect(provenance.lockScope.mock.invocationCallOrder[0]).toBeLessThan(prisma.integrationSyncRecord.updateMany.mock.invocationCallOrder[0]!);
    expect(prisma.integrationSyncRecord.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: RECORD, companyId: COMPANY, assetId: ASSET, targetKind: 'asset' },
    }));
    expect(assets.update).toHaveBeenCalledWith(ADMIN, COMPANY, ASSET, { fieldValues: { hostname: 'host-b' } }, META, prisma);
    // The binding is claimed before the asset write.
    expect(prisma.integrationSyncRecord.updateMany.mock.invocationCallOrder[0]).toBeLessThan(assets.update.mock.invocationCallOrder[0]!);
    expect(prisma.integrationSyncRecord.updateMany).toHaveBeenCalledWith({
      where: { id: RECORD, companyId: COMPANY, updatedAt: UPDATED_AT },
      data: { fieldDiffs: {}, fieldResolutions: {}, lastSyncedFieldChecksums: { [FIELD]: checksum('host-b') } },
    });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'integration.difference.resolve',
      companyId: COMPANY,
      entityId: ASSET,
      after: { integrationId: 'int-1', syncRecordId: RECORD, assetFieldId: FIELD, choice: 'source' },
    }));
  });

  it('Keep ours stores the choice against the source value and writes nothing to the asset', async () => {
    const { service, prisma, assets } = setup();
    await service.resolve(ADMIN, COMPANY, ASSET, input('local'), META);
    expect(assets.update).not.toHaveBeenCalled();
    expect(prisma.integrationSyncRecord.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        fieldDiffs: {},
        fieldResolutions: { [FIELD]: { choice: 'local', sourceFingerprint: checksum('host-b') } },
        lastSyncedFieldChecksums: { [FIELD]: checksum('host-a') },
      }),
    }));
  });

  it('404s a record outside that asset and company, or a difference that is no longer open', async () => {
    const missing = setup(null);
    await expect(missing.service.resolve(ADMIN, COMPANY, ASSET, input('local'), META)).rejects.toBeInstanceOf(NotFoundException);
    const closed = setup(record({ fieldDiffs: {} }));
    await expect(closed.service.resolve(ADMIN, COMPANY, ASSET, input('source'), META)).rejects.toBeInstanceOf(NotFoundException);
    expect(closed.assets.update).not.toHaveBeenCalled();
  });

  it('denies client users before reading anything', async () => {
    const { service, prisma } = setup();
    await expect(service.resolve({ id: 'u', role: 'CLIENT_USER' } as never, COMPANY, ASSET, input('local'), META))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.integrationSyncRecord.findFirst).not.toHaveBeenCalled();
  });

  it('reports a sync that rewrote the record in between as a conflict (Keep ours)', async () => {
    const { service, prisma, audit } = setup();
    prisma.integrationSyncRecord.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.resolve(ADMIN, COMPANY, ASSET, input('local'), META)).rejects.toBeInstanceOf(ConflictException);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('rolls back with the asset write when it fails, and logs no resolution', async () => {
    const { service, assets, audit } = setup();
    assets.update.mockRejectedValue(new Error('invalid value'));
    await expect(service.resolve(ADMIN, COMPANY, ASSET, input('source'), META)).rejects.toThrow('invalid value');
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('writes nothing to the asset when a sync touched the record first (Use source)', async () => {
    const { service, prisma, audit, assets } = setup();
    prisma.integrationSyncRecord.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.resolve(ADMIN, COMPANY, ASSET, input('source'), META)).rejects.toBeInstanceOf(ConflictException);
    expect(assets.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('requires asset.write on the path company (no asset.write -> 403 from the guard)', () => {
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, AssetIntegrationDifferencesController.prototype.resolve)).toEqual({
      action: 'asset.write',
      companyIdFrom: 'params.companyId',
    });
  });
});

describe('IntegrationDifferencesService.list', () => {
  const OTHER = '00000000-0000-4000-8000-0000000000c2';
  const row = (id: string) => ({
    id, companyId: COMPANY, assetId: ASSET,
    fieldDiffs: { [FIELD]: { sourceValue: 'host-b', sourceFingerprint: 's', localFingerprint: 'l', detectedAt: '2026-10-01T00:00:00.000Z' } },
    asset: { name: 'Workstation 01', company: { name: 'Example Co' } },
  });

  function listSetup(rows: ReturnType<typeof row>[]) {
    const ctx = setup();
    ctx.prisma.integration.findUnique.mockResolvedValue({ companyMappings: [{ companyId: COMPANY }] });
    ctx.prisma.integrationSyncRecord.findMany
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce(rows.map((r) => ({ fieldDiffs: r.fieldDiffs })));
    ctx.prisma.assetField.findMany.mockResolvedValue([{ id: FIELD, name: 'Hostname' }]);
    ctx.prisma.assetFieldValue.findMany.mockResolvedValue([{ assetId: ASSET, assetFieldId: FIELD, value: 'mine' }]);
    return ctx;
  }

  it('returns company, asset, field, both values and a cursor when more rows follow', async () => {
    const { service, prisma } = listSetup([row('00000000-0000-4000-8000-000000000001'), row('00000000-0000-4000-8000-000000000002')]);
    const page = await service.list('int-1', { limit: 1 });
    expect(page.items).toEqual([{
      syncRecordId: '00000000-0000-4000-8000-000000000001', companyId: COMPANY, companyName: 'Example Co',
      assetId: ASSET, assetName: 'Workstation 01', assetFieldId: FIELD, fieldLabel: 'Hostname',
      localValue: 'mine', sourceValue: 'host-b', detectedAt: '2026-10-01T00:00:00.000Z',
    }]);
    expect(page.nextCursor).toBe('00000000-0000-4000-8000-000000000001');
    expect(page.total).toBe(2);
    const where = prisma.integrationSyncRecord.findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({ companyId: { in: [COMPANY] }, companyMapping: { integrationId: 'int-1' } });
  });

  it('continues after the cursor without recounting', async () => {
    const { service, prisma } = listSetup([row('00000000-0000-4000-8000-000000000002')]);
    const page = await service.list('int-1', { limit: 1, cursor: '00000000-0000-4000-8000-000000000001' });
    expect(page.nextCursor).toBeNull();
    expect(page.total).toBeNull();
    expect(prisma.integrationSyncRecord.findMany.mock.calls[0]![0].where.id).toEqual({ gt: '00000000-0000-4000-8000-000000000001' });
  });

  it('404s a company filter that is not mapped to the integration, and an unknown integration', async () => {
    const { service, prisma } = listSetup([]);
    await expect(service.list('int-1', { limit: 50, companyId: OTHER })).rejects.toBeInstanceOf(NotFoundException);
    prisma.integration.findUnique.mockResolvedValue(null);
    await expect(service.list('nope', { limit: 50 })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is gated by integration.manage', () => {
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, IntegrationDifferencesController.prototype.list)).toEqual({
      action: 'integration.manage',
      companyIdFrom: undefined,
    });
  });
});
