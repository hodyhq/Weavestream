import type { SetupGuideStep } from '@weavestream/shared';
import { GOOGLE_SETUP_STEP as S, GOOGLE_WORKSPACE_SETUP_GUIDE } from '../google-workspace/google-workspace.setup-guide.js';

/**
 * The Google Workspace guide with the reseller's API, connect and mapping
 * steps swapped in. Step ids and order stay the same so the shared
 * Check setup messages ("step 2", "step 7") still point at the right step.
 */
const OVERRIDES: Partial<Record<string, Partial<SetupGuideStep>>> = {
  [S.apis]: {
    title: 'Turn on the Google Workspace Reseller API',
    body: [
      'Weavestream reads your customers\' subscriptions through the **Google Workspace Reseller API**. Open the link below, check that your project is selected, and press **Enable**.',
      'If you also use the Google Workspace integration, enable its three APIs as well. Both integrations share this project and OAuth client.',
    ].join('\n\n'),
    links: [
      { label: 'Google Workspace Reseller API', href: 'https://console.cloud.google.com/apis/library/reseller.googleapis.com' },
      { label: 'API library', href: 'https://console.cloud.google.com/apis/library' },
    ],
  },
  [S.connect]: {
    title: 'Connect your reseller account',
    body: [
      'You do this once, not once per customer. Go to **Integrations > New integration > Google Workspace (reseller)**, then press **Connect with Google** on the **Credentials & schedule** tab.',
      'Sign in with an admin of your **reseller domain**: an account that can sign in to the Google **Partner Sales Console**. A customer\'s admin account will not work.',
      'On the "Google hasn\'t verified this app" screen, press **Advanced**, then **Go to Weavestream (unsafe)**. Tick the permission and press **Continue**.',
    ].join('\n\n'),
  },
  [S.trust]: {
    body: [
      'If your own reseller domain only allows approved apps, signing in fails with "access blocked" or "admin_policy_enforced".',
      'In your reseller domain\'s Google Admin console, open **Security > Access and data control > API controls > Manage third-party app access**. Press **Configure new app**, search for your **Client ID**, and set it to **Trusted**. Then connect again.',
    ].join('\n\n'),
  },
  [S.layouts]: {
    title: 'Map each customer to a company, then sync',
    body: [
      'Open **Organizations**. Every customer of your reseller account is listed by its domain. Map each one to its Weavestream company, set **Status** to active and save.',
      'Open the **Map layouts** tab and pick the layout for **Subscriptions** (for example Licenses), matching on the subscription ID.',
      'To see renewals in **Expiring soon**, add a date field flagged as an expiry to that layout and map **Commitment end (renewal)** or **Trial end** to it.',
      'Then press **Dry run** to preview, and **Run sync now**.',
    ].join('\n\n'),
  },
};

export const GOOGLE_WORKSPACE_RESELLER_SETUP_GUIDE: SetupGuideStep[] = GOOGLE_WORKSPACE_SETUP_GUIDE.map((step) => ({
  ...step,
  ...OVERRIDES[step.id],
}));
