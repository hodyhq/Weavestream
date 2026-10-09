/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MICROSOFT_REPORT_SETTING } from '@weavestream/shared';
import { ToastProvider } from '../../../../../components/ui';
import { REPORT_NAMES_QUESTION, ReportNamesChoice, SHOW_EXPLANATION } from './report-names-choice';

const apiFetch = jest.fn();
jest.mock('../../../../../lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

const URL_ = '/admin/integrations/int-1/microsoft/report-names';

async function renderIt(choice: 'shown' | 'hidden' | null = null) {
  await act(async () => {
    render(
      <ToastProvider>
        <ReportNamesChoice integrationId="int-1" choice={choice} />
      </ToastProvider>,
    );
  });
}

beforeEach(() => {
  apiFetch.mockReset();
  jest.spyOn(window, 'confirm').mockReset().mockReturnValue(true);
});

describe('ReportNamesChoice', () => {
  it('reads the current value first and asks, naming the exact setting, its path and what changes', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, status: 200, data: { concealed: true, choice: null, readError: null } });
    await renderIt();
    expect(apiFetch).toHaveBeenCalledWith(URL_);
    expect(screen.getByText(REPORT_NAMES_QUESTION)).toBeInTheDocument();
    expect(screen.getByText(`${MICROSOFT_REPORT_SETTING.path} > "${MICROSOFT_REPORT_SETTING.label}"`)).toBeInTheDocument();
    expect(screen.getByText('On (names hidden)')).toBeInTheDocument();
    // The trade-off names the tenant-wide effect, who sees names, and how to reverse it.
    expect(SHOW_EXPLANATION).toContain('"Conceal user, group, and site names in all reports"');
    expect(SHOW_EXPLANATION).toContain('displayConcealedNames');
    expect(SHOW_EXPLANATION).toContain('true to false');
    expect(SHOW_EXPLANATION).toContain('whole tenant');
    expect(SHOW_EXPLANATION).toMatch(/Reports Readers\) sees them, and so does Weavestream/);
    expect(SHOW_EXPLANATION).toContain('turn concealment back on');
    expect(screen.getByRole('button', { name: /Yes, show real names/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /No, keep names hidden/ })).toBeEnabled();
  });

  it('confirms with the precise text, then shows the result message', async () => {
    apiFetch
      .mockResolvedValueOnce({ ok: true, status: 200, data: { concealed: true, choice: null, readError: null } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { concealed: false, choice: 'shown', readError: null, message: 'Done: "Conceal user, group, and site names in all reports" is now Off (real names shown) for this tenant.' } });
    await renderIt();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Yes, show real names/ }));
    });
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining(SHOW_EXPLANATION));
    expect(apiFetch).toHaveBeenLastCalledWith(URL_, { method: 'POST', body: JSON.stringify({ action: 'show' }) });
    expect(screen.getByRole('status')).toHaveTextContent('is now Off (real names shown)');
    // Reversible from the same place.
    expect(screen.getByRole('button', { name: 'Turn concealment back on' })).toBeEnabled();
  });

  it('sends nothing when the confirmation is cancelled', async () => {
    (window.confirm as jest.Mock).mockReturnValue(false);
    apiFetch.mockResolvedValueOnce({ ok: true, status: 200, data: { concealed: true, choice: null, readError: null } });
    await renderIt();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Yes, show real names/ }));
    });
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('records "keep" without a confirmation, and offers the revert when names are shown', async () => {
    apiFetch
      .mockResolvedValueOnce({ ok: true, status: 200, data: { concealed: true, choice: null, readError: null } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { concealed: true, choice: 'hidden', readError: null, message: 'Nothing was changed in the tenant.' } });
    await renderIt();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /No, keep names hidden/ }));
    });
    expect(window.confirm).not.toHaveBeenCalled();
    expect(apiFetch).toHaveBeenLastCalledWith(URL_, { method: 'POST', body: JSON.stringify({ action: 'keep' }) });
    expect(screen.getByText(/You chose to keep names hidden/)).toBeInTheDocument();
  });

  it('turns concealment back on after confirming', async () => {
    apiFetch
      .mockResolvedValueOnce({ ok: true, status: 200, data: { concealed: false, choice: 'shown', readError: null } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { concealed: true, choice: 'hidden', readError: null, message: 'is now On (names hidden)' } });
    await renderIt('shown');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Turn concealment back on' }));
    });
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('false to true'));
    expect(apiFetch).toHaveBeenLastCalledWith(URL_, { method: 'POST', body: JSON.stringify({ action: 'conceal' }) });
  });

  it('disables the change when the setting could not be read', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, status: 200, data: { concealed: null, choice: null, readError: 'Weavestream could not read it.' } });
    await renderIt();
    expect(screen.getByText('could not be read')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Yes, show real names/ })).toBeDisabled();
  });
});
