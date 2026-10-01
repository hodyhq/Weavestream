import { NotFoundException } from '@nestjs/common';
import { Readable } from 'node:stream';
import { UploadsService } from './uploads.service.js';

const ACTOR = { id: 'u-1' } as never;
const META = { ip: '198.51.100.7', userAgent: 'jest' };

function harness(opts: { row?: object | null; createFails?: boolean } = {}) {
  const src = {
    id: 'up-1',
    companyId: 'co-src',
    filename: 'receipt.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 4,
    storageKey: 'co-src/uploads/up-1/receipt.pdf',
    sha256: 'abc',
    isImage: true,
    width: 1,
    height: 1,
    thumbnailKey: 'co-src/thumbs/up-1.webp',
  };
  const prisma = {
    upload: {
      // Honour the tenant filter the way the DB would.
      findFirst: jest.fn(async ({ where }: { where: { id: string; companyId: string } }) =>
        opts.row === null ? null : where.companyId === src.companyId && where.id === src.id ? src : null,
      ),
      create: jest.fn(async () => {
        if (opts.createFails) throw new Error('db down');
        return {};
      }),
    },
  };
  const storage = {
    uploadKey: (c: string, id: string, f: string) => `${c}/uploads/${id}/${f}`,
    thumbnailKey: (c: string, id: string) => `${c}/thumbs/${id}.webp`,
    ensureBucket: jest.fn().mockResolvedValue(''),
    getObjectStream: jest.fn(async () => ({ body: Readable.from([Buffer.from('data')]) })),
    putObjectStream: jest.fn().mockResolvedValue(undefined),
    deleteObject: jest.fn().mockResolvedValue(undefined),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const svc = new UploadsService(prisma as never, storage as never, {} as never, audit as never, {} as never);
  return { svc, prisma, storage, audit };
}

describe('UploadsService.copyToCompany', () => {
  it('copies the file and thumbnail into the target company as an unattached upload', async () => {
    const { svc, prisma, storage, audit } = harness();
    const id = await svc.copyToCompany(ACTOR, 'co-src', 'up-1', 'co-dst', META);

    expect(storage.putObjectStream).toHaveBeenCalledWith(
      'co-dst',
      `co-dst/uploads/${id}/receipt.pdf`,
      expect.anything(),
      { contentType: 'application/pdf', maxBytes: 4 },
    );
    expect(storage.putObjectStream).toHaveBeenCalledWith('co-dst', `co-dst/thumbs/${id}.webp`, expect.anything(), expect.anything());
    expect(prisma.upload.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ id, companyId: 'co-dst', attachedToId: null, sha256: 'abc' }),
    });
    expect(audit.log.mock.calls[0][0]).toMatchObject({ action: 'upload.copy', entityId: id, companyId: 'co-dst' });
  });

  it('will not copy an upload that belongs to a different company than claimed', async () => {
    // A forged uploadId in a field value must not pull a file out of a third tenant.
    const { svc, storage } = harness();
    await expect(svc.copyToCompany(ACTOR, 'co-other', 'up-1', 'co-dst', META)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(storage.getObjectStream).not.toHaveBeenCalled();
  });

  it('removes the written bytes if the database row cannot be created', async () => {
    const { svc, storage } = harness({ createFails: true });
    await expect(svc.copyToCompany(ACTOR, 'co-src', 'up-1', 'co-dst', META)).rejects.toThrow('db down');
    expect(storage.deleteObject).toHaveBeenCalledTimes(2);
  });
});
