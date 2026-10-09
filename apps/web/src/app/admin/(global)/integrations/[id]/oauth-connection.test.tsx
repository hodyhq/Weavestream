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
  return { ok: true, status: 200, data: { provider: 'google', appConfigured: true, redirectUri: 'https://ws.example.test/cb', needsReconnect: false, connection: null, ...over } };
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
