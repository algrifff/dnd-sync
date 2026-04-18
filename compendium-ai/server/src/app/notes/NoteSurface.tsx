'use client';

// Notion-style always-editable note surface. Collaboration is always
// mounted; CollaborationCaret is mounted when the user has edit
// rights (role != viewer). Viewers see the surface read-only; everyone
// else types straight into it. No mode switch.
//
// The HocuspocusProvider connects to ws://host/collab with the session
// cookie (automatic — same origin). The server auth hook accepts the
// connection if the cookie is valid; otherwise it 401s and the
// provider retries with exponential backoff.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EditorContent, useEditor } from '@tiptap/react';
import { Collaboration } from '@tiptap/extension-collaboration';
import { CollaborationCaret } from '@tiptap/extension-collaboration-caret';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { BASE_EXTENSIONS } from '@/lib/pm-schema';

export type SurfaceUser = {
  displayName: string;
  accentColor: string;
};

export function NoteSurface({
  path,
  initialContent,
  user,
  canEdit = true,
}: {
  path: string;
  initialContent: { type: string } & Record<string, unknown>;
  user: SurfaceUser;
  canEdit?: boolean;
}): React.JSX.Element {
  const router = useRouter();

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

  const extensions = useMemo(() => {
    const exts = [
      ...BASE_EXTENSIONS,
      Collaboration.configure({
        document: ydoc,
        field: 'default',
      }),
    ];
    if (canEdit) {
      exts.push(
        CollaborationCaret.configure({
          provider,
          user: {
            name: user.displayName || 'Anonymous',
            color: user.accentColor,
          },
        }),
      );
    }
    return exts;
  }, [ydoc, provider, canEdit, user.displayName, user.accentColor]);

  const editor = useEditor(
    {
      extensions,
      // content is used only if the Y.Doc is empty — Collaboration takes
      // over after the server sync. This gives us an instant first
      // paint without waiting for the websocket to land.
      content: initialContent as object,
      editable: canEdit,
      immediatelyRender: false,
    },
    [path, ydoc, provider, canEdit],
  );

  // Wikilink click → client navigation.
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onClick = (evt: MouseEvent): void => {
      const target = evt.target as HTMLElement | null;
      const link = target?.closest('a.wikilink') as HTMLAnchorElement | null;
      if (!link) return;
      if (evt.metaKey || evt.ctrlKey || evt.shiftKey || evt.button !== 0) return;
      const href = link.getAttribute('href');
      if (!href || !href.startsWith('/notes/')) return;
      evt.preventDefault();
      router.push(href);
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [router]);

  return (
    <div className="relative">
      <div className="absolute right-0 top-0">
        <StatusDot state={authFailed ? 'error' : connected} />
      </div>

      <article
        ref={containerRef}
        className="note-surface prose-parchment mt-6"
        aria-label="Note content"
      >
        <EditorContent editor={editor} />
      </article>

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
