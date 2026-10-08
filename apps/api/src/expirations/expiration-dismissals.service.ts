import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ExpirationDismissal } from '@prisma/client';
import {
  expirationDismissalKey,
  type DismissExpirationInput,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import { PermissionService } from '../rbac/permission.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { canReadPassword } from '../passwords/password-access-policy.js';

/** The permission that lets an actor act on each kind of expiring item. */
const MANAGE_ACTION = {
  'asset-field': 'asset.write',
  domain: 'domain.manage',
  password: 'password.write',
} as const;

const DOMAIN_SOURCES = new Set(['registrar', 'tls']);
const PASSWORD_SOURCES = new Set(['expiry', 'rotation']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Dismissals for the Expiring-soon feed. A dismissal hides one item for one
 * due date; a different date (renewed, then lapsing again) is a new item.
 * Nothing about the underlying asset, domain or password is changed.
 */
@Injectable()
export class ExpirationDismissalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly permissions: PermissionService,
  ) {}

  /** Dismissals keyed by `expirationDismissalKey`, optionally for one company. */
  loadMap(companyId?: string): Promise<Map<string, ExpirationDismissal>> {
    return loadDismissalMap(this.prisma, companyId);
  }

  async dismiss(
    actor: AuthedUser,
    companyId: string,
    input: DismissExpirationInput,
    meta: { ip: string; userAgent: string },
  ): Promise<ExpirationDismissal> {
    const dueAt = new Date(input.dueAt);
    if (Number.isNaN(dueAt.getTime())) throw new BadRequestException('dueAt is not a valid date.');

    await this.assertCanManage(actor, companyId, input.kind);
    await this.assertItemInCompany(actor, companyId, input);

    const note = input.note?.length ? input.note : null;
    const row = await this.prisma.expirationDismissal.upsert({
      where: {
        kind_entityId_source_dueAt: {
          kind: input.kind,
          entityId: input.entityId,
          source: input.source,
          dueAt,
        },
      },
      create: {
        companyId,
        kind: input.kind,
        entityId: input.entityId,
        source: input.source,
        dueAt,
        note,
        dismissedBy: actor.id,
      },
      update: { note, dismissedBy: actor.id },
    });
    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.expiration.dismiss,
      entityType: 'ExpirationDismissal',
      entityId: row.id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: { kind: row.kind, entityId: row.entityId, source: row.source, dueAt: row.dueAt, note: row.note },
    });
    return row;
  }

  async restore(
    actor: AuthedUser,
    companyId: string,
    id: string,
    meta: { ip: string; userAgent: string },
  ): Promise<void> {
    // Scoped by company: a dismissal id from another tenant is not found.
    const row = await this.prisma.expirationDismissal.findFirst({ where: { id, companyId } });
    if (!row) throw new NotFoundException();
    await this.assertCanManage(actor, companyId, row.kind as DismissExpirationInput['kind']);
    await this.prisma.expirationDismissal.deleteMany({ where: { id, companyId } });
    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.expiration.restore,
      entityType: 'ExpirationDismissal',
      entityId: row.id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { kind: row.kind, entityId: row.entityId, source: row.source, dueAt: row.dueAt, note: row.note },
      after: null,
    });
  }

  private async assertCanManage(
    actor: AuthedUser,
    companyId: string,
    kind: DismissExpirationInput['kind'],
  ): Promise<void> {
    const decision = await this.permissions.can(actor, MANAGE_ACTION[kind], { companyId });
    if (!decision.allowed) {
      throw new ForbiddenException('You cannot manage these items in this company.');
    }
  }

  /**
   * The item must exist in this company (IDOR: knowing an id is not access),
   * and the source must be one that kind actually has.
   */
  private async assertItemInCompany(
    actor: AuthedUser,
    companyId: string,
    input: DismissExpirationInput,
  ): Promise<void> {
    if (input.kind === 'domain') {
      if (!DOMAIN_SOURCES.has(input.source)) throw new BadRequestException('Unknown domain source.');
      const d = await this.prisma.monitoredDomain.findFirst({
        where: {
          id: input.entityId,
          companyId,
          ...(actor.role === 'CLIENT_USER' ? { visibleToClients: true } : {}),
        },
        select: { id: true },
      });
      if (!d) throw new NotFoundException();
      return;
    }
    if (input.kind === 'password') {
      if (!PASSWORD_SOURCES.has(input.source)) throw new BadRequestException('Unknown password source.');
      const p = await this.prisma.password.findFirst({
        where: { id: input.entityId, companyId },
        select: { id: true, visibleToClients: true, restrictedToUserIds: true },
      });
      if (!p || !canReadPassword(actor, p)) throw new NotFoundException();
      return;
    }
    // asset-field: the asset is in the company and the field belongs to its layout.
    if (!UUID_RE.test(input.source)) throw new NotFoundException();
    const a = await this.prisma.asset.findFirst({
      where: { id: input.entityId, companyId },
      select: { assetLayoutId: true },
    });
    if (!a) throw new NotFoundException();
    const field = await this.prisma.assetField.findFirst({
      where: {
        id: input.source,
        assetLayoutId: a.assetLayoutId,
        // Same rule as asset writes: clients never touch MSP-internal fields.
        ...(actor.role === 'CLIENT_USER' ? { visibleToClients: true } : {}),
      },
      select: { id: true },
    });
    if (!field) throw new NotFoundException();
  }
}

/**
 * Dismissals keyed by `expirationDismissalKey`. A plain function (not a
 * service method) so the worker-side alerts runner and the domains alerts
 * query can use it without new DI wiring.
 */
export async function loadDismissalMap(
  prisma: Pick<PrismaService, 'expirationDismissal'>,
  companyId?: string,
): Promise<Map<string, ExpirationDismissal>> {
  const rows = await prisma.expirationDismissal.findMany({
    where: companyId ? { companyId } : {},
  });
  return new Map(
    rows.map((r) => [expirationDismissalKey(r.kind, r.entityId, r.source, r.dueAt), r] as const),
  );
}

