'use client';

// Discord-style worlds rail. 56 px column: the user's Home tile (/me)
// on top, then one circular icon per world they belong to. A "+" at
// the bottom opens a small dialog to create a new world; submitting
// switches the caller into it.
//
// Worlds list is fetched from /api/worlds on mount, on window focus
// and every minute while the tab is visible, so activity badges appear
// without a reload. Switching posts to /api/worlds/active then
// router.refresh()es so every server component re-reads
// session.currentGroupId, landing on the last page the user had open
// in that world.
//
// Each world renders from one RailWorld (world-rail.ts): the fetched
// row joined with this browser's last-seen map and the active and
// pending ids. Exactly one item is active. `activeWorldId` below is
// the single source: the world being switched to while a switch is in
// flight, else nothing on /me (Home is active), else the session's
// world. It never reads the `isActive` flag on the fetched list, which
// is a fetch-time snapshot and would pin the highlight to whatever
// world was active then.
//
// Worlds reorder by drag (useWorldDrag) or Alt+ArrowUp/Down on a
// focused world; Alt+1..9 opens the nth world and Alt+0 goes Home.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Check, Flame, Link2, Pencil, Plus } from 'lucide-react';
import { useWorldSwitch } from './(app)/WorldSwitch';
import { NewWorldDialog } from './NewWorldDialog';
import { useWorldDrag } from './useWorldDrag';
import { worldColor, worldInitials } from './world-chip';
import {
  applyOrder,
  moveBy,
  orderFetched,
  railShortcut,
  railWorlds,
  readLastPage,
  readSeen,
  reconcileSeen,
  shortcutLabel,
  writeSeen,
  type RailWorld,
  type SeenMap,
  type WorldRow,
} from './world-rail';

const HOME_LABEL = 'Home — your worlds & characters';
const HOME_SHORTCUT = shortcutLabel(0);
const POLL_MS = 60_000;
const MIN_REFETCH_GAP_MS = 5_000;

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
   *  for use inside MobileNavDrawer, which is itself `md:hidden`. The
   *  rail instance is always mounted, so it alone marks worlds seen
   *  and owns the global shortcuts. */
  variant?: 'rail' | 'drawer';
}): React.JSX.Element {
  const { isPending, pendingWorldId, switchTo } = useWorldSwitch();
  const router = useRouter();
  const pathname = usePathname();
  const onMe = pathname === '/me' || pathname.startsWith('/me/');
  const activeWorldId = pendingWorldId ?? (onMe ? null : worldId);
  const ownsRail = variant === 'rail';
  const [rows, setRows] = useState<WorldRow[] | null>(null);
  const [seen, setSeen] = useState<SeenMap>({});
  const [creating, setCreating] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [announcement, setAnnouncement] = useState<string>('');
  const railRef = useRef<HTMLElement | null>(null);
  const hintId = useId();
  // Orders the server has not confirmed: the live preview of a drag in
  // progress, and the last order sent to PUT /api/worlds/order until it
  // lands. A fetch arriving meanwhile keeps them instead of snapping back.
  const dragOrder = useRef<string[] | null>(null);
  const savingOrder = useRef<string[] | null>(null);
  // Every fetch gets a sequence number. A response to a request sent
  // before the last order save landed (seq < orderFreshFrom) may carry
  // the old order, so its order is ignored.
  const fetchSeq = useRef<number>(0);
  const orderFreshFrom = useRef<number>(0);
  const lastFetchAt = useRef<number>(0);

  const fetchWorlds = useCallback(async (): Promise<void> => {
    lastFetchAt.current = Date.now();
    const seq = ++fetchSeq.current;
    try {
      const res = await fetch('/api/worlds', { cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as { worlds?: WorldRow[] };
      const fetched = body.worlds ?? [];
      const local = dragOrder.current ?? savingOrder.current;
      const stale = seq < orderFreshFrom.current;
      setRows((shown) => orderFetched(fetched, shown, local, stale));
    } catch {
      /* keep the current list */
    }
  }, []);

  // Mount, and again whenever the session's world changes, so role
  // flags, iconVersion bumps and newly joined worlds stay current.
  useEffect(() => {
    void fetchWorlds();
  }, [fetchWorlds, worldId]);

  // The settings page dispatches this after a rename or icon change.
  useEffect(() => {
    const onWorldUpdated = (): void => void fetchWorlds();
    window.addEventListener('world-updated', onWorldUpdated);
    return () => window.removeEventListener('world-updated', onWorldUpdated);
  }, [fetchWorlds]);

  useEffect(() => {
    const refresh = (): void => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastFetchAt.current < MIN_REFETCH_GAP_MS) return;
      void fetchWorlds();
    };
    const timer = setInterval(refresh, POLL_MS);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [fetchWorlds]);

  // The world the session is actually in records its latest activity on
  // every fetch (which also runs when the tab regains focus). The
  // optimistic switch target is left alone, so a failed switch keeps
  // its badge. The user's own writes never reach latestActivityAt, so
  // saves that land after they leave do not come back as a badge.
  const confirmedWorldId = onMe ? null : worldId;
  useEffect(() => {
    let next = readSeen();
    if (ownsRail && rows) {
      next = reconcileSeen(next, rows, confirmedWorldId);
      writeSeen(next);
    }
    setSeen(next);
  }, [rows, confirmedWorldId, ownsRail]);

  const items = useMemo<RailWorld[] | null>(
    () => (rows ? railWorlds(rows, seen, activeWorldId, pendingWorldId) : null),
    [rows, seen, activeWorldId, pendingWorldId],
  );

  const switchWorld = useCallback(
    async (id: string, destination?: string): Promise<void> => {
      if (busy || isPending) return;
      setBusy(true);
      try {
        await switchTo(id, destination ?? readLastPage(id) ?? undefined);
      } finally {
        setBusy(false);
      }
    },
    [busy, isPending, switchTo],
  );

  // One save in flight at a time; a reorder made meanwhile is sent
  // when it lands, so the server never ends on an older order.
  const saveQueue = useRef<{ inFlight: boolean; next: string[] | null }>({
    inFlight: false,
    next: null,
  });
  const saveOrder = useCallback(
    async (order: string[]): Promise<void> => {
      const q = saveQueue.current;
      q.next = order;
      if (q.inFlight) return;
      q.inFlight = true;
      try {
        while (q.next) {
          const worldIds = q.next;
          q.next = null;
          const res = await fetch('/api/worlds/order', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
            body: JSON.stringify({ worldIds }),
          });
          if (!res.ok) throw new Error(`order save failed: ${res.status}`);
        }
        savingOrder.current = null;
        orderFreshFrom.current = fetchSeq.current + 1;
        void fetchWorlds();
      } catch {
        q.next = null;
        savingOrder.current = null;
        setAnnouncement('Could not save the world order. It has been put back.');
        void fetchWorlds();
      } finally {
        q.inFlight = false;
      }
    },
    [csrfToken, fetchWorlds],
  );

  const showOrder = useCallback((order: string[]): void => {
    setRows((prev) => (prev ? applyOrder(prev, order) : prev));
  }, []);

  const previewOrder = useCallback(
    (order: string[]): void => {
      dragOrder.current = order;
      showOrder(order);
    },
    [showOrder],
  );

  const cancelDrag = useCallback(
    (startOrder: string[]): void => {
      dragOrder.current = null;
      showOrder(startOrder);
    },
    [showOrder],
  );

  const commitOrder = useCallback(
    (order: string[], movedId: string): void => {
      dragOrder.current = null;
      savingOrder.current = order;
      showOrder(order);
      void saveOrder(order);
      const name = rows?.find((r) => r.id === movedId)?.name ?? 'World';
      setAnnouncement(`${name} moved to position ${order.indexOf(movedId) + 1} of ${order.length}.`);
    },
    [rows, saveOrder, showOrder],
  );

  const ids = useMemo(() => rows?.map((r) => r.id) ?? [], [rows]);
  const drag = useWorldDrag({
    railRef,
    ids,
    onPreview: previewOrder,
    onDrop: commitOrder,
    onCancel: cancelDrag,
  });

  const moveWithKeyboard = (id: string, delta: number): void => {
    const order = moveBy(ids, id, delta);
    if (order.join() !== ids.join()) commitOrder(order, id);
    // React moves the other items around the focused one, but keep focus
    // on the moved world explicitly in case its node was re-inserted.
    requestAnimationFrame(() =>
      railRef.current
        ?.querySelector<HTMLElement>(`[data-world-id="${CSS.escape(id)}"]`)
        ?.focus(),
    );
  };

  const latest = useRef({ items, switchWorld, router });
  latest.current = { items, switchWorld, router };
  useEffect(() => {
    if (!ownsRail) return;
    const onKey = (e: KeyboardEvent): void => {
      const shortcut = railShortcut(e);
      if (!shortcut || isEditable(e.target)) return;
      e.preventDefault();
      const { items: current, switchWorld: go, router: nav } = latest.current;
      if (shortcut.kind === 'home') {
        nav.push('/me');
        return;
      }
      const target = current?.[shortcut.index];
      if (target && !target.active) void go(target.row.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ownsRail]);

  const homeActive = activeWorldId === null;

  return (
    <>
      <aside
        ref={railRef}
        aria-label="Worlds"
        className={
          variant === 'drawer'
            ? 'flex h-full w-[56px] shrink-0 flex-col items-center gap-1.5 overflow-y-auto bg-[var(--shadow)] py-2'
            : 'hidden h-full w-[56px] shrink-0 flex-col items-center gap-1.5 bg-[var(--shadow)] py-2 md:flex'
        }
      >
        <div className="group relative">
          <RailPill state={homeActive ? 'active' : 'idle'} />
          <Link
            href="/me"
            title={`${HOME_LABEL} · ${HOME_SHORTCUT}`}
            aria-label={HOME_LABEL}
            aria-keyshortcuts={HOME_SHORTCUT}
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
        {items == null ? (
          [0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-[var(--rail-ink)]/10 motion-reduce:animate-none"
              aria-hidden
            />
          ))
        ) : (
          items.map((item) => (
            <WorldIcon
              key={item.row.id}
              item={item}
              dragging={drag.draggingId === item.row.id}
              describedBy={hintId}
              onPointerDown={(e) => drag.onPointerDown(e, item.row.id)}
              onClickCapture={drag.onClickCapture}
              onClick={() => {
                if (!item.active) void switchWorld(item.row.id);
              }}
              onMove={(delta) => moveWithKeyboard(item.row.id, delta)}
              // Editing flips the active world (a harmless no-op when it
              // already is) and lands on its settings page, all through
              // switchTo so the rail stays mounted.
              onEdit={() => void switchWorld(item.row.id, '/settings/world')}
            />
          ))
        )}
        <span id={hintId} className="sr-only">
          Drag, or press Alt with the up or down arrow, to reorder.
        </span>
        <span role="status" aria-live="polite" className="sr-only">
          {announcement}
        </span>
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
            void switchWorld(id, '/home');
          }}
        />
      )}
    </>
  );
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !==
      null
  );
}

/** Left-edge indicator shared by Home and every world. Must sit inside
 *  a `group` wrapper so hover and keyboard focus can grow it. Unread is
 *  a short nub, the way a chat app marks a channel with new messages. */
function RailPill({ state }: { state: 'active' | 'unread' | 'idle' }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={
        'pointer-events-none absolute -left-2 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-[var(--candlelight)] transition-[height] duration-150 motion-reduce:transition-none ' +
        (state === 'active'
          ? 'h-9'
          : state === 'unread'
            ? 'h-2 group-hover:h-5 group-focus-within:h-5'
            : 'h-0 group-hover:h-5 group-focus-within:h-5')
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
  item,
  dragging,
  describedBy,
  onPointerDown,
  onClickCapture,
  onClick,
  onMove,
  onEdit,
}: {
  item: RailWorld;
  dragging: boolean;
  describedBy: string;
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  onClickCapture: (e: React.MouseEvent) => void;
  onClick: () => void;
  onMove: (delta: number) => void;
  onEdit: () => void;
}): React.JSX.Element {
  const { row: world, active, pending } = item;
  const canEdit = world.role === 'admin';
  const hasIcon = world.iconVersion > 0;
  return (
    <div
      className={
        'group relative transition-transform duration-150 motion-reduce:transition-none ' +
        (dragging ? 'z-10 scale-110 opacity-90' : '')
      }
    >
      <RailPill state={active ? 'active' : item.unread ? 'unread' : 'idle'} />
      <button
        type="button"
        data-world-id={world.id}
        onPointerDown={onPointerDown}
        onClickCapture={onClickCapture}
        onClick={onClick}
        onKeyDown={(e) => {
          if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          onMove(e.key === 'ArrowUp' ? -1 : 1);
        }}
        title={item.title}
        aria-label={item.label}
        aria-describedby={describedBy}
        aria-keyshortcuts={item.shortcut ? shortcutLabel(item.shortcut) : undefined}
        aria-current={active ? 'true' : undefined}
        aria-busy={pending || undefined}
        className={
          'flex h-10 w-10 touch-manipulation select-none items-center justify-center overflow-hidden text-sm font-semibold text-[var(--rail-ink)] transition-[border-radius] duration-150 [-webkit-touch-callout:none] motion-reduce:transition-none ' +
          (dragging ? 'cursor-grabbing shadow-lg ' : '') +
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
            draggable={false}
            className="h-full w-full object-cover"
          />
        ) : (
          worldInitials(world.name)
        )}
      </button>
      {item.live && (
        <span
          aria-hidden
          className="pointer-events-none absolute -bottom-1 -right-1 flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 border-[var(--shadow)] bg-[var(--candlelight)] text-[var(--shadow)]"
        >
          <Flame size={10} strokeWidth={2.75} />
        </span>
      )}
      {/* The pencil overlaps the tile's corner, so it takes taps only while
          shown by hover or keyboard focus. Not focus-within: a tap focuses
          the tile between mousedown and mouseup, the pencil would take the
          mouseup, and the click would land on neither button. */}
      {canEdit && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          title={`Edit ${world.name}`}
          aria-label={`Edit ${world.name}`}
          className="pointer-events-none absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full opacity-0 transition-opacity duration-150 motion-reduce:transition-none group-hover:pointer-events-auto group-hover:opacity-100 group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:opacity-100"
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
