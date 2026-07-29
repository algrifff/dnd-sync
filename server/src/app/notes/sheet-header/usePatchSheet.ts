'use client';

// Headers use this to (a) own a local mirror of `sheet` that stays in
// step with peer Yjs awareness broadcasts and (b) debounce-PATCH
// changes back to the server (just like CharacterSheet does).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { HocuspocusProvider } from '@hocuspocus/provider';

export type PatchSheetFn = (partial: Record<string, unknown>) => void;

/** Fetch the note's authoritative `frontmatter.sheet` from the server.
 *  Returns null on any failure (non-2xx, network error, missing/odd
 *  shape) so callers can treat "couldn't reconcile" uniformly without
 *  a try/catch of their own. Shared by two reconcile paths in this
 *  hook: the `sheetMeta` rev-bump observer (server-originated writes,
 *  e.g. AI tools) and `flush`'s rejected-PATCH handler below — both
 *  need the same "go get server truth" fetch, just with different
 *  triggers and different call-time state to preserve on top of it. */
async function fetchNoteSheet(notePath: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(
    `/api/notes/${notePath.split('/').map(encodeURIComponent).join('/')}`,
    { headers: { 'Cache-Control': 'no-store' } },
  );
  if (!res.ok) return null;
  const body = (await res.json()) as { frontmatter?: { sheet?: Record<string, unknown> } };
  const next = body.frontmatter?.sheet;
  return next && typeof next === 'object' ? next : null;
}

export function usePatchSheet(args: {
  notePath: string;
  csrfToken: string;
  provider: HocuspocusProvider | null;
  initialSheet: Record<string, unknown>;
}): {
  sheet: Record<string, unknown>;
  patchSheet: PatchSheetFn;
  saving: boolean;
  error: string | null;
} {
  const { notePath, csrfToken, provider, initialSheet } = args;
  const [sheet, setSheet] = useState<Record<string, unknown>>(initialSheet);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pendingRef = useRef<Record<string, unknown>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflightRef = useRef<Promise<void> | null>(null);
  // Awareness broadcasts are throttled separately from the server
  // PATCH so rapid typing (HP spinner, name field) doesn't spray a
  // new awareness state on every keystroke. 80 ms is short enough
  // that peer mirroring still feels live.
  const awarenessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const awarenessPendingRef = useRef<Record<string, unknown>>({});

  const flush = useCallback(async (): Promise<void> => {
    if (inflightRef.current) await inflightRef.current;
    const batch = pendingRef.current;
    if (Object.keys(batch).length === 0) return;
    pendingRef.current = {};
    setSaving(true);
    const run = (async () => {
      try {
        const res = await fetch('/api/notes/sheet', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ path: notePath, sheet: batch }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          sheet?: Record<string, unknown>;
          error?: string;
          detail?: string;
        };
        if (!res.ok || !body.ok) {
          setError(body.detail ?? body.error ?? `save failed (${res.status})`);
          // The server rejected this batch (validation error, 4xx), but
          // `patchSheet` already applied it optimistically to local
          // state and mirrored it to peers via awareness — left alone,
          // this client and every peer keep displaying a value the
          // database doesn't have, indefinitely, with only the `error`
          // string as a clue. Reconcile against server truth instead of
          // trying to invert the optimistic update: the shallow-merge
          // PATCH contract doesn't preserve enough of the pre-patch
          // state to undo a batch correctly once more than one field or
          // more than one in-flight patch is involved.
          try {
            const next = await fetchNoteSheet(notePath);
            // Merge order mirrors the sheetMeta rev-bump reconcile
            // below: server truth wins, but pendingRef is merged LAST
            // so any field the user has typed since this failed flush
            // started (queued for the *next* flush) isn't stomped by
            // the just-fetched server value.
            if (next) setSheet((prev) => ({ ...prev, ...next, ...pendingRef.current }));
          } catch {
            // Re-fetch itself failed (network/transient). Deliberately
            // not retried here — retrying from inside a failure handler
            // is how you get an unbounded loop if the server or network
            // stays down. The next successful flush, or a peer/AI
            // sheetMeta bump, or a reload will reconcile instead.
          }
          return;
        }
        setError(null);
        if (body.sheet) setSheet(body.sheet);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'network error');
      } finally {
        setSaving(false);
      }
    })();
    inflightRef.current = run;
    await run;
    inflightRef.current = null;
  }, [csrfToken, notePath]);

  const patchSheet = useCallback<PatchSheetFn>(
    (partial) => {
      setSheet((prev) => ({ ...prev, ...partial }));
      Object.assign(pendingRef.current, partial);
      // Accumulate awareness fields in a separate buffer so the
      // throttled broadcast below sends the MOST RECENT value of each
      // field per window, not just whichever one landed last.
      Object.assign(awarenessPendingRef.current, partial);
      const aw = provider?.awareness;
      if (aw && !awarenessTimerRef.current) {
        awarenessTimerRef.current = setTimeout(() => {
          awarenessTimerRef.current = null;
          const fields = awarenessPendingRef.current;
          awarenessPendingRef.current = {};
          if (Object.keys(fields).length === 0) return;
          // Using the `aw` captured when this timer was scheduled (not
          // re-reading `provider` at fire time) is safe: the cleanup
          // effect below clears `awarenessTimerRef` on every `provider`
          // identity change (a server-initiated eviction —
          // provider-cache.ts's `evict`, or NoteWorkspace swapping in a
          // fresh provider on reconnect), so a timer can only ever fire
          // against the same provider it was scheduled under. If that
          // provider was destroyed without a swap (unmount), the
          // unmount effect's own `clearTimeout` covers it. Broadcasting
          // through a stale, destroyed Awareness would be harmless
          // anyway (y-protocols just drops it), but it can't happen.
          aw.setLocalStateField('sheetEdit', {
            path: notePath,
            seq: Date.now(),
            fields,
          });
        }, 80);
      }
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        void flush();
      }, 400);
    },
    [flush, notePath, provider],
  );

  // Listen for peer edits on the same note and merge into local state.
  useEffect(() => {
    const aw = provider?.awareness;
    if (!aw) return;
    const selfClientId = aw.clientID;
    const seen = new Map<number, number>();
    const onChange = (
      changes?: { added: number[]; updated: number[]; removed: number[] },
    ): void => {
      // Skip the whole scan if only our own awareness state changed.
      // Without this, every local broadcast re-fires the observer and
      // setSheet re-runs for every header on screen.
      if (changes) {
        const peerTouched =
          changes.added.some((id) => id !== selfClientId) ||
          changes.updated.some((id) => id !== selfClientId) ||
          changes.removed.some((id) => id !== selfClientId);
        if (!peerTouched) return;
      }
      for (const [clientId, state] of aw.getStates().entries()) {
        if (clientId === selfClientId) continue;
        const s = state as
          | {
              sheetEdit?: {
                path?: string;
                seq?: number;
                fields?: Record<string, unknown>;
              };
            }
          | undefined;
        const edit = s?.sheetEdit;
        if (!edit || edit.path !== notePath || typeof edit.seq !== 'number') {
          continue;
        }
        const last = seen.get(clientId);
        if (last === edit.seq) continue;
        seen.set(clientId, edit.seq);
        if (edit.fields && typeof edit.fields === 'object') {
          setSheet((prev) => ({ ...prev, ...edit.fields! }));
        }
      }
    };
    aw.on('change', onChange);
    return () => aw.off('change', onChange);
  }, [provider, notePath]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (awarenessTimerRef.current) clearTimeout(awarenessTimerRef.current);
      if (Object.keys(pendingRef.current).length > 0) void flush();
    };
  }, [flush]);

  // If `provider` changes identity while this component stays mounted
  // (a server-initiated eviction swaps in a fresh provider — see
  // provider-cache.ts's `evict` / NoteWorkspace's `onDocumentReset`
  // handling), cancel any pending awareness timer instead of letting it
  // fire later against the old, by-then-destroyed provider's awareness.
  // The unmount effect above already covers the case where the
  // component itself goes away; this covers the prop swap case.
  //
  // Deliberately does NOT clear `awarenessPendingRef.current` here.
  // `NoteWorkspace` nulls `provider` for ~1200ms across a reset before
  // swapping in the replacement; fields typed during that gap keep
  // accumulating in the buffer (no timer is scheduled while `aw` is
  // falsy, so nothing fires, but `patchSheet` still buffers them). If
  // this cleanup wiped the buffer, that typing would be silently lost
  // from peer mirroring instead of riding out on the next keystroke's
  // timer once the new provider arrives. The server write path
  // (`pendingRef` / `flush`) is unaffected either way — this buffer is
  // display-only.
  useEffect(() => {
    return () => {
      if (awarenessTimerRef.current) {
        clearTimeout(awarenessTimerRef.current);
        awarenessTimerRef.current = null;
      }
    };
  }, [provider]);

  // Server-originated sheet changes (AI tools writing frontmatter
  // directly) arrive as a revision bump on the note doc's `sheetMeta`
  // map — see collab/server.ts#signalSheetChanged. Awareness can't
  // carry these: it's a client-originated, ephemeral broadcast with no
  // server-side writer. On a bump, re-fetch authoritative frontmatter
  // rather than trying to diff/guess what changed.
  useEffect(() => {
    if (!provider) return;
    const doc = provider.document;
    const meta = doc.getMap('sheetMeta');
    let lastRev = 0;
    let cancelled = false;
    // Whether we've started reacting to `rev` changes yet — see
    // `startObserving` below. Guards against double-`meta.observe` if
    // `synced` fires while we're already observing (shouldn't happen,
    // but keeps the effect idempotent).
    let observing = false;

    const onMeta = (): void => {
      const rev = meta.get('rev');
      if (typeof rev !== 'number' || rev <= lastRev) return;
      lastRev = rev;
      void (async () => {
        try {
          const next = await fetchNoteSheet(notePath);
          if (next && !cancelled) {
            // Server truth wins, but keep any field the user has typed
            // since the last flush (pendingRef) so we don't stomp
            // in-flight local edits that haven't reached the server yet.
            setSheet((prev) => ({ ...prev, ...next, ...pendingRef.current }));
          }
        } catch {
          /* transient — the next bump or a reload will reconcile */
        }
      })();
    };

    // Seed `lastRev` from whatever `rev` is on the doc, but only AFTER
    // the provider has actually synced — not at mount, and not from a
    // hardcoded 0. `rev` persists into `yjs_state` across reconnects/
    // reloads, so on a note that has ever been AI-sheet-edited, the
    // very first `meta.observe` firing on a cold mount is the initial
    // sync itself replaying that persisted value into the (until then
    // empty) local Y.Doc — not a genuine new bump. Seeding at mount
    // (the previous fix) only worked for the warm/cache-hit case where
    // `provider.synced` was already true; on a cold mount `meta` is
    // still empty when this effect runs, `lastRev` fell back to 0, and
    // the persisted `rev` arriving with the sync then looked like a
    // bump — one spurious GET on every cold mount of any note that's
    // ever been AI-sheet-edited.
    //
    // Waiting for `synced` before seeding *and* before attaching the
    // observer closes that gap: nothing reacts to `rev` until the
    // authoritative post-sync value is the baseline, so only bumps
    // that happen after this point are ever treated as new.
    const startObserving = (): void => {
      if (observing) return;
      observing = true;
      const initialRev = meta.get('rev');
      lastRev = typeof initialRev === 'number' ? initialRev : 0;
      meta.observe(onMeta);
    };

    if (provider.synced) {
      startObserving();
    } else {
      provider.on('synced', startObserving);
    }

    return () => {
      cancelled = true;
      provider.off('synced', startObserving);
      if (observing) meta.unobserve(onMeta);
    };
  }, [provider, notePath]);

  return { sheet, patchSheet, saving, error };
}
