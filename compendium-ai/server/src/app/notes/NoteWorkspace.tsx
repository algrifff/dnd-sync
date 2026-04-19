'use client';

// Owns the Y.Doc + HocuspocusProvider for a note page and renders the
// Notion-style stack: title (Y.Text) → tags (REST) → body (Y.XmlFragment
// 'default'). Hoisting the provider here means all three views share
// one websocket connection and one CRDT identity.

import { useEffect, useMemo, useState } from 'react';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { TitleEditor } from './TitleEditor';
import { TagEditor } from './TagEditor';
import { NoteSurface, type SurfaceUser } from './NoteSurface';
import { PointerOverlay } from './PointerOverlay';

export function NoteWorkspace({
  path,
  initialContent,
  initialTags,
  user,
  canEdit,
  csrfToken,
}: {
  path: string;
  initialContent: { type: string } & Record<string, unknown>;
  initialTags: string[];
  user: SurfaceUser;
  canEdit: boolean;
  csrfToken: string;
}): React.JSX.Element {
  const ydoc = useMemo(() => new Y.Doc(), [path]);
  const provider = useMemo(
    () =>
      new HocuspocusProvider({
        url: buildCollabUrl(),
        name: path,
        document: ydoc,
      }),
    [path, ydoc],
  );

  const [connected, setConnected] = useState<'connecting' | 'connected' | 'disconnected'>(
    'connecting',
  );
  const [authFailed, setAuthFailed] = useState<boolean>(false);

  useEffect(() => {
    const onStatus = ({ status }: { status: 'connected' | 'disconnected' | 'connecting' }) => {
      setConnected(status);
    };
    const onAuthFail = () => setAuthFailed(true);
    provider.on('status', onStatus);
    provider.on('authenticationFailed', onAuthFail);
    return () => {
      provider.off('status', onStatus);
      provider.off('authenticationFailed', onAuthFail);
    };
  }, [provider]);

  useEffect(() => {
    const p = provider;
    const d = ydoc;
    return () => {
      p.destroy();
      d.destroy();
    };
  }, [provider, ydoc]);

  return (
    <div className="relative">
      <div className="absolute right-0 top-0">
        <StatusDot state={authFailed ? 'error' : connected} />
      </div>

      <TitleEditor ydoc={ydoc} />

      <div className="mt-2">
        <TagEditor
          path={path}
          initialTags={initialTags}
          csrfToken={csrfToken}
          canEdit={canEdit}
        />
      </div>

      <NoteSurface
        path={path}
        ydoc={ydoc}
        provider={provider}
        initialContent={initialContent}
        user={user}
        canEdit={canEdit}
        csrfToken={csrfToken}
      />

      <PointerOverlay
        provider={provider}
        user={{
          userId: user.userId,
          name: user.displayName || 'Anonymous',
          color: user.accentColor,
        }}
      />

      {authFailed && (
        <p className="mt-4 rounded-[8px] border border-[#8B4A52]/40 bg-[#8B4A52]/10 px-3 py-2 text-sm text-[#8B4A52]">
          Live collaboration couldn&apos;t authenticate. Sign out and back
          in, then refresh.
        </p>
      )}
    </div>
  );
}

function StatusDot({
  state,
}: {
  state: 'connecting' | 'connected' | 'disconnected' | 'error';
}): React.JSX.Element {
  const map = {
    connecting: { color: '#D4A85A', title: 'Connecting live sync…' },
    connected: { color: '#7B8A5F', title: 'Live' },
    disconnected: { color: '#8B4A52', title: 'Disconnected — reconnecting…' },
    error: { color: '#8B4A52', title: 'Auth failed' },
  } as const;
  const { color, title } = map[state];
  return (
    <span
      title={title}
      aria-label={title}
      className="inline-block h-2.5 w-2.5 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}

function buildCollabUrl(): string {
  if (typeof window === 'undefined') return 'ws://localhost/collab';
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/collab`;
}
