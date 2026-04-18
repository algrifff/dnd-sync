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
import { PointerOverlay } from './PointerOverlay';

export type SurfaceUser = {
  userId: string;
  displayName: string;
  accentColor: string;
};

// Custom caret DOM so the label can fade via CSS animation — each
// selection update replaces the element, which restarts the animation
// from the start (2 s visible, then fades; caret stays).
function renderCaret(user: { name?: string | null; color?: string | null }): HTMLElement {
  const color = user.color ?? '#5A4F42';
  const name = user.name ?? 'Anonymous';
  const caret = document.createElement('span');
  caret.className = 'collab-caret';
  caret.style.setProperty('--caret-color', color);
  caret.style.setProperty('--caret-color-light', withAlpha(color, 0.35));

  const label = document.createElement('span');
  label.className = 'collab-caret__label';
  label.textContent = name;
  caret.appendChild(label);
  return caret;
}

function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return hex;
  let body = m[1]!;
  if (body.length === 3) body = body.split('').map((c) => c + c).join('');
  const r = parseInt(body.slice(0, 2), 16);
  const g = parseInt(body.slice(2, 4), 16);
  const b = parseInt(body.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

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
          render: renderCaret,
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
        className="note-surface prose-parchment relative mt-6"
        aria-label="Note content"
      >
        <EditorContent editor={editor} />
        <PointerOverlay
          provider={provider}
          containerRef={containerRef}
          user={{
            userId: user.userId,
            name: user.displayName || 'Anonymous',
            color: user.accentColor,
          }}
        />
      </article>
      {canEdit && <SlashMenu editor={editor} />}
      {canEdit && <TableToolbar editor={editor} />}
    </>
  );
}
