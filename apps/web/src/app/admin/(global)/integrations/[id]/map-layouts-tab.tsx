'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  DriverDescriptor,
  DriverResourceDescriptor,
  EnsureResourceMatchFieldResult,
  IntegrationDto,
  IntegrationFieldMappingDto,
  IntegrationResourceDto,
  LayoutFieldSummary,
  LayoutSummary,
} from '@weavestream/shared';
import { problemMessage } from '@weavestream/shared';
import { apiFetch } from '../../../../../lib/api';
import { Btn, Field, Select, Tag, useToast } from '../../../../../components/ui';

/** Resources that opt into the guided matcher (asset target + match suggestions). */
export type MatchableResource = DriverResourceDescriptor & {
  targetKind: 'asset';
  matchSuggestions: NonNullable<DriverResourceDescriptor['matchSuggestions']>;
};

export function matchableResources(driver: DriverDescriptor | null): MatchableResource[] {
  return (driver?.resources ?? []).filter(
    (resource): resource is MatchableResource =>
      resource.targetKind === 'asset' && resource.matchSuggestions !== undefined,
  );
}

export const NEW_LAYOUT = '__new__';
export const SKIP = '__skip__';
/** "Match on" choice: create the match field on the picked layout when saving. */
export const CREATE_FIELD = '__create_field__';

/** Name of the field "Create field" adds (the driver's label, else the source key spelled out). */
export function createFieldLabel(resource: MatchableResource): string {
  const { fieldLabel, sourceField } = resource.matchSuggestions;
  if (fieldLabel) return fieldLabel;
  const spaced = sourceField.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const norm = (value: string) => value.trim().toLowerCase();

/** First candidate whose slug or name equals a hint, else contains one (hint order wins). */
function suggest<T extends { slug: string; name: string }>(candidates: T[], hints: string[]): T | null {
  const keyed = candidates.map((candidate) => ({ candidate, keys: [norm(candidate.slug), norm(candidate.name)] }));
  for (const exact of [true, false]) {
    for (const hint of hints.map(norm)) {
      const hit = keyed.find(({ keys }) => keys.some((key) => (exact ? key === hint : key.includes(hint))));
      if (hit) return hit.candidate;
    }
  }
  return null;
}

export function suggestLayout(layouts: LayoutSummary[], hints: string[]): LayoutSummary | null {
  return suggest(layouts, hints);
}

export function suggestField(fields: LayoutFieldSummary[], hints: string[]): LayoutFieldSummary | null {
  return suggest(fields.filter((field) => !field.archivedAt), hints);
}

type Choice = { layout: string; matchFieldId: string };

/** What is saved today, or null when the resource has never been mapped. */
function persistedChoice(row: IntegrationResourceDto | undefined): Choice | null {
  if (row && !row.enabled) return { layout: SKIP, matchFieldId: '' };
  if (row?.assetLayoutId) return { layout: row.assetLayoutId, matchFieldId: row.matchKeyFieldIds[0] ?? '' };
  return null;
}

function initialChoice(
  resource: MatchableResource,
  row: IntegrationResourceDto | undefined,
  layouts: LayoutSummary[],
  canCreate: boolean,
): Choice {
  const createField = canCreate ? CREATE_FIELD : '';
  if (row?.assetLayoutId) {
    if (!row.enabled) return { layout: SKIP, matchFieldId: '' };
    const layout = layouts.find((candidate) => candidate.id === row.assetLayoutId);
    const matchFieldId =
      row.matchKeyFieldIds[0] ??
      (layout ? suggestField(layout.fields, resource.matchSuggestions.fieldHints)?.id : undefined) ??
      createField;
    return { layout: row.assetLayoutId, matchFieldId };
  }
  if (row && !row.enabled) return { layout: SKIP, matchFieldId: '' };
  const layout = suggestLayout(layouts, resource.matchSuggestions.layoutHints);
  if (!layout) return { layout: canCreate ? NEW_LAYOUT : SKIP, matchFieldId: '' };
  return {
    layout: layout.id,
    matchFieldId: suggestField(layout.fields, resource.matchSuggestions.fieldHints)?.id ?? createField,
  };
}

/**
 * Guided "Map layouts" step for drivers whose resources declare
 * `matchSuggestions`: one row per resource with a layout picker
 * (pre-selected from the hints, or "Create new layout") and a "match on"
 * picker. Saving sets the resource layout, its match key and the match-key
 * field mapping through the same APIs as the Field mappings tab. A skipped
 * resource is disabled, not an error.
 */
export function MapLayoutsTab({
  integration,
  driver,
  canManageLayouts = true,
}: {
  integration: IntegrationDto;
  driver: DriverDescriptor | null;
  /** LAYOUT_MANAGE: needed for Create new layout and Create field (the API enforces it too). */
  canManageLayouts?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const resources = useMemo(() => matchableResources(driver), [driver]);
  const [layouts, setLayouts] = useState<LayoutSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [persisted, setPersisted] = useState<Record<string, Choice | null>>({});
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await apiFetch<{ items: LayoutSummary[] }>('/layouts');
      if (cancelled) return;
      if (!res.ok || !res.data) {
        setLoadError(problemMessage(res.problem) ?? 'Could not load asset layouts.');
        return;
      }
      const active = res.data.items.filter((layout) => !layout.archivedAt && layout.isActive);
      const next: Record<string, Choice> = {};
      const saved: Record<string, Choice | null> = {};
      for (const resource of resources) {
        const row = integration.resources.find((candidate) => candidate.resourceKey === resource.key);
        next[resource.key] = initialChoice(resource, row, active, canManageLayouts);
        saved[resource.key] = persistedChoice(row);
      }
      setLayouts(active);
      setPersisted(saved);
      setChoices(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [integration.resources, resources, canManageLayouts]);

  function choose(key: string, layoutValue: string) {
    const resource = resources.find((candidate) => candidate.key === key)!;
    const layout = layouts?.find((candidate) => candidate.id === layoutValue);
    setChoices((prev) => ({
      ...prev,
      [key]: {
        layout: layoutValue,
        matchFieldId: layout
          ? suggestField(layout.fields, resource.matchSuggestions.fieldHints)?.id ?? (canManageLayouts ? CREATE_FIELD : '')
          : '',
      },
    }));
    setErrors((prev) => ({ ...prev, [key]: '' }));
  }

  async function saveResource(resource: MatchableResource, choice: Choice): Promise<string | null> {
    const base = `/admin/integrations/${integration.id}/resources/${resource.key}`;
    const row = integration.resources.find((candidate) => candidate.resourceKey === resource.key);
    const patch = (body: Record<string, unknown>) =>
      apiFetch<IntegrationResourceDto>(base, { method: 'PATCH', body: JSON.stringify(body) });
    const putMappings = (mappings: unknown[]) =>
      apiFetch(`${base}/field-mappings`, { method: 'PATCH', body: JSON.stringify({ mappings }) });

    if (choice.layout === SKIP) {
      const res = await patch({ enabled: false });
      return res.ok ? null : problemMessage(res.problem) ?? 'Could not skip this resource.';
    }

    const layoutChanges = (row?.assetLayoutId ?? null) !== (choice.layout === NEW_LAYOUT ? null : choice.layout);
    // The API refuses a layout change while mappings point at the old one.
    if (layoutChanges && (row?.fieldMappingCount ?? 0) > 0) {
      const cleared = await putMappings([]);
      if (!cleared.ok) return problemMessage(cleared.problem) ?? 'Could not clear the old field mappings.';
    }

    if (choice.layout === NEW_LAYOUT) {
      if (row?.assetLayoutId) {
        const detached = await patch({ assetLayoutId: null, matchKeyFieldIds: [] });
        if (!detached.ok) return problemMessage(detached.problem) ?? 'Could not detach the old layout.';
      }
      const created = await apiFetch<IntegrationResourceDto>(`${base}/destination`, { method: 'POST' });
      return created.ok ? null : problemMessage(created.problem) ?? 'Could not create the layout.';
    }

    if (!choice.matchFieldId) return 'Pick the field to match on.';
    let matchFieldId = choice.matchFieldId;
    if (matchFieldId === CREATE_FIELD) {
      const ensured = await apiFetch<EnsureResourceMatchFieldResult>(`${base}/match-field`, {
        method: 'POST',
        body: JSON.stringify({ assetLayoutId: choice.layout }),
      });
      if (!ensured.ok || !ensured.data) return problemMessage(ensured.problem) ?? 'Could not create the match field.';
      matchFieldId = ensured.data.fieldId;
    }
    const updated = await patch({
      assetLayoutId: choice.layout,
      matchKeyFieldIds: [matchFieldId],
      enabled: true,
    });
    if (!updated.ok) return problemMessage(updated.problem) ?? 'Could not save the layout.';

    const sourceField = resource.matchSuggestions.sourceField;
    let kept: IntegrationFieldMappingDto[] = [];
    if (!layoutChanges) {
      const current = await apiFetch<IntegrationFieldMappingDto[]>(`${base}/field-mappings`);
      if (!current.ok || !current.data) return problemMessage(current.problem) ?? 'Could not read field mappings.';
      kept = current.data.filter(
        (mapping) =>
          mapping.targetFieldId !== null &&
          mapping.sourceField !== sourceField &&
          mapping.targetFieldId !== matchFieldId,
      );
    }
    const saved = await putMappings([
      ...kept.map((mapping) => ({
        sourceField: mapping.sourceField,
        targetFieldId: mapping.targetFieldId,
        syncDirection: mapping.syncDirection,
        transform: mapping.transform,
      })),
      { sourceField, targetFieldId: matchFieldId, syncDirection: 'source_wins', transform: null },
    ]);
    return saved.ok ? null : problemMessage(saved.problem) ?? 'Could not save the match-key mapping.';
  }

  async function save() {
    setPending(true);
    try {
      const nextErrors: Record<string, string> = {};
      for (const resource of resources) {
        const choice = choices[resource.key];
        const before = persisted[resource.key];
        if (!choice || (before && before.layout === choice.layout && before.matchFieldId === choice.matchFieldId)) {
          continue;
        }
        const error = await saveResource(resource, choice);
        if (error) nextErrors[resource.key] = error;
      }
      setErrors(nextErrors);
      if (Object.keys(nextErrors).length === 0) {
        toast.push('Layouts mapped.', 'ok');
        router.refresh();
      }
    } catch {
      // A rejected request (network down) has no problem body to show; say so instead of hanging.
      toast.push('Could not save the layout mapping. Check your connection and try again.', 'danger');
    } finally {
      setPending(false);
    }
  }

  if (resources.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h3 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 600 }}>
          Map layouts
        </h3>
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)' }}>
          Pick the layout each kind of record belongs to and the field that identifies an existing
          asset. Records that match an existing asset are linked to it; only unmatched records create
          new assets, which get just their name and the match value. If a layout has no field for the
          match value, pick Create field and it is added to the layout when you save. Everything else
          shows in the integration section on the asset page. Skipped resources are not synced.
        </p>
      </header>
      {!canManageLayouts && (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>
          Create new layout and Create field need permission to manage asset layouts.
        </p>
      )}
      {loadError && <Tag tone="danger">{loadError}</Tag>}
      {!layouts && !loadError && <Tag tone="default">Loading layouts…</Tag>}
      {layouts &&
        resources.map((resource) => {
          const choice = choices[resource.key] ?? { layout: SKIP, matchFieldId: '' };
          const layout = layouts.find((candidate) => candidate.id === choice.layout);
          const fields = layout?.fields.filter((field) => !field.archivedAt) ?? [];
          const layoutId = `map-layout-${resource.key}`;
          const fieldId = `map-match-${resource.key}`;
          return (
            <section
              key={resource.key}
              aria-label={resource.label}
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'flex-end',
                gap: 12,
                padding: 12,
                border: '1px solid var(--line)',
                borderRadius: 6,
                background: 'var(--panel-2)',
              }}
            >
              <div style={{ flex: '1 1 160px', minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{resource.label}</div>
                {resource.description && (
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>{resource.description}</div>
                )}
              </div>
              <Field label="Layout" htmlFor={layoutId} style={{ flex: '1 1 200px', minWidth: 0 }}>
                <Select id={layoutId} value={choice.layout} onChange={(e) => choose(resource.key, e.target.value)}>
                  {layouts.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                  <option value={NEW_LAYOUT} disabled={!canManageLayouts}>
                    Create new layout
                  </option>
                  <option value={SKIP}>Skip (do not sync)</option>
                </Select>
              </Field>
              {layout && (
                <Field
                  label={`Match ${resource.matchSuggestions.sourceField} on`}
                  htmlFor={fieldId}
                  style={{ flex: '1 1 200px', minWidth: 0 }}
                >
                  <Select
                    id={fieldId}
                    value={choice.matchFieldId}
                    onChange={(e) =>
                      setChoices((prev) => ({ ...prev, [resource.key]: { ...choice, matchFieldId: e.target.value } }))
                    }
                  >
                    <option value="">Select a field…</option>
                    {fields.map((field) => (
                      <option key={field.id} value={field.id}>
                        {field.name}
                      </option>
                    ))}
                    <option value={CREATE_FIELD} disabled={!canManageLayouts}>
                      {`Create field "${createFieldLabel(resource)}"`}
                    </option>
                  </Select>
                </Field>
              )}
              {errors[resource.key] && (
                <div role="alert" style={{ flexBasis: '100%' }}>
                  <Tag tone="danger">{errors[resource.key]}</Tag>
                </div>
              )}
            </section>
          );
        })}
      {layouts && (
        <div>
          <Btn kind="primary" onClick={save} loading={pending}>
            Save layout mapping
          </Btn>
        </div>
      )}
    </div>
  );
}
