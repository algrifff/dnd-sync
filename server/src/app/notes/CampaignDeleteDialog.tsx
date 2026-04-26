'use client';

// Are-you-sure dialog for nuking a whole campaign. Opened from the
// campaign-row "…" menu in FileTree. Calls /api/campaigns/delete on
// confirm — that route cascades through every note, folder marker,
// and slug-keyed index in one transaction.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, X, AlertTriangle } from 'lucide-react';
import type { Tree, TreeDir } from '@/lib/tree';
import { broadcastTreeChange } from '@/lib/tree-sync';

export function CampaignDeleteDialog({
  slug,
  name,
  csrfToken,
  onClose,
  onDeleted,
}: {
  slug: string;
  name: string;
  csrfToken: string;
  onClose: () => void;
  onDeleted: () => void;
}): React.JSX.Element {
  const router = useRouter();
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState<{ notes: number; folders: number } | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/tree', { credentials: 'same-origin' });
        if (!res.ok) return;
        const data = (await res.json()) as Tree;
        const campaignsDir = data.root.children.find(
          (c): c is TreeDir => c.kind === 'dir' && c.path === 'Campaigns',
        );
        const target = campaignsDir?.children.find(
          (c): c is TreeDir => c.kind === 'dir' && c.path === `Campaigns/${slug}`,
        );
        if (!target) return;
        let notes = 0;
        let folders = 0;
        const walk = (dir: TreeDir): void => {
          for (const child of dir.children) {
            if (child.kind === 'file') notes++;
            else {
              folders++;
              walk(child);
            }
          }
        };
        walk(target);
        if (alive) setCounts({ notes, folders });
      } catch {
        /* counts are decorative — silent fail keeps the dialog usable */
      }
    })();
    return () => {
      alive = false;
    };
  }, [slug]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  const submit = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/campaigns/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ slug }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        setError(body.reason ?? body.error ?? `Delete failed (HTTP ${res.status})`);
        setSubmitting(false);
        return;
      }
      router.refresh();
      broadcastTreeChange();
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error');
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="campaign-delete-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--ink)]/50 p-4"
      onClick={(e) => {
        if (!submitting && e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex w-full max-w-md flex-col overflow-hidden rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)] shadow-[0_16px_48px_rgb(var(--ink-rgb)/0.3)]">
        <div className="flex items-center justify-between border-b border-[var(--rule)] px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <AlertTriangle size={16} className="shrink-0 text-[var(--wine)]" aria-hidden />
            <h3 id="campaign-delete-title" className="text-sm font-semibold text-[var(--ink)]">
              Delete campaign
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
            className="rounded-[6px] p-1 text-[var(--ink-soft)] transition hover:bg-[var(--parchment)] disabled:opacity-40"
          >
            <X size={14} aria-hidden />
          </button>
        </div>

        <div className="px-4 py-4 text-sm text-[var(--ink)]">
          <p>
            Are you sure you want to delete{' '}
            <span className="font-semibold">{name}</span>?
          </p>
          <p className="mt-2 text-xs text-[var(--ink-soft)]">
            This permanently removes every folder, note, character, session, and
            asset entry inside this campaign. This can&rsquo;t be undone.
          </p>
          {counts && (counts.notes > 0 || counts.folders > 0) && (
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
          )}
          {error && (
            <p
              role="alert"
              className="mt-3 rounded-[6px] border border-[var(--wine)]/40 bg-[rgb(var(--wine-rgb)/0.08)] px-2 py-1.5 text-xs text-[var(--wine)]"
            >
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--rule)] bg-[var(--parchment-sunk)]/40 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-1.5 text-xs font-medium text-[var(--ink)] transition hover:bg-[var(--vellum)] disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting}
            className="inline-flex items-center gap-1.5 rounded-[6px] bg-[var(--wine)] px-3 py-1.5 text-xs font-semibold text-[var(--vellum)] transition hover:opacity-90 disabled:opacity-50"
          >
            {submitting && <Loader2 size={12} className="animate-spin" aria-hidden />}
            Delete campaign
          </button>
        </div>
      </div>
    </div>
  );
}
