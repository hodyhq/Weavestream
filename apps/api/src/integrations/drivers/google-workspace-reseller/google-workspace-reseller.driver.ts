import type {
  DriverDescriptor,
  DriverOAuthDescriptor,
  IntegrationSetupCheck,
  SourceFieldDto,
  SourceOrgDto,
} from '@weavestream/shared';
import {
  DriverAuthError,
  DriverRateLimitError,
  type DriverDiagnoseInput,
  type FetchRecordsContext,
  type IntegrationContext,
  type IntegrationDriver,
  type LegacyDriverFetchPage,
  type LegacyDriverRecord,
} from '../integration-driver.js';
import { assertRecommendedDestinations, parseRetryAfter } from '../driver-utils.js';
import { oauthFetch } from '../../oauth/oauth-token.js';
import {
  API_DISABLED_REASONS,
  GOOGLE_WORKSPACE_OAUTH,
  GoogleAccessError,
  RATE_LIMIT_REASONS,
  RESELLER,
  SKU_NAMES,
  decodeCursor,
  encodeCursor,
  errorReasons,
  withQuery,
} from '../google-workspace/google-workspace.driver.js';
import { toIso } from '../google-workspace/google-workspace.sections.js';
import { diagnoseGoogleClient } from '../google-workspace/google-workspace.diagnose.js';
import { buildSubscriptionSection, type ResellerSubscription } from './google-workspace-reseller.sections.js';
import { GOOGLE_WORKSPACE_RESELLER_SETUP_GUIDE } from './google-workspace-reseller.setup-guide.js';
import { diagnoseResellerConnection } from './google-workspace-reseller.diagnose.js';

/**
 * Google Workspace (reseller): one connection with the reseller admin's
 * account; each reseller customer is a source org mapped to one company.
 * Read-only (GET only) over the Reseller API with the instance Google
 * OAuth app. Records carry the name and subscription id; plan, seats and
 * dates go into the integration section. The commitment end and trial
 * end are also offered as optional DATE source fields for Expiring soon.
 */

export const GOOGLE_WORKSPACE_RESELLER_OAUTH: DriverOAuthDescriptor = {
  ...GOOGLE_WORKSPACE_OAUTH,
  scopes: ['openid', 'email', 'https://www.googleapis.com/auth/apps.order.readonly'],
};

/** Fixed text for a 403 from the Reseller API; Google's own text is never echoed. */
export const NOT_A_RESELLER = 'This Google account is not a Google Workspace reseller. Reconnect with an admin of your reseller domain (Partner Sales Console).';
const NOT_A_CUSTOMER = 'This Google Workspace customer is not one of the connected reseller\'s customers. Remap the organization, or reconnect with the reseller admin.';

const RESOURCE = 'subscriptions';
const MATCH_FIELD = 'subscriptionId';
export const RENEWAL_FIELD = 'renewalDate';
export const TRIAL_END_FIELD = 'trialEndDate';
/** Google customer ids are short alphanumerics (C0xxxxx); also accepts a domain. */
const CUSTOMER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;

export const GOOGLE_WORKSPACE_RESELLER_RECOMMENDED_DESTINATIONS = assertRecommendedDestinations('google-workspace-reseller', {
  [RESOURCE]: {
    layout: { name: 'Google Workspace Subscriptions', slug: 'google_workspace_subscriptions', icon: 'license', color: 'blue' },
    fields: [
      { sourceField: 'name', name: 'Name', slug: 'name', fieldType: 'TEXT', syncDirection: 'source_wins', isPrimary: true, showInTable: true, options: {} },
      { sourceField: MATCH_FIELD, name: 'Subscription ID', slug: 'subscription_id', fieldType: 'TEXT', syncDirection: 'source_wins', isPrimary: false, showInTable: true, options: {} },
    ],
  },
});

/**
 * Authenticated GET. 403 without a known reason means "not a reseller"
 * (or, with `forbidden`, the caller's own fixed text).
 */
async function resellerGet<T>(ctx: IntegrationContext, url: string, forbidden = NOT_A_RESELLER): Promise<T> {
  const res = await oauthFetch(ctx, GOOGLE_WORKSPACE_RESELLER_OAUTH, url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    redirect: 'error',
    serviceName: 'Google Workspace Reseller',
  });
  if (res.ok) return (await res.json()) as T;
  const reasons = [...(await errorReasons(res))];
  if (res.status === 429 || reasons.some((r) => RATE_LIMIT_REASONS.has(r))) {
    throw new DriverRateLimitError(
      'Google Workspace rate limit reached on the Google Workspace Reseller API.',
      parseRetryAfter(res.headers.get('Retry-After'), 30_000),
    );
  }
  if (res.status === 403 && reasons.some((r) => API_DISABLED_REASONS.has(r))) {
    throw new GoogleAccessError(
      'The Google Workspace Reseller API is not enabled in the Google Cloud project of the OAuth app. Enable it in the Google Cloud console, then sync again.',
    );
  }
  if (res.status === 401) throw new GoogleAccessError('Google denied access to the Google Workspace Reseller API (HTTP 401). Reconnect the reseller account.');
  if (res.status === 403) throw new GoogleAccessError(forbidden);
  if (res.status === 404 && forbidden !== NOT_A_RESELLER) throw new GoogleAccessError(forbidden);
  throw new Error(`Google Workspace Reseller request failed (HTTP ${res.status}).`);
}

function subscriptionsUrl(pageToken: string | undefined, customerId?: string): string {
  return withQuery(`${RESELLER}/subscriptions`, { maxResults: '100', customerId, pageToken });
}

function editionOf(sub: ResellerSubscription): string {
  return sub.skuName || SKU_NAMES[sub.skuId ?? ''] || sub.skuId || 'Google Workspace';
}

function isoDate(value: string | undefined): string | null {
  return toIso(value)?.slice(0, 10) ?? null;
}

function toRecord(sub: ResellerSubscription): LegacyDriverRecord {
  const name = [editionOf(sub), sub.customerDomain].filter(Boolean).join(' - ');
  return {
    externalId: sub.subscriptionId!,
    displayName: name,
    fields: {
      name,
      [MATCH_FIELD]: sub.subscriptionId!,
      [RENEWAL_FIELD]: isoDate(sub.plan?.commitmentInterval?.endTime),
      [TRIAL_END_FIELD]: isoDate(sub.trialSettings?.trialEndTime),
    },
    section: buildSubscriptionSection(sub, editionOf(sub)),
    updatedAt: null,
  };
}

export class GoogleWorkspaceResellerDriver implements IntegrationDriver {
  readonly key = 'google-workspace-reseller';

  readonly recommendedDestinations = GOOGLE_WORKSPACE_RESELLER_RECOMMENDED_DESTINATIONS;

  readonly descriptor: DriverDescriptor = {
    key: 'google-workspace-reseller',
    label: 'Google Workspace (reseller)',
    description:
      'For Google Workspace resellers only: read-only sync of every customer\'s subscriptions (edition, plan, seats, renewal and trial dates).',
    iconKey: null,
    configFields: [],
    secretFields: [],
    oauth: GOOGLE_WORKSPACE_RESELLER_OAUTH,
    setupGuide: GOOGLE_WORKSPACE_RESELLER_SETUP_GUIDE,
    resources: [
      {
        key: RESOURCE,
        label: 'Subscriptions',
        description: 'Google Workspace subscriptions of the customer: edition, plan, seats, renewal and trial dates.',
        defaultMatchKeyHint: MATCH_FIELD,
        targetKind: 'asset',
        targetConfig: {},
        dependsOnResourceKeys: [],
        matchSuggestions: {
          sourceField: MATCH_FIELD,
          layoutHints: ['licenses', 'licences', 'subscriptions', 'software'],
          fieldHints: ['subscription_id', 'subscriptionid', 'license_id', 'licence_id'],
        },
        minimalFields: ['name', MATCH_FIELD],
      },
    ],
    capabilities: {
      kind: 'pull',
      listSourceOrgs: true,
      dryRun: true,
      ticketing: false,
      reconstructionCompleteness: false,
    },
  };

  diagnose(input: DriverDiagnoseInput): Promise<IntegrationSetupCheck> {
    return input.mode === 'client' ? diagnoseGoogleClient(input) : diagnoseResellerConnection(input.ctx);
  }

  async testConnection(ctx: IntegrationContext): Promise<{ ok: true; details?: string }> {
    await resellerGet(ctx, withQuery(`${RESELLER}/subscriptions`, { maxResults: '1' }));
    return { ok: true, details: 'Connected to the Google Workspace reseller account.' };
  }

  /** Distinct customers that hold at least one subscription. */
  async listSourceOrgs(ctx: IntegrationContext): Promise<SourceOrgDto[]> {
    const customers = new Map<string, string>();
    let pageToken: string | undefined;
    for (let page = 0; page < 1_000; page += 1) {
      const body = await resellerGet<{ subscriptions?: ResellerSubscription[]; nextPageToken?: string }>(ctx, subscriptionsUrl(pageToken));
      for (const s of body.subscriptions ?? []) {
        if (s.customerId && !customers.has(s.customerId)) customers.set(s.customerId, s.customerDomain || s.customerId);
      }
      pageToken = body.nextPageToken || undefined;
      if (!pageToken) break;
    }
    if (pageToken) throw new Error('Google Workspace Reseller: too many subscription pages to list every customer.');
    return [...customers]
      .map(([externalId, name]) => ({ externalId, name, hint: externalId }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listSourceFields(ctx: IntegrationContext & { externalOrgId: string; resourceKey: string }): Promise<SourceFieldDto[]> {
    if (ctx.resourceKey !== RESOURCE) return [];
    return [
      { key: 'name', label: 'Name', hintType: 'TEXT', alwaysPresent: true },
      { key: MATCH_FIELD, label: 'Subscription ID', hintType: 'TEXT', alwaysPresent: true },
      // Opt-in: map either to a DATE field flagged isExpiry to see it in Expiring soon.
      { key: RENEWAL_FIELD, label: 'Commitment end (renewal)', hintType: 'DATE', alwaysPresent: false, description: 'End of the annual commitment, when the subscription renews.' },
      { key: TRIAL_END_FIELD, label: 'Trial end', hintType: 'DATE', alwaysPresent: false, description: 'Date the free trial ends.' },
    ];
  }

  async fetchRecords(ctx: FetchRecordsContext, cursor: string | null): Promise<LegacyDriverFetchPage> {
    if (ctx.resourceKey !== RESOURCE) throw new Error(`Unknown Google Workspace reseller resource: ${ctx.resourceKey}`);
    const customerId = ctx.externalOrgId;
    if (!CUSTOMER_ID_RE.test(customerId)) throw new DriverAuthError(NOT_A_CUSTOMER);
    // Tenant isolation: the mapped org must be one of this reseller's customers.
    const customer = await resellerGet<{ customerId?: string }>(ctx, `${RESELLER}/customers/${encodeURIComponent(customerId)}`, NOT_A_CUSTOMER);
    if (customer.customerId !== customerId) throw new DriverAuthError(NOT_A_CUSTOMER);
    const body = await resellerGet<{ subscriptions?: ResellerSubscription[]; nextPageToken?: string }>(
      ctx,
      subscriptionsUrl(decodeCursor(cursor), customerId),
    );
    // Defence in depth: never emit another customer's subscription.
    const records = (body.subscriptions ?? [])
      .filter((s) => s.subscriptionId && s.customerId === customerId)
      .map(toRecord);
    const next = encodeCursor(body.nextPageToken || undefined);
    return { records, hasMore: next !== null, cursor: next, snapshotAt: ctx.snapshotAt ?? new Date().toISOString() };
  }
}
