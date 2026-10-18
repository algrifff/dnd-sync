'use client';

// "Add connection" button at the top of the Connections panel. Opens the
// note picker with a type <select> above its search box: "just linked"
// (a plain link) or any Relationship type / inverse, read from this
// Note's side. Picking a Note POSTs /api/notes/relations, then
// router.refresh() shows the new row.

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { NotePicker } from './NotePicker';
import { connectionOptions } from './connections';

const OPTIONS = connectionOptions();

export function AddConnection({
  currentPath,
  csrfToken,
}: {
  currentPath: string;
  csrfToken: string;
}): React.JSX.Element {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [picker, setPicker] = useState<{ left: number; top: number } | null>(null);
  const [relation, setRelation] = useState<string>('link');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const open = useCallback((): void => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    // The sidebar is on the right edge: grow the popover down and to the left.
    setPicker({ left: rect.right - 320, top: rect.bottom + 6 });
  }, []);

  const close = useCallback((): void => setPicker(null), []);

  const onSelect = useCallback(
    (otherPath: string): void => {
      close();
      setLoading(true);
      setError(null);
      void fetch('/api/notes/relations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ path: currentPath, relation, otherPath }),
      })
        .then(async (res) => {
          if (res.ok) return;
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(
            res.status === 403
              ? 'You can only connect notes you can edit.'
              : `Could not add the connection (${body.error ?? res.status}).`,
          );
        })
        .catch(() => setError('Could not add the connection.'))
        .finally(() => {
          setLoading(false);
          router.refresh();
        });
    },
    [close, csrfToken, currentPath, relation, router],
  );

  return (
    <div className="flex flex-col items-end">
      <button
        ref={btnRef}
        type="button"
        onClick={open}
        disabled={loading}
        className="flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-xs text-[var(--ink-soft)] transition hover:bg-[var(--ink)]/10 hover:text-[var(--ink)] disabled:opacity-40"
      >
        <Plus size={12} aria-hidden />
        Add connection
      </button>
      {error && (
        <p role="alert" className="mt-1 max-w-[180px] text-right text-[11px] text-[var(--wine)]">
          {error}
        </p>
      )}
      {picker && (
        <NotePicker
          anchor={picker}
          onSelect={onSelect}
          onClose={close}
          excludePath={currentPath}
          header={
            <label className="flex items-center gap-2 border-b border-[var(--rule)] px-2 py-1.5 text-xs text-[var(--ink-soft)]">
              Type
              <select
                value={relation}
                onChange={(e) => setRelation(e.target.value)}
                className="min-w-0 flex-1 rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-1.5 py-1 text-xs text-[var(--ink)]"
              >
                {OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          }
        />
      )}
    </div>
  );
}
