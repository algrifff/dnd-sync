'use client';

// Plain input bound to Y.Text('title') on the shared Y.Doc — each
// keystroke broadcasts through the same HocuspocusProvider the body
// uses, so renames are fully collaborative.
//
// Folder index notes (canonical subfolders + campaign roots) render
// the title as read-only via `lockedTitle`; their renames are
// initiated from the sidebar "..." menu so the URL doesn't shift
// under the user while they're typing.

import { useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { broadcastTreeChange } from '@/lib/tree-sync';

// Hocuspocus debounces its store at ~2 s; we wait 2.5 s so the DB
// write has landed before the sidebar refresh fires.
const TREE_REFRESH_DELAY_MS = 2500;

export function TitleEditor({
  ydoc,
  placeholder = 'Untitled',
  initialTitle = '',
  lockedTitle,
}: {
  ydoc: Y.Doc;
  placeholder?: string;
  /** Initial title from the DB. Used to seed the input so it never
   *  flashes empty while Hocuspocus is mid-sync, and as a fallback
   *  for legacy notes whose yjs_state was persisted before the title
   *  sidecar was introduced. */
  initialTitle?: string;
  /** When set, the input is read-only and shows this fixed string
   *  instead of the Y.Text title. Used for folder index notes
   *  (canonical subfolders and campaign roots). */
  lockedTitle?: string;
}): React.JSX.Element {
  const yTitle = ydoc.getText('title');
  const [value, setValue] = useState<string>(
    () => yTitle.toString() || initialTitle,
  );
  const treeRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const observer = (): void => {
      const next = yTitle.toString() || initialTitle;
      setValue((prev) => (prev === next ? prev : next));
    };
    yTitle.observe(observer);
    // Pull the current value once after subscribing — if Hocuspocus
    // synced between mount and effect (or the provider was a cache
    // hit and already had content), the observer would never fire on
    // its own and the input would be stuck at the server-seeded value.
    observer();
    return () => yTitle.unobserve(observer);
  }, [yTitle, initialTitle]);

  useEffect(() => {
    return () => {
      if (treeRefreshTimer.current !== null) clearTimeout(treeRefreshTimer.current);
    };
  }, []);

  const onChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const next = e.target.value;
    setValue(next);
    ydoc.transact(() => {
      yTitle.delete(0, yTitle.length);
      yTitle.insert(0, next);
    });
    if (treeRefreshTimer.current !== null) clearTimeout(treeRefreshTimer.current);
    treeRefreshTimer.current = setTimeout(() => {
      broadcastTreeChange();
    }, TREE_REFRESH_DELAY_MS);
  };

  if (lockedTitle) {
    return (
      <input
        type="text"
        value={lockedTitle}
        readOnly
        aria-label="Note title (locked)"
        title="Rename this folder from the sidebar."
        className="w-full cursor-not-allowed border-0 bg-transparent px-0 py-3 text-4xl font-bold leading-[1.3] tracking-tight text-[var(--ink)] outline-none"
        style={{ fontFamily: '"Fraunces", Georgia, serif' }}
      />
    );
  }

  return (
    <input
      type="text"
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      aria-label="Note title"
      spellCheck
      className="w-full border-0 bg-transparent px-0 py-3 text-4xl font-bold leading-[1.3] tracking-tight text-[var(--ink)] outline-none placeholder:text-[var(--ink-soft)]/40"
      style={{ fontFamily: '"Fraunces", Georgia, serif' }}
    />
  );
}
