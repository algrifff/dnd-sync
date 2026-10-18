'use client';

// Discord-style worlds rail. 56 px column: the user's Home tile (/me)
// on top, then one circular icon per world they belong to. A "+" at
// the bottom opens a small dialog to create a new world; submitting
// switches the caller into it.
//
// Worlds list is fetched from /api/worlds on mount. Switching posts
// to /api/worlds/active then router.refresh()es so every server
// component re-reads session.currentGroupId.
//
// Exactly one item is active. `activeWorldId` below is the single
// source: the world being switched to while a switch is in flight,
// else nothing on /me (Home is active), else the session's world.
// It never reads the `isActive` flag on the fetched list, which is a
// mount-time snapshot and would pin the highlight to whatever world
// was active when the rail mounted.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Check, Link2, Pencil, Plus } from 'lucide-react';
import { useWorldSwitch } from './(app)/WorldSwitch';
import { NewWorldDialog } from './NewWorldDialog';
import { worldColor, worldInitials } from './world-chip';

type World = {
  id: string;
  name: string;
  role: 'admin' | 'editor' | 'viewer';
  /** 0 = no uploaded icon, fall back to initials chip. Non-zero acts
   *  as a cache-buster for /api/worlds/{id}/icon?v=N. */
  iconVersion: number;
};

const HOME_LABEL = 'Home — your worlds & characters';

export function WorldsSidebar({
  csrfToken,
  userId,
  displayName,
  accentColor,
  avatarVersion,
  role,
  worldId,
  variant = 'rail',
}: {
  csrfToken: string;
  userId: string;
  displayName: string;
  accentColor: string;
  avatarVersion: number;
  role: 'admin' | 'editor' | 'viewer';
  worldId: string;
  /** 'rail' (default) is the desktop Discord-style column — hidden
   *  below `md`, unchanged. 'drawer' renders the identical content as
   *  a plain always-visible flex column with no `hidden`/`md:` guard,
   *  for use inside MobileNavDrawer, which is itself `md:hidden`. */
  variant?: 'rail' | 'drawer';
}): React.JSX.Element {
  const { isPending, pendingWorldId, switchTo } = useWorldSwitch();
  const pathname = usePathname();
  const onMe = pathname === '/me' || pathname.startsWith('/me/');
  const activeWorldId = pendingWorldId ?? (onMe ? null : worldId);
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
  // iconVersion bumps, and any newly-joined worlds stay current. Skip
  // the very first render because the mount-time fetch already kicked
  // off above.
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

  const switchWorld = async (id: string, destination?: string): Promise<void> => {
    if (busy || isPending) return;
    setBusy(true);
    try {
      await switchTo(id, destination);
    } finally {
      setBusy(false);
    }
  };

  const homeActive = activeWorldId === null;

  return (
    <>
      <aside
        aria-label="Worlds"
        className={
          variant === 'drawer'
            ? 'flex h-full w-[56px] shrink-0 flex-col items-center gap-1.5 overflow-y-auto bg-[var(--shadow)] py-2'
            : 'hidden h-full w-[56px] shrink-0 flex-col items-center gap-1.5 bg-[var(--shadow)] py-2 md:flex'
        }
      >
        <div className="group relative">
          <RailPill active={homeActive} />
          <Link
            href="/me"
            title={HOME_LABEL}
            aria-label={HOME_LABEL}
            aria-current={homeActive ? 'page' : undefined}
            className={
              'flex h-10 w-10 items-center justify-center rounded-[14px] transition-colors duration-150 motion-reduce:transition-none ' +
              (homeActive
                ? 'bg-[var(--candlelight)] text-[var(--shadow)]'
                : 'bg-[var(--candlelight)]/15 text-[var(--candlelight)] hover:bg-[var(--candlelight)]/30')
            }
          >
            <HearthIcon />
          </Link>
        </div>
        <div className="my-0.5 h-0.5 w-8 rounded-full bg-[var(--rail-ink)]/25" aria-hidden />
        {worlds == null ? (
          [0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-[var(--rail-ink)]/10 motion-reduce:animate-none"
              aria-hidden
            />
          ))
        ) : (
          worlds.map((w) => (
            <WorldIcon
              key={w.id}
              world={w}
              active={w.id === activeWorldId}
              pending={w.id === pendingWorldId}
              onClick={() => {
                if (w.id !== activeWorldId) void switchWorld(w.id);
              }}
              // Editing flips the active world (a harmless no-op when it
              // already is) and lands on its settings page, all through
              // switchTo so the rail stays mounted.
              onEdit={() => void switchWorld(w.id, '/settings/world')}
            />
          ))
        )}
        <div className="mt-1 h-px w-8 bg-[var(--rail-ink)]/15" aria-hidden />
        <button
          type="button"
          onClick={() => setCreating(true)}
          title="New world"
          aria-label="New world"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--rail-ink)]/10 text-[var(--rail-ink)] transition-all motion-reduce:transition-none hover:rounded-[14px] hover:bg-[var(--moss)]"
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

/** Left-edge indicator shared by Home and every world. Must sit inside
 *  a `group` wrapper so hover and keyboard focus can grow it. */
function RailPill({ active }: { active: boolean }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={
        'pointer-events-none absolute -left-2 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-[var(--candlelight)] transition-[height] duration-150 motion-reduce:transition-none ' +
        (active ? 'h-9' : 'h-0 group-hover:h-5 group-focus-within:h-5')
      }
    />
  );
}

/** A fireplace (mantle, surround, lucide's flame inside): the user's own
 *  hearth, as opposed to the worlds they visit. Drawn on lucide's
 *  24px / 2px-stroke grid. */
function HearthIcon(): React.JSX.Element {
  return (
    <svg
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2 4h20" />
      <path d="M4 4v17h16V4" />
      <path
        transform="translate(6 8.5) scale(0.5)"
        strokeWidth={4}
        d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"
      />
    </svg>
  );
}

function WorldIcon({
  world,
  active,
  pending,
  onClick,
  onEdit,
}: {
  world: World;
  active: boolean;
  pending: boolean;
  onClick: () => void;
  onEdit: () => void;
}): React.JSX.Element {
  const canEdit = world.role === 'admin';
  const hasIcon = world.iconVersion > 0;
  return (
    <div className="group relative">
      <RailPill active={active} />
      <button
        type="button"
        onClick={onClick}
        title={`${world.name} · ${world.role}`}
        aria-label={world.name}
        aria-current={active ? 'true' : undefined}
        aria-busy={pending || undefined}
        className={
          'flex h-10 w-10 items-center justify-center overflow-hidden text-sm font-semibold text-[var(--rail-ink)] transition-[border-radius] duration-150 motion-reduce:transition-none ' +
          (pending
            ? 'rail-pending rounded-[14px]'
            : active
              ? 'rounded-[14px] ring-2 ring-[var(--rail-ink)]/20'
              : 'rounded-full hover:rounded-[14px] focus-visible:rounded-[14px]')
        }
        style={{ backgroundColor: hasIcon ? 'var(--ink)' : worldColor(world.id) }}
      >
        {hasIcon ? (
          <img
            src={`/api/worlds/${encodeURIComponent(world.id)}/icon?v=${world.iconVersion}`}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          worldInitials(world.name)
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
          className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full opacity-0 transition-opacity duration-150 motion-reduce:transition-none group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
        >
          <span className="flex h-4 w-4 items-center justify-center rounded-full border border-[var(--shadow)] bg-[var(--rail-ink)] text-[var(--shadow)]">
            <Pencil size={9} aria-hidden />
          </span>
        </button>
      )}
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
        'flex h-10 w-10 items-center justify-center rounded-full text-[var(--rail-ink)] transition-all motion-reduce:transition-none ' +
        (copied
          ? 'bg-[var(--moss)] ring-2 ring-[var(--moss)]/50'
          : 'bg-[var(--rail-ink)]/10 hover:rounded-[14px] hover:bg-[var(--moss)]')
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
      className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full transition-all motion-reduce:transition-none hover:rounded-[14px] hover:ring-2 hover:ring-[var(--rail-ink)]/20"
    >
      {hasAvatar ? (
        <img
          src={`/api/users/${userId}/avatar?v=${avatarVersion}`}
          alt={displayName}
          className="h-full w-full object-cover"
        />
      ) : (
        <span
          className="flex h-full w-full items-center justify-center text-sm font-semibold text-[var(--rail-ink)]"
          style={{ backgroundColor: accentColor }}
        >
          {initial}
        </span>
      )}
    </Link>
  );
}
