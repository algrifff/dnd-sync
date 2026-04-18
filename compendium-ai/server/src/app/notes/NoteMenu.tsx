'use client';

// Tiny "…" menu next to the breadcrumb on each note page. Two
// actions: Duplicate (copies to "<name> (copy).md" and navigates
// there) and Delete (confirms, removes, navigates home). Uses the
// session's CSRF token for the multipart-free JSON POSTs.

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { MoreHorizontal, Copy, Trash2 } from 'lucide-react';

export function NoteMenu({
  path,
  csrfToken,
}: {
  path: string;
  csrfToken: string;
}): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState<boolean>(false);
  const [pending, startTransition] = useTransition();
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
      } catch (err) {
        alert(err instanceof Error ? err.message : 'network error');
      }
    });
  }, [csrfToken, path, router]);

  const destroy = useCallback(() => {
    setOpen(false);
    if (!confirm(`Delete "${path}"? This can't be undone.`)) return;
    startTransition(async () => {
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
        router.push('/');
        router.refresh();
      } catch (err) {
        alert(err instanceof Error ? err.message : 'network error');
      }
    });
  }, [csrfToken, path, router]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={pending}
        className="rounded-[6px] border border-[#D4C7AE] bg-[#FBF5E8] p-1.5 text-[#5A4F42] transition hover:scale-[1.03] hover:bg-[#EAE1CF] disabled:opacity-60"
        aria-label="Note actions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreHorizontal size={16} aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-[10px] border border-[#D4C7AE] bg-[#FBF5E8] shadow-[0_8px_24px_rgba(42,36,30,0.12)]"
        >
          <MenuItem onClick={duplicate} icon={<Copy size={14} aria-hidden />}>
            Duplicate
          </MenuItem>
          <div className="h-px bg-[#D4C7AE]" />
          <MenuItem
            onClick={destroy}
            icon={<Trash2 size={14} aria-hidden />}
            tone="danger"
          >
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
  const base = 'flex w-full items-center gap-2 px-3 py-2 text-sm text-left transition';
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
