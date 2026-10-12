'use client';

import { useState } from 'react';
import type { IntegrationOAuthApp, IntegrationSetupCheck } from '@weavestream/shared';
import { INTEGRATION_OAUTH_PROVIDER_LABELS, problemMessage } from '@weavestream/shared';
import { copyToClipboard } from '@weavestream/shared/browser';
import { apiFetch } from '../../../../lib/api';
import { Btn, Field, Icon, Input, Tag, useToast } from '../../../../components/ui';
import { ScopeList, SetupGuide } from '../../../../components/integrations/setup-guide';
import { SectionHeader } from './settings-form';

/**
 * Instance OAuth app for one provider (Admin > Settings > Integrations).
 *
 * Shows the redirect URI and scopes to register with the provider, and
 * saves the client ID + secret through a step-up gated route. The secret
 * is write-only: once saved, only its last four characters are shown.
 * Microsoft also takes the secret's expiry date (warned 30 days ahead) and,
 * optionally, the operator's own directory (tenant) ID for Check setup.
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
  const [expiresAt, setExpiresAt] = useState(initial?.secretExpiresAt ?? '');
  const [tenantId, setTenantId] = useState(initial?.tenantId ?? '');
  const [pending, setPending] = useState(false);
  const [check, setCheck] = useState<IntegrationSetupCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const label = INTEGRATION_OAUTH_PROVIDER_LABELS[provider];
  const isMicrosoft = provider === 'microsoft';
  const title = isMicrosoft ? 'Microsoft app' : `${label} OAuth app`;

  if (!app) {
    return (
      <section style={sectionStyle}>
        <SectionHeader label={title} />
        <Tag tone="danger">Could not load the {title} settings. Reload to try again.</Tag>
      </section>
    );
  }

  // A stored secret may be kept: leaving the field blank changes only the client ID.
  const secret = clientSecret.trim();
  const msChanged =
    isMicrosoft && (expiresAt !== (app.secretExpiresAt ?? '') || tenantId.trim() !== (app.tenantId ?? ''));
  const canSave =
    clientId.trim().length > 0 &&
    (secret.length > 0 || (app.configured && (clientId.trim() !== (app.clientId ?? '') || msChanged))) &&
    !pending;

  async function save() {
    if (!canSave) return;
    setPending(true);
    const res = await apiFetch<IntegrationOAuthApp>(`/settings/integration-oauth-apps/${provider}`, {
      method: 'PUT',
      body: JSON.stringify({
        clientId: clientId.trim(),
        ...(secret ? { clientSecret: secret } : {}),
        ...(isMicrosoft ? { secretExpiresAt: expiresAt || null, tenantId: tenantId.trim() || null } : {}),
      }),
    });
    setPending(false);
    if (!res.ok || !res.data) {
      if (!res.stepUpCancelled) {
        toast.push(problemMessage(res.problem) ?? `Could not save the ${title}.`, 'danger');
      }
      return;
    }
    setApp(res.data);
    setClientId(res.data.clientId ?? '');
    setClientSecret('');
    setExpiresAt(res.data.secretExpiresAt ?? '');
    setTenantId(res.data.tenantId ?? '');
    setCheck(null);
    toast.push(`${title} saved.`, 'ok');
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
          label={title}
          help={
            isMicrosoft
              ? 'One multi-tenant Entra app registration for this Weavestream install. Every Microsoft 365 integration connects through it by admin consent.'
              : `One ${label} Cloud OAuth client for this Weavestream install. Every ${label} integration connects through it.`
          }
        />
        <Tag tone={app.configured ? 'ok' : 'warn'}>{app.configured ? 'configured' : 'not configured'}</Tag>
      </div>

      {app.callbackHostWarning && <Tag tone="danger">{app.callbackHostWarning}</Tag>}
      {app.secretExpiryWarning && (
        <p role="alert" style={warningStyle}>
          {app.secretExpiryWarning}
        </p>
      )}

      <CopyRow
        label={isMicrosoft ? 'Redirect URI (Web)' : 'Authorized redirect URI'}
        help={
          isMicrosoft
            ? 'Add this exact URL as a Web redirect URI on the app registration.'
            : `Add this exact URL to the OAuth client in the ${label} Cloud console.`
        }
        value={app.redirectUri}
        onCopy={() => void copy(app.redirectUri, 'Redirect URI')}
      />
      {app.scopeGroups.length > 0 ? (
        <Field
          label={isMicrosoft ? 'Application permissions' : 'Scopes'}
          help={
            isMicrosoft
              ? 'Add each under API permissions > Add a permission > Microsoft Graph > Application permissions.'
              : 'Add each scope to the consent screen (Data Access > Manually add scopes).'
          }
        >
          <ScopeList groups={app.scopeGroups} />
        </Field>
      ) : (
        <p style={mutedStyle}>Scopes appear here once an integration that uses this app is available.</p>
      )}

      <div style={gridStyle}>
        <Field label={isMicrosoft ? 'Application (client) ID' : 'Client ID'} htmlFor={`oauth-client-id-${provider}`}>
          <Input
            id={`oauth-client-id-${provider}`}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            maxLength={512}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field
          label={isMicrosoft ? 'Client secret value' : 'Client secret'}
          htmlFor={`oauth-client-secret-${provider}`}
          help={
            app.configured
              ? `Saved secret ends in ${app.secretMask ?? '(unreadable, save it again)'}. Leave blank to keep it. If you change the client ID, the saved secret is kept, so enter the new client's secret too unless it is the same.`
              : 'Stored encrypted. It is never shown again after saving.'
          }
        >
          <Input
            id={`oauth-client-secret-${provider}`}
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            maxLength={512}
            autoComplete="new-password"
            placeholder={app.configured ? 'Saved (write-only)' : ''}
          />
        </Field>
        {isMicrosoft && (
          <>
            <Field
              label="Secret expires"
              htmlFor="oauth-secret-expires-microsoft"
              help="The Expires date Entra showed for this secret. Weavestream warns 30 days before it."
            >
              <Input
                id="oauth-secret-expires-microsoft"
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            </Field>
            <Field
              label="Directory (tenant) ID (optional)"
              htmlFor="oauth-tenant-id-microsoft"
              help="Your own tenant, from the app's overview page. Check setup uses it to verify the secret."
            >
              <Input
                id="oauth-tenant-id-microsoft"
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
                maxLength={36}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          </>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Btn kind="primary" onClick={() => void save()} loading={pending} disabled={!canSave}>
          {isMicrosoft ? 'Save Microsoft app' : 'Save OAuth app'}
        </Btn>
      </div>

      {app.setupGuide && app.setupGuide.length > 0 && (
        <SetupGuide
          steps={app.setupGuide}
          redirectUri={app.redirectUri}
          scopeGroups={app.scopeGroups}
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
}: {
  label: string;
  help: string;
  value: string;
  onCopy: () => void;
}) {
  return (
    <Field label={label} help={help}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <code style={codeStyle}>{value}</code>
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

const warningStyle: React.CSSProperties = { margin: 0, fontSize: 12.5, color: 'var(--danger)', fontWeight: 600 };

const mutedStyle: React.CSSProperties = { margin: 0, fontSize: 12, color: 'var(--muted)' };
