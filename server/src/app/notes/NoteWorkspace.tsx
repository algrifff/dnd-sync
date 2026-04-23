'use client';

// Owns the Y.Doc + HocuspocusProvider for a note page and renders the
// Notion-style stack: title (Y.Text) → tags (REST) → body (Y.XmlFragment
// 'default'). Hoisting the provider here means all three views share
// one websocket connection and one CRDT identity.
//
// The provider is fetched from a module-level cache (`provider-cache`)
// so switching between two already-open tabs reuses the existing WS
// connection and synced Y.Doc, instead of tearing both down on every
// route change. See that file for the lifecycle contract.

import { useEffect, useState } from 'react';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type * as Y from 'yjs';
import { acquireProvider, releaseProvider } from './provider-cache';
import { TitleEditor } from './TitleEditor';
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
  user,
  canEdit,
  csrfToken,
  character,
  accentColor,
}: {
  path: string;
  initialContent: { type: string } & Record<string, unknown>;
  user: SurfaceUser;
  canEdit: boolean;
  csrfToken: string;
  character: CharacterProp | null;
  /** Per-world accent colour (groups.header_color); falls back to a
   *  parchment-friendly default in the sheet header. */
  accentColor: string | null;
}): React.JSX.Element {
  // Provider + Y.Doc come from the shared module cache. They live as
  // long as the tab is open (or the idle grace window after release),
  // so tab switches between open notes don't replay the WS handshake.
  // `path` is effectively static for a given NoteWorkspace instance —
  // Next.js remounts the whole component on route change — so a single
  // acquire on mount pairs with a single release on unmount.
  const [handle] = useState<{ provider: HocuspocusProvider; ydoc: Y.Doc }>(() =>
    acquireProvider(path),
  );
  // Release on unmount. `path` is captured at mount time and never
  // changes for the life of this component (route change → remount),
  // so pairing with the mount-time acquire is safe.
  useEffect(() => {
    const capturedPath = path;
    return () => {
      releaseProvider(capturedPath);
    };
  }, [path]);

  const { provider, ydoc } = handle;

  // On cache-hit the provider is usually already synced, so seed from
  // `synced` to avoid flashing the "connecting…" dot. Subsequent
  // status events keep us honest if the connection drops.
  const [connected, setConnected] = useState<'connecting' | 'connected' | 'disconnected'>(
    () => (provider.synced ? 'connected' : 'connecting'),
  );
  const [authFailed, setAuthFailed] = useState<boolean>(false);

  useEffect(() => {
    const onStatus = ({ status }: { status: 'connected' | 'disconnected' | 'connecting' }) => {
      setConnected(status);
    };
    const onAuthFail = () => setAuthFailed(true);
    provider.on('status', onStatus);
    provider.on('authenticationFailed', onAuthFail);
    if (provider.synced) setConnected('connected');
    return () => {
      provider.off('status', onStatus);
      provider.off('authenticationFailed', onAuthFail);
    };
  }, [provider]);

  const showSheetHeader = !!character && !!normalizeKind(character.rawKind);

  return (
    <div className="relative">
      <div className="absolute right-0 top-0">
        <StatusDot state={authFailed ? 'error' : connected} />
      </div>

      {/* ── Note header ─────────────────────────────────────────── */}
      {showSheetHeader && character ? (
        <SheetHeader
          rawKind={character.rawKind}
          initialSheet={character.sheet}
          notePath={path}
          csrfToken={csrfToken}
          provider={provider}
          canEdit={character.canWriteAll}
          displayName={character.displayName}
          accentColor={accentColor}
        />
      ) : (
        <div className="mb-4">
          <TitleEditor ydoc={ydoc} />
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

