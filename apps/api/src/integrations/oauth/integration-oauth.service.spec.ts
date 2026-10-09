import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import type { DriverDescriptor, DriverOAuthDescriptor } from '@weavestream/shared';
import {
  setDefaultFetchForTests,
  setDefaultResolveForTests,
} from '../../common/egress/safe-fetch.js';
import { integrationSecretAad } from '../../crypto/integration-secret-encryption.service.js';
import { IntegrationOAuthService, OAUTH_STATE_TTL_SEC, excessScopes, oauthStateKey } from './integration-oauth.service.js';

/**
 * The OAuth framework is exercised with a test-only fake driver: no real
 * OAuth driver is registered yet.
 */
const FAKE_OAUTH: DriverOAuthDescriptor = {
  provider: 'google',
  authorizeUrl: 'https://auth.example.test/authorize?existing=1',
  tokenUrl: 'https://auth.example.test/token',
  revokeUrl: 'https://auth.example.test/revoke',
  scopes: ['openid', 'email', 'scope.read'],
  extraAuthorizeParams: { access_type: 'offline', prompt: 'consent', state: 'attacker', client_id: 'evil' },
};
const FAKE_DRIVER = { key: 'fake-oauth', oauth: FAKE_OAUTH } as unknown as DriverDescriptor;
const PLAIN_DRIVER = { key: 'plain' } as unknown as DriverDescriptor;

const INTEGRATION_ID = '00000000-0000-4000-8000-000000000001';
const USER = { id: 'user-1' } as never;
const OTHER_USER = { id: 'user-2' } as never;
const META = { ip: '127.0.0.1', userAgent: 'jest' };
const CLIENT = { clientId: 'client-1', clientSecret: 'test-client-secret' };

function makeRedis() {
  const store = new Map<string, string>();
  const client = {
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    getdel: jest.fn(async (key: string) => {
      const v = store.get(key) ?? null;
      store.delete(key);
      return v;
    }),
  };
  return { client, store };
}

const crypto = {
  encrypt: (plaintext: string, aad: string) => `enc[${aad}]${plaintext}`,
  decrypt: (blob: string, aad: string) => {
    const prefix = `enc[${aad}]`;
    if (!blob.startsWith(prefix)) throw new Error('aad mismatch');
    return blob.slice(prefix.length);
  },
};

function setup(opts: { driver?: DriverDescriptor; client?: typeof CLIENT | null; secret?: object | null } = {}) {
  const redis = makeRedis();
  const secretRow =
    opts.secret === undefined || opts.secret === null
      ? null
      : { ciphertext: crypto.encrypt(JSON.stringify(opts.secret), integrationSecretAad(INTEGRATION_ID)) };
  const prisma = {
    integration: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        where.id === INTEGRATION_ID
          ? { id: INTEGRATION_ID, driver: (opts.driver ?? FAKE_DRIVER).key, secret: secretRow }
          : null,
      ),
    },
    integrationOAuthApp: {
      findUnique: jest.fn(async () => (opts.client === null ? null : { id: 'app-1' })),
    },
    integrationSecret: {
      upsert: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  const driver = opts.driver ?? FAKE_DRIVER;
  const drivers = { has: () => true, describe: () => driver };
  const audit = { log: jest.fn(async () => undefined) };
  const apps = {
    getClient: jest.fn(async () => (opts.client === undefined ? CLIENT : opts.client)),
    redirectUri: () => 'https://ws.example.test/api/v1/admin/integrations/oauth/callback',
  };
  const env = {
    values: {
      APP_URL: 'https://ws.example.test/',
      INTEGRATION_HTTP_TIMEOUT_MS: 5_000,
      INTEGRATION_HTTP_MAX_RETRIES: 1,
      INTEGRATION_HTTP_BACKOFF_MS: 1,
    },
  };
  const service = new IntegrationOAuthService(
    prisma as never,
    { client: redis.client } as never,
    env as never,
    audit as never,
    crypto as never,
    drivers as never,
    apps as never,
  );
  return { service, redis, prisma, audit, apps };
}

function scriptFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; body?: string }> = [];
  let i = 0;
  setDefaultFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: typeof init?.body === 'string' ? init.body : undefined });
    const next = responses[i++];
    if (!next) throw new Error('unscripted fetch');
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch);
  setDefaultResolveForTests(async () => ['1.2.3.4']);
  return calls;
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  setDefaultFetchForTests(null);
  setDefaultResolveForTests(null);
});

async function startFlow(ctx: ReturnType<typeof setup>) {
  const { authorizeUrl } = await ctx.service.start(USER, INTEGRATION_ID);
  return new URL(authorizeUrl);
}

function idToken(claims: object): string {
  return `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
}

describe('IntegrationOAuthService.start', () => {
  it('builds a PKCE authorize URL and stores single-use state for ten minutes', async () => {
    const ctx = setup();
    const url = await startFlow(ctx);
    expect(url.origin + url.pathname).toBe('https://auth.example.test/authorize');
    expect(url.searchParams.get('existing')).toBe('1');
    expect(url.searchParams.get('access_type')).toBe('offline');
    // Reserved params beat descriptor extras.
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('state')).not.toBe('attacker');
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('openid email scope.read');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://ws.example.test/api/v1/admin/integrations/oauth/callback',
    );
    const state = url.searchParams.get('state')!;
    expect(ctx.redis.client.set).toHaveBeenCalledWith(
      oauthStateKey(state),
      expect.any(String),
      'EX',
      OAUTH_STATE_TTL_SEC,
    );
    const stored = JSON.parse(ctx.redis.store.get(oauthStateKey(state))!);
    expect(stored).toMatchObject({ integrationId: INTEGRATION_ID, userId: 'user-1' });
    // The raw state is never the Redis key.
    expect([...ctx.redis.store.keys()].some((k) => k.includes(state))).toBe(false);
  });

  it('refuses when the instance OAuth app is not configured', async () => {
    await expect(setup({ client: null }).service.start(USER, INTEGRATION_ID)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses drivers without oauth and unknown integrations', async () => {
    await expect(setup({ driver: PLAIN_DRIVER }).service.start(USER, INTEGRATION_ID)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      setup().service.start(USER, '00000000-0000-4000-8000-000000000009'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('IntegrationOAuthService.callback', () => {
  const connected = `https://ws.example.test/admin/integrations/${INTEGRATION_ID}?oauth=connected`;
  const failed = `https://ws.example.test/admin/integrations/${INTEGRATION_ID}?oauth=failed`;

  it('exchanges the code, stores the grant encrypted and audits the connect', async () => {
    const ctx = setup();
    const url = await startFlow(ctx);
    const calls = scriptFetch([
      {
        body: {
          access_token: 'access-1',
          expires_in: 3600,
          refresh_token: 'test-refresh-1',
          scope: 'openid email scope.read',
          id_token: idToken({ email: 'admin@example.test' }),
        },
      },
    ]);
    const landing = await ctx.service.callback(
      USER,
      { code: 'code-1', state: url.searchParams.get('state') },
      META,
    );
    expect(landing).toBe(connected);
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get('code')).toBe('code-1');
    expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const upsert = ctx.prisma.integrationSecret.upsert.mock.calls[0] as unknown as [
      { create: { ciphertext: string } },
    ];
    const plaintext = JSON.parse(crypto.decrypt(upsert[0].create.ciphertext, integrationSecretAad(INTEGRATION_ID)));
    expect(plaintext).toMatchObject({
      refreshToken: 'test-refresh-1',
      grantedScopes: ['openid', 'email', 'scope.read'],
      connectedAs: 'admin@example.test',
    });
    expect(ctx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'integration.oauth.connect', entityId: INTEGRATION_ID }),
    );
    // Audit rows never carry the token.
    expect(JSON.stringify(ctx.audit.log.mock.calls)).not.toContain('test-refresh-1');
  });

  it('rejects a reused state', async () => {
    const ctx = setup();
    const url = await startFlow(ctx);
    scriptFetch([{ body: { access_token: 'a', refresh_token: 'test-refresh-1' } }]);
    const query = { code: 'code-1', state: url.searchParams.get('state') };
    await expect(ctx.service.callback(USER, query, META)).resolves.toBe(connected);
    await expect(ctx.service.callback(USER, query, META)).resolves.toBe(
      'https://ws.example.test/admin/integrations?oauth=failed',
    );
    expect(ctx.prisma.integrationSecret.upsert).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown or expired state without touching the integration', async () => {
    const ctx = setup();
    await expect(
      ctx.service.callback(USER, { code: 'c', state: 'expired-or-forged' }, META),
    ).resolves.toBe('https://ws.example.test/admin/integrations?oauth=failed');
    await expect(ctx.service.callback(USER, {}, META)).resolves.toBe(
      'https://ws.example.test/admin/integrations?oauth=failed',
    );
    expect(ctx.prisma.integrationSecret.upsert).not.toHaveBeenCalled();
  });

  it('rejects a state started by another user and burns it', async () => {
    const ctx = setup();
    const url = await startFlow(ctx);
    const state = url.searchParams.get('state');
    await expect(ctx.service.callback(OTHER_USER, { code: 'c', state }, META)).resolves.toBe(failed);
    expect(ctx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'integration.oauth.connect.failed',
        after: { provider: null, reason: 'user_mismatch' },
      }),
    );
    // The legitimate user cannot complete it afterwards either.
    await expect(ctx.service.callback(USER, { code: 'c', state }, META)).resolves.toBe(
      'https://ws.example.test/admin/integrations?oauth=failed',
    );
    expect(ctx.prisma.integrationSecret.upsert).not.toHaveBeenCalled();
  });

  it('never echoes the provider error', async () => {
    const ctx = setup();
    const url = await startFlow(ctx);
    const landing = await ctx.service.callback(
      USER,
      { error: 'access_denied<script>', state: url.searchParams.get('state') },
      META,
    );
    expect(landing).toBe(failed);
    expect(landing).not.toContain('access_denied');
  });

  it('fails cleanly when the token exchange fails', async () => {
    const ctx = setup();
    const url = await startFlow(ctx);
    scriptFetch([{ status: 400, body: { error: 'invalid_grant', error_description: 'Bad code' } }]);
    const landing = await ctx.service.callback(
      USER,
      { code: 'c', state: url.searchParams.get('state') },
      META,
    );
    expect(landing).toBe(failed);
    expect(ctx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ after: { provider: 'google', reason: 'token_exchange' } }),
    );
    expect(ctx.prisma.integrationSecret.upsert).not.toHaveBeenCalled();
  });

  it('fails when the provider returns no refresh token', async () => {
    const ctx = setup();
    const url = await startFlow(ctx);
    scriptFetch([{ body: { access_token: 'a' } }]);
    await expect(
      ctx.service.callback(USER, { code: 'c', state: url.searchParams.get('state') }, META),
    ).resolves.toBe(failed);
    expect(ctx.prisma.integrationSecret.upsert).not.toHaveBeenCalled();
  });

  it('fails and audits when the grant carries scopes that were not requested', async () => {
    const ctx = setup();
    const url = await startFlow(ctx);
    scriptFetch([{ body: { access_token: 'a', refresh_token: 'test-refresh-1', scope: 'openid scope.read scope.write' } }]);
    await expect(
      ctx.service.callback(USER, { code: 'c', state: url.searchParams.get('state') }, META),
    ).resolves.toBe(failed);
    expect(ctx.prisma.integrationSecret.upsert).not.toHaveBeenCalled();
    expect(ctx.audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'integration.oauth.connect.failed',
      after: { provider: 'google', reason: 'excess_scopes', excessScopes: ['scope.write'] },
    }));
  });

  it('connects with a subset of the requested scopes and Google identity scope names', async () => {
    const ctx = setup();
    const url = await startFlow(ctx);
    scriptFetch([{ body: { access_token: 'a', refresh_token: 'test-refresh-1', scope: 'openid https://www.googleapis.com/auth/userinfo.email' } }]);
    await expect(
      ctx.service.callback(USER, { code: 'c', state: url.searchParams.get('state') }, META),
    ).resolves.toBe(connected);
    expect(ctx.prisma.integrationSecret.upsert).toHaveBeenCalled();
  });
});

describe('excessScopes', () => {
  it('ignores identity scopes and requested ones', () => {
    expect(excessScopes(['openid', 'profile', 'https://www.googleapis.com/auth/userinfo.profile', 'a', 'b'], ['a'])).toEqual(['b']);
  });
});

describe('IntegrationOAuthService.disconnect and status', () => {
  const stored = {
    refreshToken: 'test-refresh-1',
    grantedScopes: ['scope.read'],
    connectedAs: 'admin@example.test',
    connectedAt: '2026-01-01T00:00:00.000Z',
  };

  it('reports the connection without tokens', async () => {
    const status = await setup({ secret: stored }).service.status(INTEGRATION_ID);
    expect(status).toEqual({
      provider: 'google',
      appConfigured: true,
      redirectUri: 'https://ws.example.test/api/v1/admin/integrations/oauth/callback',
      connection: {
        connectedAs: 'admin@example.test',
        connectedAt: '2026-01-01T00:00:00.000Z',
        grantedScopes: ['scope.read'],
      },
    });
    expect(JSON.stringify(status)).not.toContain('test-refresh-1');
  });

  it('revokes at the provider, wipes the secret and audits', async () => {
    const ctx = setup({ secret: stored });
    const calls = scriptFetch([{ body: {} }]);
    await ctx.service.disconnect(USER, INTEGRATION_ID, META);
    expect(calls[0]!.url).toBe('https://auth.example.test/revoke');
    expect(ctx.prisma.integrationSecret.deleteMany).toHaveBeenCalled();
    expect(ctx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'integration.oauth.disconnect',
        after: { provider: 'google', revoked: true },
      }),
    );
  });

  it('still wipes the secret when revocation fails', async () => {
    const ctx = setup({ secret: stored });
    setDefaultResolveForTests(async () => ['1.2.3.4']);
    setDefaultFetchForTests((async () => {
      throw new Error('network down');
    }) as typeof fetch);
    await ctx.service.disconnect(USER, INTEGRATION_ID, META);
    expect(ctx.prisma.integrationSecret.deleteMany).toHaveBeenCalled();
    expect(ctx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ after: { provider: 'google', revoked: false } }),
    );
  });
});
