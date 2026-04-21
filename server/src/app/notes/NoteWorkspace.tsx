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
import { DrawingOverlay } from './DrawingOverlay';
import { CharacterSheet } from './CharacterSheet';
import { SheetHeader } from './sheet-header/SheetHeader';
import { normalizeKind } from './sheet-header/util';
import type { NoteTemplate } from '@/lib/templates';

export type CharacterProp = {
  roleLabel: string;
  template: NoteTemplate;
  sheet: Record<string, unknown>;
  displayName: string;
  portraitUrl: string | null;
  canWriteAll: boolean;
  /** Original frontmatter kind string (canonical or legacy) — used
   *  to pick the right SheetHeader variant. */
  rawKind: string | undefined;
};

export function NoteWorkspace({
  path,
  initialContent,
  initialTags,
  user,
  canEdit,
  csrfToken,
  creator,
  createdAt,
  character,
}: {
  path: string;
  initialContent: { type: string } & Record<string, unknown>;
  initialTags: string[];
  user: SurfaceUser;
  canEdit: boolean;
  csrfToken: string;
  creator: { displayName: string; username: string } | null;
  createdAt: number;
  character: CharacterProp | null;
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

  const showSheetHeader = !!character && !!normalizeKind(character.rawKind);

  return (
    <div className="relative">
      <div className="absolute right-0 top-0">
        <StatusDot state={authFailed ? 'error' : connected} />
      </div>

      {/* ── Note header ─────────────────────────────────────────── */}
      {showSheetHeader && character ? (
        <>
          <SheetHeader
            rawKind={character.rawKind}
            initialSheet={character.sheet}
            notePath={path}
            csrfToken={csrfToken}
            provider={provider}
            canEdit={character.canWriteAll}
            displayName={character.displayName}
          />
          <div className="mb-4">
            {creator && createdAt > 0 && (
              <p className="mb-2 text-[11px] text-[#5A4F42]">
                Created by{' '}
                <span className="font-medium text-[#2A241E]">
                  {creator.displayName || creator.username}
                </span>{' '}
                · {formatCreatedAt(createdAt)}
              </p>
            )}
            <TagEditor path={path} initialTags={initialTags} csrfToken={csrfToken} canEdit={canEdit} />
          </div>
        </>
      ) : (
        <div className="mb-4">
          <TitleEditor ydoc={ydoc} />
          {creator && createdAt > 0 && (
            <p className="mt-1 text-xs text-[#5A4F42]">
              Created by{' '}
              <span className="font-medium text-[#2A241E]">
                {creator.displayName || creator.username}
              </span>{' '}
              · {formatCreatedAt(createdAt)}
            </p>
          )}
          <div className="mt-2">
            <TagEditor path={path} initialTags={initialTags} csrfToken={csrfToken} canEdit={canEdit} />
          </div>
        </div>
      )}

      {/* Only character kinds get the side-panel form; person / creature /
       *  item / location are header-inline-editable only this pass. */}
      {character && normalizeKind(character.rawKind) === 'character' && (
        <div className="mt-4">
          <CharacterSheet
            path={path}
            csrfToken={csrfToken}
            template={character.template}
            initialSheet={character.sheet}
            canWriteAll={character.canWriteAll}
            provider={provider}
          />
        </div>
      )}

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
          cursorMode: user.cursorMode,
          avatarVersion: user.avatarVersion,
        }}
        coordScopeId="note-scroll-body"
        viewportScopeId="note-main"
        virtualWidth={1600}
      />

      <DrawingOverlay provider={provider} user={{ userId: user.userId }} />

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

function formatCreatedAt(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function buildCollabUrl(): string {
  if (typeof window === 'undefined') return 'ws://localhost/collab';
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/collab`;
}

