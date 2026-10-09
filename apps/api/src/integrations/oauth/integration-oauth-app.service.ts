import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  oauthSecretExpiryWarning,
  type IntegrationOAuthApp,
  type IntegrationOAuthProvider,
  type IntegrationSetupCheck,
  type SetupGuideStep,
  type UpdateIntegrationOAuthAppInput,
} from '@weavestream/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  IntegrationSecretEncryptionService,
  integrationOAuthAppSecretAad,
} from '../../crypto/integration-secret-encryption.service.js';
import { AuditLogService } from '../../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../../audit/audit-actions.js';
import { EnvService } from '../../config/env.service.js';
import { IntegrationDriverRegistry } from '../drivers/integration-driver.registry.js';
import type { AuthedUser } from '../../common/current-user.decorator.js';
import type { RequestMeta } from '../../common/request-meta.js';
import { maskSecretTail } from '../../common/redact-secrets.js';
import type { OAuthClientCredentials } from './oauth-token.js';

/** Path (under `API_URL`) the provider redirects back to after consent. */
export const OAUTH_CALLBACK_PATH = '/v1/admin/integrations/oauth/callback';

export const OAUTH_CALLBACK_HOST_WARNING =
  'API_URL and APP_URL must share a host for Connect with Google or Microsoft to keep you signed in.';

/**
 * Session cookies are host-only, so the browser sends them to the callback
 * (built from `API_URL`) only when it is on the same hostname as the web
 * app (`APP_URL`). Ports do not matter to cookies.
 */
export function callbackHostWarning(apiUrl: string, appUrl: string): string | null {
  try {
    return new URL(apiUrl).hostname === new URL(appUrl).hostname ? null : OAUTH_CALLBACK_HOST_WARNING;
  } catch {
    return OAUTH_CALLBACK_HOST_WARNING;
  }
}

/** Append the host warning (if any) to a setup check result as a general failure. */
export function withCallbackHostWarning(
  env: { API_URL: string; APP_URL: string },
  result: IntegrationSetupCheck,
): IntegrationSetupCheck {
  const warning = callbackHostWarning(env.API_URL, env.APP_URL);
  return warning
    ? { ...result, ok: false, failures: [...result.failures, { stepId: null, message: warning }] }
    : result;
}

/**
 * Instance-wide OAuth apps (one client per provider, e.g. Google), shared
 * by every integration whose driver connects through that provider.
 *
 * The client secret is write-only: encrypted under the integrations key
 * with AAD bound to the provider, never returned, never logged. Admins
 * see its last four characters (`maskSecretTail`, the same mask as
 * integration credentials) to confirm which secret is saved.
 */
@Injectable()
export class IntegrationOAuthAppService {
  private readonly logger = new Logger(IntegrationOAuthAppService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: IntegrationSecretEncryptionService,
    private readonly audit: AuditLogService,
    private readonly env: EnvService,
    private readonly drivers: IntegrationDriverRegistry,
  ) {}

  /** The callback URL to register with every provider. */
  redirectUri(): string {
    return `${this.env.values.API_URL.replace(/\/+$/, '')}${OAUTH_CALLBACK_PATH}`;
  }

  /** Fixed warning when the callback host cannot see the session cookie, else null. */
  callbackHostWarning(): string | null {
    return callbackHostWarning(this.env.values.API_URL, this.env.values.APP_URL);
  }

  /** Union of the scopes requested by every registered driver of `provider`. */
  scopesFor(provider: IntegrationOAuthProvider): string[] {
    const scopes = this.drivers
      .list()
      .filter((d) => d.oauth?.provider === provider)
      .flatMap((d) => d.oauth!.scopes);
    return [...new Set(scopes)];
  }

  /**
   * Scopes grouped by driver in registry order. A later driver's group only
   * lists scopes no earlier group covers; a driver adding none is skipped.
   */
  scopeGroupsFor(provider: IntegrationOAuthProvider): { label: string; scopes: string[] }[] {
    // A driver may group its own permissions by purpose (Microsoft); the
    // first driver of the provider that does so decides the grouping.
    const declared = this.drivers.list().find((d) => d.oauth?.provider === provider && d.oauth.scopeGroups)?.oauth?.scopeGroups;
    if (declared) return declared.map((g) => ({ label: g.label, scopes: [...g.scopes] }));
    const seen = new Set<string>();
    const groups: { label: string; scopes: string[] }[] = [];
    for (const d of this.drivers.list().filter((x) => x.oauth?.provider === provider)) {
      const fresh = d.oauth!.scopes.filter((s) => !seen.has(s));
      fresh.forEach((s) => seen.add(s));
      if (fresh.length > 0) {
        groups.push({ label: groups.length === 0 ? 'Required' : `Only if you use ${d.label}`, scopes: fresh });
      }
    }
    return groups;
  }

  /** Setup guide of the first registered driver of `provider` that ships one. */
  setupGuideFor(provider: IntegrationOAuthProvider): SetupGuideStep[] | undefined {
    return this.drivers.list().find((d) => d.oauth?.provider === provider && d.setupGuide)?.setupGuide;
  }

  async get(provider: IntegrationOAuthProvider): Promise<IntegrationOAuthApp> {
    const row = await this.prisma.integrationOAuthApp.findUnique({ where: { provider } });
    const setupGuide = this.setupGuideFor(provider);
    let secretMask: string | null = null;
    if (row) {
      try {
        secretMask = maskSecretTail(
          this.crypto.decrypt(row.secretCiphertext, integrationOAuthAppSecretAad(provider)),
        );
      } catch (e) {
        // The row stays "configured"; the missing mask tells the
        // admin to save the secret again.
        this.logger.error(
          { err: (e as Error).message, provider },
          'failed to decrypt integration OAuth app secret',
        );
      }
    }
    const secretExpiresAt = row?.secretExpiresAt ? row.secretExpiresAt.toISOString().slice(0, 10) : null;
    return {
      provider,
      secretExpiresAt,
      secretExpiryWarning: oauthSecretExpiryWarning(secretExpiresAt),
      tenantId: row?.tenantId ?? null,
      configured: Boolean(row),
      clientId: row?.clientId ?? null,
      secretMask,
      redirectUri: this.redirectUri(),
      callbackHostWarning: this.callbackHostWarning(),
      scopes: this.scopesFor(provider),
      scopeGroups: this.scopeGroupsFor(provider),
      updatedAt: row ? row.updatedAt.toISOString() : null,
      ...(setupGuide ? { setupGuide } : {}),
    };
  }

  async update(
    actor: AuthedUser,
    provider: IntegrationOAuthProvider,
    input: UpdateIntegrationOAuthAppInput,
    meta: RequestMeta,
  ): Promise<IntegrationOAuthApp> {
    const before = await this.prisma.integrationOAuthApp.findUnique({
      where: { provider },
      select: { clientId: true, secretExpiresAt: true, tenantId: true },
    });
    // Omitted = keep, null = clear. Stored as a DATE (UTC midnight). A new
    // secret without a date clears the old one: that date was the old secret's.
    const expiry = input.secretExpiresAt === undefined && input.clientSecret !== undefined ? null : input.secretExpiresAt;
    const extra = {
      ...(expiry !== undefined
        ? { secretExpiresAt: expiry === null ? null : new Date(`${expiry}T00:00:00.000Z`) }
        : {}),
      ...(input.tenantId !== undefined ? { tenantId: input.tenantId === null ? null : input.tenantId.toLowerCase() } : {}),
    };
    if (input.clientSecret === undefined) {
      if (!before) {
        throw new BadRequestException('Enter the client secret.');
      }
      // Keep the stored secret; only the client ID (and the plain fields) change.
      await this.prisma.integrationOAuthApp.update({
        where: { provider },
        data: { clientId: input.clientId, ...extra, updatedBy: actor.id },
      });
    } else {
      const secretCiphertext = this.crypto.encrypt(
        input.clientSecret,
        integrationOAuthAppSecretAad(provider),
      );
      await this.prisma.integrationOAuthApp.upsert({
        where: { provider },
        create: { provider, clientId: input.clientId, secretCiphertext, ...extra, updatedBy: actor.id },
        update: { clientId: input.clientId, secretCiphertext, ...extra, updatedBy: actor.id },
      });
    }
    const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.settings.integrationOAuthAppUpdate,
      entityType: 'IntegrationOAuthApp',
      entityId: provider,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: before
        ? { provider, clientId: before.clientId, secretExpiresAt: day(before.secretExpiresAt), tenantId: before.tenantId }
        : null,
      after: {
        provider,
        clientId: input.clientId,
        ...(expiry !== undefined ? { secretExpiresAt: expiry } : {}),
        ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
        ...(input.clientSecret === undefined
          ? { secretKept: true }
          : { secretMask: maskSecretTail(input.clientSecret) }),
      },
    });
    return this.get(provider);
  }

  /**
   * Check setup for the instance OAuth app (no customer token): the first
   * driver of `provider` with a `diagnose()` verifies the client against
   * the provider. Audited by outcome and failed step ids only.
   */
  async check(actor: AuthedUser, provider: IntegrationOAuthProvider, meta: RequestMeta): Promise<IntegrationSetupCheck> {
    const driver = this.drivers
      .list()
      .filter((d) => d.oauth?.provider === provider && this.drivers.kindOf(d.key) === 'pull')
      .map((d) => this.drivers.get(d.key))
      .find((d) => d.diagnose);
    if (!driver?.diagnose) throw new BadRequestException('This provider has no setup check.');
    const client = await this.getClient(provider);
    const home = client
      ? await this.prisma.integrationOAuthApp.findUnique({ where: { provider }, select: { tenantId: true } })
      : null;
    const result: IntegrationSetupCheck = withCallbackHostWarning(this.env.values, client
      ? await driver.diagnose({
          mode: 'client',
          oauthClient: client,
          redirectUri: this.redirectUri(),
          homeTenantId: home?.tenantId ?? null,
          http: {
            timeoutMs: this.env.values.INTEGRATION_HTTP_TIMEOUT_MS,
            maxRetries: this.env.values.INTEGRATION_HTTP_MAX_RETRIES,
            backoffMs: this.env.values.INTEGRATION_HTTP_BACKOFF_MS,
          },
          correlationId: randomUUID(),
        })
      : {
          ok: false,
          passedStepIds: [],
          failures: [{ stepId: 'credentials', message: 'Save the client ID and client secret first, then check again.' }],
        });
    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.settings.integrationOAuthAppCheck,
      entityType: 'IntegrationOAuthApp',
      entityId: provider,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: { provider, ok: result.ok, failedStepIds: result.failures.map((f) => f.stepId) },
    });
    return result;
  }

  /**
   * Decrypted client credentials for runtime use (authorize, token
   * exchange, refresh). Null when the provider has no app configured.
   */
  async getClient(provider: IntegrationOAuthProvider): Promise<OAuthClientCredentials | null> {
    const row = await this.prisma.integrationOAuthApp.findUnique({ where: { provider } });
    if (!row) return null;
    try {
      return {
        clientId: row.clientId,
        clientSecret: this.crypto.decrypt(
          row.secretCiphertext,
          integrationOAuthAppSecretAad(provider),
        ),
        version: `${row.id}@${row.updatedAt.toISOString()}`,
      };
    } catch (e) {
      this.logger.error(
        { err: (e as Error).message, provider },
        'failed to decrypt integration OAuth app secret',
      );
      throw new ConflictException(
        'The stored OAuth app secret could not be decrypted. Save it again under Settings.',
      );
    }
  }
}
