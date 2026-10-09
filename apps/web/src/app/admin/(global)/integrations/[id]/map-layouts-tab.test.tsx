/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MapLayoutsTab, matchableResources, suggestField, suggestLayout } from './map-layouts-tab';

const apiFetch = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn() }) }));
jest.mock('../../../../../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
jest.mock('../../../../../components/ui', () => ({
  Btn: ({ children, loading: _loading, kind: _kind, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & Record<string, unknown>) => <button {...props}>{children}</button>,
  Field: ({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) => (
    <div><label htmlFor={htmlFor}>{label}</label>{children}</div>
  ),
  Select: (props: React.SelectHTMLAttributes<HTMLSelectElement>) => <select {...props} />,
  Tag: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  useToast: () => ({ push: jest.fn() }),
}));

const field = (id: string, name: string, slug: string) => ({
  id, name, slug, fieldType: 'TEXT', position: 0, isRequired: false, isUniquePerCompany: false,
  visibleToClients: true, isPrimary: false, showInTable: true, options: {}, archivedAt: null,
});
const layout = (id: string, name: string, slug: string, fields: ReturnType<typeof field>[]) => ({
  id, name, slug, icon: 'x', color: 'x', isActive: true, version: 1, position: 0, archivedAt: null,
  createdBy: null, createdAt: '', updatedAt: '', fields,
});

const people = layout('l-people', 'People', 'people', [field('f-name', 'Name', 'name'), field('f-email', 'Email address', 'email_address')]);
const laptops = layout('l-laptops', 'Laptops', 'laptops', [field('f-serial', 'Serial', 'serial')]);

const users = {
  key: 'users', label: 'Users', targetKind: 'asset', targetConfig: {}, dependsOnResourceKeys: [],
  matchSuggestions: { sourceField: 'primaryEmail', layoutHints: ['people', 'contacts'], fieldHints: ['email', 'e-mail'] },
};
const groups = {
  key: 'groups', label: 'Groups', targetKind: 'asset', targetConfig: {}, dependsOnResourceKeys: [],
  matchSuggestions: { sourceField: 'email', layoutHints: ['distribution lists'], fieldHints: ['email'] },
};
const driver = { resources: [users, groups, { key: 'other', label: 'Other', targetKind: 'asset', targetConfig: {}, dependsOnResourceKeys: [] }] };

const row = (resourceKey: string, overrides: Record<string, unknown> = {}) => ({
  id: `r-${resourceKey}`, integrationId: 'i1', resourceKey, resourceLabel: resourceKey, enabled: true,
  targetKind: 'asset', targetConfig: {}, dependsOnResourceKeys: [], assetLayoutId: null, assetLayoutName: null,
  matchKeyFieldIds: [], fieldMappingCount: 0, createdAt: '', updatedAt: '', ...overrides,
});

describe('layout matcher suggestions', () => {
  it('lists only resources that declare matchSuggestions', () => {
    expect(matchableResources(driver as never).map((r) => r.key)).toEqual(['users', 'groups']);
    expect(matchableResources(null)).toEqual([]);
  });

  it('prefers exact hint matches over partial ones, in hint order', () => {
    const contacts = layout('l-c', 'Contacts', 'contacts', []);
    const peopleOld = layout('l-po', 'People (old)', 'people_old', []);
    expect(suggestLayout([peopleOld, contacts, people] as never, ['people', 'contacts'])?.id).toBe('l-people');
    expect(suggestLayout([peopleOld, contacts] as never, ['people', 'contacts'])?.id).toBe('l-c');
    expect(suggestLayout([laptops] as never, ['people'])).toBeNull();
    expect(suggestField(people.fields as never, ['email'])?.id).toBe('f-email');
  });
});

describe('MapLayoutsTab', () => {
  beforeEach(() => apiFetch.mockReset());

  it('pre-selects suggested layouts and match fields, creates a new layout when none fits, and saves', async () => {
    apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === '/layouts') return { ok: true, data: { items: [people, laptops] } };
      if (path.endsWith('/field-mappings') && !init) return { ok: true, data: [] };
      return { ok: true, data: row('users') };
    });
    render(<MapLayoutsTab integration={{ id: 'i1', resources: [row('users'), row('groups')] } as never} driver={driver as never} />);

    const usersLayout = await screen.findByLabelText('Layout', { selector: '#map-layout-users' });
    expect(usersLayout).toHaveValue('l-people');
    expect(screen.getByLabelText('Match primaryEmail on')).toHaveValue('f-email');
    // No "distribution lists" layout: groups default to creating one.
    expect(screen.getByLabelText('Layout', { selector: '#map-layout-groups' })).toHaveValue('__new__');

    fireEvent.click(screen.getByRole('button', { name: 'Save layout mapping' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(
      '/admin/integrations/i1/resources/groups/destination', { method: 'POST' },
    ));
    expect(apiFetch).toHaveBeenCalledWith('/admin/integrations/i1/resources/users', {
      method: 'PATCH',
      body: JSON.stringify({ assetLayoutId: 'l-people', matchKeyFieldIds: ['f-email'], enabled: true }),
    });
    expect(apiFetch).toHaveBeenCalledWith('/admin/integrations/i1/resources/users/field-mappings', {
      method: 'PATCH',
      body: JSON.stringify({ mappings: [{ sourceField: 'primaryEmail', targetFieldId: 'f-email', syncDirection: 'source_wins', transform: null }] }),
    });
  });

  it('disables a skipped resource instead of failing, and leaves unchanged ones alone', async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path === '/layouts' ? { ok: true, data: { items: [people] } } : { ok: true, data: row('users') },
    );
    render(
      <MapLayoutsTab
        integration={{ id: 'i1', resources: [
          row('users', { assetLayoutId: 'l-people', matchKeyFieldIds: ['f-email'], fieldMappingCount: 1 }),
          row('groups'),
        ] } as never}
        driver={driver as never}
      />,
    );
    const groupsLayout = await screen.findByLabelText('Layout', { selector: '#map-layout-groups' });
    fireEvent.change(groupsLayout, { target: { value: '__skip__' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save layout mapping' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/admin/integrations/i1/resources/groups', {
      method: 'PATCH', body: JSON.stringify({ enabled: false }),
    }));
    expect(apiFetch).not.toHaveBeenCalledWith(expect.stringContaining('/resources/users'), expect.anything());
  });

  it('requires a match field before saving an existing layout', async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path === '/layouts' ? { ok: true, data: { items: [people, laptops] } } : { ok: true, data: row('users') },
    );
    render(<MapLayoutsTab integration={{ id: 'i1', resources: [row('users', { enabled: false })] } as never} driver={{ resources: [users] } as never} />);
    const select = await screen.findByLabelText('Layout', { selector: '#map-layout-users' });
    fireEvent.change(select, { target: { value: 'l-laptops' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save layout mapping' }));
    expect(await screen.findByText('Pick the field to match on.')).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
});
