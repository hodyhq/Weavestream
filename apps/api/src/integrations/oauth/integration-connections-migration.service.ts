import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditLogService } from '../../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../../audit/audit-actions.js';
import {
  IntegrationSecretEncryptionService,
  integrationConnectionSecretAad,
  integrationSecretAad,
} from '../../crypto/integration-secret-encryption.service.js';
import { IntegrationDriverRegistry } from '../drivers/integration-driver.registry.js';
import { IntegrationOAuthAppService } from './integration-oauth-app.service.js';
import { isAdminConsent, parseStoredAdminConsent, parseStoredOAuthSecret } from './oauth-token.js';

/** Arbitrary constant for `pg_advisory_xact_lock`: one migrating API process at a time. */
const MIGRATION_LOCK_KEY = 0x0c0e_c710;

/** What one run did, per provider. Ids and reasons only; never secrets. */
export interface ConnectionsMigrationReport {
  appsAdopted: string[];
  connectionsCreated: Array<{ integrationId: string; connectionId: string; externalOrgId: string }>;
  /** Integrations (or app rows) left untouched, with the reason. */
  skipped: Array<{ integrationId: string | null; provider: string; reason: string }>;
}

/**
 * One-shot, idempotent move of pre-connections OAuth data into the
 * connections model. Runs on every API boot; once nothing is left to move it
 * only reads. The encryption keys live in the app env, so this cannot be SQL.
 *
 * Per provider (Google, Microsoft), the oldest integration of that provider
 * is the one kept (later ones are left untouched and reported, so an install
 * that had several keeps working data to look at but must delete the extras):
 *   1. The instance-wide app row (`integration_oauth_apps` with no
 *      integration) is attached to it, its secret re-encrypted from the
 *      provider-bound AAD to the integration-bound AAD.
 *   2. Its stored grant (`integration_secrets`) becomes connection #1, keyed
 *      by the tenant: Microsoft by the consent's verified tenant id, Google by
 *      its single company mapping's external org id (the customer id). The
 *      grant is re-encrypted under the connection AAD and the old secret row
 *      deleted in the same transaction. Report-names choices travel with it.
 * Anything that cannot be keyed safely (unreadable secret, Google with zero
 * or several mappings, a mapping on a different tenant) is left in place and
 * reported: the admin reconnects instead. Non-OAuth integrations are never
 * read. Assets, mappings, sync records and differences are not touched.
 */
@Injectable()
export class IntegrationConnectionsMigrationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(IntegrationConnectionsMigrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: IntegrationSecretEncryptionService,
    private readonly drivers: IntegrationDriverRegistry,
    private readonly apps: IntegrationOAuthAppService,
    private readonly audit: AuditLogService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.run();
    } catch (e) {
      // Never block boot: the old rows stay as they were and the next boot retries.
      this.logger.error({ err: (e as Error).message }, 'integration connections migration failed; will retry on next boot');
    }
  }

  async run(): Promise<ConnectionsMigrationReport> {
    const report: ConnectionsMigrationReport = { appsAdopted: [], connectionsCreated: [], skipped: [] };
    const providers = new Map<string, { keys: string[]; adminConsent: boolean }>();
    for (const d of this.drivers.list()) {
      if (!d.oauth) continue;
      const entry = providers.get(d.oauth.provider) ?? { keys: [], adminConsent: isAdminConsent(d.oauth) };
      entry.keys.push(d.key);
      providers.set(d.oauth.provider, entry);
    }
    if (providers.size === 0) return report;

    await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`;
        for (const [provider, { keys, adminConsent }] of providers) {
          await this.migrateProvider(tx, provider, keys, adminConsent, report);
        }
      },
      { timeout: 60_000 },
    );

    for (const c of report.connectionsCreated) {
      await this.audit.log({
        actorId: null,
        action: AUDIT_ACTIONS.integration.connectionMigrated,
        entityType: 'Integration',
        entityId: c.integrationId,
        ip: null,
        userAgent: 'system:integration-connections-migration',
        before: null,
        after: { connectionId: c.connectionId, tenantId: c.externalOrgId },
      });
    }
    if (report.appsAdopted.length > 0 || report.connectionsCreated.length > 0 || report.skipped.length > 0) {
      this.logger.log(
        {
          appsAdopted: report.appsAdopted,
          connectionsCreated: report.connectionsCreated.map((c) => ({ integrationId: c.integrationId, connectionId: c.connectionId })),
          skipped: report.skipped,
        },
        'integration connections migration',
      );
    }
    return report;
  }

  private async migrateProvider(
    tx: Prisma.TransactionClient,
    provider: string,
    driverKeys: string[],
    adminConsent: boolean,
    report: ConnectionsMigrationReport,
  ): Promise<void> {
    const integrations = await tx.integration.findMany({
      where: { driver: { in: driverKeys } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, secret: { select: { id: true, ciphertext: true } } },
    });
    const [kept, ...extras] = integrations;
    if (!kept) return;
    for (const extra of extras) {
      // Only report what still needs a decision: an extra with legacy data.
      if (extra.secret) {
        report.skipped.push({ integrationId: extra.id, provider, reason: 'another_integration_of_provider' });
      }
    }

    try {
      if (await this.apps.adoptLegacyApp(tx, provider, kept.id)) report.appsAdopted.push(kept.id);
    } catch (e) {
      this.logger.error({ err: (e as Error).message, provider }, 'could not re-encrypt the stored OAuth app secret');
      report.skipped.push({ integrationId: null, provider, reason: 'app_secret_unreadable' });
    }

    if (!kept.secret) return;
    let raw: unknown;
    try {
      raw = JSON.parse(this.crypto.decrypt(kept.secret.ciphertext, integrationSecretAad(kept.id)));
    } catch {
      report.skipped.push({ integrationId: kept.id, provider, reason: 'secret_unreadable' });
      return;
    }
    const mappings = await tx.integrationCompanyMapping.findMany({
      where: { integrationId: kept.id },
      select: { externalOrgId: true, externalOrgName: true },
    });
    const tenants = [...new Map(mappings.map((m) => [m.externalOrgId, m])).values()];

    let externalOrgId: string;
    let displayName: string | null;
    let connectedAt: string;
    if (adminConsent) {
      const consent = parseStoredAdminConsent(raw);
      if (!consent) {
        report.skipped.push({ integrationId: kept.id, provider, reason: 'secret_unparseable' });
        return;
      }
      externalOrgId = consent.tenantId.toLowerCase();
      // Every mapping must already be this tenant: the driver refused any other.
      if (tenants.some((t) => t.externalOrgId.toLowerCase() !== externalOrgId)) {
        report.skipped.push({ integrationId: kept.id, provider, reason: 'mapping_on_other_tenant' });
        return;
      }
      const mapped = tenants[0];
      externalOrgId = mapped ? mapped.externalOrgId : externalOrgId;
      displayName = consent.tenantName ?? mapped?.externalOrgName ?? null;
      connectedAt = consent.consentedAt;
    } else {
      const grant = parseStoredOAuthSecret(raw);
      if (!grant) {
        report.skipped.push({ integrationId: kept.id, provider, reason: 'secret_unparseable' });
        return;
      }
      // The grant does not record its customer id: only a single mapping keys it safely.
      if (tenants.length !== 1) {
        report.skipped.push({
          integrationId: kept.id,
          provider,
          reason: tenants.length === 0 ? 'no_mapping_to_key_by' : 'several_mappings',
        });
        return;
      }
      externalOrgId = tenants[0]!.externalOrgId;
      displayName = tenants[0]!.externalOrgName;
      connectedAt = grant.connectedAt;
    }

    const already = await tx.integrationConnection.findUnique({
      where: { integrationId_externalOrgId: { integrationId: kept.id, externalOrgId } },
      select: { id: true },
    });
    if (already) {
      // Reconnected already under the new model: the newer grant wins; leave the old row for the admin.
      report.skipped.push({ integrationId: kept.id, provider, reason: 'tenant_already_connected' });
      return;
    }
    const connectionId = randomUUID();
    const parsedAt = new Date(connectedAt);
    await tx.integrationConnection.create({
      data: {
        id: connectionId,
        integrationId: kept.id,
        externalOrgId,
        displayName: displayName ? displayName.slice(0, 256) : null,
        secretCiphertext: this.crypto.encrypt(
          JSON.stringify(raw),
          integrationConnectionSecretAad(kept.id, connectionId),
        ),
        status: 'ok',
        connectedAt: Number.isNaN(parsedAt.getTime()) ? new Date() : parsedAt,
      },
    });
    await tx.integrationSecret.deleteMany({ where: { id: kept.secret.id } });
    report.connectionsCreated.push({ integrationId: kept.id, connectionId, externalOrgId });
  }
}
