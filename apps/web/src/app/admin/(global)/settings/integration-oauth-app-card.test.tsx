/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { IntegrationOAuthApp } from '@weavestream/shared';
import { ToastProvider } from '../../../../components/ui';
import { IntegrationOAuthAppCard } from './integration-oauth-app-card';

const apiFetch = jest.fn();
const copyToClipboard = jest.fn();

jest.mock('../../../../lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
jest.mock('@weavestream/shared/browser', () => ({
  copyToClipboard: (...a: unknown[]) => copyToClipboard(...a),
}));

const REDIRECT = 'https://ws.example.test/api/v1/admin/integrations/oauth/callback';

function app(over: Partial<IntegrationOAuthApp> = {}): IntegrationOAuthApp {
  return {
    provider: 'google',
    configured: false,
    clientId: null,
    secretFingerprint: null,
    redirectUri: REDIRECT,
    scopes: ['openid', 'scope.read'],
    updatedAt: null,
    ...over,
  };
}

function renderCard(initial: IntegrationOAuthApp | null) {
  render(
    <ToastProvider>
      <IntegrationOAuthAppCard initial={initial} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  apiFetch.mockReset();
  copyToClipboard.mockReset().mockResolvedValue(true);
});

describe('IntegrationOAuthAppCard', () => {
  it('shows the redirect URI and scopes with copy buttons', async () => {
    renderCard(app());
    expect(screen.getByText(REDIRECT)).toBeInTheDocument();
    expect(screen.getByText('not configured')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy authorized redirect uri' }));
    });
    expect(copyToClipboard).toHaveBeenCalledWith(REDIRECT);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy scopes' }));
    });
    expect(copyToClipboard).toHaveBeenLastCalledWith('openid scope.read');
  });

  it('saves through the step-up route and clears the write-only secret', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: app({ configured: true, clientId: 'client-1', secretFingerprint: 'abc123def456' }),
    });
    renderCard(app());
    const save = screen.getByRole('button', { name: 'Save OAuth app' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: ' client-1 ' } });
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'typed-secret' } });
    await act(async () => {
      fireEvent.click(save);
    });
    expect(apiFetch).toHaveBeenCalledWith('/settings/integration-oauth-apps/google', {
      method: 'PUT',
      body: JSON.stringify({ clientId: 'client-1', clientSecret: 'typed-secret' }),
    });
    expect(screen.getByLabelText('Client secret')).toHaveValue('');
    expect(screen.getByText(/abc123def456/)).toBeInTheDocument();
    expect(screen.getByText('configured')).toBeInTheDocument();
  });

  it('stays silent when the step-up prompt is dismissed', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 403, data: null, stepUpCancelled: true });
    renderCard(app());
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'client-1' } });
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'typed-secret' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save OAuth app' }));
    });
    expect(screen.queryByText(/Could not save/)).not.toBeInTheDocument();
    expect(screen.getByText('not configured')).toBeInTheDocument();
  });

  it('explains when scopes are not known yet, and when loading failed', () => {
    renderCard(app({ scopes: [] }));
    expect(screen.getByText(/Scopes appear here/)).toBeInTheDocument();
  });

  it('shows a load error without the form', () => {
    renderCard(null);
    expect(screen.getByText(/Could not load the Google OAuth app/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Client ID')).not.toBeInTheDocument();
  });
});
