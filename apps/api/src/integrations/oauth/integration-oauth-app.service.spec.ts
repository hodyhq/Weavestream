import { ConflictException, Logger } from '@nestjs/common';
import { integrationOAuthAppSecretAad } from '../../crypto/integration-secret-encryption.service.js';
import { IntegrationOAuthAppService } from './integration-oauth-app.service.js';

const crypto = {
  encrypt: (plaintext: string, aad: string) => `enc[${aad}]${plaintext}`,
  decrypt: (blob: string, aad: string) => {
    const prefix = `enc[${aad}]`;
    if (!blob.startsWith(prefix)) throw new Error('aad mismatch');
    return blob.slice(prefix.length);
  },
};

function setup(row: { clientId: string; secretCiphertext: string; updatedAt: Date } | null = null) {
  let stored = row;
  const prisma = {
    integrationOAuthApp: {
      findUnique: jest.fn(async () => stored),
      upsert: jest.fn(async ({ create }: { create: { clientId: string; secretCiphertext: string } }) => {
        stored = { ...create, updatedAt: new Date('2026-01-02T00:00:00Z') };
        return stored;
      }),
      update: jest.fn(async ({ data }: { data: { clientId: string } }) => {
        stored = { ...stored!, clientId: data.clientId };
        return stored;
      }),
    },
  };
  const audit = { log: jest.fn(async () => undefined) };
  const drivers = {
    list: () => [
      { key: 'a', oauth: { provider: 'google', scopes: ['openid', 'scope.a'] } },
      { key: 'b', oauth: { provider: 'google', scopes: ['openid', 'scope.b'] } },
      { key: 'c' },
    ],
  };
  const env = { values: { API_URL: 'https://ws.example.test/api/' } };
  const service = new IntegrationOAuthAppService(
    prisma as never,
    crypto as never,
    audit as never,
    env as never,
    drivers as never,
  );
  return { service, prisma, audit };
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

describe('IntegrationOAuthAppService', () => {
  it('reports an unconfigured app with the computed redirect URI and scope union', async () => {
    await expect(setup().service.get('google')).resolves.toEqual({
      provider: 'google',
      configured: false,
      clientId: null,
      secretFingerprint: null,
      redirectUri: 'https://ws.example.test/api/v1/admin/integrations/oauth/callback',
      scopes: ['openid', 'scope.a', 'scope.b'],
      updatedAt: null,
    });
  });

  it('saves the secret encrypted with a provider-bound AAD and never returns it', async () => {
    const { service, prisma, audit } = setup();
    const dto = await service.update(
      { id: 'user-1' } as never,
      'google',
      { clientId: 'client-1', clientSecret: 'test-client-secret' },
      { ip: '127.0.0.1', userAgent: 'jest' },
    );
    const call = prisma.integrationOAuthApp.upsert.mock.calls[0] as unknown as [
      { create: { secretCiphertext: string; updatedBy: string } },
    ];
    expect(call[0].create.secretCiphertext).toBe(
      `enc[${integrationOAuthAppSecretAad('google')}]test-client-secret`,
    );
    expect(call[0].create.updatedBy).toBe('user-1');
    expect(dto.configured).toBe(true);
    expect(dto.secretFingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(dto)).not.toContain('test-client-secret');
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'settings.integration_oauth_app.update',
        entityId: 'google',
      }),
    );
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain('test-client-secret');
  });

  it('keeps the stored secret when only the client ID changes', async () => {
    const secretCiphertext = `enc[${integrationOAuthAppSecretAad('google')}]kept-secret`;
    const { service, prisma, audit } = setup({ clientId: 'old-client', secretCiphertext, updatedAt: new Date() });
    const dto = await service.update(
      { id: 'user-1' } as never, 'google', { clientId: 'new-client' }, { ip: '127.0.0.1', userAgent: 'jest' },
    );
    expect(prisma.integrationOAuthApp.upsert).not.toHaveBeenCalled();
    expect(prisma.integrationOAuthApp.update).toHaveBeenCalledWith({
      where: { provider: 'google' },
      data: { clientId: 'new-client', updatedBy: 'user-1' },
    });
    expect(dto.clientId).toBe('new-client');
    await expect(service.getClient('google')).resolves.toEqual({ clientId: 'new-client', clientSecret: 'kept-secret' });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      after: { provider: 'google', clientId: 'new-client', secretKept: true },
    }));
  });

  it('requires a secret on the first save', async () => {
    const { service, prisma } = setup();
    await expect(service.update(
      { id: 'user-1' } as never, 'google', { clientId: 'client-1' }, { ip: '127.0.0.1', userAgent: 'jest' },
    )).rejects.toThrow('Enter the client secret.');
    expect(prisma.integrationOAuthApp.upsert).not.toHaveBeenCalled();
  });

  it('decrypts client credentials for runtime use', async () => {
    const { service } = setup({
      clientId: 'client-1',
      secretCiphertext: crypto.encrypt('test-client-secret', integrationOAuthAppSecretAad('google')),
      updatedAt: new Date(),
    });
    await expect(service.getClient('google')).resolves.toEqual({
      clientId: 'client-1',
      clientSecret: 'test-client-secret',
    });
  });

  it('returns null when no app is configured', async () => {
    await expect(setup().service.getClient('google')).resolves.toBeNull();
  });

  it('refuses a blob bound to another provider', async () => {
    const { service } = setup({
      clientId: 'client-1',
      secretCiphertext: crypto.encrypt('test-client-secret', integrationOAuthAppSecretAad('other')),
      updatedAt: new Date(),
    });
    await expect(service.getClient('google')).rejects.toBeInstanceOf(ConflictException);
    await expect(service.get('google')).resolves.toMatchObject({
      configured: true,
      secretFingerprint: null,
    });
  });

  describe('check (Check setup)', () => {
    const guide = [{ id: 'credentials', title: 'Paste', body: 'Paste it.' }];
    function checkSetup(row: Parameters<typeof setup>[0], diagnose = jest.fn(async () => ({ ok: true, passedStepIds: ['client'], failures: [] }))) {
      const ctx = setup(row);
      const drivers = (ctx.service as unknown as { drivers: Record<string, unknown> }).drivers;
      // A first Google driver without diagnose() must not hide the one that has it.
      drivers.list = () => [
        { key: 'other', oauth: { provider: 'google', scopes: ['openid'] } },
        { key: 'gw', oauth: { provider: 'google', scopes: ['openid'] }, setupGuide: guide },
      ];
      drivers.kindOf = () => 'pull';
      drivers.get = (key: string) => (key === 'gw' ? { diagnose } : {});
      (ctx.service as unknown as { env: { values: Record<string, unknown> } }).env.values = {
        API_URL: 'https://ws.example.test/api/', INTEGRATION_HTTP_TIMEOUT_MS: 5_000, INTEGRATION_HTTP_MAX_RETRIES: 0, INTEGRATION_HTTP_BACKOFF_MS: 1,
      };
      return { ...ctx, diagnose };
    }
    const actor = { id: 'user-1' } as never;
    const meta = { ip: '127.0.0.1', userAgent: 'jest' };

    it('runs the driver client check with the decrypted client and redirect URI, and audits the outcome only', async () => {
      const { service, diagnose, audit } = checkSetup({
        clientId: 'client-1', secretCiphertext: `enc[${integrationOAuthAppSecretAad('google')}]shh-secret`, updatedAt: new Date(),
      });
      await expect(service.check(actor, 'google', meta)).resolves.toEqual({ ok: true, passedStepIds: ['client'], failures: [] });
      expect(diagnose).toHaveBeenCalledWith(expect.objectContaining({
        mode: 'client',
        oauthClient: { clientId: 'client-1', clientSecret: 'shh-secret' },
        redirectUri: 'https://ws.example.test/api/v1/admin/integrations/oauth/callback',
      }));
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
        action: 'settings.integration_oauth_app.check',
        after: { provider: 'google', ok: true, failedStepIds: [] },
      }));
      expect(JSON.stringify(audit.log.mock.calls)).not.toContain('shh-secret');
    });

    it('fails the credentials step without calling Google when nothing is saved', async () => {
      const { service, diagnose } = checkSetup(null);
      await expect(service.check(actor, 'google', meta)).resolves.toMatchObject({
        ok: false, failures: [{ stepId: 'credentials' }],
      });
      expect(diagnose).not.toHaveBeenCalled();
    });

    it('returns the driver setup guide with the app view', async () => {
      const { service } = checkSetup(null);
      await expect(service.get('google')).resolves.toMatchObject({ setupGuide: guide });
    });
  });
});
