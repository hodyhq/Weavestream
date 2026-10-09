'use client';

import { useState } from 'react';
import type { IntegrationOAuthApp } from '@weavestream/shared';
import { INTEGRATION_OAUTH_PROVIDER_LABELS, problemMessage } from '@weavestream/shared';
import { copyToClipboard } from '@weavestream/shared/browser';
import { apiFetch } from '../../../../lib/api';
import { Btn, Field, Icon, Input, Tag, useToast } from '../../../../components/ui';
import { SectionHeader } from './settings-form';

/**
 * Instance OAuth app for one provider (Admin > Settings > Integrations).
 *
 * Shows the redirect URI and scopes to register with the provider, and
 * saves the client ID + secret through a step-up gated route. The secret
 * is write-only: once saved, only its fingerprint is shown.
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
  const label = INTEGRATION_OAUTH_PROVIDER_LABELS[provider];

  if (!app) {
    return (
      <section style={sectionStyle}>
        <SectionHeader label={`${label} OAuth app`} />
        <Tag tone="danger">Could not load the {label} OAuth app settings. Reload to try again.</Tag>
      </section>
    );
  }

  const canSave = clientId.trim().length > 0 && clientSecret.trim().length > 0 && !pending;

  async function save() {
    if (!canSave) return;
    setPending(true);
    const res = await apiFetch<IntegrationOAuthApp>(`/settings/integration-oauth-apps/${provider}`, {
      method: 'PUT',
      body: JSON.stringify({ clientId: clientId.trim(), clientSecret: clientSecret.trim() }),
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
    toast.push(`${label} OAuth app saved.`, 'ok');
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
              ? `Saved secret fingerprint: ${app.secretFingerprint ?? 'unreadable, save it again'}. Enter the secret again to change either value.`
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
