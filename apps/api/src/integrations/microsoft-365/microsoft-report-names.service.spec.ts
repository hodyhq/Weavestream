import { BadRequestException, Logger } from '@nestjs/common';
import { MICROSOFT_REPORT_SETTING } from '@weavestream/shared';
import { setDefaultFetchForTests, setDefaultResolveForTests } from '../../common/egress/safe-fetch.js';
import { integrationSecretAad } from '../../crypto/integration-secret-encryption.service.js';
import { __resetOAuthAccessTokenCacheForTests } from '../oauth/oauth-token.js';
import { MicrosoftReportNamesService } from './microsoft-report-names.service.js';

const ID = '00000000-0000-4000-8000-000000000091';
const TENANT = '11111111-2222-4333-8444-555555555555';
const SETTINGS_URL = 'https://graph.microsoft.com/v1.0/admin/reportSettings';
const META = { ip: '127.0.0.1', userAgent: 'jest' };
const ACTOR = { id: 'user-1' } as never;

const crypto = {
  encrypt: (plaintext: string, aad: string) => `enc[${aad}]${plaintext}`,
  decrypt: (blob: string, aad: string) => blob.slice(`enc[${aad}]`.length),
};

/** Tenant state behind the scripted Graph: GET reads it, PATCH writes it. */
function graph(initial: boolean | 'forbidden', patchStatus = 204) {
  let concealed = initial;
  const calls: Array<{ method: string; body?: string }> = [];
  setDefaultFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('https://login.microsoftonline.com/')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (url !== SETTINGS_URL) throw new Error(`unscripted ${url}`);
    calls.push({ method, body: typeof init?.body === 'string' ? init.body : undefined });
    if (concealed === 'forbidden') return new Response(JSON.stringify({ error: { code: 'Forbidden', message: 'internal' } }), { status: 403 });
    if (method === 'PATCH') {
      if (patchStatus !== 204) return new Response(JSON.stringify({ error: { code: 'Forbidden' } }), { status: patchStatus });
      concealed = (JSON.parse(String(init?.body)) as { displayConcealedNames: boolean }).displayConcealedNames;
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ displayConcealedNames: concealed }), { status: 200 });
  }) as typeof fetch);
  setDefaultResolveForTests(async () => ['1.2.3.4']);
  return { calls, state: () => concealed };
}

function setup(choice?: 'shown' | 'hidden') {
  let secret: Record<string, unknown> = { tenantId: TENANT, grantedRoles: [], consentedAt: '2026-10-01T00:00:00.000Z', ...(choice ? { reportNames: choice } : {}) };
  const integrations = {
    loadDriverContext: jest.fn(async () => ({
      integrationId: ID,
      driver: 'microsoft-365',
      config: {},
      secret,
      oauthClient: { clientId: 'client-1', clientSecret: 'client-secret-1' },
      credentialVersion: `v-${Math.random()}`,
    })),
  };
  const prisma = {
    integrationSecret: {
      update: jest.fn(async ({ data }: { data: { ciphertext: string } }) => {
        secret = JSON.parse(crypto.decrypt(data.ciphertext, integrationSecretAad(ID)));
        return {};
      }),
    },
  };
  const audit = { log: jest.fn(async () => undefined) };
  const env = { values: { INTEGRATION_HTTP_TIMEOUT_MS: 5_000, INTEGRATION_HTTP_MAX_RETRIES: 0, INTEGRATION_HTTP_BACKOFF_MS: 1 } };
  const service = new MicrosoftReportNamesService(prisma as never, integrations as never, crypto as never, audit as never, env as never);
  return { service, audit, secret: () => secret };
}

beforeEach(() => {
  __resetOAuthAccessTokenCacheForTests();
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  setDefaultFetchForTests(null);
  setDefaultResolveForTests(null);
});

describe('MicrosoftReportNamesService', () => {
  it('names the exact admin-center setting and its Graph property', () => {
    expect(MICROSOFT_REPORT_SETTING.label).toBe('Conceal user, group, and site names in all reports');
    expect(MICROSOFT_REPORT_SETTING.path).toBe('Microsoft 365 admin center > Settings > Org settings > Services > Reports');
    expect(MICROSOFT_REPORT_SETTING.graph).toContain('displayConcealedNames');
  });

  it('reads the current tenant value before asking (GET only)', async () => {
    const { calls } = graph(true);
    await expect(setup().service.status(ID)).resolves.toEqual({ concealed: true, choice: null, readError: null });
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('reports an unreadable setting with fixed text naming it', async () => {
    graph('forbidden');
    const status = await setup().service.status(ID);
    expect(status.concealed).toBeNull();
    expect(status.readError).toContain(`"${MICROSOFT_REPORT_SETTING.label}"`);
    expect(status.readError).not.toContain('internal');
  });

  it('show: reads, then PATCHes displayConcealedNames false once, stores the choice and audits before/after', async () => {
    const { calls, state } = graph(true);
    const { service, audit, secret } = setup();
    const result = await service.apply(ACTOR, ID, { action: 'show' }, META);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ displayConcealedNames: false });
    expect(state()).toBe(false);
    expect(secret().reportNames).toBe('shown');
    expect(result).toMatchObject({ concealed: false, choice: 'shown' });
    expect(result.message).toBe(`Done: "${MICROSOFT_REPORT_SETTING.label}" is now Off (real names shown) for this tenant. Microsoft applies it within a few minutes; the next sync uses it.`);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'integration.microsoft.report_names',
      entityId: ID,
      before: { choice: null, displayConcealedNames: true },
      after: expect.objectContaining({
        tenantId: TENANT,
        setting: MICROSOFT_REPORT_SETTING.label,
        path: MICROSOFT_REPORT_SETTING.path,
        graphProperty: 'displayConcealedNames',
        action: 'show',
        displayConcealedNames: false,
        changed: true,
      }),
    }));
  });

  it('keep: changes nothing in the tenant and records the choice', async () => {
    const { calls, state } = graph(true);
    const { service, audit, secret } = setup();
    const result = await service.apply(ACTOR, ID, { action: 'keep' }, META);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    expect(state()).toBe(true);
    expect(secret().reportNames).toBe('hidden');
    expect(result.message).toContain('Nothing was changed in the tenant');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ after: expect.objectContaining({ action: 'keep', changed: false }) }));
  });

  it('keep records that names are shown when the tenant already shows them, still changing nothing', async () => {
    const { calls } = graph(false);
    const { service, secret } = setup();
    const result = await service.apply(ACTOR, ID, { action: 'keep' }, META);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    expect(secret().reportNames).toBe('shown');
    expect(result).toMatchObject({ choice: 'shown', concealed: false });
  });

  it('conceal: turns concealment back on with one audited PATCH', async () => {
    const { calls, state } = graph(false);
    const { service, audit, secret } = setup('shown');
    const result = await service.apply(ACTOR, ID, { action: 'conceal' }, META);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ displayConcealedNames: true });
    expect(state()).toBe(true);
    expect(secret().reportNames).toBe('hidden');
    expect(result.message).toContain('is now On (names hidden)');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      before: { choice: 'shown', displayConcealedNames: false },
      after: expect.objectContaining({ action: 'conceal', displayConcealedNames: true, changed: true }),
    }));
  });

  it('does not PATCH when the tenant already has the wanted value', async () => {
    const { calls } = graph(false);
    const result = await setup().service.apply(ACTOR, ID, { action: 'show' }, META);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    expect(result.message).toContain('was already Off (real names shown); nothing was changed');
  });

  it('audits a refused change and answers with fixed text', async () => {
    graph(true, 403);
    const { service, audit, secret } = setup();
    await expect(service.apply(ACTOR, ID, { action: 'show' }, META)).rejects.toThrow(/ReportSettings\.ReadWrite\.All is not granted/);
    expect(secret().reportNames).toBeUndefined();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'integration.microsoft.report_names.failed', after: expect.objectContaining({ reason: 'forbidden' }) }));
  });

  it('never changes a setting it could not read first', async () => {
    const { calls } = graph('forbidden');
    await expect(setup().service.apply(ACTOR, ID, { action: 'show' }, META)).rejects.toBeInstanceOf(BadRequestException);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });
});
