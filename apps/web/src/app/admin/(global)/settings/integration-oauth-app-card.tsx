'use client';

import { useState } from 'react';
import type { IntegrationOAuthApp, IntegrationSetupCheck } from '@weavestream/shared';
import { INTEGRATION_OAUTH_PROVIDER_LABELS, problemMessage } from '@weavestream/shared';
import { copyToClipboard } from '@weavestream/shared/browser';
import { apiFetch } from '../../../../lib/api';
import { Btn, Field, Icon, Input, Tag, useToast } from '../../../../components/ui';
import { SetupGuide } from '../../../../components/integrations/setup-guide';
import { SectionHeader } from './settings-form';

/**
 * Instance OAuth app for one provider (Admin > Settings > Integrations).
 *
 * Shows the redirect URI and scopes to register with the provider, and
 * saves the client ID + secret through a step-up gated route. The secret
 * is write-only: once saved, only its last four characters are shown.
 */
export function IntegrationOAuthAppCard({
  initial,
  provider = 'google',
}: {
  initial: IntegrationOAuthApp | null;
  provider?: IntegrationOAuthApp['provider'];
}) {
  const toast = useToast();
  const [app, setApp] = useState(initial);
  const [clientId, setClientId] = useState(initial?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [pending, setPending] = useState(false);
  const [check, setCheck] = useState<IntegrationSetupCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const label = INTEGRATION_OAUTH_PROVIDER_LABELS[provider];

  if (!app) {
    return (
      <section style={sectionStyle}>
        <SectionHeader label={`${label} OAuth app`} />
        <Tag tone="danger">Could not load the {label} OAuth app settings. Reload to try again.</Tag>
      </section>
    );
  }

  // A stored secret may be kept: leaving the field blank changes only the client ID.
  const secret = clientSecret.trim();
  const canSave =
    clientId.trim().length > 0 &&
    (secret.length > 0 || (app.configured && clientId.trim() !== (app.clientId ?? ''))) &&
    !pending;

  async function save() {
    if (!canSave) return;
    setPending(true);
    const res = await apiFetch<IntegrationOAuthApp>(`/settings/integration-oauth-apps/${provider}`, {
      method: 'PUT',
      body: JSON.stringify({ clientId: clientId.trim(), ...(secret ? { clientSecret: secret } : {}) }),
    });
    setPending(false);
    if (!res.ok || !res.data) {
      if (!res.stepUpCancelled) {
        toast.push(problemMessage(res.problem) ?? `Could not save the ${label} OAuth app.`, 'danger');
      }
      return;
    }
    setApp(res.data);
    setClientId(res.data.clientId ?? '');
    setClientSecret('');
    setCheck(null);
    toast.push(`${label} OAuth app saved.`, 'ok');
  }

  async function runCheck() {
    setChecking(true);
    const res = await apiFetch<IntegrationSetupCheck>(`/settings/integration-oauth-apps/${provider}/check`, {
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

  async function copy(value: string, what: string) {
    const ok = await copyToClipboard(value);
    toast.push(ok ? `${what} copied.` : `Could not copy the ${what.toLowerCase()}.`, ok ? 'ok' : 'danger');
  }

  return (
    <section style={sectionStyle}>
      <div style={headerRowStyle}>
        <SectionHeader
          label={`${label} OAuth app`}
          help={`One ${label} Cloud OAuth client for this Weavestream install. Every ${label} integration connects through it.`}
        />
        <Tag tone={app.configured ? 'ok' : 'warn'}>{app.configured ? 'configured' : 'not configured'}</Tag>
      </div>

      {app.callbackHostWarning && <Tag tone="danger">{app.callbackHostWarning}</Tag>}

      <CopyRow
        label="Authorized redirect URI"
        help={`Add this exact URL to the OAuth client in the ${label} Cloud console.`}
        value={app.redirectUri}
        onCopy={() => void copy(app.redirectUri, 'Redirect URI')}
      />
      {app.scopes.length > 0 ? (
        <CopyRow
          label="Scopes"
          help="Add these scopes to the consent screen."
          value={app.scopes.join('\n')}
          onCopy={() => void copy(app.scopes.join(' '), 'Scopes')}
          multiline
        />
      ) : (
        <p style={mutedStyle}>Scopes appear here once an integration that uses this app is available.</p>
      )}

      <div style={gridStyle}>
        <Field label="Client ID" htmlFor="oauth-client-id">
          <Input
            id="oauth-client-id"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            maxLength={512}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field
          label="Client secret"
          htmlFor="oauth-client-secret"
          help={
            app.configured
              ? `Saved secret ends in ${app.secretMask ?? '(unreadable, save it again)'}. Leave blank to keep it. If you change the client ID, the saved secret is kept, so enter the new client's secret too unless it is the same.`
              : 'Stored encrypted. It is never shown again after saving.'
          }
        >
          <Input
            id="oauth-client-secret"
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            maxLength={512}
            autoComplete="new-password"
            placeholder={app.configured ? 'Saved (write-only)' : ''}
          />
        </Field>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Btn kind="primary" onClick={() => void save()} loading={pending} disabled={!canSave}>
          Save OAuth app
        </Btn>
      </div>

      {app.setupGuide && app.setupGuide.length > 0 && (
        <SetupGuide
          steps={app.setupGuide}
          redirectUri={app.redirectUri}
          scopes={app.scopes}
          check={check}
          onCheck={() => void runCheck()}
          checking={checking}
          checkDisabledReason={app.configured ? null : 'Save the client ID and secret first, then press Check setup.'}
          defaultOpen={!app.configured}
        />
      )}
    </section>
  );
}

function CopyRow({
  label,
  help,
  value,
  onCopy,
  multiline = false,
}: {
  label: string;
  help: string;
  value: string;
  onCopy: () => void;
  multiline?: boolean;
}) {
  return (
    <Field label={label} help={help}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <code style={{ ...codeStyle, whiteSpace: multiline ? 'pre-wrap' : 'normal' }}>{value}</code>
        <Btn kind="outline" size="sm" icon={Icon.copy} onClick={onCopy} aria-label={`Copy ${label.toLowerCase()}`}>
          Copy
        </Btn>
      </div>
    </Field>
  );
}

const sectionStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 14 };

const headerRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: 12,
  flexWrap: 'wrap',
};

// auto-fit collapses the two inputs into one column on narrow screens.
const gridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
  gap: 16,
};

const codeStyle: React.CSSProperties = {
  flex: '1 1 240px',
  minWidth: 0,
  padding: '7px 10px',
  border: '1px solid var(--line)',
  borderRadius: 6,
  background: 'var(--panel-2)',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--text)',
  overflowWrap: 'anywhere',
};

const mutedStyle: React.CSSProperties = { margin: 0, fontSize: 12, color: 'var(--muted)' };
