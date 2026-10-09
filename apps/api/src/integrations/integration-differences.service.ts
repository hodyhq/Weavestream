import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  IntegrationDifferenceRowDto,
  IntegrationDifferencesPage,
  IntegrationDifferencesQuery,
  ResolveIntegrationDifferenceInput,
} from '@weavestream/shared';
import { getTenantContext, runWithTenantContext } from '@weavestream/shared/server';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import { AssetsService } from '../assets/assets.service.js';
import type { AuditMeta } from './integrations.service.js';
import { IntegrationProvenanceService } from './reconstruction/integration-provenance.service.js';
import { differenceDisplayValue, parseFieldDiffs, parseFieldResolutions } from './field-diffs.js';

/** Rows with any open difference (the column defaults to `{}`). */
const HAS_DIFFS: Prisma.IntegrationSyncRecordWhereInput = { NOT: { fieldDiffs: { equals: {} } } };

/**
 * Standard-field differences recorded by integration syncs: a person
 * changed a field the integration fills, so the sync left it alone.
 * Resolving one either writes the source value (the field follows the
 * source again) or keeps the person's value until the source changes.
 */
@Injectable()
export class IntegrationDifferencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly assets: AssetsService,
    private readonly provenance: IntegrationProvenanceService,
  ) {}

  /**
   * The caller holds asset.write on `companyId` (route guard). The sync
   * record must belong to that asset in that company; anything else is a
   * 404 so a known id never crosses tenants.
   */
  async resolve(
    actor: AuthedUser,
    companyId: string,
    assetId: string,
    input: ResolveIntegrationDifferenceInput,
    meta: AuditMeta,
  ): Promise<{ ok: true }> {
    // Differences are MSP-internal, like the integration sections.
    if (actor.role === 'CLIENT_USER') throw new ForbiddenException();
    const record = await this.prisma.integrationSyncRecord.findFirst({
      where: { id: input.syncRecordId, companyId, assetId, targetKind: 'asset' },
      select: {
        id: true,
        updatedAt: true,
        fieldDiffs: true,
        fieldResolutions: true,
        lastSyncedFieldChecksums: true,
        integrationCompanyMappingId: true,
        resourceId: true,
        companyMapping: { select: { integrationId: true } },
      },
    });
    if (!record) throw new NotFoundException();
    const diffs = parseFieldDiffs(record.fieldDiffs);
    const diff = diffs[input.assetFieldId];
    if (!diff) throw new NotFoundException('This difference is no longer open.');
    const resolutions = parseFieldResolutions(record.fieldResolutions);
    const checksums = { ...((record.lastSyncedFieldChecksums ?? {}) as Record<string, string>) };
    delete diffs[input.assetFieldId];
    delete resolutions[input.assetFieldId];

    let slug: string | null = null;
    if (input.choice === 'source') {
      const field = await this.prisma.assetField.findFirst({
        where: { id: input.assetFieldId, archivedAt: null, assetLayout: { assets: { some: { id: assetId, companyId } } } },
        select: { slug: true },
      });
      if (!field) throw new NotFoundException();
      slug = field.slug;
      // Recorded as the integration's last write (the fingerprint of the
      // normalized source value the asset is about to hold), so the field
      // follows the source again.
      checksums[input.assetFieldId] = diff.sourceFingerprint;
    } else {
      resolutions[input.assetFieldId] = { choice: 'local', sourceFingerprint: diff.sourceFingerprint };
    }

    // One transaction under the sync runner's per-scope lock: a sync page
    // either finished before (the updatedAt guard then refuses, nothing is
    // written) or waits until the record and the asset are both updated.
    await this.prisma.$transaction(async (tx) => {
      await this.provenance.lockScope(tx, {
        companyId,
        integrationCompanyMappingId: record.integrationCompanyMappingId,
        resourceId: record.resourceId,
        observedAt: new Date(),
      });
      const updated = await tx.integrationSyncRecord.updateMany({
        where: { id: record.id, companyId, updatedAt: record.updatedAt },
        data: {
          fieldDiffs: diffs as unknown as Prisma.InputJsonValue,
          fieldResolutions: resolutions as unknown as Prisma.InputJsonValue,
          lastSyncedFieldChecksums: checksums as Prisma.InputJsonValue,
        },
      });
      if (updated.count === 0) {
        throw new ConflictException('The integration synced this asset just now. Reload and try again.');
      }
      if (slug !== null) {
        // The operator write path: validated, audited and indexed like any
        // edit; a failure rolls the record change back with it.
        await this.assets.update(actor, companyId, assetId, { fieldValues: { [slug]: diff.sourceValue } }, meta, tx);
      }
    });
    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.integration.differenceResolve,
      entityType: 'Asset',
      entityId: assetId,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: {
        integrationId: record.companyMapping.integrationId,
        syncRecordId: record.id,
        assetFieldId: input.assetFieldId,
        choice: input.choice,
      },
    });
    return { ok: true };
  }

  /** Open differences across the integration's mapped companies (integration.manage). */
  async list(integrationId: string, query: IntegrationDifferencesQuery): Promise<IntegrationDifferencesPage> {
    const integration = await this.prisma.integration.findUnique({
      where: { id: integrationId },
      select: { companyMappings: { select: { companyId: true } } },
    });
    if (!integration) throw new NotFoundException(`Integration ${integrationId} not found`);
    const mapped = [...new Set(integration.companyMappings.map((mapping) => mapping.companyId))];
    if (query.companyId && !mapped.includes(query.companyId)) {
      throw new NotFoundException('That company is not mapped to this integration.');
    }
    const companyIds = query.companyId ? [query.companyId] : mapped;
    if (companyIds.length === 0) return { items: [], total: 0, nextCursor: null };
    const where: Prisma.IntegrationSyncRecordWhereInput = {
      ...HAS_DIFFS,
      companyId: { in: companyIds },
      targetKind: 'asset',
      assetId: { not: null },
      companyMapping: { integrationId },
    };
    return this.inCompanyScope(companyIds, async () => {
      const rows = await this.prisma.integrationSyncRecord.findMany({
        where: { ...where, ...(query.cursor ? { id: { gt: query.cursor } } : {}) },
        orderBy: { id: 'asc' },
        take: query.limit + 1,
        select: {
          id: true,
          companyId: true,
          assetId: true,
          fieldDiffs: true,
          asset: { select: { name: true, company: { select: { name: true } } } },
        },
      });
      const page = rows.slice(0, query.limit);
      const diffsByRow = new Map(page.map((row) => [row.id, parseFieldDiffs(row.fieldDiffs)]));
      const fieldIds = [...new Set([...diffsByRow.values()].flatMap((diffs) => Object.keys(diffs)))];
      const assetIds = page.flatMap((row) => (row.assetId ? [row.assetId] : []));
      const [fields, values] = fieldIds.length === 0
        ? [[], []]
        : await Promise.all([
            this.prisma.assetField.findMany({
              where: { id: { in: fieldIds }, archivedAt: null },
              select: { id: true, name: true },
            }),
            this.prisma.assetFieldValue.findMany({
              where: { companyId: { in: companyIds }, assetId: { in: assetIds }, assetFieldId: { in: fieldIds } },
              select: { assetId: true, assetFieldId: true, value: true },
            }),
          ]);
      const labelById = new Map(fields.map((field) => [field.id, field.name]));
      const valueByKey = new Map(values.map((value) => [`${value.assetId}:${value.assetFieldId}`, value.value]));
      const items: IntegrationDifferenceRowDto[] = [];
      for (const row of page) {
        if (!row.assetId || !row.asset) continue;
        for (const [assetFieldId, diff] of Object.entries(diffsByRow.get(row.id) ?? {})) {
          const fieldLabel = labelById.get(assetFieldId);
          if (fieldLabel === undefined) continue;
          items.push({
            syncRecordId: row.id,
            companyId: row.companyId,
            companyName: row.asset.company.name,
            assetId: row.assetId,
            assetName: row.asset.name,
            assetFieldId,
            fieldLabel,
            localValue: differenceDisplayValue(valueByKey.get(`${row.assetId}:${assetFieldId}`)),
            sourceValue: differenceDisplayValue(diff.sourceValue),
            detectedAt: diff.detectedAt,
          });
        }
      }
      // ponytail: counts every stored diff (archived fields included); a SQL
      // jsonb key count can replace this if a fleet ever holds thousands.
      const total = query.cursor
        ? null
        : (await this.prisma.integrationSyncRecord.findMany({ where, select: { fieldDiffs: true } }))
            .reduce((sum, row) => sum + Object.keys(parseFieldDiffs(row.fieldDiffs)).length, 0);
      const last = page[page.length - 1];
      return { items, total, nextCursor: rows.length > query.limit && last ? last.id : null };
    });
  }

  private inCompanyScope<T>(companyIds: string[], read: () => Promise<T>): Promise<T> {
    const tenant = getTenantContext();
    if (!tenant) return read();
    return runWithTenantContext({ ...tenant, allowedCompanyIds: companyIds }, read);
  }
}
