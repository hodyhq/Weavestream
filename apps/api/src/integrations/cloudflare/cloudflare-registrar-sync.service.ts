import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type MonitoredDomain } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { domainHostnameSchema } from '@weavestream/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditLogService } from '../../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../../audit/audit-actions.js';
import { EnvService } from '../../config/env.service.js';
import { RedisService } from '../../redis/redis.service.js';
import { IntegrationsService } from '../integrations.service.js';
import { IntegrationDriverRegistry } from '../drivers/integration-driver.registry.js';
import { cloudflareConfigSchema } from '../drivers/cloudflare/cloudflare.driver.js';

const LOCK_LEASE_SEC = 900;
const RUN_DEADLINE_MS = 600_000;
/** Delete KEYS[1] only if it still holds ARGV[1] (our token). */
const RELEASE_IF_OWNER =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export interface RegistrarSyncResult {
  /** False when the integration has no `domainsCompanySlug` (sync off). */
  enabled: boolean;
  created: number;
  updated: number;
  /** MANUAL rows that matched a Cloudflare domain and were taken over. */
  adopted: number;
  /** Rows this integration owns that Cloudflare no longer reports. */
  missing: number;
}

/**
 * Cloudflare registrar → MonitoredDomain sync.
 *
 * Cloudflare is the source of truth for registrar facts (registrar, expiry,
 * auto-renew, lock, nameservers); Weavestream owns everything else on the row
 * — which company it belongs to, the monitoring toggles, client visibility.
 * So a domain moved to a client company stays there, and the sync only ever
 * rewrites the registrar columns.
 *
 * Never deletes. A domain that disappears from the account (transferred out,
 * expired, moved to a different Cloudflare account) gets
 * `registrarMissingSince` stamped and keeps its history; an operator decides
 * whether to archive it.
 */
@Injectable()
export class CloudflareRegistrarSyncService {
  private readonly logger = new Logger(CloudflareRegistrarSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
    private readonly drivers: IntegrationDriverRegistry,
    private readonly audit: AuditLogService,
    private readonly env: EnvService,
    private readonly redis: RedisService,
  ) {}

  async sync(
    integrationId: string,
    actorId: string | null,
    meta: { ip: string; userAgent: string } = { ip: 'worker', userAgent: 'worker' },
  ): Promise<RegistrarSyncResult> {
    // One run per integration at a time: a manual sync overlapping the
    // scheduled sweep would otherwise race on the find-then-create below.
    // The lease bounds a crashed run; run() stops writing at RUN_DEADLINE_MS,
    // well inside it, so it never writes after the lock could have expired.
    const lockKey = `lock:cf-registrar-sync:${integrationId}`;
    const token = randomUUID();
    const got = await this.redis.client.set(lockKey, token, 'EX', LOCK_LEASE_SEC, 'NX');
    if (got !== 'OK') {
      throw new ConflictException('A domain sync for this integration is already running.');
    }
    try {
      return await this.run(integrationId, actorId, meta, Date.now() + RUN_DEADLINE_MS);
    } finally {
      // Compare-and-delete in one step so we can only ever release our own
      // lock. A failure here must not mask the run's result; the lease
      // expires on its own.
      await this.redis.client
        .eval(RELEASE_IF_OWNER, 1, lockKey, token)
        .catch((err: unknown) =>
          this.logger.warn(
            `Could not release registrar sync lock (integration=${integrationId}): ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }
  }

  private async run(
    integrationId: string,
    actorId: string | null,
    meta: { ip: string; userAgent: string },
    deadline: number,
  ): Promise<RegistrarSyncResult> {
    const integration = await this.prisma.integration.findUnique({
      where: { id: integrationId },
    });
    if (!integration) throw new NotFoundException(`Integration ${integrationId} not found`);
    if (integration.driver !== 'cloudflare') {
      throw new BadRequestException(`Integration ${integrationId} is not a Cloudflare integration.`);
    }
    if (integration.status !== 'ACTIVE') {
      throw new BadRequestException(`Integration ${integrationId} is not active.`);
    }

    const ctx = await this.integrations.loadDriverContext(integrationId);
    const config = cloudflareConfigSchema.parse(ctx.config);
    const result: RegistrarSyncResult = {
      enabled: false,
      created: 0,
      updated: 0,
      adopted: 0,
      missing: 0,
    };
    if (!config.domainsCompanySlug) return result;
    result.enabled = true;

    const company = await this.prisma.company.findUnique({
      where: { slug: config.domainsCompanySlug },
      select: { id: true, archivedAt: true },
    });
    if (!company || company.archivedAt) {
      throw new BadRequestException(
        `Domain sync company "${config.domainsCompanySlug}" does not exist or is archived.`,
      );
    }

    const driver = this.drivers.getSecurity(integration.driver);
    const domains = await driver.listRegistrarDomains(
      ctx.config,
      ctx.secret,
      {
        timeoutMs: this.env.values.INTEGRATION_HTTP_TIMEOUT_MS,
        maxRetries: this.env.values.INTEGRATION_HTTP_MAX_RETRIES,
        backoffMs: this.env.values.INTEGRATION_HTTP_BACKOFF_MS,
      },
      randomUUID(),
    );

    const now = new Date();
    const seen = new Set<string>();
    const createdNames: string[] = [];
    const adoptedNames: string[] = [];

    for (const d of domains) {
      if (Date.now() > deadline) {
        // Past here the lock may lapse; stop rather than race a new run.
        // Rows not reached are untouched and picked up next sweep. No
        // missing-stamping either, since `seen` is incomplete.
        throw new Error(`Registrar sync exceeded its time budget (integration=${integrationId})`);
      }
      const parsed = domainHostnameSchema.safeParse(d.name);
      if (!parsed.success) {
        this.logger.warn(`Skipping unparseable Cloudflare domain name (integration=${integrationId})`);
        continue;
      }
      const hostname = parsed.data;
      seen.add(hostname);

      const registrarData = {
        source: 'CLOUDFLARE' as const,
        integrationId,
        cloudflareAccountId: config.accountId,
        registrar: d.cloudflareRegistration ? 'Cloudflare' : d.registrar,
        registrarAutoRenew: d.autoRenew,
        registrarLocked: d.locked,
        registrarRegisteredAt: d.registeredAt,
        registrarExpiresAt: d.expiresAt,
        registrarStatuses: d.registryStatuses,
        nameservers: d.nameservers,
        registrarSyncedAt: now,
        registrarMissingSince: null,
      } satisfies Prisma.MonitoredDomainUncheckedUpdateInput;

      const candidates = await this.prisma.monitoredDomain.findMany({
        where: { hostname, archivedAt: null },
      });
      const row = pickRow(candidates, integrationId, company.id);

      if (row) {
        const adopting = row.source === 'MANUAL';
        await this.prisma.monitoredDomain.update({ where: { id: row.id }, data: registrarData });
        if (adopting) {
          result.adopted += 1;
          adoptedNames.push(hostname);
        } else {
          result.updated += 1;
        }
      } else if (candidates.length > 0) {
        // Every match belongs to another Cloudflare integration. Creating a
        // second row would show the domain twice under two owners.
        this.logger.warn(
          `Skipping ${hostname}: already synced by another Cloudflare integration (integration=${integrationId})`,
        );
      } else {
        try {
          await this.prisma.monitoredDomain.create({
            data: {
              ...registrarData,
              companyId: company.id,
              hostname,
              createdBy: actorId,
            },
          });
          result.created += 1;
          createdNames.push(hostname);
        } catch (err) {
          // Someone added the same hostname by hand mid-run. Leave it; the
          // next sweep adopts it through pickRow.
          if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
            throw err;
          }
          this.logger.warn(`Skipping ${hostname}: created concurrently (integration=${integrationId})`);
        }
      }
    }

    // Owned rows Cloudflare stopped reporting. Only stamp the first time so
    // the date records when it went missing, not the latest sweep.
    const owned = await this.prisma.monitoredDomain.findMany({
      where: { integrationId, archivedAt: null, registrarMissingSince: null },
      select: { id: true, hostname: true },
    });
    const gone = owned.filter((r) => !seen.has(r.hostname));
    if (gone.length > 0) {
      await this.prisma.monitoredDomain.updateMany({
        where: { id: { in: gone.map((r) => r.id) } },
        data: { registrarMissingSince: now },
      });
      result.missing = gone.length;
    }

    await this.audit.log({
      actorId,
      action: AUDIT_ACTIONS.integration.cloudflareRegistrarSync,
      entityType: 'Integration',
      entityId: integrationId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: {
        ...result,
        seen: seen.size,
        createdHostnames: createdNames,
        adoptedHostnames: adoptedNames,
        missingHostnames: gone.map((r) => r.hostname),
      },
    });

    return result;
  }
}

/**
 * Which existing active row a Cloudflare domain maps to. Hostnames are only
 * unique per company, so there can be several. Preference: the row this
 * integration already owns, then one in the default company, then any MANUAL
 * row (adopted). A row owned by a *different* Cloudflare integration is left
 * alone — two accounts claiming one name is for a human to sort out.
 */
export function pickRow(
  rows: MonitoredDomain[],
  integrationId: string,
  defaultCompanyId: string,
): MonitoredDomain | undefined {
  return (
    rows.find((r) => r.integrationId === integrationId) ??
    rows.find((r) => r.source === 'MANUAL' && r.companyId === defaultCompanyId) ??
    rows.find((r) => r.source === 'MANUAL')
  );
}
