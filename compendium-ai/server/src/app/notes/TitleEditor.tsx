'use client';

// Plain input bound to Y.Text('title') on the shared Y.Doc — each
// keystroke broadcasts through the same HocuspocusProvider the body
// uses, so renames are fully collaborative.

import { useEffect, useState } from 'react';
import type * as Y from 'yjs';

export function TitleEditor({
  ydoc,
  placeholder = 'Untitled',
}: {
  ydoc: Y.Doc;
  placeholder?: string;
}): React.JSX.Element {
  const yTitle = ydoc.getText('title');
  const [value, setValue] = useState<string>(() => yTitle.toString());

  useEffect(() => {
    const observer = (): void => {
      const next = yTitle.toString();
      setValue((prev) => (prev === next ? prev : next));
    };
    yTitle.observe(observer);
    return () => yTitle.unobserve(observer);
  }, [yTitle]);

  const onChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const next = e.target.value;
    setValue(next);
    ydoc.transact(() => {
      yTitle.delete(0, yTitle.length);
      yTitle.insert(0, next);
    });
  };

  return (
    <input
      type="text"
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      aria-label="Note title"
      spellCheck
      className="w-full border-0 bg-transparent px-0 py-2 text-4xl font-bold tracking-tight text-[#2A241E] outline-none placeholder:text-[#5A4F42]/40"
      style={{ fontFamily: '"Fraunces", Georgia, serif' }}
    />
  );
}
