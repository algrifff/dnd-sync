'use client';

// Notion-style always-editable body surface. Receives the shared
// Y.Doc + HocuspocusProvider from NoteWorkspace so title / tags / body
// all live on one CRDT document and one websocket. CollaborationCaret
// is mounted when the user has edit rights (role != viewer). Viewers
// see the surface read-only; everyone else types straight into it.

import { useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { EditorContent, useEditor } from '@tiptap/react';
import { Collaboration } from '@tiptap/extension-collaboration';
import { CollaborationCaret } from '@tiptap/extension-collaboration-caret';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type * as Y from 'yjs';
import { BASE_EXTENSIONS } from '@/lib/pm-schema';
import { SlashMenu } from './SlashMenu';
import { TableToolbar } from './TableToolbar';

export type SurfaceUser = {
  displayName: string;
  accentColor: string;
};

export function NoteSurface({
  path,
  ydoc,
  provider,
  initialContent,
  user,
  canEdit = true,
}: {
  path: string;
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  initialContent: { type: string } & Record<string, unknown>;
  user: SurfaceUser;
  canEdit?: boolean;
}): React.JSX.Element {
  const router = useRouter();

  const extensions = useMemo(() => {
    const exts = [
      ...BASE_EXTENSIONS,
      Collaboration.configure({
        document: ydoc,
        field: 'default',
      }),
    ];
    if (canEdit) {
      exts.push(
        CollaborationCaret.configure({
          provider,
          user: {
            name: user.displayName || 'Anonymous',
            color: user.accentColor,
          },
        }),
      );
    }
    return exts;
  }, [ydoc, provider, canEdit, user.displayName, user.accentColor]);

  const editor = useEditor(
    {
      extensions,
      content: initialContent as object,
      editable: canEdit,
      immediatelyRender: false,
    },
    [path, ydoc, provider, canEdit],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onClick = (evt: MouseEvent): void => {
      const target = evt.target as HTMLElement | null;
      const link = target?.closest('a.wikilink, a.tag') as HTMLAnchorElement | null;
      if (!link) return;
      if (evt.metaKey || evt.ctrlKey || evt.shiftKey || evt.button !== 0) return;
      const href = link.getAttribute('href');
      if (!href) return;
      if (!href.startsWith('/notes/') && !href.startsWith('/tags/')) return;
      evt.preventDefault();
      router.push(href);
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [router]);

  return (
    <>
      <article
        ref={containerRef}
        className="note-surface prose-parchment mt-6"
        aria-label="Note content"
      >
        <EditorContent editor={editor} />
      </article>
      {canEdit && <SlashMenu editor={editor} />}
      {canEdit && <TableToolbar editor={editor} />}
    </>
  );
}
