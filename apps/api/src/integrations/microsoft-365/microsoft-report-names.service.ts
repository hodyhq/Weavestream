import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  MICROSOFT_REPORT_SETTING,
  type MicrosoftReportNames,
  type MicrosoftReportNamesAction,
} from '@weavestream/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditLogService } from '../../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../../audit/audit-actions.js';
import { EnvService } from '../../config/env.service.js';
import {
  IntegrationSecretEncryptionService,
  integrationSecretAad,
} from '../../crypto/integration-secret-encryption.service.js';
import { IntegrationsService } from '../integrations.service.js';
import type { AuthedUser } from '../../common/current-user.decorator.js';
import type { RequestMeta } from '../../common/request-meta.js';
import type { IntegrationContext } from '../drivers/integration-driver.js';
import { DriverAuthError, DriverRateLimitError } from '../drivers/integration-driver.js';
import { parseStoredAdminConsent, type StoredAdminConsent } from '../oauth/oauth-token.js';
import { readReportConcealment } from '../drivers/microsoft-365/microsoft-365.graph.js';
import { writeReportConcealment } from '../drivers/microsoft-365/microsoft-365.report-settings.js';

const DRIVER = 'microsoft-365';

export const REPORT_NAMES_READ_ERROR =
  `Weavestream could not read "${MICROSOFT_REPORT_SETTING.label}" for this tenant. Run Check setup, or press Reconnect if ReportSettings.ReadWrite.All was not approved.`;

/** "On (names hidden)" / "Off (real names shown)" for a displayConcealedNames value. */
export function settingState(concealed: boolean): string {
  return concealed ? 'On (names hidden)' : 'Off (real names shown)';
}

/**
 * The admin's choice about the tenant setting "Conceal user, group, and
 * site names in all reports" (Microsoft 365 admin center > Settings > Org
 * settings > Services > Reports; Graph adminReportSettings
 * .displayConcealedNames). Weavestream reads it before asking, and only
 * changes it on an explicit `show` (turn it off) or `conceal` (turn it back
 * on). `keep` records the choice and changes nothing. Every action is
 * audited with the value before and after; the stored choice lives in the
 * encrypted integration secret.
 */
@Injectable()
export class MicrosoftReportNamesService {
  private readonly logger = new Logger(MicrosoftReportNamesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
    private readonly crypto: IntegrationSecretEncryptionService,
    private readonly audit: AuditLogService,
    private readonly env: EnvService,
  ) {}

  /** Current tenant value (read live) and the stored choice. */
  async status(integrationId: string): Promise<MicrosoftReportNames> {
    const { ctx, consent } = await this.load(integrationId);
    const concealed = await this.read(ctx, integrationId);
    return { concealed, choice: consent.reportNames ?? null, readError: concealed === null ? REPORT_NAMES_READ_ERROR : null };
  }

  async apply(
    actor: AuthedUser,
    integrationId: string,
    input: MicrosoftReportNamesAction,
    meta: RequestMeta,
  ): Promise<MicrosoftReportNames> {
    const { ctx, consent } = await this.load(integrationId);
    const auditBase = {
      actorId: actor.id,
      entityType: 'Integration',
      entityId: integrationId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    };
    const detail = {
      tenantId: consent.tenantId,
      setting: MICROSOFT_REPORT_SETTING.label,
      path: MICROSOFT_REPORT_SETTING.path,
      graphProperty: 'displayConcealedNames',
      action: input.action,
    };

    // Read before any change, so the audit row and the answer state the real "before".
    const before = await this.read(ctx, integrationId);
    if (input.action === 'keep') {
      await this.storeChoice(integrationId, consent, 'hidden');
      await this.audit.log({
        ...auditBase,
        action: AUDIT_ACTIONS.integration.microsoftReportNames,
        before: { choice: consent.reportNames ?? null, displayConcealedNames: before },
        after: { ...detail, choice: 'hidden', displayConcealedNames: before, changed: false },
      });
      return {
        concealed: before,
        choice: 'hidden',
        readError: before === null ? REPORT_NAMES_READ_ERROR : null,
        message: `Nothing was changed in the tenant. "${MICROSOFT_REPORT_SETTING.label}" stays ${before === null ? 'as it is' : settingState(before)}.`,
      };
    }

    const conceal = input.action === 'conceal';
    const choice = conceal ? 'hidden' : 'shown';
    if (before === null) {
      await this.audit.log({
        ...auditBase,
        action: AUDIT_ACTIONS.integration.microsoftReportNamesFailed,
        before: null,
        after: { ...detail, reason: 'read_failed' },
      });
      throw new BadRequestException(REPORT_NAMES_READ_ERROR);
    }
    let changed = false;
    if (before !== conceal) {
      try {
        await writeReportConcealment(ctx, conceal);
        changed = true;
      } catch (e) {
        const reason = e instanceof DriverRateLimitError ? 'rate_limited' : e instanceof DriverAuthError ? 'forbidden' : 'provider_error';
        this.logger.warn({ err: (e as Error).message, integrationId, reason }, 'Report setting change failed');
        await this.audit.log({
          ...auditBase,
          action: AUDIT_ACTIONS.integration.microsoftReportNamesFailed,
          before: { displayConcealedNames: before },
          after: { ...detail, reason },
        });
        throw new BadRequestException(
          e instanceof DriverAuthError || e instanceof DriverRateLimitError
            ? e.message
            : 'Microsoft did not accept the change. Try again later.',
        );
      }
    }
    await this.storeChoice(integrationId, consent, choice);
    await this.audit.log({
      ...auditBase,
      action: AUDIT_ACTIONS.integration.microsoftReportNames,
      before: { choice: consent.reportNames ?? null, displayConcealedNames: before },
      after: { ...detail, choice, displayConcealedNames: conceal, changed },
    });
    const state = settingState(conceal);
    return {
      concealed: conceal,
      choice,
      readError: null,
      message: changed
        ? `Done: "${MICROSOFT_REPORT_SETTING.label}" is now ${state} for this tenant. Microsoft applies it within a few minutes; the next sync uses it.`
        : `"${MICROSOFT_REPORT_SETTING.label}" was already ${state}; nothing was changed.`,
    };
  }

  private async load(integrationId: string): Promise<{ ctx: IntegrationContext; consent: StoredAdminConsent }> {
    const loaded = await this.integrations.loadDriverContext(integrationId);
    if (loaded.driver !== DRIVER) throw new BadRequestException('This integration is not Microsoft 365.');
    const consent = parseStoredAdminConsent(loaded.secret);
    if (!consent) throw new BadRequestException('Connect with Microsoft first.');
    return {
      consent,
      ctx: {
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
    };
  }

  /** Null when the setting cannot be read (permission missing, Microsoft unreachable). */
  private async read(ctx: IntegrationContext, integrationId: string): Promise<boolean | null> {
    try {
      return await readReportConcealment(ctx);
    } catch (e) {
      this.logger.warn({ err: (e as Error).message, integrationId }, 'Reading the report setting failed');
      return null;
    }
  }

  private async storeChoice(integrationId: string, consent: StoredAdminConsent, reportNames: 'shown' | 'hidden'): Promise<void> {
    const ciphertext = this.crypto.encrypt(JSON.stringify({ ...consent, reportNames }), integrationSecretAad(integrationId));
    await this.prisma.integrationSecret.update({ where: { integrationId }, data: { ciphertext } });
  }
}
