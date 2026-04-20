'use client';

// Discord-style worlds rail. 56 px column of circular icons, one per
// world the user is a member of, with the active world highlighted
// by a left-edge pill. A "+" at the bottom opens a small dialog to
// create a new world; submitting switches the caller into it.
//
// Worlds list is fetched from /api/worlds on mount. Switching posts
// to /api/worlds/active then router.refresh()es so every server
// component re-reads session.currentGroupId.

import { useEffect, useRef, useState } from 'react';
import { Pencil, Plus, X } from 'lucide-react';

type World = {
  id: string;
  name: string;
  role: 'admin' | 'editor' | 'viewer';
  isActive: boolean;
};

export function WorldsSidebar({
  csrfToken,
}: {
  csrfToken: string;
}): React.JSX.Element {
  const [worlds, setWorlds] = useState<World[] | null>(null);
  const [creating, setCreating] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);

  useEffect(() => {
    void fetchWorlds();
  }, []);

  const fetchWorlds = async (): Promise<void> => {
    try {
      const res = await fetch('/api/worlds', { cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as { worlds?: World[] };
      setWorlds(body.worlds ?? []);
    } catch {
      /* keep loading state */
    }
  };

  const activateWorld = async (id: string): Promise<boolean> => {
    const res = await fetch('/api/worlds/active', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({ id }),
    });
    return res.ok;
  };

  const switchWorld = async (id: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const ok = await activateWorld(id);
      if (!ok) return;
      // Full reload to drop any active-character pin / in-memory state
      // from the previous world.
      window.location.href = '/';
    } finally {
      setBusy(false);
    }
  };

  const editWorld = async (w: World): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      if (!w.isActive) {
        const ok = await activateWorld(w.id);
        if (!ok) return;
      }
      window.location.href = '/settings/world';
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <aside
        aria-label="Worlds"
        className="hidden h-full w-[56px] shrink-0 flex-col items-center gap-1.5 bg-[#2A241E] py-2 md:flex"
      >
        {worlds == null ? (
          <div className="h-10 w-10 animate-pulse rounded-full bg-[#5A4F42]/40" />
        ) : (
          worlds.map((w) => (
            <WorldIcon
              key={w.id}
              world={w}
              onClick={() => {
                if (!w.isActive) void switchWorld(w.id);
              }}
              onEdit={() => void editWorld(w)}
            />
          ))
        )}
        <div className="mt-1 h-px w-8 bg-[#5A4F42]/40" aria-hidden />
        <button
          type="button"
          onClick={() => setCreating(true)}
          title="New world"
          aria-label="New world"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-[#5A4F42]/40 text-[#F4EDE0] transition hover:rounded-[14px] hover:bg-[#7B8A5F] hover:text-[#F4EDE0]"
        >
          <Plus size={18} aria-hidden />
        </button>
      </aside>
      {creating && (
        <NewWorldDialog
          csrfToken={csrfToken}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            window.location.href = '/';
          }}
        />
      )}
    </>
  );
}

function WorldIcon({
  world,
  onClick,
  onEdit,
}: {
  world: World;
  onClick: () => void;
  onEdit: () => void;
}): React.JSX.Element {
  const initials = initialsOf(world.name);
  const bg = colorFor(world.id);
  const canEdit = world.role === 'admin';
  return (
    <div className="group relative">
      <span
        aria-hidden
        className={
          'absolute -left-1.5 top-1/2 -translate-y-1/2 rounded-r-full bg-[#F4EDE0] transition-all ' +
          (world.isActive ? 'h-8 w-1' : 'h-0 w-0.5')
        }
      />
      <button
        type="button"
        onClick={onClick}
        title={`${world.name} · ${world.role}`}
        aria-label={world.name}
        aria-pressed={world.isActive}
        className={
          'flex h-10 w-10 items-center justify-center overflow-hidden text-sm font-semibold text-[#F4EDE0] transition-all ' +
          (world.isActive
            ? 'rounded-[14px] ring-2 ring-[#F4EDE0]/20'
            : 'rounded-full hover:rounded-[14px]')
        }
        style={{ backgroundColor: bg }}
      >
        {initials}
      </button>
      {canEdit && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          title={`Edit ${world.name}`}
          aria-label={`Edit ${world.name}`}
          className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full border border-[#2A241E] bg-[#F4EDE0] text-[#2A241E] opacity-0 transition hover:scale-110 group-hover:opacity-100"
        >
          <Pencil size={9} aria-hidden />
        </button>
      )}
    </div>
  );
}


function NewWorldDialog({
  csrfToken,
  onClose,
  onCreated,
}: {
  csrfToken: string;
  onClose: () => void;
  onCreated: () => void;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState<string>('');
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean || pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/worlds', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ name: clean }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        detail?: string;
      };
      if (!res.ok || !body.ok) {
        setError(body.detail ?? body.error ?? `HTTP ${res.status}`);
        return;
      }
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error');
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#2A241E]/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8] p-4 shadow-[0_16px_48px_rgba(42,36,30,0.3)]"
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[#2A241E]">New world</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-[6px] p-1 text-[#5A4F42] transition hover:bg-[#F4EDE0]"
          >
            <X size={14} aria-hidden />
          </button>
        </div>
        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-medium text-[#5A4F42]">
            Name
          </span>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. The Crownfall"
            maxLength={80}
            className="w-full rounded-[6px] border border-[#D4C7AE] bg-[#F4EDE0] px-2 py-1.5 text-sm text-[#2A241E] outline-none focus:border-[#D4A85A]"
          />
        </label>
        <p className="mb-3 text-[11px] text-[#5A4F42]">
          You&rsquo;ll be the first admin. A starter folder skeleton
          (Campaigns / Assets / World) gets seeded automatically so you can
          start creating notes right away.
        </p>
        {error && <p className="mb-3 text-xs text-[#8B4A52]">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[6px] px-3 py-1.5 text-xs font-medium text-[#5A4F42] transition hover:text-[#2A241E]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending || !name.trim()}
            className="rounded-[6px] bg-[#2A241E] px-3 py-1.5 text-xs font-medium text-[#F4EDE0] transition hover:bg-[#3A342E] disabled:opacity-50"
          >
            {pending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** Deterministic background per world id so the same world always
 *  gets the same colour chip without persisting one on the row. */
function colorFor(id: string): string {
  const palette = [
    '#8B4A52', // wine
    '#7B8A5F', // moss
    '#6B7F8E', // sage
    '#D4A85A', // candlelight
    '#B5572A', // embers
    '#6A5D8B', // wisteria
    '#4A6B7B', // deep water
    '#8E6E53', // chestnut
  ];
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return palette[h % palette.length]!;
}
