'use client';

// Folder-picker modal opened from the sidebar row "…" menu. Lists every
// destination folder in the current tree, filtered through the shared
// move-policy so only legal targets are clickable. Calls /api/notes/move
// or /api/folders/move on confirm — the same endpoint the drag-and-drop
// path uses, so server-side rule enforcement is identical.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, X } from 'lucide-react';
import type { Tree, TreeDir } from '@/lib/tree';
import { broadcastTreeChange } from '@/lib/tree-sync';
import { canDropOn } from '@/lib/move-policy';

type MoveKind = 'file' | 'folder';

type DestRow = {
  path: string;
  depth: number;
  allowed: boolean;
  reason?: string | undefined;
  isCurrent: boolean;
};

export function MoveDialog({
  src,
  csrfToken,
  onClose,
  onMoved,
}: {
  src: { kind: MoveKind; path: string };
  csrfToken: string;
  onClose: () => void;
  onMoved: (newPath: string) => void;
}): React.JSX.Element {
  const router = useRouter();
  const [tree, setTree] = useState<Tree | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [filter, setFilter] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/tree', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as Tree;
        if (alive) setTree(data);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Failed to load tree');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const currentParent = useMemo(() => {
    const i = src.path.lastIndexOf('/');
    return i < 0 ? '' : src.path.slice(0, i);
  }, [src.path]);

  const rows = useMemo<DestRow[]>(() => {
    if (!tree) return [];
    const out: DestRow[] = [];
    const walk = (dir: TreeDir, depth: number): void => {
      for (const child of dir.children) {
        if (child.kind !== 'dir') continue;
        const policy = canDropOn(src, child.path);
        const isCurrent = child.path === currentParent;
        const row: DestRow = {
          path: child.path,
          depth,
          allowed: policy.ok && !isCurrent,
          isCurrent,
        };
        if (!policy.ok) row.reason = policy.reason;
        out.push(row);
        walk(child, depth + 1);
      }
    };
    walk(tree.root, 0);
    return out;
  }, [tree, src, currentParent]);

  const visibleRows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.path.toLowerCase().includes(q));
  }, [rows, filter]);

  const submit = useCallback(
    async (destFolder: string) => {
      const basename = src.path.includes('/')
        ? src.path.slice(src.path.lastIndexOf('/') + 1)
        : src.path;
      const to = destFolder ? destFolder + '/' + basename : basename;
      setSubmitting(true);
      setError(null);
      try {
        const url = src.kind === 'file' ? '/api/notes/move' : '/api/folders/move';
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ from: src.path, to }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.ok) {
          setError(
            body.error === 'exists'
              ? `"${basename}" already exists in that folder.`
              : (body.reason ?? body.error ?? `HTTP ${res.status}`),
          );
          return;
        }
        onMoved(to);
        router.refresh();
        broadcastTreeChange();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'network error');
      } finally {
        setSubmitting(false);
      }
    },
    [csrfToken, src, router, onMoved],
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="move-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--ink)]/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex w-full max-w-md flex-col overflow-hidden rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)] shadow-[0_16px_48px_rgb(var(--ink-rgb)/0.3)]">
        <div className="flex items-center justify-between border-b border-[var(--rule)] px-4 py-3">
          <div className="min-w-0">
            <h3 id="move-dialog-title" className="text-sm font-semibold text-[var(--ink)]">
              Move {src.kind === 'folder' ? 'folder' : 'note'}
            </h3>
            <p className="mt-0.5 truncate text-xs text-[var(--ink-soft)]" title={src.path}>
              {src.path}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-[6px] p-1 text-[var(--ink-soft)] transition hover:bg-[var(--parchment)]"
          >
            <X size={14} aria-hidden />
          </button>
        </div>

        <div className="border-b border-[var(--rule)] px-4 py-2">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter folders…"
            className="w-full rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-2 py-1.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--candlelight)]"
          />
        </div>

        <div className="max-h-[60vh] min-h-[180px] flex-1 overflow-y-auto px-2 py-2">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-[var(--ink-soft)]">
              <Loader2 size={14} className="animate-spin" aria-hidden />
              Loading folders…
            </div>
          ) : visibleRows.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-[var(--ink-soft)]">
              No folders match.
            </p>
          ) : (
            <ul role="listbox">
              {visibleRows.map((row) => {
                const name = row.path.includes('/')
                  ? row.path.slice(row.path.lastIndexOf('/') + 1)
                  : row.path;
                const disabled = !row.allowed || submitting;
                const title = row.isCurrent
                  ? 'Already in this folder'
                  : row.allowed
                    ? row.path
                    : (row.reason ?? 'Not allowed');
                return (
                  <li key={row.path}>
                    <button
                      type="button"
                      role="option"
                      disabled={disabled}
                      aria-selected={false}
                      onClick={() => submit(row.path)}
                      title={title}
                      style={{ paddingLeft: 8 + row.depth * 14 }}
                      className={
                        'flex w-full items-baseline gap-2 rounded-[6px] py-1.5 pr-2 text-left text-sm transition ' +
                        (disabled
                          ? 'cursor-not-allowed text-[var(--ink-soft)]/40'
                          : 'text-[var(--ink)] hover:bg-[var(--candlelight)]/15')
                      }
                    >
                      <span className="truncate">{name}</span>
                      {row.isCurrent && (
                        <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-[var(--ink-soft)]/70">
                          current
                        </span>
                      )}
                      {!row.allowed && !row.isCurrent && row.reason && (
                        <span className="ml-auto shrink-0 truncate text-[10px] text-[var(--ink-soft)]/50">
                          {row.reason}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {error && (
          <div className="border-t border-[var(--rule)] bg-[rgb(var(--wine-rgb)/0.08)] px-4 py-2 text-xs text-[var(--wine)]">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
