/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AssetIntegrationSection } from '@weavestream/shared';
import { ToastProvider } from '../ui/toast';
import { IntegrationSections } from './integration-sections';

const apiFetch = jest.fn();
const refresh = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
jest.mock('../../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

const COMPANY = '00000000-0000-4000-8000-0000000000c1';
const ASSET = '00000000-0000-4000-8000-0000000000a1';
const RECORD = '00000000-0000-4000-8000-0000000000e1';
const FIELD = '00000000-0000-4000-8000-0000000000f1';

const entry: AssetIntegrationSection = {
  integrationId: '00000000-0000-4000-8000-000000000001',
  driver: 'level',
  integrationName: 'Example Level',
  lastSyncedAt: new Date().toISOString(),
  section: { title: 'Level RMM', groups: [{ key: 'status', title: 'Status', rows: [{ label: 'Platform', kind: 'text', value: 'Windows' }] }] },
  syncRecordId: RECORD,
  differences: [{
    syncRecordId: RECORD, assetFieldId: FIELD, fieldLabel: 'Hostname',
    localValue: 'front-desk', sourceValue: 'ws-01', detectedAt: '2026-10-01T00:00:00.000Z',
  }],
};

function renderSections(canResolve: boolean) {
  return render(
    <ToastProvider>
      <IntegrationSections sections={[entry]} companyId={COMPANY} assetId={ASSET} canResolve={canResolve} />
    </ToastProvider>,
  );
}

describe('IntegrationSections differences', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    refresh.mockReset();
  });

  it('lists each difference at the bottom of the panel with both values', () => {
    renderSections(true);
    const group = screen.getByRole('group', { name: 'Differences' });
    expect(within(group).getByText('Hostname')).toBeInTheDocument();
    expect(within(group).getByText('front-desk')).toBeInTheDocument();
    expect(within(group).getByText('ws-01')).toBeInTheDocument();
    expect(within(group).getByText('Level RMM')).toBeInTheDocument();
  });

  it('Use <source> value resolves the difference and refreshes the page', async () => {
    apiFetch.mockResolvedValue({ ok: true, data: { ok: true } });
    renderSections(true);
    fireEvent.click(screen.getByRole('button', { name: 'Use Level RMM value' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(apiFetch).toHaveBeenCalledWith(`/companies/${COMPANY}/assets/${ASSET}/integration-differences/resolve`, {
      method: 'POST',
      body: JSON.stringify({ syncRecordId: RECORD, assetFieldId: FIELD, choice: 'source' }),
    });
  });

  it('Keep ours sends the local choice and shows a failure without refreshing', async () => {
    apiFetch.mockResolvedValue({ ok: false, problem: { title: 'Forbidden', status: 403, detail: 'Not allowed.' } });
    renderSections(true);
    fireEvent.click(screen.getByRole('button', { name: 'Keep ours' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      body: JSON.stringify({ syncRecordId: RECORD, assetFieldId: FIELD, choice: 'local' }),
    })));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('hides the buttons from viewers who cannot write the asset', () => {
    renderSections(false);
    expect(screen.getByRole('group', { name: 'Differences' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Keep ours' })).not.toBeInTheDocument();
  });

  it('shows no Differences group without differences', () => {
    render(<ToastProvider><IntegrationSections sections={[{ ...entry, differences: [] }]} companyId={COMPANY} assetId={ASSET} canResolve /></ToastProvider>);
    expect(screen.queryByRole('group', { name: 'Differences' })).not.toBeInTheDocument();
  });
});
