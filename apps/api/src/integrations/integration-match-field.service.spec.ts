import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { REQUIRE_PERMISSION_KEY } from '../rbac/require-permission.decorator.js';
import { IntegrationMatchFieldController } from './integration-match-field.controller.js';
import { IntegrationMatchFieldService } from './integration-match-field.service.js';
import { IntegrationDriverRegistry } from './drivers/integration-driver.registry.js';

const ADMIN = { id: 'user-1', role: 'SUPER_ADMIN' } as never;
const META = { ip: '203.0.113.1', userAgent: 'jest' };
const LAYOUT_ID = '00000000-0000-4000-8000-000000000001';

function field(overrides: Record<string, unknown>) {
  return {
    id: 'f-name', name: 'Name', slug: 'name', fieldType: 'TEXT', position: 0, isRequired: true, isUniquePerCompany: false,
    visibleToClients: true, isPrimary: true, showInTable: true, options: {}, archivedAt: null, ...overrides,
  };
}

function setup(driver: string, fields: ReturnType<typeof field>[]) {
  const layouts = {
    get: jest.fn().mockResolvedValue({ id: LAYOUT_ID, isActive: true, archivedAt: null, fields }),
    saveFields: jest.fn().mockImplementation(async (_actor, _id, input: { fields: Array<Record<string, unknown>> }) => ({
      fields: input.fields.map((f, i) => ({ ...f, id: f.id ?? `f-new-${i}`, archivedAt: null })),
    })),
  };
  const prisma = { integration: { findUnique: jest.fn().mockResolvedValue({ driver }) } };
  const service = new IntegrationMatchFieldService(prisma as never, new IntegrationDriverRegistry(), layouts as never);
  return { service, layouts };
}

describe('IntegrationMatchFieldService', () => {
  it('creates the missing match field through the layout builder save, keeping existing fields', async () => {
    const { service, layouts } = setup('level', [field({})]);
    await expect(service.ensureMatchField(ADMIN, 'i-1', 'devices', LAYOUT_ID, META)).resolves.toEqual({ fieldId: 'f-new-1', created: true });
    const [, layoutId, input, opts, meta] = layouts.saveFields.mock.calls[0]!;
    expect(layoutId).toBe(LAYOUT_ID);
    expect(opts).toEqual({});
    expect(meta).toBe(META);
    expect(input.fields).toEqual([
      expect.objectContaining({ id: 'f-name', slug: 'name', isPrimary: true }),
      expect.objectContaining({ slug: 'serial_number', name: 'Serial number', fieldType: 'TEXT', isPrimary: false, isRequired: false }),
    ]);
    expect(input.fields[0]).not.toHaveProperty('archivedAt');
  });

  it('reuses an existing field with the same slug and type without saving', async () => {
    const { service, layouts } = setup('google-workspace', [field({}), field({ id: 'f-email', name: 'Email', slug: 'email', fieldType: 'EMAIL', isPrimary: false })]);
    await expect(service.ensureMatchField(ADMIN, 'i-1', 'users', LAYOUT_ID, META)).resolves.toEqual({ fieldId: 'f-email', created: false });
    expect(layouts.saveFields).not.toHaveBeenCalled();
  });

  it('refuses when a field with that slug has another type, and never alters it', async () => {
    const { service, layouts } = setup('google-workspace', [field({}), field({ id: 'f-email', name: 'Email', slug: 'email', fieldType: 'TEXT', isPrimary: false })]);
    const error = await service.ensureMatchField(ADMIN, 'i-1', 'users', LAYOUT_ID, META).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toMatch(/already has a field "Email" \(email\) of type TEXT/);
    expect(layouts.saveFields).not.toHaveBeenCalled();
  });

  it('ignores archived fields when looking for the slug', async () => {
    const { service } = setup('level', [field({}), field({ id: 'f-old', slug: 'serial_number', isPrimary: false, archivedAt: new Date() })]);
    await expect(service.ensureMatchField(ADMIN, 'i-1', 'devices', LAYOUT_ID, META)).resolves.toMatchObject({ created: true });
  });

  it('refuses inactive layouts, unknown resources and client users', async () => {
    const { service, layouts } = setup('level', [field({})]);
    layouts.get.mockResolvedValueOnce({ id: LAYOUT_ID, isActive: false, archivedAt: null, fields: [] });
    await expect(service.ensureMatchField(ADMIN, 'i-1', 'devices', LAYOUT_ID, META)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.ensureMatchField(ADMIN, 'i-1', 'nope', LAYOUT_ID, META)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.ensureMatchField({ id: 'u', role: 'CLIENT_USER' } as never, 'i-1', 'devices', LAYOUT_ID, META)).rejects.toBeInstanceOf(ForbiddenException);
    expect(layouts.saveFields).not.toHaveBeenCalled();
  });

  it('is gated by integration.manage', () => {
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, IntegrationMatchFieldController.prototype.ensureMatchField)).toEqual({
      action: 'integration.manage',
      companyIdFrom: undefined,
    });
  });
});
