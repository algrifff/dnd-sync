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
import { usePathname, useRouter } from 'next/navigation';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { PresencePanel, type PresencePeer } from './PresencePanel';
import { TREE_CHANGE_EVENT } from '@/lib/tree-sync';

export type Me = {
  userId: string;
  displayName: string;
  username: string;
  accentColor: string;
};

export function PresenceClient({ me }: { me: Me }): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname() ?? '';

  const ydoc = useMemo(() => new Y.Doc(), []);
  const provider = useMemo(
    () =>
      new HocuspocusProvider({
        url: buildCollabUrl(),
        name: '.presence',
        document: ydoc,
      }),
    [ydoc],
  );

  const [peers, setPeers] = useState<PresencePeer[]>([]);
  const providerRef = useRef(provider);
  providerRef.current = provider;

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
    });

    const recompute = (): void => {
      const states = aw.getStates();
      const list: PresencePeer[] = [];
      for (const [clientId, state] of states.entries()) {
        if (clientId === aw.clientID) continue;
        const s = state as Partial<PeerState> | undefined;
        if (!s?.user) continue;
        list.push({
          clientId,
          userId: s.user.userId ?? '',
          name: s.user.name ?? 'Anonymous',
          username: s.user.username ?? '',
          color: s.user.color ?? '#5A4F42',
          viewing: s.viewing ?? null,
          viewingTitle: s.viewingTitle ?? null,
        });
      }
      setPeers(list);
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
      if (shouldRefresh) router.refresh();
    };
    aw.on('change', onRemoteChange);

    return () => {
      document.removeEventListener(TREE_CHANGE_EVENT, onLocalChange);
      aw.off('change', onRemoteChange);
    };
  }, [router]);

  // Tear down on unmount.
  useEffect(() => {
    const p = provider;
    const d = ydoc;
    return () => {
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
  if (pathname.startsWith('/admin/')) return 'Admin';
  return pathname;
}

function buildCollabUrl(): string {
  if (typeof window === 'undefined') return 'ws://localhost/collab';
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/collab`;
}
