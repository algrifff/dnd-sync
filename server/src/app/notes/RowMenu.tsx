'use client';

// "…" affordance on each tree row. Opens a tiny menu with Rename /
// Duplicate / Delete. Rename and delete always apply; duplicate is
// only meaningful for files (the existing /api/notes/duplicate
// endpoint doesn't yet copy folder trees). All handlers fire through
// fetch + router.refresh and surface errors via alert().

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MoreHorizontal, Pencil, Copy, Trash2 } from 'lucide-react';
import { broadcastTreeChange } from '@/lib/tree-sync';

type Props = {
  kind: 'file' | 'folder';
  path: string;
  csrfToken: string;
  onStartRename: () => void;
  onCreateInside?: (sub: 'page' | 'folder') => void;
};

export function RowMenu({
  kind,
  path,
  csrfToken,
  onStartRename,
}: Props): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState<boolean>(false);
  const [dropUp, setDropUp] = useState<boolean>(false);
  const ref = useRef<HTMLDivElement>(null);

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
        className="rounded-[4px] p-1 text-[#5A4F42] transition hover:bg-[#2A241E]/10 hover:text-[#2A241E]"
      >
        <MoreHorizontal size={14} aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className={`absolute right-0 z-30 w-40 overflow-hidden rounded-[8px] border border-[#D4C7AE] bg-[#FBF5E8] shadow-[0_8px_24px_rgba(42,36,30,0.18)] ${dropUp ? 'bottom-full mb-1' : 'top-full mt-1'}`}
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
          {kind === 'file' && (
            <MenuItem onClick={duplicate} icon={<Copy size={13} aria-hidden />}>
              Duplicate
            </MenuItem>
          )}
          <div className="h-px bg-[#D4C7AE]" />
          <MenuItem onClick={destroy} icon={<Trash2 size={13} aria-hidden />} tone="danger">
            Delete
          </MenuItem>
        </div>
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
      ? 'text-[#8B4A52] hover:bg-[#8B4A52]/10'
      : 'text-[#2A241E] hover:bg-[#D4A85A]/15';
  return (
    <button type="button" role="menuitem" onClick={onClick} className={`${base} ${colour}`}>
      {icon}
      <span>{children}</span>
    </button>
  );
}
