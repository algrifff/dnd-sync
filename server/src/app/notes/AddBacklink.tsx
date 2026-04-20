'use client';

// "+" button in the Backlinks section of the note sidebar. Opens a
// note picker; on selection, dispatches a DOM custom event that
// NoteSurface listens for and inserts a wikilink at the editor's
// caret. That decoupling keeps the server-component sidebar free of
// direct editor refs.

import { useCallback, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { NotePicker } from './NotePicker';

export const INSERT_WIKILINK_EVENT = 'compendium:insert-wikilink';

export type InsertWikilinkDetail = {
  target: string;
  label?: string;
};

export function AddBacklink({ currentPath }: { currentPath: string }): React.JSX.Element {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [picker, setPicker] = useState<{ left: number; top: number } | null>(null);

  const open = useCallback(() => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPicker({ left: rect.right + 6, top: rect.top });
  }, []);
  const close = useCallback(() => setPicker(null), []);

  const onSelect = useCallback(
    (path: string) => {
      const target = path.replace(/\.(md|canvas)$/i, '');
      document.dispatchEvent(
        new CustomEvent<InsertWikilinkDetail>(INSERT_WIKILINK_EVENT, {
          detail: { target },
        }),
      );
      close();
    },
    [close],
  );

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={open}
        title="Link to another note"
        aria-label="Link to another note"
        className="rounded-[4px] p-0.5 text-[#5A4F42] transition hover:bg-[#2A241E]/10 hover:text-[#2A241E]"
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
