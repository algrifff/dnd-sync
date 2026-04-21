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
      const aw = provider?.awareness;
      if (aw) {
        aw.setLocalStateField('sheetEdit', {
          path: notePath,
          seq: Date.now(),
          fields: { ...partial },
        });
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
    const seen = new Map<number, number>();
    const onChange = (): void => {
      for (const [clientId, state] of aw.getStates().entries()) {
        if (clientId === aw.clientID) continue;
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
      if (Object.keys(pendingRef.current).length > 0) void flush();
    };
  }, [flush]);

  return { sheet, patchSheet, saving, error };
}
