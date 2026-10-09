import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  DriverOAuthDescriptor,
  IntegrationOAuthStartResponse,
  IntegrationOAuthStatus,
} from '@weavestream/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RedisService } from '../../redis/redis.service.js';
import { EnvService } from '../../config/env.service.js';
import { AuditLogService } from '../../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../../audit/audit-actions.js';
import {
  IntegrationSecretEncryptionService,
  integrationSecretAad,
} from '../../crypto/integration-secret-encryption.service.js';
import { IntegrationDriverRegistry } from '../drivers/integration-driver.registry.js';
import type { AuthedUser } from '../../common/current-user.decorator.js';
import type { RequestMeta } from '../../common/request-meta.js';
import { IntegrationOAuthAppService } from './integration-oauth-app.service.js';
import {
  connectedAsFromIdToken,
  exchangeAuthorizationCode,
  parseStoredOAuthSecret,
  revokeOAuthToken,
  type StoredOAuthSecret,
} from './oauth-token.js';

/** Authorization requests expire after ten minutes. */
export const OAUTH_STATE_TTL_SEC = 600;

/**
 * Pending authorization requests live in Redis under a SHA-256 of the
 * state, so lookup is an exact key match (no timing-sensitive compare in
 * process) and a Redis dump never holds a usable state value.
 */
export function oauthStateKey(state: string): string {
  return `integration-oauth:state:${createHash('sha256').update(state).digest('hex')}`;
}

const pendingStateSchema = z.object({
  integrationId: z.string().uuid(),
  userId: z.string().min(1),
  codeVerifier: z.string().min(43).max(128),
});

export interface OAuthCallbackQuery {
  code?: unknown;
  state?: unknown;
  error?: unknown;
}

type FailureReason =
  | 'state_invalid'
  | 'user_mismatch'
  | 'provider_denied'
  | 'not_oauth'
  | 'app_not_configured'
  | 'token_exchange'
  | 'no_refresh_token'
  | 'excess_scopes';

/** Identity scopes and the names Google reports them under; never counted as excess. */
const IDENTITY_SCOPES = new Set([
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
]);

/** Granted scopes outside what the descriptor requested (identity scopes ignored). */
export function excessScopes(granted: readonly string[], requested: readonly string[]): string[] {
  const allowed = new Set(requested);
  return granted.filter((scope) => !allowed.has(scope) && !IDENTITY_SCOPES.has(scope));
}

/**
 * Authorization-code flow (with PKCE S256) for drivers whose descriptor
 * declares `oauth`: start, callback, disconnect, status.
 *
 * The state is 32 random bytes, single use (Redis GETDEL), valid for ten
 * minutes, and bound to the integration and the user who started the
 * flow. The callback only accepts it from that same signed-in user. The
 * resulting refresh token is stored encrypted in `IntegrationSecret`.
 * Provider error text is never echoed: the browser lands on the
 * integration page with `?oauth=connected` or `?oauth=failed`.
 */
@Injectable()
export class IntegrationOAuthService {
  private readonly logger = new Logger(IntegrationOAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly env: EnvService,
    private readonly audit: AuditLogService,
    private readonly crypto: IntegrationSecretEncryptionService,
    private readonly drivers: IntegrationDriverRegistry,
    private readonly apps: IntegrationOAuthAppService,
  ) {}

  async status(integrationId: string): Promise<IntegrationOAuthStatus> {
    const { row, oauth } = await this.requireOAuthIntegration(integrationId);
    const client = await this.prisma.integrationOAuthApp.findUnique({
      where: { provider: oauth.provider },
      select: { id: true },
    });
    const stored = row.secret ? this.decryptStored(row.id, row.secret.ciphertext) : null;
    return {
      provider: oauth.provider,
      appConfigured: Boolean(client),
      redirectUri: this.apps.redirectUri(),
      connection: stored
        ? {
            connectedAs: stored.connectedAs ?? null,
            connectedAt: stored.connectedAt,
            grantedScopes: stored.grantedScopes,
          }
        : null,
    };
  }

  async start(actor: AuthedUser, integrationId: string): Promise<IntegrationOAuthStartResponse> {
    const { oauth } = await this.requireOAuthIntegration(integrationId);
    const client = await this.apps.getClient(oauth.provider);
    if (!client) {
      throw new BadRequestException(
        'The OAuth app for this provider is not configured. An administrator can set it up under Settings.',
      );
    }
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    await this.redis.client.set(
      oauthStateKey(state),
      JSON.stringify({ integrationId, userId: actor.id, codeVerifier }),
      'EX',
      OAUTH_STATE_TTL_SEC,
    );

    const url = new URL(oauth.authorizeUrl);
    for (const [k, v] of Object.entries(oauth.extraAuthorizeParams ?? {})) {
      url.searchParams.set(k, v);
    }
    // Reserved parameters are set last so a descriptor can never override them.
    url.searchParams.set('client_id', client.clientId);
    url.searchParams.set('redirect_uri', this.apps.redirectUri());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', oauth.scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { authorizeUrl: url.toString() };
  }

  /**
   * Complete the flow. Never throws: always returns the absolute web URL
   * to redirect the browser to.
   */
  async callback(actor: AuthedUser, query: OAuthCallbackQuery, meta: RequestMeta): Promise<string> {
    const state = typeof query.state === 'string' && query.state.length <= 256 ? query.state : null;
    if (!state) return this.landing(null, false);

    let pending: z.infer<typeof pendingStateSchema> | null = null;
    try {
      const raw = await this.redis.client.getdel(oauthStateKey(state));
      const parsed = raw ? pendingStateSchema.safeParse(JSON.parse(raw)) : null;
      pending = parsed?.success ? parsed.data : null;
    } catch (e) {
      this.logger.error({ err: (e as Error).message }, 'OAuth state lookup failed');
    }
    if (!pending) {
      // Unknown, expired or already used. No integration to attribute it to.
      this.logger.warn({ userId: actor.id }, 'OAuth callback with an invalid or reused state');
      return this.landing(null, false);
    }
    const { integrationId } = pending;
    const fail = async (reason: FailureReason, provider: string | null, extra: Record<string, unknown> = {}) => {
      await this.audit.log({
        actorId: actor.id,
        action: AUDIT_ACTIONS.integration.oauthConnectFailed,
        entityType: 'Integration',
        entityId: integrationId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: null,
        after: { provider, reason, ...extra },
      });
      return this.landing(integrationId, false);
    };

    if (pending.userId !== actor.id) return fail('user_mismatch', null);
    if (query.error !== undefined) return fail('provider_denied', null);
    const code = typeof query.code === 'string' && query.code.length <= 2048 ? query.code : null;
    if (!code) return fail('provider_denied', null);

    let oauth: DriverOAuthDescriptor;
    try {
      ({ oauth } = await this.requireOAuthIntegration(integrationId));
    } catch {
      // Deleted mid-flow, or its driver no longer uses OAuth.
      return fail('not_oauth', null);
    }
    let client;
    try {
      client = await this.apps.getClient(oauth.provider);
    } catch {
      client = null;
    }
    if (!client) return fail('app_not_configured', oauth.provider);

    const correlationId = randomUUID();
    let tokens;
    try {
      tokens = await exchangeAuthorizationCode(
        oauth,
        client,
        { code, codeVerifier: pending.codeVerifier, redirectUri: this.apps.redirectUri() },
        this.httpDefaults(),
        correlationId,
      );
    } catch (e) {
      this.logger.warn(
        { err: (e as Error).message, integrationId, correlationId },
        'OAuth code exchange failed',
      );
      return fail('token_exchange', oauth.provider);
    }
    if (!tokens.refresh_token) return fail('no_refresh_token', oauth.provider);

    const grantedScopes = tokens.scope
      ? tokens.scope.split(/\s+/).filter(Boolean).slice(0, 100)
      : oauth.scopes;
    // A grant wider than requested is never stored. A narrower one connects;
    // Check setup then reports the missing permissions.
    const excess = excessScopes(grantedScopes, oauth.scopes);
    if (excess.length > 0) return fail('excess_scopes', oauth.provider, { excessScopes: excess.slice(0, 20) });
    const secret: StoredOAuthSecret = {
      refreshToken: tokens.refresh_token,
      grantedScopes,
      connectedAt: new Date().toISOString(),
    };
    const connectedAs = connectedAsFromIdToken(tokens.id_token);
    if (connectedAs) secret.connectedAs = connectedAs;

    const ciphertext = this.crypto.encrypt(JSON.stringify(secret), integrationSecretAad(integrationId));
    await this.prisma.integrationSecret.upsert({
      where: { integrationId },
      create: { integrationId, ciphertext },
      update: { ciphertext },
    });
    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.integration.oauthConnect,
      entityType: 'Integration',
      entityId: integrationId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: { provider: oauth.provider, grantedScopes },
    });
    return this.landing(integrationId, true);
  }

  async disconnect(actor: AuthedUser, integrationId: string, meta: RequestMeta): Promise<void> {
    const { row, oauth } = await this.requireOAuthIntegration(integrationId);
    const stored = row.secret ? this.decryptStored(row.id, row.secret.ciphertext) : null;
    let revoked = false;
    if (stored && oauth.revokeUrl) {
      const correlationId = randomUUID();
      try {
        revoked = await revokeOAuthToken(oauth, stored.refreshToken, this.httpDefaults(), correlationId);
      } catch (e) {
        // Best effort: the local secret is wiped either way, and the
        // provider drops unused grants on its own.
        this.logger.warn(
          { err: (e as Error).message, integrationId, correlationId },
          'OAuth token revocation failed',
        );
      }
    }
    await this.prisma.integrationSecret.deleteMany({ where: { integrationId: { equals: integrationId } } });
    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.integration.oauthDisconnect,
      entityType: 'Integration',
      entityId: integrationId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { connected: Boolean(stored) },
      after: { provider: oauth.provider, revoked },
    });
  }

  private async requireOAuthIntegration(integrationId: string) {
    const row = await this.prisma.integration.findUnique({
      where: { id: integrationId },
      include: { secret: true },
    });
    if (!row) throw new NotFoundException(`Integration ${integrationId} not found`);
    const oauth = this.drivers.has(row.driver) ? this.drivers.describe(row.driver).oauth : undefined;
    if (!oauth) throw new BadRequestException('This integration does not connect with OAuth.');
    return { row, oauth };
  }

  private decryptStored(integrationId: string, ciphertext: string): StoredOAuthSecret | null {
    try {
      return parseStoredOAuthSecret(
        JSON.parse(this.crypto.decrypt(ciphertext, integrationSecretAad(integrationId))),
      );
    } catch (e) {
      this.logger.error(
        { err: (e as Error).message, integrationId },
        'failed to decrypt integration secret',
      );
      throw new ConflictException('Stored integration secret could not be decrypted (key rotated?).');
    }
  }

  private landing(integrationId: string | null, ok: boolean): string {
    const base = this.env.values.APP_URL.replace(/\/+$/, '');
    const path = integrationId ? `/admin/integrations/${integrationId}` : '/admin/integrations';
    return `${base}${path}?oauth=${ok ? 'connected' : 'failed'}`;
  }

  private httpDefaults() {
    return {
      timeoutMs: this.env.values.INTEGRATION_HTTP_TIMEOUT_MS,
      maxRetries: this.env.values.INTEGRATION_HTTP_MAX_RETRIES,
      backoffMs: this.env.values.INTEGRATION_HTTP_BACKOFF_MS,
    };
  }
}
