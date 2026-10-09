import { z } from 'zod';
import type {
  DriverDescriptor,
  DriverOAuthDescriptor,
  SourceFieldDto,
  SourceOrgDto,
} from '@weavestream/shared';
import {
  DriverAuthError,
  DriverRateLimitError,
  type FetchRecordsContext,
  type IntegrationContext,
  type IntegrationDriver,
  type LegacyDriverFetchPage,
  type LegacyDriverRecord,
  type RecommendedDestination,
  type RecommendedDestinationField,
} from '../integration-driver.js';
import { assertRecommendedDestinations, parseRetryAfter } from '../driver-utils.js';
import { oauthFetch } from '../../oauth/oauth-token.js';
import {
  buildAlertSection,
  buildChromeSection,
  buildDomainSection,
  buildGroupSection,
  buildMobileSection,
  buildTenantSection,
  buildUserSection,
  toIso,
  type ChromeDevice,
  type GoogleAlert,
  type GoogleGroup,
  type GoogleUser,
  type Lookup,
  type MobileDevice,
  type StorageUsage,
  type UsageReport,
} from './google-workspace.sections.js';

/**
 * Google Workspace driver (read-only, one integration = one Workspace
 * tenant). Plain REST over `oauthFetch` (egress guard, token refresh);
 * every Google API call is a GET. External ids are Google's immutable
 * ids; records carry only the name and the match key as layout fields,
 * every other detail goes into the integration section.
 *
 * Lookups shared by every page of one run (licences, storage usage) are
 * cached in process per integration + snapshot. Licensing, Reports and
 * their privileges are optional: when unavailable the records still sync
 * with a note in place of the missing data.
 */

const DIRECTORY = 'https://admin.googleapis.com/admin/directory/v1';
const REPORTS = 'https://admin.googleapis.com/admin/reports/v1';
const LICENSING = 'https://licensing.googleapis.com/apps/licensing/v1';
const ALERT_CENTER = 'https://alertcenter.googleapis.com/v1beta1';
const SCOPE = 'https://www.googleapis.com/auth/';

export const GOOGLE_WORKSPACE_OAUTH: DriverOAuthDescriptor = {
  provider: 'google',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
  scopes: [
    'openid',
    'email',
    ...[
      'admin.directory.user.readonly',
      'admin.directory.group.readonly',
      'admin.directory.group.member.readonly',
      'admin.directory.domain.readonly',
      'admin.directory.customer.readonly',
      'admin.directory.device.chromeos.readonly',
      'admin.directory.device.mobile.readonly',
      'admin.reports.usage.readonly',
      // No read-only variant exists for these two; the driver only GETs.
      'apps.licensing',
      'apps.alerts',
    ].map((scope) => `${SCOPE}${scope}`),
  ],
  extraAuthorizeParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
};

/** Edition names for SKUs whose listing omits `skuName`. */
const SKU_NAMES: Readonly<Record<string, string>> = {
  '1010020027': 'Business Starter',
  '1010020028': 'Business Standard',
  '1010020025': 'Business Plus',
  '1010020029': 'Enterprise Starter',
  '1010020026': 'Enterprise Standard',
  '1010020020': 'Enterprise Plus',
  '1010060003': 'Enterprise Essentials',
  '1010060001': 'Essentials',
  '1010060005': 'Essentials Plus',
  '1010020030': 'Frontline Starter',
  '1010020031': 'Frontline Standard',
  '1010020034': 'Frontline Plus',
  '1010070001': 'Education Fundamentals',
  '1010310005': 'Education Standard',
  '1010310008': 'Education Plus',
};

type ResourceKey = 'tenant' | 'users' | 'groups' | 'domains' | 'chrome_devices' | 'mobile_devices' | 'alerts';

interface ResourceSpec {
  label: string;
  description: string;
  matchField: string;
  matchLabel: string;
  matchType: 'TEXT' | 'EMAIL';
  layoutHints: string[];
  fieldHints: string[];
  layout: RecommendedDestination['layout'];
}

const RESOURCES: Readonly<Record<ResourceKey, ResourceSpec>> = {
  tenant: {
    label: 'Tenant',
    description: 'The Workspace tenant: licences per edition, pooled storage and security posture.',
    matchField: 'customerId', matchLabel: 'Customer ID', matchType: 'TEXT',
    layoutHints: ['google_workspace', 'workspace', 'tenant', 'tenants'],
    fieldHints: ['customer_id', 'customerid', 'tenant_id'],
    layout: { name: 'Google Workspace Tenants', slug: 'google_workspace_tenants', icon: 'building', color: 'blue' },
  },
  users: {
    label: 'Users',
    description: 'Users with licences, mailbox and Drive storage, admin role and 2-step verification.',
    matchField: 'primaryEmail', matchLabel: 'Email', matchType: 'EMAIL',
    layoutHints: ['people', 'contacts', 'users', 'staff', 'employees'],
    fieldHints: ['email', 'primary_email', 'e_mail', 'mail'],
    layout: { name: 'People', slug: 'people', icon: 'person', color: 'blue' },
  },
  groups: {
    label: 'Groups',
    description: 'Groups and distribution lists with their members.',
    matchField: 'email', matchLabel: 'Email', matchType: 'EMAIL',
    layoutHints: ['distribution_lists', 'distribution', 'groups', 'mailing_lists'],
    fieldHints: ['email', 'group_email', 'address'],
    layout: { name: 'Distribution Lists', slug: 'distribution_lists', icon: 'users', color: 'teal' },
  },
  domains: {
    label: 'Domains',
    description: 'Domains and domain aliases of the tenant.',
    matchField: 'name', matchLabel: 'Domain', matchType: 'TEXT',
    layoutHints: ['domains', 'domain'],
    fieldHints: ['domain', 'domain_name', 'name', 'fqdn'],
    layout: { name: 'Domains', slug: 'domains', icon: 'globe', color: 'green' },
  },
  chrome_devices: {
    label: 'Chrome devices',
    description: 'ChromeOS devices with OS version, user and auto-update expiration.',
    matchField: 'serialNumber', matchLabel: 'Serial number', matchType: 'TEXT',
    layoutHints: ['laptops', 'chromebooks', 'workstations', 'computers', 'devices'],
    fieldHints: ['serial_number', 'serial', 'serialnumber', 'service_tag'],
    layout: { name: 'Chromebooks', slug: 'chromebooks', icon: 'laptop', color: 'amber' },
  },
  mobile_devices: {
    label: 'Mobile devices',
    description: 'Phones and tablets managed by Google endpoint management.',
    matchField: 'serialNumber', matchLabel: 'Serial number', matchType: 'TEXT',
    layoutHints: ['phones', 'mobile', 'mobile_devices', 'tablets'],
    fieldHints: ['serial_number', 'serial', 'serialnumber', 'imei'],
    layout: { name: 'Phones', slug: 'phones', icon: 'box', color: 'violet' },
  },
  alerts: {
    label: 'Security alerts',
    description: 'Alert Center alerts from the last 90 days.',
    matchField: 'alertId', matchLabel: 'Alert ID', matchType: 'TEXT',
    layoutHints: ['google_security_alerts', 'security_alerts', 'alerts'],
    fieldHints: ['alert_id', 'alertid', 'id'],
    layout: { name: 'Google Security Alerts', slug: 'google_security_alerts', icon: 'shield', color: 'red' },
  },
};

const RESOURCE_KEYS = Object.keys(RESOURCES) as ResourceKey[];
const AUTO_UPDATE_FIELD = 'autoUpdateExpiration';

function destinationField(
  sourceField: string, name: string, fieldType: RecommendedDestinationField['fieldType'], isPrimary: boolean,
): RecommendedDestinationField {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return { sourceField, name, slug, fieldType, syncDirection: 'source_wins', isPrimary, showInTable: true, options: {} };
}

/** "Create a new layout" for each resource: the name and the match key only. */
export const GOOGLE_WORKSPACE_RECOMMENDED_DESTINATIONS = assertRecommendedDestinations(
  'google-workspace',
  Object.fromEntries(
    RESOURCE_KEYS.map((key) => {
      const spec = RESOURCES[key];
      const fields = spec.matchField === 'name'
        ? [destinationField('name', spec.matchLabel, 'TEXT', true)]
        : [destinationField('name', 'Name', 'TEXT', true), destinationField(spec.matchField, spec.matchLabel, spec.matchType, false)];
      return [key, { layout: spec.layout, fields }];
    }),
  ),
);

/** Google pageToken walker state, opaque to the runner (UniFi pattern). */
const cursorSchema = z.object({ pageToken: z.string().min(1).max(4_096) }).strict();

function encodeCursor(pageToken: string | undefined): string | null {
  return pageToken ? Buffer.from(JSON.stringify({ pageToken }), 'utf8').toString('base64') : null;
}

function decodeCursor(cursor: string | null): string | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')));
    return parsed.success ? parsed.data.pageToken : undefined;
  } catch {
    // A malformed cursor restarts the walk from the first page.
    return undefined;
  }
}

/** A Google 401/403: missing privilege, scope, or an API not enabled. */
export class GoogleAccessError extends DriverAuthError {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleAccessError';
  }
}

const RATE_LIMIT_REASONS = new Set(['userRateLimitExceeded', 'quotaExceeded', 'rateLimitExceeded', 'RATE_LIMIT_EXCEEDED']);
const API_DISABLED_REASONS = new Set(['accessNotConfigured', 'SERVICE_DISABLED']);

function apiName(url: string): string {
  if (url.startsWith(LICENSING)) return 'Enterprise License Manager API';
  if (url.startsWith(ALERT_CENTER)) return 'Google Workspace Alert Center API';
  if (url.startsWith(REPORTS)) return 'Admin SDK API (Reports)';
  return 'Admin SDK API';
}

/** Google error `reason` values from both the v1 (`errors[]`) and v2 (`details[]`) shapes. */
async function errorReasons(res: Response): Promise<Set<string>> {
  const body = (await res.json().catch(() => null)) as {
    error?: { status?: string; errors?: Array<{ reason?: string }>; details?: Array<{ reason?: string }> };
  } | null;
  const reasons = [
    body?.error?.status,
    ...(body?.error?.errors ?? []).map((e) => e?.reason),
    ...(body?.error?.details ?? []).map((d) => d?.reason),
  ];
  return new Set(reasons.filter((r): r is string => typeof r === 'string'));
}

/** Authenticated GET; never echoes Google's error text, only status and API name. */
async function googleGet<T>(ctx: IntegrationContext, url: string): Promise<T> {
  const res = await oauthFetch(ctx, GOOGLE_WORKSPACE_OAUTH, url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    redirect: 'error',
    serviceName: 'Google Workspace',
  });
  if (res.ok) return (await res.json()) as T;
  const reasons = await errorReasons(res);
  const api = apiName(url);
  if (res.status === 429 || [...reasons].some((r) => RATE_LIMIT_REASONS.has(r))) {
    throw new DriverRateLimitError(
      `Google Workspace rate limit reached on the ${api}.`,
      parseRetryAfter(res.headers.get('Retry-After'), 30_000),
    );
  }
  if (res.status === 403 && [...reasons].some((r) => API_DISABLED_REASONS.has(r))) {
    throw new GoogleAccessError(
      `The ${api} is not enabled in the Google Cloud project of the OAuth app. Enable it in the Google Cloud console, then sync again.`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new GoogleAccessError(
      `Google denied access to the ${api} (HTTP ${res.status}). The connected account needs admin privileges for this data; reconnect with a suitable admin.`,
    );
  }
  throw new Error(`Google Workspace request to the ${api} failed (HTTP ${res.status}).`);
}

function withQuery(base: string, params: Record<string, string | undefined>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  return url.toString();
}

/** Every page of a pageToken listing. */
async function listAll<T>(
  ctx: IntegrationContext,
  url: (pageToken: string | undefined) => string,
  items: (body: Record<string, unknown>) => T[] | undefined,
): Promise<T[]> {
  const out: T[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 1_000; page += 1) {
    const body = await googleGet<Record<string, unknown>>(ctx, url(pageToken));
    out.push(...(items(body) ?? []));
    pageToken = typeof body.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : undefined;
    if (!pageToken) break;
  }
  return out;
}

// ---------------------------------------------------------------------
// Per-run lookup cache
// ---------------------------------------------------------------------

// ponytail: single process, per run. Keyed by integration + snapshot so
// every page of one run shares one fetch; entries expire after the TTL.
const RUN_CACHE_TTL_MS = 15 * 60_000;
const runCache = new Map<string, { expiresAt: number; value: Promise<unknown> }>();

/** @internal only `*.spec.ts` should call this. */
export function __resetGoogleWorkspaceRunCacheForTests(): void {
  runCache.clear();
}

function runCached<T>(ctx: IntegrationContext, snapshotAt: string, name: string, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  for (const [key, entry] of runCache) if (entry.expiresAt <= now) runCache.delete(key);
  const key = `${ctx.integrationId ?? ctx.correlationId}\0${snapshotAt}\0${name}`;
  const hit = runCache.get(key);
  if (hit) return hit.value as Promise<T>;
  const value = load();
  runCache.set(key, { expiresAt: now + RUN_CACHE_TTL_MS, value });
  // A failed load is not cached; the next page retries it.
  value.catch(() => runCache.delete(key));
  return value;
}

/** Optional data: a privilege or API problem becomes a note, never a failed run. */
async function optional<T>(load: () => Promise<T | null>, unavailable: string): Promise<Lookup<T>> {
  try {
    const value = await load();
    return value === null ? { ok: false, reason: unavailable } : { ok: true, value };
  } catch (e) {
    if (e instanceof GoogleAccessError) return { ok: false, reason: e.message };
    throw e;
  }
}

interface Customer {
  id: string;
  customerDomain: string;
  customerCreationTime?: string;
}

async function getCustomer(ctx: IntegrationContext): Promise<Customer> {
  const body = await googleGet<Partial<Customer>>(ctx, `${DIRECTORY}/customers/my_customer`);
  if (!body.id || !body.customerDomain) throw new Error('Google Workspace returned no customer id.');
  return { id: body.id, customerDomain: body.customerDomain, customerCreationTime: body.customerCreationTime };
}

/** Licence editions assigned per user email (lowercased). Assigned only, never purchased totals. */
function getLicences(ctx: IntegrationContext, customerId: string): Promise<Map<string, string[]>> {
  return listAll<{ userId?: string; skuId?: string; skuName?: string }>(
    ctx,
    (pageToken) => withQuery(`${LICENSING}/product/Google-Apps/users`, { customerId, maxResults: '1000', pageToken }),
    (body) => body.items as never,
  ).then((items) => {
    const byEmail = new Map<string, string[]>();
    for (const item of items) {
      if (!item.userId) continue;
      const email = item.userId.toLowerCase();
      const name = item.skuName || SKU_NAMES[item.skuId ?? ''] || item.skuId || 'Unknown edition';
      byEmail.set(email, [...(byEmail.get(email) ?? []), name]);
    }
    return byEmail;
  });
}

interface UsageParameter {
  name?: string;
  intValue?: string | number;
}
interface UsageEntry {
  entity?: { userEmail?: string };
  parameters?: UsageParameter[];
}

const USER_USAGE_PARAMS = [
  'accounts:used_quota_in_mb',
  'accounts:total_quota_in_mb',
  'accounts:drive_used_quota_in_mb',
  'accounts:gmail_used_quota_in_mb',
].join(',');
const CUSTOMER_USAGE_PARAMS = [
  'accounts:used_quota_in_mb',
  'accounts:total_quota_in_mb',
  'accounts:drive_used_quota_in_mb',
  'accounts:gmail_used_quota_in_mb',
  'accounts:team_drive_used_quota_in_mb',
].join(',');
const REPORT_LAG_DAYS = 2;
const REPORT_STEP_BACKS = 5;

function storageOf(params: UsageParameter[] | undefined): StorageUsage {
  const read = (name: string) => {
    const raw = params?.find((p) => p.name === name)?.intValue;
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    usedMb: read('accounts:used_quota_in_mb'),
    totalMb: read('accounts:total_quota_in_mb'),
    driveMb: read('accounts:drive_used_quota_in_mb'),
    gmailMb: read('accounts:gmail_used_quota_in_mb'),
    sharedDrivesMb: read('accounts:team_drive_used_quota_in_mb'),
  };
}

/**
 * Reports lag 1 to 3 days: start at snapshot - 2 days (UTC) and step back
 * one day while Google warns the data is not available yet (at most 5
 * times). Null when no date in the window has data.
 */
async function latestReport(
  ctx: IntegrationContext,
  snapshotAt: string,
  url: (date: string, pageToken: string | undefined) => string,
): Promise<UsageReport<UsageEntry[]> | null> {
  const start = Date.parse(snapshotAt);
  for (let step = 0; step <= REPORT_STEP_BACKS; step += 1) {
    const date = new Date(start - (REPORT_LAG_DAYS + step) * 86_400_000).toISOString().slice(0, 10);
    const entries: UsageEntry[] = [];
    let unavailable = false;
    let pageToken: string | undefined;
    for (let page = 0; page < 1_000; page += 1) {
      const body = await googleGet<{
        usageReports?: UsageEntry[];
        nextPageToken?: string;
        warnings?: Array<{ code?: string; message?: string }>;
      }>(ctx, url(date, pageToken));
      // PARTIAL_DATA_AVAILABLE is accepted; only a missing day steps back.
      if ((body.warnings ?? []).some((w) => w.code === 'DATA_NOT_AVAILABLE')) {
        unavailable = true;
        break;
      }
      entries.push(...(body.usageReports ?? []));
      pageToken = body.nextPageToken || undefined;
      if (!pageToken) break;
    }
    if (!unavailable) return { date, value: entries };
  }
  return null;
}

async function getUserUsage(
  ctx: IntegrationContext,
  snapshotAt: string,
): Promise<UsageReport<Map<string, StorageUsage>> | null> {
  const report = await latestReport(ctx, snapshotAt, (date, pageToken) =>
    withQuery(`${REPORTS}/usage/users/all/dates/${date}`, { parameters: USER_USAGE_PARAMS, maxResults: '1000', pageToken }),
  );
  if (!report) return null;
  const byEmail = new Map<string, StorageUsage>();
  for (const entry of report.value) {
    const email = entry.entity?.userEmail?.toLowerCase();
    if (email) byEmail.set(email, storageOf(entry.parameters));
  }
  return { date: report.date, value: byEmail };
}

async function getCustomerUsage(ctx: IntegrationContext, snapshotAt: string): Promise<UsageReport<StorageUsage> | null> {
  const report = await latestReport(ctx, snapshotAt, (date, pageToken) =>
    withQuery(`${REPORTS}/usage/dates/${date}`, { parameters: CUSTOMER_USAGE_PARAMS, pageToken }),
  );
  if (!report || report.value.length === 0) return null;
  return { date: report.date, value: storageOf(report.value[0]!.parameters) };
}

const REPORT_UNAVAILABLE = 'Google has not published usage reports for the last week yet (reports lag 1 to 3 days).';

function usersUrl(pageToken: string | undefined): string {
  return withQuery(`${DIRECTORY}/users`, {
    customer: 'my_customer',
    projection: 'full',
    viewType: 'admin_view',
    maxResults: '500',
    pageToken,
  });
}

function record(key: ResourceKey, externalId: string, name: string, matchValue: string | undefined, section: unknown, extra: Record<string, unknown> = {}): LegacyDriverRecord {
  const matchField = RESOURCES[key].matchField;
  return {
    externalId,
    displayName: name,
    fields: { name, ...(matchField === 'name' ? {} : { [matchField]: matchValue ?? null }), ...extra },
    section,
    updatedAt: null,
  };
}

export class GoogleWorkspaceDriver implements IntegrationDriver {
  readonly key = 'google-workspace';

  readonly recommendedDestinations = GOOGLE_WORKSPACE_RECOMMENDED_DESTINATIONS;

  readonly descriptor: DriverDescriptor = {
    key: 'google-workspace',
    label: 'Google Workspace',
    description:
      'Read-only sync of a Google Workspace tenant: users, licences, storage, groups, domains, devices and security alerts.',
    iconKey: null,
    configFields: [],
    secretFields: [],
    oauth: GOOGLE_WORKSPACE_OAUTH,
    resources: RESOURCE_KEYS.map((key) => {
      const spec = RESOURCES[key];
      return {
        key,
        label: spec.label,
        description: spec.description,
        defaultMatchKeyHint: spec.matchField,
        targetKind: 'asset' as const,
        targetConfig: {},
        dependsOnResourceKeys: [],
        matchSuggestions: { sourceField: spec.matchField, layoutHints: spec.layoutHints, fieldHints: spec.fieldHints },
        minimalFields: spec.matchField === 'name' ? ['name'] : ['name', spec.matchField],
      };
    }),
    capabilities: {
      kind: 'pull',
      listSourceOrgs: true,
      dryRun: true,
      ticketing: false,
      reconstructionCompleteness: false,
    },
  };

  async testConnection(ctx: IntegrationContext): Promise<{ ok: true; details?: string }> {
    const customer = await getCustomer(ctx);
    return { ok: true, details: `Connected to the Google Workspace tenant ${customer.customerDomain}.` };
  }

  async listSourceOrgs(ctx: IntegrationContext): Promise<SourceOrgDto[]> {
    const customer = await getCustomer(ctx);
    return [{ externalId: customer.id, name: customer.customerDomain, hint: null }];
  }

  async listSourceFields(
    ctx: IntegrationContext & { externalOrgId: string; resourceKey: string },
  ): Promise<SourceFieldDto[]> {
    const spec = RESOURCES[ctx.resourceKey as ResourceKey];
    if (!spec) return [];
    const fields: SourceFieldDto[] = [{ key: 'name', label: spec.matchField === 'name' ? spec.matchLabel : 'Name', hintType: 'TEXT', alwaysPresent: true }];
    if (spec.matchField !== 'name') {
      fields.push({ key: spec.matchField, label: spec.matchLabel, hintType: spec.matchType, alwaysPresent: ctx.resourceKey !== 'chrome_devices' && ctx.resourceKey !== 'mobile_devices' });
    }
    if (ctx.resourceKey === 'chrome_devices') {
      // Opt-in: map it to a DATE field flagged isExpiry to see it in Expiring soon.
      fields.push({
        key: AUTO_UPDATE_FIELD,
        label: 'Auto-update expiration',
        hintType: 'DATE',
        alwaysPresent: false,
        description: 'Date the device stops receiving ChromeOS updates.',
      });
    }
    return fields;
  }

  async fetchRecords(ctx: FetchRecordsContext, cursor: string | null): Promise<LegacyDriverFetchPage> {
    const key = ctx.resourceKey as ResourceKey;
    if (!RESOURCES[key]) throw new Error(`Unknown Google Workspace resource: ${ctx.resourceKey}`);
    const snapshotAt = ctx.snapshotAt ?? new Date().toISOString();
    const customer = await runCached(ctx, snapshotAt, 'customer', () => getCustomer(ctx));
    // Tenant isolation: these tokens may only feed the tenant they are mapped to.
    if (customer.id !== ctx.externalOrgId) {
      throw new DriverAuthError(
        'This Google connection belongs to a different Workspace tenant than the mapped one. Reconnect with an admin of the mapped tenant.',
      );
    }
    const pageToken = decodeCursor(cursor);
    const page = await this.fetchPage(key, ctx, customer, snapshotAt, pageToken);
    const next = encodeCursor(page.nextPageToken);
    return { records: page.records, hasMore: next !== null, cursor: next, snapshotAt };
  }

  private async fetchPage(
    key: ResourceKey,
    ctx: FetchRecordsContext,
    customer: Customer,
    snapshotAt: string,
    pageToken: string | undefined,
  ): Promise<{ records: LegacyDriverRecord[]; nextPageToken?: string }> {
    const nowMs = Date.parse(snapshotAt);
    const licences = () =>
      runCached(ctx, snapshotAt, 'licences', () => optional(() => getLicences(ctx, customer.id), 'Licence data is not available.'));

    switch (key) {
      case 'tenant': {
        const users = await listAll<GoogleUser>(ctx, usersUrl, (body) => body.users as never);
        const storage = await optional(() => getCustomerUsage(ctx, snapshotAt), REPORT_UNAVAILABLE);
        const section = buildTenantSection({
          customerId: customer.id,
          primaryDomain: customer.customerDomain,
          createdAt: customer.customerCreationTime,
          users,
          licences: await licences(),
          storage,
          nowMs,
        });
        return { records: [record(key, customer.id, customer.customerDomain, customer.id, section)] };
      }
      case 'users': {
        const body = await googleGet<{ users?: GoogleUser[]; nextPageToken?: string }>(ctx, usersUrl(pageToken));
        const licenceLookup = await licences();
        const usage = await runCached(ctx, snapshotAt, 'usage', () => optional(() => getUserUsage(ctx, snapshotAt), REPORT_UNAVAILABLE));
        const records = (body.users ?? [])
          .filter((u) => u.id && u.primaryEmail)
          .map((u) =>
            record(key, u.id!, u.name?.fullName || u.primaryEmail!, u.primaryEmail, buildUserSection(u, licenceLookup, usage, nowMs)),
          );
        return { records, nextPageToken: body.nextPageToken };
      }
      case 'groups': {
        const body = await googleGet<{ groups?: GoogleGroup[]; nextPageToken?: string }>(
          ctx,
          withQuery(`${DIRECTORY}/groups`, { customer: 'my_customer', maxResults: '200', pageToken }),
        );
        const records: LegacyDriverRecord[] = [];
        for (const g of body.groups ?? []) {
          if (!g.id || !g.email) continue;
          // The section list holds at most 50 items, so one page of 50 members is enough.
          const members = await googleGet<{ members?: Array<{ email?: string; role?: string }> }>(
            ctx,
            withQuery(`${DIRECTORY}/groups/${encodeURIComponent(g.id)}/members`, { maxResults: '50' }),
          );
          records.push(record(key, g.id, g.name || g.email, g.email, buildGroupSection(g, members.members ?? [])));
        }
        return { records, nextPageToken: body.nextPageToken };
      }
      case 'domains': {
        const body = await googleGet<{
          domains?: Array<{
            domainName?: string;
            isPrimary?: boolean;
            verified?: boolean;
            creationTime?: string;
            domainAliases?: Array<{ domainAliasName?: string; parentDomainName?: string; verified?: boolean; creationTime?: string }>;
          }>;
        }>(ctx, `${DIRECTORY}/customer/my_customer/domains`);
        const records: LegacyDriverRecord[] = [];
        for (const d of body.domains ?? []) {
          if (!d.domainName) continue;
          // Domain names are Google's own identifiers for domains (no separate id).
          records.push(record(key, d.domainName.toLowerCase(), d.domainName, undefined, buildDomainSection({
            primary: d.isPrimary === true, verified: d.verified, creationTime: d.creationTime,
          })));
          for (const alias of d.domainAliases ?? []) {
            if (!alias.domainAliasName) continue;
            records.push(record(key, alias.domainAliasName.toLowerCase(), alias.domainAliasName, undefined, buildDomainSection({
              primary: false, verified: alias.verified, aliasOf: alias.parentDomainName ?? d.domainName, creationTime: alias.creationTime,
            })));
          }
        }
        return { records };
      }
      case 'chrome_devices': {
        const body = await googleGet<{ chromeosdevices?: ChromeDevice[]; nextPageToken?: string }>(
          ctx,
          withQuery(`${DIRECTORY}/customer/my_customer/devices/chromeos`, { projection: 'FULL', maxResults: '200', pageToken }),
        );
        const records = (body.chromeosdevices ?? [])
          .filter((d) => d.deviceId)
          .map((d) => {
            const expiry = toIso(d.autoUpdateExpiration);
            const name = d.annotatedAssetId || [d.model, d.serialNumber].filter(Boolean).join(' ') || d.deviceId!;
            return record(key, d.deviceId!, name, d.serialNumber, buildChromeSection(d, nowMs), {
              [AUTO_UPDATE_FIELD]: expiry ? expiry.slice(0, 10) : null,
            });
          });
        return { records, nextPageToken: body.nextPageToken };
      }
      case 'mobile_devices': {
        const body = await googleGet<{ mobiledevices?: MobileDevice[]; nextPageToken?: string }>(
          ctx,
          withQuery(`${DIRECTORY}/customer/my_customer/devices/mobile`, { projection: 'FULL', maxResults: '100', pageToken }),
        );
        const records = (body.mobiledevices ?? [])
          .filter((d) => d.resourceId)
          .map((d) => {
            const name = [d.model, d.serialNumber].filter(Boolean).join(' ') || d.resourceId!;
            return record(key, d.resourceId!, name, d.serialNumber, buildMobileSection(d));
          });
        return { records, nextPageToken: body.nextPageToken };
      }
      case 'alerts': {
        const since = new Date(nowMs - 90 * 86_400_000).toISOString();
        const body = await googleGet<{ alerts?: GoogleAlert[]; nextPageToken?: string }>(
          ctx,
          withQuery(`${ALERT_CENTER}/alerts`, {
            pageSize: '100',
            orderBy: 'createTime desc',
            filter: `createTime >= "${since}"`,
            pageToken,
          }),
        );
        const records = (body.alerts ?? [])
          .filter((a) => a.alertId)
          .map((a) => {
            const created = toIso(a.createTime)?.slice(0, 10);
            const name = [a.type || 'Security alert', created].filter(Boolean).join(' ');
            return record(key, a.alertId!, name, a.alertId, buildAlertSection(a));
          });
        return { records, nextPageToken: body.nextPageToken };
      }
    }
  }
}
