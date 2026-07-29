'use client';

// Tiny "…" menu next to the breadcrumb on each note page. Actions:
// Duplicate (copies to "<name> (copy).md" and navigates there),
// Promote (GM-only, styled destination-path prompt instead of a native
// prompt()), Mark/Unmark DM-only, and Delete (styled confirm instead of
// a native confirm(), removes, navigates home). Uses the session's CSRF
// token for the multipart-free JSON POSTs.

import { useCallback, useEffect, useId, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { MoreHorizontal, Copy, Trash2, EyeOff, Eye, Send } from 'lucide-react';
import { broadcastTreeChange } from '@/lib/tree-sync';
import { ConfirmDialog } from './dialog/ConfirmDialog';
import { PromptDialog } from './dialog/PromptDialog';

export function NoteMenu({
  path,
  csrfToken,
  dmOnly,
  gmOnly = false,
  isAdmin = false,
}: {
  path: string;
  csrfToken: string;
  dmOnly: boolean;
  /** True when the source note is in the GM namespace. */
  gmOnly?: boolean;
  /** True when the caller is the world owner — gates the Promote action. */
  isAdmin?: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const deleteTitleId = useId();
  const promoteTitleId = useId();
  const [open, setOpen] = useState<boolean>(false);
  const [pending, startTransition] = useTransition();
  const [dmState, setDmState] = useState<boolean>(dmOnly);
  const [showDelete, setShowDelete] = useState<boolean>(false);
  const [promoteMode, setPromoteMode] = useState<'copy' | 'move' | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const duplicate = useCallback(() => {
    setOpen(false);
    startTransition(async () => {
      try {
        const res = await fetch('/api/notes/duplicate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ path }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.ok) {
          alert(body.error ?? `Duplicate failed (HTTP ${res.status})`);
          return;
        }
        router.push('/notes/' + body.path.split('/').map(encodeURIComponent).join('/'));
        router.refresh();
        broadcastTreeChange();
      } catch (err) {
        alert(err instanceof Error ? err.message : 'network error');
      }
    });
  }, [csrfToken, path, router]);

  const toggleDm = useCallback(() => {
    setOpen(false);
    const next = !dmState;
    setDmState(next);
    startTransition(async () => {
      try {
        const res = await fetch('/api/notes/visibility', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ path, dmOnly: next }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.ok) {
          setDmState(dmState);
          alert(body.error ?? `Visibility toggle failed (HTTP ${res.status})`);
          return;
        }
        router.refresh();
        broadcastTreeChange();
      } catch (err) {
        setDmState(dmState);
        alert(err instanceof Error ? err.message : 'network error');
      }
    });
  }, [csrfToken, path, router, dmState]);

  const requestPromote = useCallback((mode: 'copy' | 'move') => {
    setOpen(false);
    setPromoteMode(mode);
  }, []);

  const submitPromote = useCallback(
    async (toPath: string): Promise<string | void> => {
      const mode = promoteMode;
      if (!mode) return;
      const res = await fetch('/api/notes/promote', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ fromPath: path, toPath, mode }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        return body.error ?? `Promote failed (HTTP ${res.status})`;
      }
      setPromoteMode(null);
      if (mode === 'move') {
        // The current note is no longer in the GM namespace —
        // navigate to wherever it landed (player view).
        router.push('/notes/' + body.path.split('/').map(encodeURIComponent).join('/'));
      }
      router.refresh();
      broadcastTreeChange();
    },
    [csrfToken, path, promoteMode, router],
  );

  const requestDelete = useCallback(() => {
    setOpen(false);
    setShowDelete(true);
  }, []);

  const submitDelete = useCallback(async (): Promise<string | void> => {
    const res = await fetch(
      '/api/notes/' + path.split('/').map(encodeURIComponent).join('/'),
      {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': csrfToken },
      },
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) {
      return body.error ?? `Delete failed (HTTP ${res.status})`;
    }
    setShowDelete(false);
    router.push('/');
    router.refresh();
    broadcastTreeChange();
  }, [csrfToken, path, router]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={pending}
        className="rounded-[6px] border border-[var(--rule)] bg-[var(--vellum)] p-1.5 text-[var(--ink-soft)] transition hover:scale-[1.03] hover:bg-[var(--parchment-sunk)] disabled:opacity-60"
        aria-label="Note actions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreHorizontal size={16} aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-[10px] border border-[var(--rule)] bg-[var(--vellum)] shadow-[0_8px_24px_rgb(var(--ink-rgb) / 0.12)]"
        >
          <MenuItem onClick={duplicate} icon={<Copy size={14} aria-hidden />}>
            Duplicate
          </MenuItem>
          {isAdmin && gmOnly && (
            <>
              <MenuItem
                onClick={() => requestPromote('copy')}
                icon={<Send size={14} aria-hidden />}
              >
                Promote (copy to players)
              </MenuItem>
              <MenuItem
                onClick={() => requestPromote('move')}
                icon={<Send size={14} aria-hidden />}
              >
                Promote (move to players)
              </MenuItem>
            </>
          )}
          <MenuItem
            onClick={toggleDm}
            icon={
              dmState ? (
                <Eye size={14} aria-hidden />
              ) : (
                <EyeOff size={14} aria-hidden />
              )
            }
          >
            {dmState ? 'Unmark DM-only' : 'Mark DM-only'}
          </MenuItem>
          <div className="h-px bg-[var(--rule)]" />
          <MenuItem
            onClick={requestDelete}
            icon={<Trash2 size={14} aria-hidden />}
            tone="danger"
          >
            Delete
          </MenuItem>
        </div>
      )}
      {showDelete && (
        <ConfirmDialog
          titleId={deleteTitleId}
          title="Delete note"
          tone="danger"
          confirmLabel="Delete"
          confirmingLabel="Deleting…"
          description={
            <p>
              Are you sure you want to delete <span className="font-semibold">{path}</span>?
              This can&rsquo;t be undone.
            </p>
          }
          onClose={() => setShowDelete(false)}
          onConfirm={submitDelete}
        />
      )}
      {promoteMode && (
        <PromptDialog
          titleId={promoteTitleId}
          title="Promote to players"
          description="Copies or moves this note out of the GM namespace so players can see it. Destination path:"
          label="Destination path"
          initialValue={path}
          submitLabel={promoteMode === 'move' ? 'Move' : 'Copy'}
          submittingLabel={promoteMode === 'move' ? 'Moving…' : 'Copying…'}
          onClose={() => setPromoteMode(null)}
          onSubmit={submitPromote}
        />
      )}
    </div>
  );
}

function MenuItem({
  onClick,
  icon,
  tone,
  children,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  tone?: 'danger';
  children: React.ReactNode;
}): React.JSX.Element {
  const base = 'flex w-full items-center gap-2 px-3 py-2 text-sm text-left transition';
  const colour =
    tone === 'danger'
      ? 'text-[var(--wine)] hover:bg-[var(--wine)]/10'
      : 'text-[var(--ink)] hover:bg-[var(--candlelight)]/15';
  return (
    <button type="button" role="menuitem" onClick={onClick} className={`${base} ${colour}`}>
      {icon}
      <span>{children}</span>
    </button>
  );
}
