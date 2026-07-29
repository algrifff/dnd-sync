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

import { useEffect, useRef, useState } from 'react';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type * as Y from 'yjs';
import {
  acquireProvider,
  releaseProvider,
  onDocumentReset,
  RESET_REACQUIRE_DELAY_MS,
} from './provider-cache';
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
  groupId,
  user,
  canEdit,
  csrfToken,
  character,
  accentColor,
  initialTitle = '',
  lockedTitle,
}: {
  path: string;
  /** Current world/campaign id — `session.currentGroupId` from the
   *  server page, threaded down as a prop (never refetched client-side).
   *  Qualifies the Hocuspocus document name as `${groupId}:${path}` so
   *  two worlds sharing an identical note path never collide on the
   *  same Y.Doc. See `@/app/notes/provider-cache`. */
  groupId: string;
  user: SurfaceUser;
  canEdit: boolean;
  csrfToken: string;
  character: CharacterProp | null;
  /** Per-world accent colour (groups.header_color); falls back to a
   *  parchment-friendly default in the sheet header. */
  accentColor: string | null;
  /** Initial title from the DB. Used to seed TitleEditor so it doesn't
   *  flash empty during Hocuspocus sync. */
  initialTitle?: string;
  /** When set, the title input is read-only and shows this fixed
   *  string. Used for folder index notes (canonical subfolders +
   *  campaign roots) — those are renamed from the sidebar menu. */
  lockedTitle?: string;
}): React.JSX.Element {
  // Provider + Y.Doc come from the shared module cache. They live as
  // long as the tab is open (or the idle grace window after release),
  // so tab switches between open notes don't replay the WS handshake.
  // `path`/`groupId` are effectively static for a given NoteWorkspace
  // instance — Next.js remounts the whole component on route change —
  // so a single acquire on mount pairs with a single release on
  // unmount.
  const [handle, setHandle] = useState<{ provider: HocuspocusProvider; ydoc: Y.Doc } | null>(() =>
    acquireProvider(groupId, path),
  );
  // Remount key: bumped whenever the server evicts this document
  // (provider-cache#onDocumentReset — e.g. an AI tool rewrote the
  // note body). Passed as `key` to <NoteSurface> below so Tiptap's
  // Collaboration extension binds to a clean Y.Doc from scratch
  // instead of trying to rebind pieces of its internal state to the
  // replacement one.
  const [epoch, setEpoch] = useState(0);
  // Pending re-acquire timer, set while `handle` is null after a reset.
  // See the effect below for why this delay exists.
  const reacquireTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Server-initiated resets: drop the (already-destroyed) handle
  // immediately so nothing renders against a torn-down provider/ydoc,
  // then wait RESET_REACQUIRE_DELAY_MS before acquiring a fresh one and
  // bumping the epoch so NoteSurface remounts against it.
  //
  // The delay is load-bearing, not cosmetic. `closeDocumentForWrite`
  // (server/src/collab/server.ts) evicts us and then polls up to 500ms
  // for the document to unload before overwriting the note's
  // `yjs_state` in the DB. Hocuspocus's vendored provider reconnects
  // with `initialDelay: 0` — i.e. instantly, not after the 1000ms
  // backoff that only applies to a dropped, previously-established
  // connection — so re-acquiring synchronously here (as this code used
  // to) would reconnect within milliseconds, land before the server's
  // drain finishes, and cause the server to reload the pre-write state
  // into memory. The next local keystroke would then persist that
  // stale doc, silently reverting whatever the server just wrote. See
  // `RESET_REACQUIRE_DELAY_MS` in provider-cache.ts for the full
  // writeup — do not shorten this delay without re-reading it.
  useEffect(() => {
    // The reset listener receives the QUALIFIED name (see
    // provider-cache.ts#ResetListener) — compare against our own
    // qualified name, not the bare path, or resets silently stop
    // matching for this component.
    const qualifiedName = `${groupId}:${path}`;
    const unsubscribe = onDocumentReset((resetName) => {
      if (resetName !== qualifiedName) return;
      if (reacquireTimerRef.current) clearTimeout(reacquireTimerRef.current);
      setHandle(null);
      reacquireTimerRef.current = setTimeout(() => {
        reacquireTimerRef.current = null;
        setHandle(acquireProvider(groupId, path));
        setEpoch((n) => n + 1);
      }, RESET_REACQUIRE_DELAY_MS);
    });
    return () => {
      unsubscribe();
      if (reacquireTimerRef.current) {
        clearTimeout(reacquireTimerRef.current);
        reacquireTimerRef.current = null;
      }
    };
  }, [groupId, path]);

  // Release on unmount / path (or groupId) change only — deliberately
  // NOT keyed on `epoch`. `groupId` is effectively as static as `path`
  // here (both come from the same server-rendered page and only change
  // via a full remount), so adding it to the dependency array doesn't
  // change the reasoning below, only what's captured for the qualified
  // name. Every reset's acquireProvider() call above always lands
  // on a fresh cache entry (the previous one is already gone, torn
  // down by evict()), so at any instant there is exactly one live
  // acquire for `path` that needs exactly one matching release. If
  // this cleanup were also keyed on `epoch`, it would fire right after
  // a reset's acquire — since evict()+re-acquire both run synchronously
  // before this effect's cleanup is invoked, that cleanup would target
  // the entry we JUST acquired (not the discarded one) and immediately
  // decrement its refCount back to 0, undercounting an active viewer.
  //
  // The delayed re-acquire above (RESET_REACQUIRE_DELAY_MS) adds a third
  // state to the "exactly one" reasoning: for the gap between a reset
  // and its delayed re-acquire, there are ZERO live acquires for `path`
  // — `handle` is null and the cache has no entry. If unmount happens
  // during that gap, this cleanup's `releaseProvider(path)` finds
  // nothing in the cache and no-ops (see its `if (!entry) return`
  // guard) rather than decrementing anything, so the invariant holds:
  // one acquire → one release, or zero of each, never a mismatch.
  useEffect(() => {
    const capturedGroupId = groupId;
    const capturedPath = path;
    return () => {
      releaseProvider(capturedGroupId, capturedPath);
    };
  }, [groupId, path]);

  // `handle` is null only in the RESET_REACQUIRE_DELAY_MS gap after a
  // server-initiated reset (see the effect above) — every other read
  // of `provider`/`ydoc` below must tolerate that. The initial value
  // from `acquireProvider(path)` at mount is never null, so the lazy
  // initializer below is safe.
  const provider = handle?.provider ?? null;
  const ydoc = handle?.ydoc ?? null;

  // On cache-hit the provider is usually already synced, so seed from
  // `synced` to avoid flashing the "connecting…" dot. Subsequent
  // status events keep us honest if the connection drops.
  const [connected, setConnected] = useState<'connecting' | 'connected' | 'disconnected'>(
    () => (handle?.provider.synced ? 'connected' : 'connecting'),
  );
  const [authFailed, setAuthFailed] = useState<boolean>(false);

  useEffect(() => {
    if (!provider) {
      // Mid-reset: no provider to listen on. Reflect that as
      // "disconnected" rather than leaving a stale 'connected' dot up.
      setConnected('disconnected');
      return;
    }
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

  // Mid-reset: `provider`/`ydoc` are null for the RESET_REACQUIRE_DELAY_MS
  // gap. Only <NoteSurface> (plus the pointer/drawing overlays, which
  // ride the same live provider) get swapped for a "Reconnecting…"
  // placeholder below — the header (SheetHeader/TitleEditor) and
  // CharacterSheet stay MOUNTED across the gap.
  //
  // This matters because SheetHeader → usePatchSheet and CharacterSheet
  // hold their own local `sheet` state seeded once from `character.sheet`
  // (a page-load snapshot). If those components unmounted here like
  // NoteSurface does, remounting after the gap would re-seed from that
  // stale snapshot — discarding the user's own patches, peer `sheetEdit`
  // awareness merges, and any `sheetMeta` re-fetch that happened before
  // the reset, with nothing to re-fetch it afterwards (the `sheetMeta`
  // observer only reacts to a NEW bump, not a remount). A player would
  // see their own HP revert and stay wrong for the rest of the session.
  // Keeping these mounted with a nullable provider (which usePatchSheet
  // and CharacterSheet's awareness calls already tolerate) avoids that
  // entirely — the sheet's local state simply survives the gap untouched.
  //
  // NoteSurface/PointerOverlay/DrawingOverlay don't have an equivalent
  // stale-snapshot problem (Tiptap's Collaboration extension needs to
  // rebind to a clean Y.Doc via the `key={epoch}` remount, and the
  // overlays hold no state that isn't re-derived fresh from the Y.Doc on
  // mount), so swapping them for a placeholder is safe and remains the
  // simplest way to guarantee nothing renders against a destroyed
  // provider/ydoc.
  //
  // The `!provider || !ydoc` check below is inlined (rather than hoisted
  // to a named boolean) deliberately — TypeScript's control-flow
  // narrowing only follows the literal expression, so inlining it lets
  // the `else` branch narrow `provider`/`ydoc` to their non-null types
  // for NoteSurface/PointerOverlay/DrawingOverlay without a cast.

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
          <TitleEditor
            ydoc={ydoc}
            initialTitle={initialTitle}
            {...(lockedTitle !== undefined ? { lockedTitle } : {})}
          />
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

      {!provider || !ydoc ? (
        <div
          role="status"
          aria-live="polite"
          className="mt-4 flex h-40 items-center justify-center rounded-[8px] border border-[var(--rule)] bg-[var(--parchment-sunk)] text-sm text-[var(--ink-muted)]"
        >
          Reconnecting…
        </div>
      ) : (
        <>
          <NoteSurface
            key={epoch}
            path={path}
            ydoc={ydoc}
            provider={provider}
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
        </>
      )}

      {authFailed && (
        <p className="mt-4 rounded-[8px] border border-[var(--wine)]/40 bg-[var(--wine)]/10 px-3 py-2 text-sm text-[var(--wine)]">
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
    connecting: { color: 'var(--candlelight)', title: 'Connecting live sync…' },
    connected: { color: 'var(--moss)', title: 'Live' },
    disconnected: { color: 'var(--wine)', title: 'Disconnected — reconnecting…' },
    error: { color: 'var(--wine)', title: 'Auth failed' },
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

