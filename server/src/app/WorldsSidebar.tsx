'use client';

// Discord-style worlds rail. 56 px column of circular icons, one per
// world the user is a member of, with the active world highlighted
// by a left-edge pill. A "+" at the bottom opens a small dialog to
// create a new world; submitting switches the caller into it.
//
// Worlds list is fetched from /api/worlds on mount. Switching posts
// to /api/worlds/active then router.refresh()es so every server
// component re-reads session.currentGroupId.
//
// IMPORTANT: the active pill is driven by the `worldId` prop (from
// the server session), NOT by the `isActive` flag on the fetched
// list. The fetched list is a mount-time snapshot — if we read
// isActive from it, every switch after the first keeps the highlight
// pinned to whatever world was active when the sidebar mounted.

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Check, Link2, Pencil, Plus, X } from 'lucide-react';
import { useWorldSwitch } from './(app)/WorldSwitch';

type World = {
  id: string;
  name: string;
  role: 'admin' | 'editor' | 'viewer';
  isActive: boolean;
  /** 0 = no uploaded icon, fall back to initials chip. Non-zero acts
   *  as a cache-buster for /api/worlds/{id}/icon?v=N. */
  iconVersion: number;
};

export function WorldsSidebar({
  csrfToken,
  userId,
  displayName,
  accentColor,
  avatarVersion,
  role,
  worldId,
}: {
  csrfToken: string;
  userId: string;
  displayName: string;
  accentColor: string;
  avatarVersion: number;
  role: 'admin' | 'editor' | 'viewer';
  worldId: string;
}): React.JSX.Element {
  const { isPending, switchTo } = useWorldSwitch();
  const [worlds, setWorlds] = useState<World[] | null>(null);
  const [creating, setCreating] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);

  useEffect(() => {
    void fetchWorlds();
  }, []);

  // Re-fetch the worlds list whenever the current world is edited
  // elsewhere (for example the settings page dispatches this after a
  // successful rename), so the sidebar's icon tooltip / aria-label stay
  // in sync without a full reload.
  useEffect(() => {
    const onWorldUpdated = (): void => {
      void fetchWorlds();
    };
    window.addEventListener('world-updated', onWorldUpdated);
    return () => window.removeEventListener('world-updated', onWorldUpdated);
  }, []);

  // When the active world changes, re-pull the list so role flags,
  // iconVersion bumps, and any newly-joined worlds stay current. We
  // already render the active pill straight from the `worldId` prop,
  // so the list's own isActive column isn't load-bearing anymore —
  // but the rest of the row data still needs to match the new
  // session. Skip the very first render because the mount-time fetch
  // already kicked off above.
  const mountedOnce = useRef<boolean>(false);
  useEffect(() => {
    if (!mountedOnce.current) {
      mountedOnce.current = true;
      return;
    }
    void fetchWorlds();
  }, [worldId]);

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

  // Live active-state view of the worlds list. We keep the fetched
  // list as-is and override `isActive` per-row from the server
  // session's worldId, so that after a switch the highlight flips
  // even before the (possibly debounced) re-fetch finishes.
  const worldsWithLiveActive = useMemo<World[] | null>(
    () =>
      worlds == null
        ? null
        : worlds.map((w) => ({ ...w, isActive: w.id === worldId })),
    [worlds, worldId],
  );

  const switchWorld = async (id: string): Promise<void> => {
    if (busy || isPending) return;
    setBusy(true);
    try {
      await switchTo(id);
    } finally {
      setBusy(false);
    }
  };

  // Clicking the pencil on any world both flips the active world
  // (server-side) and lands the user on its settings page. Setting
  // the active world to the one it already is is a harmless no-op on
  // the server, so we can route every case through switchTo and keep
  // the world rail mounted.
  const editWorld = async (w: World): Promise<void> => {
    if (busy || isPending) return;
    setBusy(true);
    try {
      await switchTo(w.id, '/settings/world');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <aside
        aria-label="Worlds"
        className="hidden h-full w-[56px] shrink-0 flex-col items-center gap-1.5 bg-[var(--shadow)] py-2 md:flex"
      >
        {worldsWithLiveActive == null ? (
          <div className="h-10 w-10 animate-pulse rounded-full bg-[var(--ink-soft)]/40" />
        ) : (
          worldsWithLiveActive.map((w) => (
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
        <div className="mt-1 h-px w-8 bg-[var(--ink-soft)]/40" aria-hidden />
        <button
          type="button"
          onClick={() => setCreating(true)}
          title="New world"
          aria-label="New world"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--ink-soft)]/40 text-[var(--parchment)] transition hover:rounded-[14px] hover:bg-[var(--moss)] hover:text-[var(--parchment)]"
        >
          <Plus size={18} aria-hidden />
        </button>
        <div className="flex-1" />
        {role === 'admin' && (
          <ShareLinkButton worldId={worldId} csrfToken={csrfToken} />
        )}
        <ProfileAvatar
          userId={userId}
          displayName={displayName}
          accentColor={accentColor}
          avatarVersion={avatarVersion}
        />
        <div className="pb-1" />
      </aside>
      {creating && (
        <NewWorldDialog
          csrfToken={csrfToken}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            void switchWorld(id);
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
  const hasIcon = world.iconVersion > 0;
  return (
    <div className="group relative">
      <span
        aria-hidden
        className={
          'absolute -left-1.5 top-1/2 -translate-y-1/2 rounded-r-full bg-[var(--parchment)] transition-all ' +
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
          'flex h-10 w-10 items-center justify-center overflow-hidden text-sm font-semibold text-[var(--parchment)] transition-all ' +
          (world.isActive
            ? 'rounded-[14px] ring-2 ring-[var(--parchment)]/20'
            : 'rounded-full hover:rounded-[14px]')
        }
        style={{ backgroundColor: hasIcon ? 'var(--ink)' : bg }}
      >
        {hasIcon ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/worlds/${encodeURIComponent(world.id)}/icon?v=${world.iconVersion}`}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          initials
        )}
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
          className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full border border-[var(--ink)] bg-[var(--parchment)] text-[var(--ink)] opacity-0 transition hover:scale-110 group-hover:opacity-100"
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
  onCreated: (id: string) => void;
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
        id?: string;
        error?: string;
        detail?: string;
      };
      if (!res.ok || !body.ok) {
        setError(body.detail ?? body.error ?? `HTTP ${res.status}`);
        return;
      }
      if (!body.id) {
        setError('Server did not return a world id.');
        return;
      }
      onCreated(body.id);
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--ink)]/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)] p-4 shadow-[0_16px_48px_rgb(var(--ink-rgb) / 0.3)]"
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[var(--ink)]">New world</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-[6px] p-1 text-[var(--ink-soft)] transition hover:bg-[var(--parchment)]"
          >
            <X size={14} aria-hidden />
          </button>
        </div>
        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-medium text-[var(--ink-soft)]">
            Name
          </span>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. The Crownfall"
            maxLength={80}
            className="w-full rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-2 py-1.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--candlelight)]"
          />
        </label>
        <p className="mb-3 text-[11px] text-[var(--ink-soft)]">
          You&rsquo;ll be the first admin. A starter folder skeleton
          (Campaigns / Assets / World) gets seeded automatically so you can
          start creating notes right away.
        </p>
        {error && <p className="mb-3 text-xs text-[var(--wine)]">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[6px] px-3 py-1.5 text-xs font-medium text-[var(--ink-soft)] transition hover:text-[var(--ink)]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending || !name.trim()}
            className="rounded-[6px] bg-[var(--ink)] px-3 py-1.5 text-xs font-medium text-[var(--parchment)] transition hover:bg-[var(--vellum)] disabled:opacity-50"
          >
            {pending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}

function ShareLinkButton({
  worldId,
  csrfToken,
}: {
  worldId: string;
  csrfToken: string;
}): React.JSX.Element {
  const [copied, setCopied] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);

  const share = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      let token: string | null = null;
      const getRes = await fetch(`/api/worlds/${worldId}/invite`);
      if (getRes.ok) {
        const data = (await getRes.json()) as { token?: string | null };
        token = data.token ?? null;
      }
      if (!token) {
        const postRes = await fetch(`/api/worlds/${worldId}/invite`, {
          method: 'POST',
          headers: { 'X-CSRF-Token': csrfToken },
        });
        if (postRes.ok) {
          const data = (await postRes.json()) as { token?: string };
          token = data.token ?? null;
        }
      }
      if (token) {
        await navigator.clipboard.writeText(
          `${window.location.origin}/join/${token}`,
        );
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void share()}
      title={copied ? 'Link copied!' : 'Copy invite link'}
      aria-label={copied ? 'Link copied!' : 'Copy invite link'}
      className={
        'flex h-10 w-10 items-center justify-center rounded-full transition-all ' +
        (copied
          ? 'bg-[var(--moss)] text-[var(--parchment)] ring-2 ring-[var(--moss)]/50'
          : 'bg-[var(--ink-soft)]/40 text-[var(--parchment)] hover:rounded-[14px] hover:bg-[var(--moss)]')
      }
    >
      {copied ? <Check size={16} aria-hidden /> : <Link2 size={16} aria-hidden />}
    </button>
  );
}

function ProfileAvatar({
  userId,
  displayName,
  accentColor,
  avatarVersion,
}: {
  userId: string;
  displayName: string;
  accentColor: string;
  avatarVersion: number;
}): React.JSX.Element {
  const hasAvatar = avatarVersion > 0;
  const initial = displayName.trim()[0]?.toUpperCase() ?? '?';

  return (
    <Link
      href="/settings/profile"
      title={`Profile · ${displayName}`}
      aria-label="Profile settings"
      className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full transition-all hover:rounded-[14px] hover:ring-2 hover:ring-[var(--parchment)]/20"
    >
      {hasAvatar ? (
        <img
          src={`/api/users/${userId}/avatar?v=${avatarVersion}`}
          alt={displayName}
          className="h-full w-full object-cover"
        />
      ) : (
        <span
          className="flex h-full w-full items-center justify-center text-sm font-semibold text-[var(--parchment)]"
          style={{ backgroundColor: accentColor }}
        >
          {initial}
        </span>
      )}
    </Link>
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
    'var(--wine)', // wine
    'var(--moss)', // moss
    'var(--sage)', // sage
    'var(--candlelight)', // candlelight
    'var(--embers)', // embers
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
