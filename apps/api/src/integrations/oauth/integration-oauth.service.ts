import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  oauthSecretExpiryWarning,
  type DriverOAuthDescriptor,
  type IntegrationOAuthStartResponse,
  type IntegrationOAuthStatus,
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
  OAuthTokenError,
  TENANT_ID_RE,
  appTokenClaims,
  connectedAsFromIdToken,
  exchangeAuthorizationCode,
  isAdminConsent,
  mintClientCredentialsToken,
  parseStoredAdminConsent,
  parseStoredOAuthSecret,
  revokeOAuthToken,
  type OAuthClientCredentials,
  type StoredAdminConsent,
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

const pendingStateSchema = z.union([
  z.object({
    integrationId: z.string().uuid(),
    userId: z.string().min(1),
    codeVerifier: z.string().min(43).max(128),
  }),
  z.object({
    integrationId: z.string().uuid(),
    userId: z.string().min(1),
    flow: z.literal('admin_consent'),
  }),
]);

export interface OAuthCallbackQuery {
  code?: unknown;
  state?: unknown;
  error?: unknown;
  /** Admin consent (Microsoft): the tenant that consented. Never trusted; verified by token. */
  tenant?: unknown;
  admin_consent?: unknown;
  error_description?: unknown;
}

/**
 * Fixed reason codes the landing URL may carry (`?oauth=failed&reason=`);
 * the web app maps each to fixed text. Provider error text never travels.
 */
export type LandingReason =
  | 'consent_declined'
  | 'admin_required'
  | 'tenant_unverified'
  | 'excess_permissions'
  | 'app_not_configured'
  | 'token_failed';

/** Provider `error` values recorded in the audit row; anything else is 'other'. */
const KNOWN_PROVIDER_ERRORS = new Set([
  'access_denied',
  'invalid_request',
  'invalid_scope',
  'unauthorized_client',
  'consent_required',
  'interaction_required',
  'server_error',
  'temporarily_unavailable',
]);

/** AADSTS codes meaning "an admin who can grant application permissions must approve". */
const ADMIN_REQUIRED_AADSTS = new Set([90094, 90099, 65001]);

/**
 * Classify an admin-consent error callback into fixed values. The
 * description is only scanned for an AADSTS number; it is never stored,
 * logged or echoed.
 */
export function classifyConsentError(query: OAuthCallbackQuery): {
  providerError: string;
  aadsts: number | null;
  landing: LandingReason;
} {
  const raw = typeof query.error === 'string' ? query.error.slice(0, 64) : '';
  const providerError = KNOWN_PROVIDER_ERRORS.has(raw) ? raw : 'other';
  const desc = typeof query.error_description === 'string' ? query.error_description.slice(0, 2048) : '';
  const match = /AADSTS(\d{5,7})/.exec(desc);
  const aadsts = match ? Number(match[1]) : null;
  const landing: LandingReason =
    aadsts !== null && ADMIN_REQUIRED_AADSTS.has(aadsts) ? 'admin_required' : 'consent_declined';
  return { providerError, aadsts, landing };
}

/** Attempts and spacing while a fresh consent propagates (the service principal can lag). */
export const CONSENT_PROPAGATION_ATTEMPTS = 3;
export const CONSENT_PROPAGATION_DELAY_MS = 2_000;

type FailureReason =
  | 'state_invalid'
  | 'user_mismatch'
  | 'provider_denied'
  | 'not_oauth'
  | 'app_not_configured'
  | 'token_exchange'
  | 'no_refresh_token'
  | 'excess_scopes'
  | 'tenant_invalid'
  | 'tenant_mismatch';

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
      select: { id: true, secretExpiresAt: true },
    });
    const base = {
      provider: oauth.provider,
      appConfigured: Boolean(client),
      redirectUri: this.apps.redirectUri(),
      appSecretExpiryWarning: oauthSecretExpiryWarning(client?.secretExpiresAt?.toISOString().slice(0, 10) ?? null),
    };
    if (isAdminConsent(oauth)) {
      const { consent, unreadable } = this.readConsent(row.id, row.secret?.ciphertext);
      return {
        ...base,
        needsReconnect: unreadable,
        connection: consent
          ? {
              connectedAs: consent.tenantName ?? null,
              connectedAt: consent.consentedAt,
              grantedScopes: consent.grantedRoles,
              tenantId: consent.tenantId,
              ...(consent.reportNames ? { reportNames: consent.reportNames } : {}),
            }
          : null,
      };
    }
    const { stored, unreadable } = this.readStored(row.id, row.secret?.ciphertext);
    return {
      ...base,
      needsReconnect: unreadable,
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
    if (isAdminConsent(oauth)) {
      // Admin consent has no code and no PKCE: the state alone binds the
      // round trip to this user and integration.
      await this.redis.client.set(
        oauthStateKey(state),
        JSON.stringify({ integrationId, userId: actor.id, flow: 'admin_consent' }),
        'EX',
        OAUTH_STATE_TTL_SEC,
      );
      const url = new URL(oauth.authorizeUrl);
      url.searchParams.set('client_id', client.clientId);
      url.searchParams.set('scope', oauth.clientCredentialsScope ?? '');
      url.searchParams.set('redirect_uri', this.apps.redirectUri());
      url.searchParams.set('state', state);
      return { authorizeUrl: url.toString() };
    }
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
    const fail = async (
      reason: FailureReason,
      provider: string | null,
      extra: Record<string, unknown> = {},
      landingReason?: LandingReason,
    ) => {
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
      return this.landing(integrationId, false, landingReason);
    };

    if (pending.userId !== actor.id) return fail('user_mismatch', null);
    if ('flow' in pending) return this.adminConsentCallback(actor, integrationId, query, meta, fail);
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
    if (!('codeVerifier' in pending)) return fail('state_invalid', oauth.provider);
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
    // An unreadable secret is still wiped: revocation is skipped (no token
    // to send), and the audit row says why. Admin consent has no token to
    // revoke: the customer removes the enterprise app in their tenant.
    const read = isAdminConsent(oauth)
      ? (() => {
          const r = this.readConsent(row.id, row.secret?.ciphertext);
          return { stored: null, connected: Boolean(r.consent), unreadable: r.unreadable };
        })()
      : (() => {
          const r = this.readStored(row.id, row.secret?.ciphertext);
          return { ...r, connected: Boolean(r.stored) };
        })();
    const { stored, unreadable } = read;
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
      before: { connected: read.connected },
      after: {
        provider: oauth.provider,
        revoked,
        ...(unreadable ? { reason: 'secret_unreadable' } : {}),
      },
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

  /**
   * Decrypt and parse the stored grant. `unreadable` is true when a secret
   * row exists but cannot be decrypted or parsed (key rotated, damaged):
   * the UI then offers Reconnect / Disconnect instead of failing.
   */
  private readStored(
    integrationId: string,
    ciphertext: string | undefined,
  ): { stored: StoredOAuthSecret | null; unreadable: boolean } {
    if (ciphertext === undefined) return { stored: null, unreadable: false };
    let stored: StoredOAuthSecret | null;
    try {
      stored = parseStoredOAuthSecret(
        JSON.parse(this.crypto.decrypt(ciphertext, integrationSecretAad(integrationId))),
      );
    } catch (e) {
      this.logger.error(
        { err: (e as Error).message, integrationId },
        'failed to decrypt integration secret',
      );
      return { stored: null, unreadable: true };
    }
    if (!stored) this.logger.warn({ integrationId }, 'stored OAuth grant does not parse; reconnect needed');
    return { stored, unreadable: !stored };
  }

  /**
   * Admin consent (Microsoft). The callback's `tenant` is only a claim: a
   * client-credentials token is minted for it, the token's `tid` must equal
   * it, and the driver re-reads the tenant through the provider API. The
   * granted application permissions come from the token's `roles`. No user
   * or refresh token is stored.
   */
  private async adminConsentCallback(
    actor: AuthedUser,
    integrationId: string,
    query: OAuthCallbackQuery,
    meta: RequestMeta,
    fail: (reason: FailureReason, provider: string | null, extra?: Record<string, unknown>, landing?: LandingReason) => Promise<string>,
  ): Promise<string> {
    let row;
    let oauth: DriverOAuthDescriptor;
    try {
      ({ row, oauth } = await this.requireOAuthIntegration(integrationId));
    } catch {
      return fail('not_oauth', null);
    }
    if (!isAdminConsent(oauth)) return fail('not_oauth', oauth.provider);
    if (query.error !== undefined) {
      const { providerError, aadsts, landing } = classifyConsentError(query);
      return fail('provider_denied', oauth.provider, { providerError, aadsts }, landing);
    }
    const tenantId =
      typeof query.tenant === 'string' && TENANT_ID_RE.test(query.tenant) ? query.tenant.toLowerCase() : null;
    if (!tenantId || String(query.admin_consent).toLowerCase() !== 'true') {
      return fail('tenant_invalid', oauth.provider, {}, 'tenant_unverified');
    }
    let client: OAuthClientCredentials | null;
    try {
      client = await this.apps.getClient(oauth.provider);
    } catch {
      client = null;
    }
    if (!client) return fail('app_not_configured', oauth.provider, {}, 'app_not_configured');

    const correlationId = randomUUID();
    const driver = this.drivers.kindOf(row.driver) === 'pull' ? this.drivers.get(row.driver) : null;
    let accessToken: string | null = null;
    let roles: string[] = [];
    let tokenTid: string | null = null;
    let lastAadsts: number | null = null;
    // A fresh consent can take a few seconds to reach the token service:
    // retry an unknown-app answer or an empty role list a couple of times.
    for (let attempt = 1; attempt <= CONSENT_PROPAGATION_ATTEMPTS; attempt += 1) {
      try {
        const tokens = await mintClientCredentialsToken(oauth, client, tenantId, this.httpDefaults(), correlationId);
        const claims = appTokenClaims(tokens.access_token);
        accessToken = tokens.access_token;
        roles = claims?.roles ?? [];
        tokenTid = claims?.tid?.toLowerCase() ?? null;
        if (claims?.appId && claims.appId.toLowerCase() !== client.clientId.toLowerCase()) {
          return fail('tenant_mismatch', oauth.provider, { tenantId, check: 'app_id' }, 'tenant_unverified');
        }
        if (roles.length > 0 || !claims || attempt === CONSENT_PROPAGATION_ATTEMPTS) break;
      } catch (e) {
        lastAadsts = e instanceof OAuthTokenError ? e.aadsts : null;
        this.logger.warn(
          { err: (e as Error).message, integrationId, correlationId, attempt },
          'Admin consent token request failed',
        );
        const propagating = lastAadsts === 700016 || lastAadsts === 65001;
        if (!propagating || attempt === CONSENT_PROPAGATION_ATTEMPTS) break;
      }
      await this.sleep(CONSENT_PROPAGATION_DELAY_MS);
    }
    if (!accessToken) {
      return fail('token_exchange', oauth.provider, { tenantId, aadsts: lastAadsts }, 'token_failed');
    }
    if (tokenTid !== null && tokenTid !== tenantId) {
      return fail('tenant_mismatch', oauth.provider, { tenantId, check: 'tid' }, 'tenant_unverified');
    }
    let tenantName: string | null = null;
    if (driver?.verifyConsentedTenant) {
      try {
        ({ tenantName } = await driver.verifyConsentedTenant({
          accessToken,
          tenantId,
          http: this.httpDefaults(),
          correlationId,
        }));
      } catch (e) {
        this.logger.warn({ err: (e as Error).message, integrationId, correlationId }, 'Consented tenant check failed');
        return fail('tenant_mismatch', oauth.provider, { tenantId, check: 'provider' }, 'tenant_unverified');
      }
    } else if (tokenTid === null) {
      // Neither the token nor the driver can prove the tenant: never store it.
      return fail('tenant_mismatch', oauth.provider, { tenantId, check: 'unverifiable' }, 'tenant_unverified');
    }
    const excess = excessScopes(roles, oauth.scopes);
    if (excess.length > 0) {
      return fail('excess_scopes', oauth.provider, { tenantId, excessScopes: excess.slice(0, 20) }, 'excess_permissions');
    }

    // Keep the report-names choice across a reconnect of the same tenant.
    const previous = this.readConsent(integrationId, row.secret?.ciphertext).consent;
    const consent: StoredAdminConsent = {
      tenantId,
      grantedRoles: roles,
      consentedAt: new Date().toISOString(),
      ...(tenantName ? { tenantName: tenantName.slice(0, 256) } : {}),
      ...(previous?.tenantId === tenantId && previous.reportNames ? { reportNames: previous.reportNames } : {}),
    };
    const ciphertext = this.crypto.encrypt(JSON.stringify(consent), integrationSecretAad(integrationId));
    await this.prisma.integrationSecret.upsert({
      where: { integrationId },
      create: { integrationId, ciphertext },
      update: { ciphertext },
    });
    const missing = oauth.scopes.filter((s) => !roles.includes(s));
    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.integration.oauthConnect,
      entityType: 'Integration',
      entityId: integrationId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: { provider: oauth.provider, tenantId, grantedScopes: roles, missingScopes: missing },
    });
    return this.landing(integrationId, true);
  }

  /** Separate so specs can skip the propagation wait. */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Admin-consent counterpart of `readStored`. */
  private readConsent(
    integrationId: string,
    ciphertext: string | undefined,
  ): { consent: StoredAdminConsent | null; unreadable: boolean } {
    if (ciphertext === undefined) return { consent: null, unreadable: false };
    let consent: StoredAdminConsent | null;
    try {
      consent = parseStoredAdminConsent(
        JSON.parse(this.crypto.decrypt(ciphertext, integrationSecretAad(integrationId))),
      );
    } catch (e) {
      this.logger.error({ err: (e as Error).message, integrationId }, 'failed to decrypt integration secret');
      return { consent: null, unreadable: true };
    }
    if (!consent) this.logger.warn({ integrationId }, 'stored admin consent does not parse; reconnect needed');
    return { consent, unreadable: !consent };
  }

  private landing(integrationId: string | null, ok: boolean, reason?: LandingReason): string {
    const base = this.env.values.APP_URL.replace(/\/+$/, '');
    const path = integrationId ? `/admin/integrations/${integrationId}` : '/admin/integrations';
    return `${base}${path}?oauth=${ok ? 'connected' : 'failed'}${!ok && reason ? `&reason=${reason}` : ''}`;
  }

  private httpDefaults() {
    return {
      timeoutMs: this.env.values.INTEGRATION_HTTP_TIMEOUT_MS,
      maxRetries: this.env.values.INTEGRATION_HTTP_MAX_RETRIES,
      backoffMs: this.env.values.INTEGRATION_HTTP_BACKOFF_MS,
    };
  }
}
