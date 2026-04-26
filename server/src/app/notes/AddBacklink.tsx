'use client';

// "+" button in the Backlinks section of the note sidebar. Opens a note
// picker; on selection it POSTs to /api/notes/backlink which appends a
// [[wikilink]] to the *selected* note pointing at the current note — so
// the selected note appears in the current note's backlinks list.
// router.refresh() re-runs the server component to show the new entry.

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { NotePicker } from './NotePicker';

export function AddBacklink({
  currentPath,
  csrfToken,
}: {
  currentPath: string;
  csrfToken: string;
}): React.JSX.Element {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [picker, setPicker] = useState<{ left: number; top: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const open = useCallback((): void => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Sidebar lives on the right edge — anchor the popover so it grows
    // down-and-left into the main content area (not rightward, off-screen).
    // NotePicker still clamps to viewport as a final safety net.
    const POPOVER_W = 320;
    setPicker({ left: rect.right - POPOVER_W, top: rect.bottom + 6 });
  }, []);

  const close = useCallback((): void => setPicker(null), []);

  const onSelect = useCallback(
    (path: string): void => {
      close();
      setLoading(true);
      void fetch('/api/notes/backlink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ fromPath: path, toPath: currentPath }),
      }).finally(() => {
        setLoading(false);
        router.refresh();
      });
    },
    [close, csrfToken, currentPath, router],
  );

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={open}
        disabled={loading}
        title="Add a note that links here"
        aria-label="Add a note that links here"
        className="rounded-[4px] p-0.5 text-[var(--ink-soft)] transition hover:bg-[var(--ink)]/10 hover:text-[var(--ink)] disabled:opacity-40"
      >
        <Plus size={12} aria-hidden />
      </button>
      {picker && (
        <NotePicker
          anchor={picker}
          onSelect={onSelect}
          onClose={close}
          excludePath={currentPath}
        />
      )}
    </>
  );
}
