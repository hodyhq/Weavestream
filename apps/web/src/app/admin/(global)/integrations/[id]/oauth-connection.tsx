'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type {
  DriverOAuthDescriptor,
  IntegrationOAuthStartResponse,
  IntegrationOAuthStatus,
  IntegrationSetupCheck,
  SetupGuideStep,
} from '@weavestream/shared';
import { INTEGRATION_OAUTH_PROVIDER_LABELS, problemMessage } from '@weavestream/shared';
import { apiFetch } from '../../../../../lib/api';
import { FormattedDate } from '../../../../../lib/timezone-context';
import { Btn, Icon, Tag, useToast } from '../../../../../components/ui';
import { SetupGuide } from '../../../../../components/integrations/setup-guide';

/**
 * Connect / Reconnect / Disconnect for drivers whose descriptor declares
 * `oauth`. Connecting sends the browser to the provider; the API callback
 * brings it back here with a generic `?oauth=connected|failed` flag, which
 * becomes a toast and is then stripped from the URL.
 */
export function OAuthConnection({
  integrationId,
  oauth,
  setupGuide,
}: {
  integrationId: string;
  oauth: DriverOAuthDescriptor;
  setupGuide?: SetupGuideStep[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const toast = useToast();
  const [status, setStatus] = useState<IntegrationOAuthStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<'connect' | 'disconnect' | null>(null);
  const [check, setCheck] = useState<IntegrationSetupCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const label = INTEGRATION_OAUTH_PROVIDER_LABELS[oauth.provider];

  const load = useCallback(async () => {
    const res = await apiFetch<IntegrationOAuthStatus>(`/admin/integrations/${integrationId}/oauth`);
    if (res.ok && res.data) {
      setStatus(res.data);
      setLoadFailed(false);
    } else {
      setLoadFailed(true);
    }
  }, [integrationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const flag = sp.get('oauth');
  useEffect(() => {
    if (flag !== 'connected' && flag !== 'failed') return;
    toast.push(
      flag === 'connected'
        ? `Connected with ${label}.`
        : `Could not connect with ${label}. Try again, or check the OAuth app under Settings.`,
      flag === 'connected' ? 'ok' : 'danger',
    );
    const params = new URLSearchParams(sp.toString());
    params.delete('oauth');
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
    // Fire once per flag value; toast/router identities are irrelevant here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flag]);

  async function connect() {
    setBusy('connect');
    const res = await apiFetch<IntegrationOAuthStartResponse>(
      `/admin/integrations/${integrationId}/oauth/start`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    if (!res.ok || !res.data) {
      setBusy(null);
      if (!res.stepUpCancelled) {
        toast.push(problemMessage(res.problem) ?? `Could not start the ${label} sign-in.`, 'danger');
      }
      return;
    }
    // Same-tab navigation to the provider; `open` rather than `location` so it is testable.
    window.open(res.data.authorizeUrl, '_self');
  }

  async function runCheck() {
    setChecking(true);
    const res = await apiFetch<IntegrationSetupCheck>(`/admin/integrations/${integrationId}/check`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    setChecking(false);
    if (!res.ok || !res.data) {
      toast.push(problemMessage(res.problem) ?? 'Could not run the setup check.', 'danger');
      return;
    }
    setCheck(res.data);
  }

  async function disconnect() {
    if (
      !window.confirm(
        `Disconnect from ${label}?\n\nWeavestream revokes its access and forgets the connection. Syncs stop until you connect again.`,
      )
    ) {
      return;
    }
    setBusy('disconnect');
    const res = await apiFetch<null>(`/admin/integrations/${integrationId}/oauth/disconnect`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    setBusy(null);
    if (!res.ok && res.status !== 204) {
      if (!res.stepUpCancelled) {
        toast.push(problemMessage(res.problem) ?? 'Could not disconnect.', 'danger');
      }
      return;
    }
    toast.push(`Disconnected from ${label}.`, 'ok');
    await load();
    router.refresh();
  }

  const connection = status?.connection ?? null;
  // An unreadable stored grant still occupies the slot: offer Reconnect and Disconnect.
  const needsReconnect = status?.needsReconnect ?? false;
  const hasGrant = Boolean(connection) || needsReconnect;
  const appConfigured = status?.appConfigured ?? false;

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h3 style={headerStyle}>Connection</h3>
      {loadFailed ? (
        <Tag tone="danger">Could not load the connection status. Reload to try again.</Tag>
      ) : !status ? (
        <p style={mutedStyle}>Loading connection status…</p>
      ) : (
        <>
          {connection ? (
            <p style={{ margin: 0, fontSize: 13 }}>
              <Tag tone="ok">connected</Tag>{' '}
              {connection.connectedAs ? (
                <>
                  Connected as <strong>{connection.connectedAs}</strong> on{' '}
                </>
              ) : (
                'Connected on '
              )}
              <FormattedDate value={connection.connectedAt} />.
            </p>
          ) : needsReconnect ? (
            <p style={{ margin: 0, fontSize: 13 }}>
              <Tag tone="danger">needs reconnect</Tag> The saved connection can&apos;t be read. Reconnect,
              or disconnect to remove it.
            </p>
          ) : (
            <p style={{ margin: 0, fontSize: 13 }}>
              <Tag tone="warn">not connected</Tag> Sign in with an administrator account of the
              organization to connect.
            </p>
          )}
          {!appConfigured && (
            <p style={mutedStyle}>
              The {label} OAuth app is not set up for this Weavestream install yet.{' '}
              <Link href="/admin/settings?tab=integrations" style={linkStyle}>
                Set it up in Settings
              </Link>
              .
            </p>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Btn
              kind={hasGrant ? 'outline' : 'primary'}
              size="sm"
              icon={hasGrant ? Icon.refresh : Icon.plug}
              onClick={() => void connect()}
              loading={busy === 'connect'}
              disabled={!appConfigured || busy !== null}
            >
              {hasGrant ? 'Reconnect' : `Connect with ${label}`}
            </Btn>
            {hasGrant && (
              <Btn
                kind="ghost"
                size="sm"
                icon={Icon.x}
                onClick={() => void disconnect()}
                loading={busy === 'disconnect'}
                disabled={busy !== null}
              >
                Disconnect
              </Btn>
            )}
          </div>
          {setupGuide && setupGuide.length > 0 && (
            <SetupGuide
              steps={setupGuide}
              redirectUri={status.redirectUri}
              scopeGroups={[{ scopes: oauth.scopes }]}
              check={check}
              onCheck={() => void runCheck()}
              checking={checking}
              checkDisabledReason={connection ? null : `Connect with ${label} first, then press Check setup.`}
              defaultOpen={!connection}
            />
          )}
        </>
      )}
    </section>
  );
}

const headerStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-display)',
  fontSize: 14,
  fontWeight: 600,
  letterSpacing: -0.2,
  color: 'var(--text)',
};

const mutedStyle: React.CSSProperties = { margin: 0, fontSize: 12.5, color: 'var(--muted)' };

const linkStyle: React.CSSProperties = {
  color: 'var(--accent)',
  fontWeight: 600,
  textDecoration: 'none',
};
