'use client';

// Plain input bound to Y.Text('title') on the shared Y.Doc — each
// keystroke broadcasts through the same HocuspocusProvider the body
// uses, so renames are fully collaborative.

import { useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { broadcastTreeChange } from '@/lib/tree-sync';

// Hocuspocus debounces its store at ~2 s; we wait 2.5 s so the DB
// write has landed before the sidebar refresh fires.
const TREE_REFRESH_DELAY_MS = 2500;

export function TitleEditor({
  ydoc,
  placeholder = 'Untitled',
}: {
  ydoc: Y.Doc;
  placeholder?: string;
}): React.JSX.Element {
  const yTitle = ydoc.getText('title');
  const [value, setValue] = useState<string>(() => yTitle.toString());
  const treeRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const observer = (): void => {
      const next = yTitle.toString();
      setValue((prev) => (prev === next ? prev : next));
    };
    yTitle.observe(observer);
    return () => yTitle.unobserve(observer);
  }, [yTitle]);

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
