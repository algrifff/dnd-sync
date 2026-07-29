'use client';

// Vault-wide awareness channel. Every authenticated client opens a
// persistent Hocuspocus connection against the reserved ".presence"
// doc (content-less — the collab server short-circuits fetch/store
// for dot-prefixed names), publishes { user, viewing, viewingTitle },
// and listens for peers. PresencePanel renders the resulting list
// of avatars with a hover tooltip and click-to-navigate.
//
// The provider survives across route changes (mounted once in the
// AppHeader) so closing a note doesn't bounce anyone off presence.

import { useEffect, useMemo, useRef, useState } from 'react';
import { EVENTS, track } from '@/lib/analytics/client';
import { usePathname, useRouter } from 'next/navigation';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { PresencePanel, type PresencePeer } from './PresencePanel';
import { TREE_CHANGE_EVENT, TREE_CHANGE_REMOTE_EVENT } from '@/lib/tree-sync';
import {
  notePathFromPathname,
  setPresencePeers,
  type PresencePeerLite,
} from '@/lib/presence-state';

export type Me = {
  userId: string;
  displayName: string;
  username: string;
  accentColor: string;
  avatarVersion: number;
};

export function PresenceClient({
  me,
  groupId,
}: {
  me: Me;
  /** Current world/campaign id — REQUIRED. This used to be optional
   *  with an un-suffixed `.presence` fallback for a missing groupId,
   *  which was a second, latent cross-tenant channel: every world
   *  without a groupId would share one global awareness doc leaking
   *  display names, usernames, and `viewing` paths across every world.
   *  Both callers (`AppHeader.tsx`) already pass a real groupId, so
   *  the fallback was unreachable in practice — it's removed here so
   *  it can't become reachable by a future caller forgetting the prop. */
  groupId: string;
}): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname() ?? '';

  const ydoc = useMemo(() => new Y.Doc(), [groupId]);
  const provider = useMemo(
    () =>
      new HocuspocusProvider({
        url: buildCollabUrl(),
        // Scope presence per group so users from different worlds
        // don't appear in each other's avatar rows.
        name: `.presence:${groupId}`,
        document: ydoc,
      }),
    [ydoc, groupId],
  );

  const [peers, setPeers] = useState<PresencePeer[]>([]);
  const providerRef = useRef(provider);
  providerRef.current = provider;
  // Pending debounce timer for peer-driven router.refresh() calls — see
  // the tree-sync effect below. Held in a ref (not effect-local state)
  // so the effect's cleanup can always reach the latest timer and clear
  // it on unmount, even though the effect itself only re-runs when
  // `router` changes identity.
  const remoteRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Seed the local awareness state once the provider is live. `user`
  // stays static; `viewing` is updated in a separate effect so route
  // changes propagate without tearing the connection down.
  useEffect(() => {
    const aw = provider.awareness;
    if (!aw) return;
    aw.setLocalStateField('user', {
      userId: me.userId,
      name: me.displayName,
      username: me.username,
      color: me.accentColor,
      avatarVersion: me.avatarVersion,
    });

    const recompute = (): void => {
      const states = aw.getStates();
      const list: PresencePeer[] = [];
      const lite: PresencePeerLite[] = [];
      for (const [clientId, state] of states.entries()) {
        if (clientId === aw.clientID) continue;
        const s = state as Partial<PeerState> | undefined;
        if (!s?.user) continue;
        const viewing = s.viewing ?? null;
        const color = s.user.color ?? 'var(--ink-soft)';
        const name = s.user.name ?? 'Anonymous';
        const userId = s.user.userId ?? '';
        const avatarVersion =
          typeof s.user.avatarVersion === 'number' ? s.user.avatarVersion : 0;
        list.push({
          clientId,
          userId,
          name,
          username: s.user.username ?? '',
          color,
          avatarVersion,
          viewing,
          viewingTitle: s.viewingTitle ?? null,
        });
        lite.push({
          clientId,
          userId,
          name,
          color,
          avatarVersion,
          viewing,
          notePath: notePathFromPathname(viewing),
        });
      }
      setPeers(list);
      setPresencePeers(lite);
      maybeReportPresence(list.length);
    };

    // Throttle presence reports to one every 30s per mount — an open
    // session with peers would otherwise fire every keystroke.
    let lastReportAt = 0;
    let lastReportedCount = -1;
    const maybeReportPresence = (peerCount: number): void => {
      const now = Date.now();
      if (peerCount === lastReportedCount && now - lastReportAt < 30_000) return;
      lastReportAt = now;
      lastReportedCount = peerCount;
      track(EVENTS.PEER_PRESENCE_SEEN, {
        peer_count: peerCount,
        group_id: groupId,
      });
    };

    aw.on('change', recompute);
    recompute();
    return () => {
      aw.off('change', recompute);
    };
  }, [provider, me.userId, me.displayName, me.username, me.accentColor]);

  // Broadcast the current route. Decoded for the panel's tooltip.
  useEffect(() => {
    const aw = providerRef.current.awareness;
    if (!aw) return;
    const viewing = pathname || '/';
    const title = titleFromPathname(pathname);
    aw.setLocalStateField('viewing', viewing);
    aw.setLocalStateField('viewingTitle', title);
  }, [pathname]);

  // Live tree sync: mutating clients fire broadcastTreeChange(), which
  // bumps our local awareness.treeVersion. Peers observe the change
  // and router.refresh() their server-rendered sidebar. Self-bumps
  // are ignored so the mutating client doesn't double-refresh.
  useEffect(() => {
    const aw = providerRef.current.awareness;
    if (!aw) return;

    const onLocalChange = (): void => {
      aw.setLocalStateField('treeVersion', Date.now());
      router.refresh();
    };
    document.addEventListener(TREE_CHANGE_EVENT, onLocalChange);

    const lastSeen = new Map<number, number>();
    const onRemoteChange = (): void => {
      let shouldRefresh = false;
      for (const [clientId, state] of aw.getStates().entries()) {
        if (clientId === aw.clientID) continue;
        const raw = (state as { treeVersion?: unknown } | undefined)?.treeVersion;
        if (typeof raw !== 'number') continue;
        const prev = lastSeen.get(clientId) ?? 0;
        if (raw > prev) {
          lastSeen.set(clientId, raw);
          shouldRefresh = true;
        }
      }
      if (!shouldRefresh) return;
      // Debounce: with several peers actively creating/moving notes,
      // each one's treeVersion bump lands as its own awareness 'change'
      // event, which could otherwise fire a full RSC refresh —
      // reconciling the entire sidebar tree — multiple times a second.
      // Collapse a burst into a single trailing refresh ~500ms after
      // the last bump seen, rather than either refreshing on every bump
      // (the bug) or a leading-edge throttle that would swallow the
      // tail bump of a burst and leave the sidebar stale. Re-arming the
      // timer on every bump (instead of a fixed-window throttle) is
      // what guarantees the trailing bump always gets its refresh.
      if (remoteRefreshTimerRef.current) clearTimeout(remoteRefreshTimerRef.current);
      remoteRefreshTimerRef.current = setTimeout(() => {
        remoteRefreshTimerRef.current = null;
        router.refresh();
        // Fan out to local listeners that care about tree changes
        // (e.g. NoteTabs' stale-tab pruner) — separate event so
        // PresenceClient's own local listener above doesn't pick it
        // up and re-broadcast into awareness, which would loop back
        // to the originator.
        document.dispatchEvent(new CustomEvent(TREE_CHANGE_REMOTE_EVENT));
      }, 500);
    };
    aw.on('change', onRemoteChange);

    return () => {
      document.removeEventListener(TREE_CHANGE_EVENT, onLocalChange);
      aw.off('change', onRemoteChange);
      // Clear any pending trailing refresh so it can't fire after this
      // effect (or the component) tears down — e.g. a peer bump lands
      // right as the user navigates away or the provider is swapped.
      if (remoteRefreshTimerRef.current) {
        clearTimeout(remoteRefreshTimerRef.current);
        remoteRefreshTimerRef.current = null;
      }
    };
  }, [router]);

  // Tear down on unmount. Clear local awareness first so peers see
  // the user disappear immediately rather than waiting for the
  // WebSocket close timeout.
  useEffect(() => {
    const p = provider;
    const d = ydoc;
    return () => {
      p.awareness?.setLocalState(null);
      p.destroy();
      d.destroy();
    };
  }, [provider, ydoc]);

  return <PresencePanel peers={peers} onNavigate={(href) => router.push(href)} />;
}

type PeerState = {
  user: {
    userId: string;
    name: string;
    username: string;
    color: string;
    avatarVersion?: number;
  };
  viewing?: string | null;
  viewingTitle?: string | null;
};

function titleFromPathname(pathname: string): string {
  if (!pathname || pathname === '/') return 'Home';
  if (pathname.startsWith('/notes/')) {
    const rest = pathname.slice('/notes/'.length);
    const last = rest.split('/').pop() ?? rest;
    try {
      return decodeURIComponent(last).replace(/\.(md|canvas)$/i, '');
    } catch {
      return last;
    }
  }
  if (pathname.startsWith('/tags/')) {
    const tag = pathname.slice('/tags/'.length);
    try {
      return '#' + decodeURIComponent(tag);
    } catch {
      return '#' + tag;
    }
  }
  if (pathname === '/tags') return 'Tags';
  if (pathname.startsWith('/settings')) return 'Settings';
  return pathname;
}

function buildCollabUrl(): string {
  if (typeof window === 'undefined') return 'ws://localhost/collab';
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/collab`;
}
