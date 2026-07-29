'use client';

// Are-you-sure dialog for deleting a folder. Was previously a native
// window.confirm() in RowMenu with no indication of what would be
// destroyed — folder delete cascades an arbitrary number of nested
// notes/characters/assets, the same blast radius as campaign delete,
// which already gets counts + a styled dialog (CampaignDeleteDialog).
// This brings folder delete up to the same standard, reusing the shared
// ConfirmDialog chrome and the same "fetch /api/tree, walk the subtree"
// counts approach — there's no dedicated counts endpoint, and /api/tree
// is already the cheap way to get one (MoveDialog and CampaignDeleteDialog
// both fetch it for their own purposes).

import { useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Tree } from '@/lib/tree';
import { broadcastTreeChange } from '@/lib/tree-sync';
import { ConfirmDialog } from './ConfirmDialog';
import { countTreeContents, type TreeCounts } from './tree-counts';

export function FolderDeleteDialog({
  path,
  csrfToken,
  onClose,
  onDeleted,
}: {
  path: string;
  csrfToken: string;
  onClose: () => void;
  /** Called after the delete succeeds and the tree has been refreshed +
   *  broadcast. The caller (RowMenu) still decides whether to redirect —
   *  it knows whether the active note lived inside the deleted folder.
   *  `redirectTo` is the nearest surviving ancestor's index path from
   *  the delete route's response (see findNearestIndexPath in
   *  lib/notes.ts), or null when nothing survives above this folder. */
  onDeleted: (redirectTo?: string | null) => void;
}): React.JSX.Element {
  const router = useRouter();
  const titleId = useId();
  const [counts, setCounts] = useState<TreeCounts | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/tree', { credentials: 'same-origin' });
        if (!res.ok) return;
        const data = (await res.json()) as Tree;
        const found = countTreeContents(data, path);
        if (alive && found) setCounts(found);
      } catch {
        /* counts are decorative — silent fail keeps the dialog usable */
      }
    })();
    return () => {
      alive = false;
    };
  }, [path]);

  const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;

  return (
    <ConfirmDialog
      titleId={titleId}
      title="Delete folder"
      tone="danger"
      confirmLabel="Delete folder"
      confirmingLabel="Deleting…"
      description={
        <>
          <p>
            Are you sure you want to delete <span className="font-semibold">{name}</span>{' '}
            and everything inside it?
          </p>
          <p className="mt-2 text-xs text-[var(--ink-soft)]">This can&rsquo;t be undone.</p>
        </>
      }
      detail={
        counts && (counts.notes > 0 || counts.folders > 0) ? (
          <p className="mt-2 rounded-[6px] border border-[var(--rule)] bg-[var(--parchment-sunk)]/40 px-2 py-1.5 text-xs text-[var(--ink-soft)]">
            <span className="font-semibold text-[var(--ink)]">
              {counts.notes} note{counts.notes === 1 ? '' : 's'}
            </span>{' '}
            across{' '}
            <span className="font-semibold text-[var(--ink)]">
              {counts.folders} folder{counts.folders === 1 ? '' : 's'}
            </span>{' '}
            will be deleted.
          </p>
        ) : undefined
      }
      onClose={onClose}
      onConfirm={async () => {
        const res = await fetch('/api/folders/delete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ path }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.ok) {
          return body.reason ?? body.error ?? `Delete failed (HTTP ${res.status})`;
        }
        router.refresh();
        broadcastTreeChange();
        onDeleted(typeof body.redirectTo === 'string' ? body.redirectTo : null);
      }}
    />
  );
}
