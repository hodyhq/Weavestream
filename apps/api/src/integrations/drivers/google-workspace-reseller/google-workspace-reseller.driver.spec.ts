import { driverDescriptorSchema, integrationSectionSchema, type IntegrationSection } from '@weavestream/shared';
import {
  DriverAuthError,
  DriverRateLimitError,
  type FetchRecordsContext,
  type IntegrationContext,
  type LegacyDriverRecord,
} from '../integration-driver.js';
import {
  GOOGLE_WORKSPACE_RESELLER_RECOMMENDED_DESTINATIONS,
  GoogleWorkspaceResellerDriver,
} from './google-workspace-reseller.driver.js';
import { GOOGLE_WORKSPACE_SETUP_GUIDE } from '../google-workspace/google-workspace.setup-guide.js';
import { __resetOAuthAccessTokenCacheForTests } from '../../oauth/oauth-token.js';
import { setDefaultFetchForTests, setDefaultResolveForTests } from '../../../common/egress/safe-fetch.js';

const RESELLER = 'https://reseller.googleapis.com/apps/reseller/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SNAPSHOT = '2026-10-08T12:00:00.000Z';
const ACME = 'C0acme01';
const GLOBEX = 'C0globex1';
const ms = (iso: string) => String(Date.parse(iso));

type Reply = { status?: number; body: unknown } | ((url: string) => { status?: number; body: unknown });
interface Call { url: string; method: string }

/** Scripted fetch table: the longest key prefixing the URL answers; anything else throws. */
function installFetchTable(table: Record<string, Reply>) {
  const calls: Call[] = [];
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  setDefaultFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, method: init?.method ?? 'GET' });
    const key = keys.find((k) => url.startsWith(k));
    if (!key) throw new Error(`reseller driver test: unscripted fetch to ${url}`);
    const entry = table[key]!;
    const reply = typeof entry === 'function' ? entry(url) : entry;
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch);
  setDefaultResolveForTests(async () => ['1.2.3.4']);
  return calls;
}

let seq = 0;
function makeCtx(): IntegrationContext {
  seq += 1;
  return {
    config: {},
    secret: { refreshToken: 'refresh-1', grantedScopes: [], connectedAt: '2026-10-01T00:00:00.000Z' },
    oauthClient: { clientId: 'client-1', clientSecret: 'client-secret-1' },
    integrationId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    correlationId: 'corr-1',
    http: { timeoutMs: 5_000, maxRetries: 1, backoffMs: 1 },
  };
}

function fetchCtx(customerId = ACME): FetchRecordsContext {
  return { ...makeCtx(), externalOrgId: customerId, resourceKey: 'subscriptions', filter: {}, mode: 'full', updatedSince: null, snapshotAt: SNAPSHOT };
}

function sectionOf(rec: LegacyDriverRecord): IntegrationSection {
  const parsed = integrationSectionSchema.safeParse(rec.section);
  if (!parsed.success) throw new Error(`invalid section: ${parsed.error.message}`);
  return parsed.data;
}

function row(section: IntegrationSection, group: string, label: string) {
  return section.groups.find((g) => g.key === group)?.rows.find((r) => r.label === label);
}

const COMMITMENT = {
  customerId: ACME, subscriptionId: 'sub-annual', skuId: '1010020028', customerDomain: 'acme.example.com',
  plan: {
    planName: 'ANNUAL_YEARLY_PAY', isCommitmentPlan: true,
    commitmentInterval: { startTime: ms('2026-01-15T00:00:00Z'), endTime: ms('2027-01-15T00:00:00Z') },
  },
  seats: { numberOfSeats: 25, licensedNumberOfSeats: 20 },
  renewalSettings: { renewalType: 'AUTO_RENEW_YEARLY_PAY' },
  status: 'ACTIVE', purchaseOrderId: 'PO-1001', creationTime: ms('2026-01-15T09:30:00Z'),
};
const FLEXIBLE = {
  customerId: ACME, subscriptionId: 'sub-flex', skuId: '1010020027', skuName: 'Google Workspace Business Starter',
  customerDomain: 'acme.example.com',
  plan: { planName: 'FLEXIBLE', isCommitmentPlan: false },
  seats: { maximumNumberOfSeats: 50, licensedNumberOfSeats: 12 },
  status: 'SUSPENDED', creationTime: ms('2025-06-01T00:00:00Z'),
};
const TRIAL = {
  customerId: ACME, subscriptionId: 'sub-trial', skuId: '1010020025', customerDomain: 'acme.example.com',
  plan: { planName: 'TRIAL', isCommitmentPlan: false },
  seats: { maximumNumberOfSeats: 10, licensedNumberOfSeats: 0 },
  trialSettings: { isInTrial: true, trialEndTime: ms('2026-11-01T00:00:00Z') },
  status: 'ACTIVE',
};
const OTHER = { ...COMMITMENT, customerId: GLOBEX, subscriptionId: 'sub-globex', customerDomain: 'globex.example.com' };

const BASE: Record<string, Reply> = {
  [TOKEN_URL]: { body: { access_token: 'access-1', expires_in: 3600 } },
  [`${RESELLER}/customers/${ACME}`]: { body: { customerId: ACME, customerDomain: 'acme.example.com' } },
};

beforeEach(() => __resetOAuthAccessTokenCacheForTests());
afterEach(() => {
  setDefaultFetchForTests(null);
  setDefaultResolveForTests(null);
});

describe('GoogleWorkspaceResellerDriver descriptor', () => {
  const driver = new GoogleWorkspaceResellerDriver();

  it('validates against the shared schema with the read-only reseller scope', () => {
    const parsed = driverDescriptorSchema.parse(driver.descriptor);
    expect(parsed.key).toBe('google-workspace-reseller');
    expect(parsed.oauth?.provider).toBe('google');
    expect(parsed.oauth?.scopes).toEqual(['openid', 'email', 'https://www.googleapis.com/auth/apps.order.readonly']);
    expect(parsed.resources.map((r) => r.key)).toEqual(['subscriptions']);
    expect(parsed.resources[0]!.matchSuggestions).toMatchObject({ sourceField: 'subscriptionId', layoutHints: expect.arrayContaining(['licenses', 'subscriptions']) });
    expect(parsed.resources[0]!.minimalFields).toEqual(['name', 'subscriptionId']);
    const dest = GOOGLE_WORKSPACE_RESELLER_RECOMMENDED_DESTINATIONS.subscriptions!;
    expect(dest.fields.map((f) => f.sourceField)).toEqual(['name', 'subscriptionId']);
  });

  it('keeps the Google guide step ids and order so Check setup step numbers hold', () => {
    expect(driver.descriptor.setupGuide!.map((s) => s.id)).toEqual(GOOGLE_WORKSPACE_SETUP_GUIDE.map((s) => s.id));
    expect(driver.descriptor.setupGuide!.find((s) => s.id === 'apis')!.links![0]!.href).toContain('reseller.googleapis.com');
  });

  it('offers renewal and trial end as optional mappable dates', async () => {
    const fields = await driver.listSourceFields({ ...makeCtx(), externalOrgId: ACME, resourceKey: 'subscriptions' });
    expect(fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'renewalDate', hintType: 'DATE', alwaysPresent: false }),
      expect.objectContaining({ key: 'trialEndDate', hintType: 'DATE', alwaysPresent: false }),
    ]));
  });
});

describe('GoogleWorkspaceResellerDriver connection', () => {
  it('lists the distinct customers across subscription pages', async () => {
    installFetchTable({
      ...BASE,
      [`${RESELLER}/subscriptions?`]: (url) => new URL(url).searchParams.get('pageToken') === 'p2'
        ? { body: { subscriptions: [OTHER, FLEXIBLE] } }
        : { body: { subscriptions: [COMMITMENT, TRIAL], nextPageToken: 'p2' } },
    });
    await expect(new GoogleWorkspaceResellerDriver().listSourceOrgs(makeCtx())).resolves.toEqual([
      { externalId: ACME, name: 'acme.example.com', hint: ACME },
      { externalId: GLOBEX, name: 'globex.example.com', hint: GLOBEX },
    ]);
  });

  it('turns a 403 into the fixed not-a-reseller message without Google text', async () => {
    installFetchTable({
      ...BASE,
      [`${RESELLER}/subscriptions?`]: { status: 403, body: { error: { code: 403, errors: [{ reason: 'forbidden' }], message: 'raw provider text' } } },
    });
    const error = await new GoogleWorkspaceResellerDriver().testConnection(makeCtx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DriverAuthError);
    expect((error as Error).message).toMatch(/^This Google account is not a Google Workspace reseller/);
    expect((error as Error).message).not.toMatch(/raw provider text/);
  });

  it('names the Reseller API when it is not enabled, and maps rate limits', async () => {
    installFetchTable({
      ...BASE,
      [`${RESELLER}/subscriptions?`]: { status: 403, body: { error: { errors: [{ reason: 'accessNotConfigured' }] } } },
    });
    await expect(new GoogleWorkspaceResellerDriver().testConnection(makeCtx())).rejects.toThrow(/Reseller API is not enabled/);
    installFetchTable({ ...BASE, [`${RESELLER}/subscriptions?`]: { status: 429, body: {} } });
    await expect(new GoogleWorkspaceResellerDriver().testConnection(makeCtx())).rejects.toBeInstanceOf(DriverRateLimitError);
  });
});

describe('GoogleWorkspaceResellerDriver subscriptions', () => {
  it('only fetches the mapped customer and drops any other customer\'s rows', async () => {
    const calls = installFetchTable({ ...BASE, [`${RESELLER}/subscriptions?`]: { body: { subscriptions: [COMMITMENT, OTHER] } } });
    const page = await new GoogleWorkspaceResellerDriver().fetchRecords(fetchCtx(), null);
    expect(page.records.map((r) => r.externalId)).toEqual(['sub-annual']);
    const list = new URL(calls.find((c) => c.url.startsWith(`${RESELLER}/subscriptions?`))!.url);
    expect(list.searchParams.get('customerId')).toBe(ACME);
  });

  it('refuses a customer that is not the reseller\'s', async () => {
    installFetchTable({
      ...BASE,
      [`${RESELLER}/customers/${GLOBEX}`]: { status: 404, body: { error: { message: 'raw provider text' } } },
      [`${RESELLER}/subscriptions?`]: { body: { subscriptions: [OTHER] } },
    });
    const error = await new GoogleWorkspaceResellerDriver().fetchRecords(fetchCtx(GLOBEX), null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DriverAuthError);
    expect((error as Error).message).toMatch(/not one of the connected reseller's customers/);
    await expect(new GoogleWorkspaceResellerDriver().fetchRecords(fetchCtx('../x'), null)).rejects.toBeInstanceOf(DriverAuthError);
  });

  it('walks pages through an opaque cursor', async () => {
    installFetchTable({
      ...BASE,
      [`${RESELLER}/subscriptions?`]: (url) => new URL(url).searchParams.get('pageToken') === 'p2'
        ? { body: { subscriptions: [FLEXIBLE] } }
        : { body: { subscriptions: [COMMITMENT], nextPageToken: 'p2' } },
    });
    const driver = new GoogleWorkspaceResellerDriver();
    const first = await driver.fetchRecords(fetchCtx(), null);
    expect(first.hasMore).toBe(true);
    expect(JSON.parse(Buffer.from(first.cursor!, 'base64').toString('utf8'))).toEqual({ pageToken: 'p2' });
    const second = await driver.fetchRecords(fetchCtx(), first.cursor);
    expect(second).toMatchObject({ hasMore: false, cursor: null });
    expect(second.records.map((r) => r.externalId)).toEqual(['sub-flex']);
  });

  it('commitment plan: seats meter against purchased, renewal date field and section rows', async () => {
    installFetchTable({ ...BASE, [`${RESELLER}/subscriptions?`]: { body: { subscriptions: [COMMITMENT] } } });
    const [rec] = (await new GoogleWorkspaceResellerDriver().fetchRecords(fetchCtx(), null)).records;
    expect(rec!.fields).toEqual({ name: 'Business Standard - acme.example.com', subscriptionId: 'sub-annual', renewalDate: '2027-01-15', trialEndDate: null });
    const s = sectionOf(rec!);
    expect(s.groups.map((g) => g.key)).toEqual(['plan', 'seats', 'dates']);
    expect(row(s, 'plan', 'Plan')).toMatchObject({ value: 'Annual, paid yearly' });
    expect(row(s, 'plan', 'Commitment')).toMatchObject({ value: true });
    expect(row(s, 'plan', 'Renewal')).toMatchObject({ value: 'Auto-renew, paid yearly' });
    expect(row(s, 'plan', 'Status')).toMatchObject({ value: 'ACTIVE', tone: 'success' });
    expect(row(s, 'plan', 'Purchase order')).toMatchObject({ value: 'PO-1001' });
    expect(row(s, 'seats', 'Licensed of purchased seats')).toEqual({ kind: 'meter', label: 'Licensed of purchased seats', used: 20, total: 25, unit: 'count' });
    expect(row(s, 'dates', 'Created')).toMatchObject({ kind: 'datetime', value: '2026-01-15T09:30:00.000Z' });
    expect(row(s, 'dates', 'Commitment start')).toMatchObject({ kind: 'date', value: '2026-01-15' });
    expect(row(s, 'dates', 'Commitment end (renewal)')).toMatchObject({ kind: 'date', value: '2027-01-15' });
  });

  it('flexible plan: meter against the maximum, no renewal date', async () => {
    installFetchTable({ ...BASE, [`${RESELLER}/subscriptions?`]: { body: { subscriptions: [FLEXIBLE] } } });
    const [rec] = (await new GoogleWorkspaceResellerDriver().fetchRecords(fetchCtx(), null)).records;
    expect(rec!.fields).toMatchObject({ name: 'Google Workspace Business Starter - acme.example.com', renewalDate: null });
    const s = sectionOf(rec!);
    expect(row(s, 'seats', 'Licensed of maximum seats')).toMatchObject({ used: 12, total: 50 });
    expect(row(s, 'plan', 'Status')).toMatchObject({ tone: 'danger' });
    expect(row(s, 'dates', 'Commitment end (renewal)')).toBeUndefined();
  });

  it('trial plan: trial end date field and row; a zero total gives no meter', async () => {
    installFetchTable({
      ...BASE,
      [`${RESELLER}/subscriptions?`]: { body: { subscriptions: [TRIAL, { ...TRIAL, subscriptionId: 'sub-empty', seats: { licensedNumberOfSeats: 3, numberOfSeats: 0 }, plan: { planName: 'ANNUAL_MONTHLY_PAY', isCommitmentPlan: true } }] } },
    });
    const [trial, empty] = (await new GoogleWorkspaceResellerDriver().fetchRecords(fetchCtx(), null)).records;
    expect(trial!.fields).toMatchObject({ trialEndDate: '2026-11-01', renewalDate: null });
    const s = sectionOf(trial!);
    expect(row(s, 'plan', 'Plan')).toMatchObject({ value: 'Trial' });
    expect(row(s, 'plan', 'In trial')).toMatchObject({ value: true });
    expect(row(s, 'dates', 'Trial end')).toMatchObject({ value: '2026-11-01' });
    expect(row(s, 'seats', 'Licensed of maximum seats')).toMatchObject({ used: 0, total: 10 });
    const e = sectionOf(empty!);
    expect(e.groups.find((g) => g.key === 'seats')!.rows.some((r) => r.kind === 'meter')).toBe(false);
  });

  it('never issues a non-GET request', async () => {
    const calls = installFetchTable({ ...BASE, [`${RESELLER}/subscriptions?`]: { body: { subscriptions: [COMMITMENT, FLEXIBLE, TRIAL] } } });
    const driver = new GoogleWorkspaceResellerDriver();
    await driver.testConnection(makeCtx());
    await driver.listSourceOrgs(makeCtx());
    await driver.fetchRecords(fetchCtx(), null);
    const apiCalls = calls.filter((c) => !c.url.startsWith(TOKEN_URL));
    expect(apiCalls.length).toBeGreaterThanOrEqual(4);
    expect(apiCalls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
});

describe('GoogleWorkspaceResellerDriver Check setup', () => {
  const check = () => new GoogleWorkspaceResellerDriver().diagnose({ mode: 'connection', ctx: makeCtx() });
  const RAW = 'raw provider text';

  it('passes every step when the subscriptions list answers', async () => {
    installFetchTable({ ...BASE, [`${RESELLER}/subscriptions?`]: { body: { subscriptions: [] } } });
    const result = await check();
    expect(result.ok).toBe(true);
    expect(result.passedStepIds).toEqual(expect.arrayContaining(['project', 'apis', 'scopes', 'connect', 'trust']));
  });

  it('reports a non-reseller account on the connect step with fixed text', async () => {
    installFetchTable({ ...BASE, [`${RESELLER}/subscriptions?`]: { status: 403, body: { error: { errors: [{ reason: 'forbidden' }], message: RAW } } } });
    const result = await check();
    expect(result).toMatchObject({ ok: false, failures: [{ stepId: 'connect' }] });
    expect(result.failures[0]!.message).toMatch(/not a Google Workspace reseller/);
    expect(result.passedStepIds).toContain('apis');
    expect(JSON.stringify(result)).not.toContain(RAW);
  });

  it('points a disabled Reseller API at step 2', async () => {
    installFetchTable({ ...BASE, [`${RESELLER}/subscriptions?`]: { status: 403, body: { error: { errors: [{ reason: 'accessNotConfigured' }], message: RAW } } } });
    const result = await check();
    expect(result).toMatchObject({ ok: false, failures: [{ stepId: 'apis' }] });
    expect(result.failures[0]!.message).toContain('Google Workspace Reseller API');
    expect(result.passedStepIds).not.toContain('scopes');
  });

  it('asks to reconnect when the refresh token is revoked', async () => {
    installFetchTable({ [TOKEN_URL]: { status: 400, body: { error: 'invalid_grant', error_description: RAW } } });
    const result = await check();
    expect(result).toMatchObject({ ok: false, passedStepIds: [], failures: [{ stepId: 'connect' }] });
    expect(JSON.stringify(result)).not.toContain(RAW);
  });
});
