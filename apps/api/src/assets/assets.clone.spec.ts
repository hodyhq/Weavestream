import { ForbiddenException } from '@nestjs/common';
import { AssetsService } from './assets.service.js';
import { AssetsController } from './assets.controller.js';
import { REQUIRE_PERMISSION_KEY } from '../rbac/require-permission.decorator.js';

const SRC = 'co-src';
const DST = 'co-dst';
const ACTOR = { id: 'u-1', role: 'OPERATOR' } as never;
const META = { ip: '198.51.100.7', userAgent: 'jest' };

const LAYOUT = {
  id: 'layout-1',
  fields: [
    { slug: 'hostname', fieldType: 'TEXT', archivedAt: null },
    { slug: 'linked', fieldType: 'ASSET_REFERENCE', archivedAt: null },
    { slug: 'receipt', fieldType: 'FILE', archivedAt: null },
    { slug: 'old', fieldType: 'TEXT', archivedAt: new Date() },
  ],
};

function harness(opts: { archived?: boolean; createFails?: boolean; archiveFails?: boolean } = {}) {
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    asset: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'a-1',
        companyId: SRC,
        name: 'FW13',
        externalId: 'ext-1',
        externalSource: 'breeze',
        archivedAt: opts.archived ? new Date() : null,
        assetLayout: LAYOUT,
        fieldValues: [],
      }),
    },
    upload: { updateMany },
  };
  let n = 0;
  const uploads = { copyToCompany: jest.fn(async () => `up-new-${++n}`) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const svc = new AssetsService(
    prisma as never,
    audit as never,
    {} as never,
    {} as never,
    uploads as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  // serialize() applies role visibility; here it returns what the actor sees.
  jest.spyOn(svc as never, 'serialize' as never).mockReturnValue({
    fieldValues: {
      hostname: 'fw13.local',
      linked: 'a-9',
      receipt: [{ uploadId: 'up-1', filename: 'r.pdf', mimeType: 'application/pdf', sizeBytes: 10 }],
    },
  } as never);
  const create = jest
    .spyOn(svc, 'create')
    .mockImplementation(async () =>
      opts.createFails
        ? Promise.reject(new Error('unique clash'))
        : ({ id: 'a-new' } as never),
    );
  const archive = jest
    .spyOn(svc, 'archive')
    .mockImplementation(async () =>
      opts.archiveFails ? Promise.reject(new Error('lock timeout')) : ({} as never),
    );
  return { svc, uploads, create, archive, updateMany, audit };
}

describe('AssetsService.clone', () => {
  it('copies into another company: files duplicated, links and external identity dropped', async () => {
    const { svc, uploads, create, archive } = harness();
    await svc.clone(ACTOR, SRC, 'a-1', DST, { archiveOriginal: false }, META);

    expect(uploads.copyToCompany).toHaveBeenCalledWith(ACTOR, SRC, 'up-1', DST, META);
    expect(create).toHaveBeenCalledWith(
      ACTOR,
      DST,
      {
        assetLayoutId: 'layout-1',
        name: 'FW13',
        fieldValues: {
          hostname: 'fw13.local',
          receipt: [{ uploadId: 'up-new-1', filename: 'r.pdf', mimeType: 'application/pdf', sizeBytes: 10 }],
        },
      },
      META,
    );
    expect(archive).not.toHaveBeenCalled();
  });

  it('keeps links when copying within the same company', async () => {
    const { svc, create } = harness();
    await svc.clone(ACTOR, SRC, 'a-1', SRC, { archiveOriginal: false }, META);
    expect((create.mock.calls[0]![2] as { fieldValues: Record<string, unknown> }).fieldValues.linked).toBe('a-9');
  });

  it('archives the original only after the copy exists, when asked to move', async () => {
    const { svc, create, archive } = harness();
    await svc.clone(ACTOR, SRC, 'a-1', DST, { archiveOriginal: true }, META);
    expect(archive).toHaveBeenCalledWith(ACTOR, SRC, 'a-1', META);
    expect(create.mock.invocationCallOrder[0]!).toBeLessThan(archive.mock.invocationCallOrder[0]!);
  });

  it('on a failed copy retires the duplicated files and leaves the original alone', async () => {
    const { svc, archive, updateMany } = harness({ createFails: true });
    await expect(svc.clone(ACTOR, SRC, 'a-1', DST, { archiveOriginal: true }, META)).rejects.toThrow(
      'unique clash',
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['up-new-1'] }, companyId: DST, attachedToId: null },
      data: { deletedAt: expect.any(Date) },
    });
    expect(archive).not.toHaveBeenCalled();
  });

  it('a copy whose original could not be archived is reported as kept, not failed', async () => {
    // Reporting it as failed would invite a retry that copies it twice.
    const { svc, audit } = harness({ archiveFails: true });
    const res = await svc.clone(ACTOR, SRC, 'a-1', DST, { archiveOriginal: true }, META);
    expect(res).toMatchObject({ id: 'a-new', originalArchived: false });
    expect(audit.log.mock.calls[0][0].after).toMatchObject({ moveRequested: true, archivedOriginal: false });

    const bulk = await harness({ archiveFails: true }).svc.cloneMany(
      ACTOR, SRC, ['a-1'], DST, { archiveOriginal: true }, META,
    );
    expect(bulk.ok).toEqual(['a-1']);
    expect(bulk.failed).toEqual([expect.objectContaining({ id: 'a-1', code: 'original_not_archived' })]);
  });

  it('a failed provenance audit row does not fail a committed copy', async () => {
    const { svc, audit } = harness();
    audit.log.mockRejectedValueOnce(new Error('audit down'));
    await expect(svc.clone(ACTOR, SRC, 'a-1', DST, { archiveOriginal: false }, META)).resolves.toMatchObject({
      id: 'a-new',
    });
  });

  it('refuses a move within one company and copying an archived asset', async () => {
    await expect(
      harness().svc.clone(ACTOR, SRC, 'a-1', SRC, { archiveOriginal: true }, META),
    ).rejects.toThrow(/different target company/);
    await expect(
      harness({ archived: true }).svc.clone(ACTOR, SRC, 'a-1', DST, { archiveOriginal: false }, META),
    ).rejects.toThrow(/Restore the asset/);
  });
});

describe('AssetsController clone authorisation', () => {
  function controller(allowed: Record<string, boolean>) {
    const can = jest.fn(async (_u: unknown, action: string) => ({ allowed: allowed[action] ?? false }));
    const assets = { clone: jest.fn().mockResolvedValue({}), cloneMany: jest.fn().mockResolvedValue({}) };
    return { c: new AssetsController(assets as never, { can } as never), can, assets };
  }
  const req = { headers: {}, ip: '198.51.100.7' } as never;

  it('requires asset.read on the source company via the route', () => {
    for (const h of ['clone', 'bulkClone']) {
      expect(
        Reflect.getMetadata(REQUIRE_PERMISSION_KEY, AssetsController.prototype[h as keyof AssetsController] as object),
      ).toEqual({ action: 'asset.read', companyIdFrom: 'params.companyId' });
    }
  });

  it('refuses without asset.write on the target company', async () => {
    const { c, assets } = controller({ 'asset.write': false });
    await expect(
      c.clone(ACTOR, SRC, 'a-1', { targetCompanyId: DST, archiveOriginal: false }, req),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(assets.clone).not.toHaveBeenCalled();
  });

  it('a move also needs asset.archive on the source', async () => {
    const { c, can, assets } = controller({ 'asset.write': true, 'asset.archive': false });
    await expect(
      c.bulkClone(ACTOR, SRC, { ids: ['a-1'], targetCompanyId: DST, archiveOriginal: true }, req),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(can).toHaveBeenCalledWith(ACTOR, 'asset.archive', { companyId: SRC });
    expect(assets.cloneMany).not.toHaveBeenCalled();
  });
});
