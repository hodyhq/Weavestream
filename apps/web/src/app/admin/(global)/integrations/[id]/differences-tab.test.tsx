/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../../../components/ui';
import { DifferencesTab } from './differences-tab';
import { apiFetch } from '../../../../../lib/api';

jest.mock('../../../../../lib/api', () => ({ apiFetch: jest.fn() }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn() }) }));
const fetchMock = apiFetch as jest.MockedFunction<typeof apiFetch>;

const ids = {
  integration: '00000000-0000-4000-8000-000000000001',
  company: '00000000-0000-4000-8000-0000000000c1',
  company2: '00000000-0000-4000-8000-0000000000c2',
  asset: '00000000-0000-4000-8000-0000000000a1',
  record: '00000000-0000-4000-8000-0000000000e1',
  field: '00000000-0000-4000-8000-0000000000f1',
};
const mapping = (companyId: string, companyName: string) => ({ id: `m-${companyId}`, companyId, companyName }) as never;
const item = {
  syncRecordId: ids.record, companyId: ids.company, companyName: 'Example Co', assetId: ids.asset,
  assetName: 'Workstation 01', assetFieldId: ids.field, fieldLabel: 'Hostname',
  localValue: 'front-desk', sourceValue: 'ws-01', detectedAt: '2026-10-01T00:00:00.000Z',
};

function renderTab() {
  return render(
    <ToastProvider>
      <DifferencesTab
        integrationId={ids.integration}
        mappings={[mapping(ids.company, 'Example Co'), mapping(ids.company2, 'Other Co')]}
        sourceLabel="Level RMM"
      />
    </ToastProvider>,
  );
}

describe('DifferencesTab', () => {
  beforeEach(() => fetchMock.mockReset());

  it('lists open differences with both values, the total and a link to the asset', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, data: { items: [item], total: 1, nextCursor: null } } as never);
    renderTab();
    expect((await screen.findAllByText('Workstation 01'))[0]!.closest('a')).toHaveAttribute('href', `/admin/companies/${ids.company}/assets/${ids.asset}`);
    expect(screen.getAllByText('front-desk').length).toBeGreaterThan(0);
    expect(screen.getAllByText('ws-01').length).toBeGreaterThan(0);
    expect(screen.getByText('1 open')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(`/admin/integrations/${ids.integration}/differences`);
  });

  it('filters by company and pages with the cursor', async () => {
    fetchMock.mockImplementation(async (path: string) => ({
      ok: true, status: 200,
      data: path.includes('cursor=') ? { items: [], total: null, nextCursor: null } : { items: [item], total: 3, nextCursor: ids.record },
    }) as never);
    renderTab();
    await screen.findAllByText('Workstation 01');
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: ids.company2 } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/admin/integrations/${ids.integration}/differences?companyId=${ids.company2}`));
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/admin/integrations/${ids.integration}/differences?companyId=${ids.company2}&cursor=${ids.record}`,
    ));
  });

  it('Keep ours resolves through the asset company path and reloads the list', async () => {
    fetchMock.mockImplementation(async (path: string) =>
      (path.endsWith('/resolve')
        ? { ok: true, status: 200, data: { ok: true } }
        : { ok: true, status: 200, data: { items: [item], total: 1, nextCursor: null } }) as never,
    );
    renderTab();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Keep ours' }))[0]!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/companies/${ids.company}/assets/${ids.asset}/integration-differences/resolve`,
      { method: 'POST', body: JSON.stringify({ syncRecordId: ids.record, assetFieldId: ids.field, choice: 'local' }) },
    ));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([p]) => String(p).includes('/differences')).length).toBe(2));
  });

  it('shows a load error', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, problem: { title: 'Forbidden', status: 403, detail: 'No access.' } } as never);
    renderTab();
    expect(await screen.findByText(/No access|Could not load/)).toBeInTheDocument();
  });
});
