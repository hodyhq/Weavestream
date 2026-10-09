import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type MonitoredDomain } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { domainHostnameSchema } from '@weavestream/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditLogService } from '../../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../../audit/audit-actions.js';
import { EnvService } from '../../config/env.service.js';
import { QueuesService } from '../../queues/queues.service.js';
import { IntegrationsService } from '../integrations.service.js';
import { lockDomainHostname } from '../cloudflare/cloudflare-registrar-sync.service.js';
import {
  listWorkspaceDomains,
  type WorkspaceDomain,
} from '../drivers/google-workspace/google-workspace.driver.js';
import { DriverAuthError, DriverRateLimitError } from '../drivers/integration-driver.js';

export interface WorkspaceDomainSyncResult {
  created: number;
  matched: number;
  missing: number;
  skipped: number;
}

const WORKER_META = { ip: '0.0.0.0', userAgent: 'weavestream-worker/integration-sync' };

/**
 * Google Workspace domains → Domains monitoring (MonitoredDomain).
 *
 * Runs once per Google Workspace mapping sync, scoped to the mapping's
 * company only. A verified Workspace domain is matched to an existing row of
 * that company by hostname (manual, Cloudflare or Google-created); a match
 * gains only the `workspace*` columns, so registrar facts, check settings and
 * the row's source stay with whoever owns them (Cloudflare wins). With no
 * match a GOOGLE_WORKSPACE row is created and its first check queued.
 * Archived rows are left alone and block creation, as for Cloudflare.
 *
 * Never deletes: a domain that leaves Workspace has its role cleared and
 * `workspaceMissingSince` stamped.
 */
@Injectable()
export class GoogleWorkspaceDomainSyncService {
  private readonly logger = new Logger(GoogleWorkspaceDomainSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
    private readonly audit: AuditLogService,
    private readonly env: EnvService,
    private readonly queues: QueuesService,
  ) {}

  async syncMapping(mappingId: string, actorId: string | null): Promise<WorkspaceDomainSyncResult> {
    const mapping = await this.prisma.integrationCompanyMapping.findUnique({
      where: { id: mappingId },
      select: {
        id: true,
        companyId: true,
        externalOrgId: true,
        integrationId: true,
        integration: { select: { driver: true } },
        company: { select: { archivedAt: true } },
      },
    });
    const result: WorkspaceDomainSyncResult = { created: 0, matched: 0, missing: 0, skipped: 0 };
    if (!mapping || mapping.integration.driver !== 'google-workspace' || mapping.company.archivedAt) {
      return result;
    }
    const { companyId, integrationId } = mapping;

    const loaded = await this.integrations.loadDriverContext(integrationId);
    const domains = await listWorkspaceDomains(
      {
        config: loaded.config,
        secret: loaded.secret,
        oauthClient: loaded.oauthClient,
        credentialVersion: loaded.credentialVersion,
        integrationId,
        http: {
          timeoutMs: this.env.values.INTEGRATION_HTTP_TIMEOUT_MS,
          maxRetries: this.env.values.INTEGRATION_HTTP_MAX_RETRIES,
          backoffMs: this.env.values.INTEGRATION_HTTP_BACKOFF_MS,
        },
        correlationId: randomUUID(),
      },
      mapping.externalOrgId,
    );

    const now = new Date();
    const seen = new Set<string>();
    const createdIds: string[] = [];
    const createdNames: string[] = [];
    const skipped: Record<string, string> = {};

    for (const domain of domains) {
      const parsed = domainHostnameSchema.safeParse(domain.hostname);
      if (!parsed.success) {
        this.logger.warn(`Skipping unparseable Google Workspace domain (integration=${integrationId})`);
        continue;
      }
      const hostname = parsed.data;
      seen.add(hostname);
      const outcome = await this.writeDomain(companyId, integrationId, hostname, domain, now, actorId);
      if (outcome.kind === 'match') result.matched += 1;
      else if (outcome.kind === 'skip') {
        result.skipped += 1;
        skipped[hostname] = outcome.reason;
      } else {
        result.created += 1;
        createdIds.push(outcome.id);
        createdNames.push(hostname);
      }
    }

    // Rows this integration linked in this company that Workspace no longer
    // reports. Stamp once so the date records when it went missing.
    const linked = await this.prisma.monitoredDomain.findMany({
      where: { companyId, workspaceIntegrationId: integrationId, archivedAt: null, workspaceMissingSince: null },
      select: { id: true, hostname: true },
    });
    const gone = linked.filter((r) => !seen.has(r.hostname.toLowerCase()));
    if (gone.length > 0) {
      await this.prisma.monitoredDomain.updateMany({
        where: { id: { in: gone.map((r) => r.id) }, companyId },
        data: { workspaceRole: null, workspaceAliasOf: null, workspaceMissingSince: now },
      });
      result.missing = gone.length;
    }

    // First WHOIS/DNS/TLS check now, like a manual add. Best effort.
    for (const domainId of createdIds) {
      await this.queues
        .enqueueDomainCheck({ kind: 'single', domainId, actorId })
        .catch((err: unknown) =>
          this.logger.warn(
            `First check for Google Workspace domain ${domainId} not queued: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }

    await this.audit.log({
      actorId,
      action: AUDIT_ACTIONS.integration.googleWorkspaceDomainSync,
      entityType: 'IntegrationCompanyMapping',
      entityId: mapping.id,
      companyId,
      ip: WORKER_META.ip,
      userAgent: WORKER_META.userAgent,
      before: null,
      after: {
        ...result,
        seen: seen.size,
        skipped,
        createdHostnames: createdNames,
        missingHostnames: gone.map((r) => r.hostname),
      },
    });
    return result;
  }

  private async writeDomain(
    companyId: string,
    integrationId: string,
    hostname: string,
    domain: WorkspaceDomain,
    now: Date,
    actorId: string | null,
  ): Promise<WriteOutcome> {
    const workspace = {
      workspaceIntegrationId: integrationId,
      workspaceRole: domain.role,
      workspaceAliasOf: domain.aliasOf,
      workspaceSyncedAt: now,
      workspaceMissingSince: null,
    } satisfies Prisma.MonitoredDomainUncheckedUpdateInput;
    try {
      return await this.prisma.$transaction(async (tx): Promise<WriteOutcome> => {
        // Same lock as the Cloudflare sync: neither can create beside the other.
        await lockDomainHostname(tx, hostname);
        const candidates = await tx.monitoredDomain.findMany({
          where: { companyId, hostname: { equals: hostname, mode: 'insensitive' } },
        });
        const match = matchWorkspaceRow(candidates);
        if (match.kind === 'match') {
          await tx.monitoredDomain.updateMany({ where: { id: match.row.id, companyId }, data: workspace });
          return { kind: 'match' };
        }
        if (match.kind === 'skip') return match;
        const row = await tx.monitoredDomain.create({
          data: {
            ...workspace,
            companyId,
            hostname,
            source: 'GOOGLE_WORKSPACE',
            integrationId,
            createdBy: actorId,
          },
          select: { id: true },
        });
        return { kind: 'create', id: row.id };
      });
    } catch (err) {
      // Added by hand mid-run (manual adds do not take the lock); the unique
      // index refused the duplicate. The next sync matches it.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        this.logger.warn(`Skipping ${hostname}: created concurrently (integration=${integrationId})`);
        return { kind: 'skip', reason: 'created concurrently' };
      }
      throw err;
    }
  }
}

type WriteOutcome = { kind: 'match' } | { kind: 'skip'; reason: string } | { kind: 'create'; id: string };

/**
 * Given every row of the mapped company with this hostname: the active row
 * is matched (whatever its source); only archived rows → skip, so an
 * operator's archive is neither undone nor shadowed by a new row; none →
 * create.
 */
export function matchWorkspaceRow(
  rows: MonitoredDomain[],
): { kind: 'match'; row: MonitoredDomain } | { kind: 'skip'; reason: string } | { kind: 'create' } {
  const active = rows.find((r) => !r.archivedAt);
  if (active) return { kind: 'match', row: active };
  if (rows.length > 0) return { kind: 'skip', reason: 'archived' };
  return { kind: 'create' };
}

/**
 * Run-warning text for a failed domain sync. Driver errors carry fixed,
 * operator-safe text (missing privilege, rate limit, wrong tenant); anything
 * else may hold internal detail and gets a generic line (full error in the
 * worker log).
 */
export function workspaceDomainSyncWarning(err: unknown): string {
  const known = err instanceof DriverAuthError || err instanceof DriverRateLimitError;
  const detail = known ? (err as Error).message : 'an internal error occurred (see the worker log)';
  return `Google Workspace domains were not synced to Domains monitoring: ${detail}`;
}
