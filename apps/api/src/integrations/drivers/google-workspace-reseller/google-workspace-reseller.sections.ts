import type { IntegrationSection, IntegrationSectionRow } from '@weavestream/shared';
import { badge, bool, date, datetime, group, num, section, text, type Row } from '../google-workspace/google-workspace.sections.js';

/**
 * Pure builder for a reseller subscription section (integrationSectionSchema).
 * Google sends dates as epoch-millisecond strings; `date()` accepts both.
 */

export interface ResellerSubscription {
  customerId?: string;
  subscriptionId?: string;
  skuId?: string;
  skuName?: string;
  customerDomain?: string;
  status?: string;
  purchaseOrderId?: string;
  creationTime?: string;
  plan?: {
    planName?: string;
    isCommitmentPlan?: boolean;
    commitmentInterval?: { startTime?: string; endTime?: string };
  };
  seats?: { numberOfSeats?: number; maximumNumberOfSeats?: number; licensedNumberOfSeats?: number };
  renewalSettings?: { renewalType?: string };
  trialSettings?: { isInTrial?: boolean; trialEndTime?: string };
}

const PLAN_LABELS: Readonly<Record<string, string>> = {
  ANNUAL_MONTHLY_PAY: 'Annual, paid monthly',
  ANNUAL_YEARLY_PAY: 'Annual, paid yearly',
  FLEXIBLE: 'Flexible',
  TRIAL: 'Trial',
  FREE: 'Free',
};

const RENEWAL_LABELS: Readonly<Record<string, string>> = {
  AUTO_RENEW_MONTHLY_PAY: 'Auto-renew, paid monthly',
  AUTO_RENEW_YEARLY_PAY: 'Auto-renew, paid yearly',
  RENEW_CURRENT_USERS_MONTHLY_PAY: 'Renew current users, paid monthly',
  RENEW_CURRENT_USERS_YEARLY_PAY: 'Renew current users, paid yearly',
  SWITCH_TO_PAY_AS_YOU_GO: 'Switch to Flexible',
  CANCEL: 'Cancel at end of term',
};

function statusTone(status: string): 'neutral' | 'success' | 'warning' | 'danger' {
  if (status === 'ACTIVE') return 'success';
  if (status === 'SUSPENDED') return 'danger';
  return 'warning';
}

function finite(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Licensed vs purchased (commitment) or vs the cap (Flexible, Trial), when the total is positive. */
function seatMeter(sub: ResellerSubscription): Row {
  const licensed = finite(sub.seats?.licensedNumberOfSeats);
  const purchased = finite(sub.seats?.numberOfSeats);
  const max = finite(sub.seats?.maximumNumberOfSeats);
  const total = sub.plan?.isCommitmentPlan ? purchased : max;
  if (licensed === undefined || !total) return null;
  const row: IntegrationSectionRow = {
    kind: 'meter',
    label: sub.plan?.isCommitmentPlan ? 'Licensed of purchased seats' : 'Licensed of maximum seats',
    used: licensed,
    total,
    unit: 'count',
  };
  return row;
}

export function buildSubscriptionSection(sub: ResellerSubscription, edition: string): IntegrationSection {
  const planName = sub.plan?.planName;
  const renewal = sub.renewalSettings?.renewalType;
  const trial = sub.trialSettings;
  return {
    ...section([
      group('plan', 'Plan', 'google-admin', [
        text('Edition', edition),
        text('SKU', sub.skuId),
        planName ? text('Plan', PLAN_LABELS[planName] ?? planName) : null,
        bool('Commitment', sub.plan?.isCommitmentPlan),
        renewal ? text('Renewal', RENEWAL_LABELS[renewal] ?? renewal) : null,
        sub.status ? badge('Status', sub.status, statusTone(sub.status)) : null,
        bool('In trial', trial?.isInTrial),
        text('Purchase order', sub.purchaseOrderId),
        text('Customer domain', sub.customerDomain),
        text('Subscription ID', sub.subscriptionId),
      ]),
      group('seats', 'Seats', 'google-admin', [
        seatMeter(sub),
        num('Purchased seats', finite(sub.seats?.numberOfSeats)),
        num('Licensed seats', finite(sub.seats?.licensedNumberOfSeats)),
        num('Maximum seats', finite(sub.seats?.maximumNumberOfSeats)),
      ]),
      group('dates', 'Dates', 'google-admin', [
        datetime('Created', sub.creationTime),
        date('Commitment start', sub.plan?.commitmentInterval?.startTime),
        date('Commitment end (renewal)', sub.plan?.commitmentInterval?.endTime),
        date('Trial end', trial?.trialEndTime),
      ]),
    ]),
    // Distinguishable from the tenant block when an asset has both.
    title: 'Google Workspace (reseller)',
  };
}
