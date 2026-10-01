'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { BulkAssetResult } from '@weavestream/shared';
import { apiFetch } from '../../../../../lib/api';
import {
  Btn,
  Checkbox,
  CompanyPicker,
  Dialog,
  Field,
  useToast,
  type CompanyPickerValue,
} from '../../../../../components/ui';

/**
 * Copy (or move) assets into a company. One asset → the single-asset
 * endpoint, then open the copy. Several → the bulk endpoint, with per-item
 * failures reported (typically a unique field already taken in the target).
 *
 * Authorisation is entirely server-side (write on the target, archive on the
 * source for a move); this dialog only collects the choice.
 */
export function CopyAssetsDialog({
  open,
  onClose,
  companyId,
  assetIds,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  companyId: string;
  assetIds: string[];
  /** Called after a bulk copy with the ids that failed (to keep selected). */
  onDone?: (failedIds: string[]) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [target, setTarget] = useState<CompanyPickerValue | null>(null);
  const [move, setMove] = useState(false);
  const [pending, setPending] = useState(false);
  const sameCompany = target?.id === companyId;
  const n = assetIds.length;
  const noun = `asset${n === 1 ? '' : 's'}`;

  function close() {
    if (pending) return;
    setTarget(null);
    setMove(false);
    onClose();
  }

  async function submit() {
    if (!target) return;
    setPending(true);
    try {
      const body = { targetCompanyId: target.id, archiveOriginal: move && !sameCompany };
      if (n === 1) {
        const res = await apiFetch<{ id: string }>(
          `/companies/${companyId}/assets/${assetIds[0]}/clone`,
          { method: 'POST', body: JSON.stringify(body) },
        );
        if (!res.ok || !res.data) {
          const p = res.problem as { message?: string; detail?: string; title?: string } | undefined;
          toast.push(p?.message ?? p?.detail ?? p?.title ?? 'Could not copy the asset.', 'danger');
          return;
        }
        const kept = move && !(res.data as { originalArchived?: boolean }).originalArchived;
        toast.push(
          kept
            ? `Copied to ${target.name}, but the original could not be archived.`
            : move
              ? `Moved to ${target.name}.`
              : `Copied to ${target.name}.`,
          kept ? 'warn' : 'ok',
        );
        setPending(false);
        close();
        router.push(`/admin/companies/${target.id}/assets/${res.data.id}`);
        return;
      }
      const res = await apiFetch<BulkAssetResult>(`/companies/${companyId}/assets/bulk/clone`, {
        method: 'POST',
        body: JSON.stringify({ ...body, ids: assetIds }),
      });
      if (!res.ok || !res.data) {
        const p = res.problem as { detail?: string; title?: string } | undefined;
        toast.push(p?.detail ?? p?.title ?? `Could not copy the ${noun}.`, 'danger');
        return;
      }
      const { ok, failed } = res.data;
      const verb = move ? 'Moved' : 'Copied';
      if (failed.length === 0) {
        toast.push(`${verb} ${ok.length} ${noun} to ${target.name}.`, 'ok');
      } else {
        const why = failed[0]?.reason ? ` First problem: ${failed[0].reason}` : '';
        toast.push(`${verb} ${ok.length}, ${failed.length} failed.${why}`, ok.length ? 'warn' : 'danger');
      }
      setPending(false);
      close();
      // A copy that exists but whose original stayed active must not be
      // offered for retry: that would copy it a second time.
      onDone?.(failed.filter((f) => f.code !== 'original_not_archived').map((f) => f.id));
      router.refresh();
    } catch {
      toast.push(`Could not copy the ${noun}.`, 'danger');
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={`Copy ${n === 1 ? 'asset' : `${n} assets`} to a company`}
      width={500}
      footer={
        <>
          <Btn kind="outline" onClick={close} disabled={pending}>
            Cancel
          </Btn>
          <Btn kind="primary" loading={pending} disabled={!target} onClick={submit}>
            {move && !sameCompany ? 'Move' : 'Copy'}
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Target company">
          <CompanyPicker value={target} onChange={setTarget} autoFocus />
        </Field>
        <Checkbox
          label="Move: archive the originals here after copying"
          checked={move && !sameCompany}
          onChange={setMove}
          hint={
            sameCompany
              ? 'Pick a different company to move.'
              : 'Originals are archived, not deleted, so they can be restored.'
          }
        />
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
          Fields and files (including attachments) are copied. Links to other assets are
          dropped when the company changes. Linked passwords and integration sync stay with
          the original, so assets that have them can be copied but not moved. Fields hidden
          from you are not copied.
        </p>
      </div>
    </Dialog>
  );
}
