'use client';

// "…" affordance on each tree row. Opens a tiny menu with Rename /
// Duplicate / Delete. Rename and delete always apply; duplicate is
// only meaningful for files (the existing /api/notes/duplicate
// endpoint doesn't yet copy folder trees). All handlers fire through
// fetch + router.refresh and surface errors via alert().

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MoreHorizontal, Pencil, Copy, Trash2, FolderInput, UserPlus } from 'lucide-react';
import { broadcastTreeChange } from '@/lib/tree-sync';
import { isDraggableSource } from '@/lib/move-policy';
import { MoveDialog } from './MoveDialog';
import { TransferCharacterDialog } from './TransferCharacterDialog';

type Props = {
  kind: 'file' | 'folder';
  path: string;
  csrfToken: string;
  onStartRename: () => void;
  onCreateInside?: (sub: 'page' | 'folder') => void;
  /** kind from the character index — 'pc' gates the Transfer to… item */
  noteKind?: string;
  /** True when the current user is the world admin (GM). */
  isWorldOwner?: boolean;
  /** Needed to fetch the member list in the transfer dialog. */
  groupId?: string;
};

export function RowMenu({
  kind,
  path,
  csrfToken,
  onStartRename,
  noteKind,
  isWorldOwner,
  groupId,
}: Props): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState<boolean>(false);
  const [dropUp, setDropUp] = useState<boolean>(false);
  const [showMove, setShowMove] = useState<boolean>(false);
  const [showTransfer, setShowTransfer] = useState<boolean>(false);
  const ref = useRef<HTMLDivElement>(null);

  const movable = isDraggableSource({ kind, path });

  const openMenu = (): void => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setDropUp(rect.bottom + 160 > window.innerHeight - 8);
    }
    setOpen(true);
  };

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

  const duplicate = useCallback(async () => {
    setOpen(false);
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
      router.refresh();
      broadcastTreeChange();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'network error');
    }
  }, [csrfToken, path, router]);

  const destroy = useCallback(async () => {
    setOpen(false);
    if (kind === 'file') {
      if (!confirm(`Delete "${path}"? This can't be undone.`)) return;
      try {
        const res = await fetch(
          '/api/notes/' + path.split('/').map(encodeURIComponent).join('/'),
          {
            method: 'DELETE',
            headers: { 'X-CSRF-Token': csrfToken },
          },
        );
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.ok) {
          alert(body.error ?? `Delete failed (HTTP ${res.status})`);
          return;
        }
        router.refresh();
        broadcastTreeChange();
      } catch (err) {
        alert(err instanceof Error ? err.message : 'network error');
      }
    } else {
      if (
        !confirm(
          `Delete folder "${path}" and everything inside it? This can't be undone.`,
        )
      ) {
        return;
      }
      try {
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
          alert(body.error ?? `Delete failed (HTTP ${res.status})`);
          return;
        }
        router.refresh();
        broadcastTreeChange();
      } catch (err) {
        alert(err instanceof Error ? err.message : 'network error');
      }
    }
  }, [csrfToken, kind, path, router]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          if (open) { setOpen(false); } else { openMenu(); }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Actions"
        className="rounded-[4px] p-1 text-[var(--ink-soft)] transition hover:bg-[var(--ink)]/10 hover:text-[var(--ink)]"
      >
        <MoreHorizontal size={14} aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className={`absolute right-0 z-30 w-40 overflow-hidden rounded-[8px] border border-[var(--rule)] bg-[var(--vellum)] shadow-[0_8px_24px_rgb(var(--ink-rgb) / 0.18)] ${dropUp ? 'bottom-full mb-1' : 'top-full mt-1'}`}
        >
          <MenuItem
            onClick={() => {
              setOpen(false);
              onStartRename();
            }}
            icon={<Pencil size={13} aria-hidden />}
          >
            Rename
          </MenuItem>
          {movable && (
            <MenuItem
              onClick={() => {
                setOpen(false);
                setShowMove(true);
              }}
              icon={<FolderInput size={13} aria-hidden />}
            >
              Move to…
            </MenuItem>
          )}
          {kind === 'file' && noteKind === 'pc' && isWorldOwner && groupId && (
            <MenuItem
              onClick={() => {
                setOpen(false);
                setShowTransfer(true);
              }}
              icon={<UserPlus size={13} aria-hidden />}
            >
              Transfer to…
            </MenuItem>
          )}
          {kind === 'file' && (
            <MenuItem onClick={duplicate} icon={<Copy size={13} aria-hidden />}>
              Duplicate
            </MenuItem>
          )}
          <div className="h-px bg-[var(--rule)]" />
          <MenuItem onClick={destroy} icon={<Trash2 size={13} aria-hidden />} tone="danger">
            Delete
          </MenuItem>
        </div>
      )}
      {showMove && (
        <MoveDialog
          src={{ kind, path }}
          csrfToken={csrfToken}
          onClose={() => setShowMove(false)}
          onMoved={(newPath) => {
            setShowMove(false);
            // If we moved the currently-open note, route there.
            if (kind === 'file' && typeof window !== 'undefined' && window.location.pathname.startsWith('/notes/')) {
              const here = decodeURIComponent(window.location.pathname.slice('/notes/'.length));
              if (here === path) {
                router.push('/notes/' + newPath.split('/').map(encodeURIComponent).join('/'));
              }
            }
          }}
        />
      )}
      {showTransfer && groupId && (
        <TransferCharacterDialog
          notePath={path}
          groupId={groupId}
          csrfToken={csrfToken}
          onClose={() => setShowTransfer(false)}
          onTransferred={() => {
            setShowTransfer(false);
            router.refresh();
            broadcastTreeChange();
          }}
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
  const base = 'flex w-full items-center gap-2 px-3 py-1.5 text-xs text-left transition';
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
