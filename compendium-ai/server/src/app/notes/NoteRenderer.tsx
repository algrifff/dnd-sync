'use client';

// Mounts Tiptap in read-only mode against a stored ProseMirror JSON.
// Phase 4 will add the Collaboration extension so remote updates stream
// into the same surface; for now this component only renders.
//
// A tiny click handler intercepts wikilink anchors to use the Next.js
// router (no full-page nav) while letting other links behave normally.

import { useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { EditorContent, useEditor } from '@tiptap/react';
import { BASE_EXTENSIONS } from '@/lib/pm-schema';

type ContentJson = { type: string; content?: unknown[] };

export function NoteRenderer({ content }: { content: ContentJson }): React.JSX.Element {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);

  // `useEditor` needs a stable extension list identity, and the content
  // reference only needs to update when the note changes.
  const extensions = useMemo(() => BASE_EXTENSIONS, []);

  const editor = useEditor(
    {
      extensions,
      content: content as object,
      editable: false,
      immediatelyRender: false, // avoid SSR hydration mismatch
    },
    [content],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onClick = (evt: MouseEvent): void => {
      const target = evt.target as HTMLElement | null;
      const link = target?.closest('a.wikilink') as HTMLAnchorElement | null;
      if (!link) return;
      // Modifier keys / middle-click → let the browser do its thing.
      if (evt.metaKey || evt.ctrlKey || evt.shiftKey || evt.button !== 0) return;
      const href = link.getAttribute('href');
      if (!href || !href.startsWith('/notes/')) return;
      evt.preventDefault();
      router.push(href);
    };

    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [router]);

  return (
    <article
      ref={containerRef}
      className="note-surface prose-parchment"
      aria-label="Note content"
    >
      <EditorContent editor={editor} />
    </article>
  );
}
