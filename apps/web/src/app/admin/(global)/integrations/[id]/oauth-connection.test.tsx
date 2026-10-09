/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DriverOAuthDescriptor } from '@weavestream/shared';
import { ToastProvider } from '../../../../../components/ui';
import { OAuthConnection } from './oauth-connection';

const apiFetch = jest.fn();
const refresh = jest.fn();
const replace = jest.fn();
let search = new URLSearchParams();

jest.mock('../../../../../lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, replace }),
  usePathname: () => '/admin/integrations/int-1',
  useSearchParams: () => search,
}));

const oauth: DriverOAuthDescriptor = {
  provider: 'google',
  authorizeUrl: 'https://auth.example.test/authorize',
  tokenUrl: 'https://auth.example.test/token',
  scopes: ['scope.read'],
};

function status(over: Record<string, unknown> = {}) {
  return { ok: true, status: 200, data: { provider: 'google', appConfigured: true, redirectUri: 'https://ws.example.test/cb', needsReconnect: false, appSecretExpiryWarning: null, connection: null, ...over } };
}

async function renderIt() {
  await act(async () => {
    render(
      <ToastProvider>
        <OAuthConnection integrationId="int-1" oauth={oauth} />
      </ToastProvider>,
    );
  });
}

beforeEach(() => {
  apiFetch.mockReset();
  refresh.mockReset();
  replace.mockReset();
  search = new URLSearchParams();
});

describe('OAuthConnection', () => {
  it('offers Connect with Google and sends the browser to the authorize URL', async () => {
    const open = jest.spyOn(window, 'open').mockReturnValue(null);
    apiFetch
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce({ ok: true, status: 200, data: { authorizeUrl: 'https://auth.example.test/authorize?x=1' } });
    await renderIt();
    expect(screen.getByText('not connected')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Connect with Google/ }));
    });
    expect(apiFetch).toHaveBeenLastCalledWith('/admin/integrations/int-1/oauth/start', {
      method: 'POST',
      body: '{}',
    });
    expect(open).toHaveBeenCalledWith('https://auth.example.test/authorize?x=1', '_self');
  });

  it('shows who connected, with Reconnect and Disconnect', async () => {
    apiFetch.mockResolvedValueOnce(
      status({
        connection: { connectedAs: 'admin@example.test', connectedAt: '2026-01-05T12:00:00Z', grantedScopes: [] },
      }),
    );
    await renderIt();
    expect(screen.getByText('admin@example.test')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reconnect/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Disconnect/ })).toBeInTheDocument();
  });

  it('offers Reconnect and Disconnect when the saved grant is unreadable', async () => {
    apiFetch.mockResolvedValueOnce(status({ needsReconnect: true }));
    await renderIt();
    expect(screen.getByText('needs reconnect')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reconnect/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Disconnect/ })).toBeInTheDocument();
    expect(screen.queryByText('not connected')).not.toBeInTheDocument();
  });

  it('disables connecting and links to Settings when the OAuth app is missing', async () => {
    apiFetch.mockResolvedValueOnce(status({ appConfigured: false }));
    await renderIt();
    expect(screen.getByRole('button', { name: /Connect with Google/ })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Set it up in Settings' })).toHaveAttribute(
      'href',
      '/admin/settings?tab=integrations',
    );
  });

  it('disconnects after confirmation', async () => {
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    apiFetch
      .mockResolvedValueOnce(
        status({ connection: { connectedAs: null, connectedAt: '2026-01-05T12:00:00Z', grantedScopes: [] } }),
      )
      .mockResolvedValueOnce({ ok: true, status: 204, data: null })
      .mockResolvedValueOnce(status());
    await renderIt();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Disconnect/ }));
    });
    expect(apiFetch).toHaveBeenCalledWith('/admin/integrations/int-1/oauth/disconnect', {
      method: 'POST',
      body: '{}',
    });
    await waitFor(() => expect(screen.getByText('not connected')).toBeInTheDocument());
    expect(refresh).toHaveBeenCalled();
  });

  it.each([
    ['connected', 'Connected with Google.'],
    ['failed', /Could not connect with Google/],
  ])('turns ?oauth=%s into a toast and strips the flag', async (flag, message) => {
    search = new URLSearchParams({ oauth: flag, tab: 'creds' });
    apiFetch.mockResolvedValueOnce(status());
    await renderIt();
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(replace).toHaveBeenCalledWith('/admin/integrations/int-1?tab=creds');
  });

  it('ignores any other flag value', async () => {
    search = new URLSearchParams({ oauth: '<b>provider text</b>' });
    apiFetch.mockResolvedValueOnce(status());
    await renderIt();
    expect(replace).not.toHaveBeenCalled();
  });

  it('shows the setup guide and runs the connection check once connected', async () => {
    apiFetch
      .mockResolvedValueOnce(status({ connection: { connectedAs: 'admin@example.test', connectedAt: '2026-10-01T00:00:00.000Z', grantedScopes: [] } }))
      .mockResolvedValueOnce({ ok: true, status: 200, data: { ok: true, passedStepIds: ['connect'], failures: [] } });
    await act(async () => {
      render(
        <ToastProvider>
          <OAuthConnection integrationId="int-1" oauth={oauth} setupGuide={[{ id: 'connect', title: 'Connect a customer', body: 'Sign in.' }]} />
        </ToastProvider>,
      );
    });
    fireEvent.click(screen.getByRole('button', { name: /Setup guide/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Check setup/ }));
    });
    expect(apiFetch).toHaveBeenLastCalledWith('/admin/integrations/int-1/check', { method: 'POST', body: '{}' });
    expect(screen.getByText('Setup check passed.')).toBeInTheDocument();
  });
});

describe('OAuthConnection (Microsoft admin consent)', () => {
  const msOauth: DriverOAuthDescriptor = {
    provider: 'microsoft',
    consentFlow: 'admin_consent',
    authorizeUrl: 'https://login.microsoftonline.com/organizations/v2.0/adminconsent',
    tokenUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token',
    clientCredentialsScope: 'https://graph.microsoft.com/.default',
    scopes: ['User.Read.All'],
  };
  const reportNames = { ok: true, status: 200, data: { concealed: true, choice: null, readError: null } };

  async function renderMs() {
    await act(async () => {
      render(
        <ToastProvider>
          <OAuthConnection integrationId="int-1" oauth={msOauth} />
        </ToastProvider>,
      );
    });
  }

  it('offers Connect with Microsoft and says who must approve', async () => {
    apiFetch.mockResolvedValueOnce(status({ provider: 'microsoft' }));
    await renderMs();
    expect(screen.getByRole('button', { name: /Connect with Microsoft/ })).toBeEnabled();
    expect(screen.getByText(/Global Administrator or Privileged Role Administrator/)).toBeInTheDocument();
  });

  it('shows the connected tenant, the secret expiry warning and the report-names prompt', async () => {
    apiFetch.mockImplementation(async (url: string) =>
      url.endsWith('/microsoft/report-names')
        ? reportNames
        : status({
            provider: 'microsoft',
            appSecretExpiryWarning: 'The client secret expires on 2026-10-20 (in 11 days).',
            connection: { connectedAs: 'Contoso', connectedAt: '2026-10-05T12:00:00Z', grantedScopes: [], tenantId: '11111111-2222-4333-8444-555555555555' },
          }),
    );
    await renderMs();
    expect(screen.getByText(/Connected to/)).toBeInTheDocument();
    expect(screen.getByText('Contoso')).toBeInTheDocument();
    expect(screen.getByText(/expires on 2026-10-20/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Usage report names')).toBeInTheDocument());
  });

  it('turns a failure reason into fixed text and strips it from the URL', async () => {
    search = new URLSearchParams('oauth=failed&reason=admin_required');
    apiFetch.mockResolvedValueOnce(status({ provider: 'microsoft' }));
    await renderMs();
    expect(screen.getByText(/must approve/)).toBeInTheDocument();
    expect(replace).toHaveBeenCalledWith('/admin/integrations/int-1');
  });

  it('ignores an unknown reason value (generic text, nothing echoed)', async () => {
    search = new URLSearchParams('oauth=failed&reason=<b>evil</b>');
    apiFetch.mockResolvedValueOnce(status({ provider: 'microsoft' }));
    await renderMs();
    expect(screen.getByText(/Could not connect with Microsoft/)).toBeInTheDocument();
    expect(screen.queryByText(/evil/)).not.toBeInTheDocument();
  });
});
