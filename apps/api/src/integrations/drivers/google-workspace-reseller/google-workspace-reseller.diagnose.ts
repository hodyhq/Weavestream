import type { IntegrationSetupCheck } from '@weavestream/shared';
import type { IntegrationContext } from '../integration-driver.js';
import { oauthFetch } from '../../oauth/oauth-token.js';
import { RESELLER } from '../google-workspace/google-workspace.driver.js';
import { probeFailure, tokenFailure } from '../google-workspace/google-workspace.diagnose.js';
import { GOOGLE_SETUP_STEP as S } from '../google-workspace/google-workspace.setup-guide.js';
import { GOOGLE_WORKSPACE_RESELLER_OAUTH, NOT_A_RESELLER } from './google-workspace-reseller.driver.js';

/**
 * Check setup for a connected reseller integration: one GET on the
 * subscriptions list, mapped with the Google Workspace failure messages
 * plus the not-a-reseller case. Fixed messages only.
 */
export async function diagnoseResellerConnection(ctx: IntegrationContext): Promise<IntegrationSetupCheck> {
  const url = `${RESELLER}/subscriptions?maxResults=1`;
  // A token was issued, so the project, consent screen and client work.
  const passed: string[] = [S.project, S.consent, S.client, S.credentials];
  let res: Response;
  try {
    res = await oauthFetch(ctx, GOOGLE_WORKSPACE_RESELLER_OAUTH, url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      serviceName: 'Google Workspace Reseller',
    });
  } catch (e) {
    return { ok: false, passedStepIds: [], failures: [tokenFailure(e)] };
  }
  const failure = await probeFailure(url, res, NOT_A_RESELLER);
  if (!failure) return { ok: true, passedStepIds: [...passed, S.apis, S.scopes, S.connect, S.trust], failures: [] };
  // The API answered through the policy with an account or scope problem: it is enabled.
  if (failure.stepId === S.connect) passed.push(S.apis, S.trust);
  return { ok: false, passedStepIds: passed, failures: [failure] };
}
