'use client';

// "+" button in the "Links to" section of the note sidebar. Opens a note
// picker; on selection it POSTs to /api/notes/backlink with the current note
// as fromPath and the selected note as toPath — i.e. the current note
// gets a manual outgoing edge to the chosen note.
// router.refresh() re-runs the server component to show the new entry.

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { NotePicker } from './NotePicker';

export function AddOutgoingLink({
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
    setPicker({ left: rect.right + 6, top: rect.top });
  }, []);

  const close = useCallback((): void => setPicker(null), []);

  const onSelect = useCallback(
    (path: string): void => {
      close();
      setLoading(true);
      void fetch('/api/notes/backlink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        // fromPath = current note (it's the one linking out)
        // toPath   = selected note (the destination)
        body: JSON.stringify({ fromPath: currentPath, toPath: path }),
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
        title="Add a note this note links to"
        aria-label="Add a note this note links to"
        className="rounded-[4px] p-0.5 text-[#5A4F42] transition hover:bg-[#2A241E]/10 hover:text-[#2A241E] disabled:opacity-40"
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
