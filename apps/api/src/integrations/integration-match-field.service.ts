import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { EnsureResourceMatchFieldResult } from '@weavestream/shared';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AssetLayoutsService } from '../asset-layouts/asset-layouts.service.js';
import { IntegrationDriverRegistry } from './drivers/integration-driver.registry.js';
import { minimalRecommendation, type AuditMeta } from './integrations.service.js';

/**
 * "Map layouts" on an existing layout that lacks the field a resource
 * matches on: create that one field (name, slug and type from the driver's
 * recommended destination) through the layout service's add-one-field path, so
 * it is validated and audited like any field the operator adds. A field
 * with the same slug but another type is never altered.
 */
@Injectable()
export class IntegrationMatchFieldService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly drivers: IntegrationDriverRegistry,
    private readonly layouts: AssetLayoutsService,
  ) {}

  async ensureMatchField(
    actor: AuthedUser,
    integrationId: string,
    resourceKey: string,
    assetLayoutId: string,
    meta: AuditMeta,
  ): Promise<EnsureResourceMatchFieldResult> {
    // Defense in depth: client users never edit layouts.
    if (actor.role === 'CLIENT_USER') throw new ForbiddenException();
    const integration = await this.prisma.integration.findUnique({ where: { id: integrationId }, select: { driver: true } });
    if (!integration) throw new NotFoundException();
    const driver = this.drivers.get(integration.driver);
    const resource = driver.descriptor.resources.find((candidate) => candidate.key === resourceKey);
    if (!resource) throw new BadRequestException(`Unknown resource "${resourceKey}" for this integration.`);
    const recommendation = driver.recommendedDestinations?.[resourceKey];
    const sourceField = resource.matchSuggestions?.sourceField;
    const wanted = recommendation && sourceField
      ? minimalRecommendation(recommendation, resource).fields.find((field) => field.sourceField === sourceField)
      : undefined;
    if (resource.targetKind !== 'asset' || !wanted) {
      throw new BadRequestException('This resource has no match field to create.');
    }

    const layout = await this.layouts.get(actor, assetLayoutId);
    if (layout.archivedAt || !layout.isActive) throw new BadRequestException('Pick an active layout.');
    // Adds against the layout's current fields (not this read), so a field
    // added concurrently is never dropped.
    const { field, created } = await this.layouts.addField(
      actor,
      assetLayoutId,
      {
        name: wanted.name,
        slug: wanted.slug,
        fieldType: wanted.fieldType,
        isRequired: false,
        isUniquePerCompany: false,
        visibleToClients: true,
        isPrimary: false,
        showInTable: wanted.showInTable,
        options: wanted.options,
      },
      meta,
    );
    if (!created && field.fieldType !== wanted.fieldType) {
      throw new BadRequestException(
        `The layout already has a field "${field.name}" (${field.slug}) of type ${field.fieldType}, and this integration needs ${wanted.fieldType}. Pick that field or another one to match on.`,
      );
    }
    return { fieldId: field.id, created };
  }
}
