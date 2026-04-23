'use client';

// Headers use this to (a) own a local mirror of `sheet` that stays in
// step with peer Yjs awareness broadcasts and (b) debounce-PATCH
// changes back to the server (just like CharacterSheet does).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { HocuspocusProvider } from '@hocuspocus/provider';

export type PatchSheetFn = (partial: Record<string, unknown>) => void;

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

  return { sheet, patchSheet, saving, error };
}
