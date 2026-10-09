import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  IntegrationOAuthApp,
  IntegrationOAuthProvider,
  UpdateIntegrationOAuthAppInput,
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
import type { OAuthClientCredentials } from './oauth-token.js';

/** Path (under `API_URL`) the provider redirects back to after consent. */
export const OAUTH_CALLBACK_PATH = '/v1/admin/integrations/oauth/callback';

/**
 * Instance-wide OAuth apps (one client per provider, e.g. Google), shared
 * by every integration whose driver connects through that provider.
 *
 * The client secret is write-only: encrypted under the integrations key
 * with AAD bound to the provider, never returned, never logged. Admins
 * see a SHA-256 prefix to confirm which secret is saved.
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

  /** Union of the scopes requested by every registered driver of `provider`. */
  scopesFor(provider: IntegrationOAuthProvider): string[] {
    const scopes = this.drivers
      .list()
      .filter((d) => d.oauth?.provider === provider)
      .flatMap((d) => d.oauth!.scopes);
    return [...new Set(scopes)];
  }

  async get(provider: IntegrationOAuthProvider): Promise<IntegrationOAuthApp> {
    const row = await this.prisma.integrationOAuthApp.findUnique({ where: { provider } });
    let secretFingerprint: string | null = null;
    if (row) {
      try {
        secretFingerprint = fingerprint(
          this.crypto.decrypt(row.secretCiphertext, integrationOAuthAppSecretAad(provider)),
        );
      } catch (e) {
        // The row stays "configured"; the missing fingerprint tells the
        // admin to save the secret again.
        this.logger.error(
          { err: (e as Error).message, provider },
          'failed to decrypt integration OAuth app secret',
        );
      }
    }
    return {
      provider,
      configured: Boolean(row),
      clientId: row?.clientId ?? null,
      secretFingerprint,
      redirectUri: this.redirectUri(),
      scopes: this.scopesFor(provider),
      updatedAt: row ? row.updatedAt.toISOString() : null,
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
      select: { clientId: true },
    });
    const secretCiphertext = this.crypto.encrypt(
      input.clientSecret,
      integrationOAuthAppSecretAad(provider),
    );
    await this.prisma.integrationOAuthApp.upsert({
      where: { provider },
      create: { provider, clientId: input.clientId, secretCiphertext, updatedBy: actor.id },
      update: { clientId: input.clientId, secretCiphertext, updatedBy: actor.id },
    });
    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.settings.integrationOAuthAppUpdate,
      entityType: 'IntegrationOAuthApp',
      entityId: provider,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: before ? { provider, clientId: before.clientId } : null,
      after: {
        provider,
        clientId: input.clientId,
        secretFingerprint: fingerprint(input.clientSecret),
      },
    });
    return this.get(provider);
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

function fingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 12);
}
