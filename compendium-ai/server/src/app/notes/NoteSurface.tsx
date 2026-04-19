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
import { imageFilesFromDataTransfer, uploadImageAsset } from '@/lib/image-upload';
import {
  INSERT_WIKILINK_EVENT,
  type InsertWikilinkDetail,
} from './AddBacklink';

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
  csrfToken,
}: {
  path: string;
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  initialContent: { type: string } & Record<string, unknown>;
  user: SurfaceUser;
  canEdit?: boolean;
  csrfToken: string;
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

  // Drag-drop image upload. Intercepts file drops on the note body,
  // uploads each image, and inserts an embed at the ProseMirror
  // position under the cursor. Runs only when the user can edit; for
  // non-image drops (text, URLs, PM-internal moves) we let the event
  // fall through to Tiptap's own handler.
  useEffect(() => {
    if (!canEdit || !editor) return;
    const el = containerRef.current;
    if (!el) return;

    const onDragOver = (evt: DragEvent): void => {
      if (!evt.dataTransfer) return;
      const hasFiles = Array.from(evt.dataTransfer.types).includes('Files');
      if (!hasFiles) return;
      evt.preventDefault();
      evt.dataTransfer.dropEffect = 'copy';
    };

    const onDrop = (evt: DragEvent): void => {
      if (!evt.dataTransfer) return;
      const images = imageFilesFromDataTransfer(evt.dataTransfer);
      if (images.length === 0) return;
      evt.preventDefault();
      evt.stopPropagation();

      // Find the PM position closest to the drop point so the embed
      // lands where the user aimed, not at the end of the doc.
      const coords = editor.view.posAtCoords({
        left: evt.clientX,
        top: evt.clientY,
      });
      const dropPos = coords?.pos ?? editor.state.doc.content.size;

      void (async () => {
        for (let i = 0; i < images.length; i++) {
          const file = images[i]!;
          try {
            const asset = await uploadImageAsset(file, csrfToken);
            // Inserting at the same pos each time naturally stacks
            // uploads in the correct order (the embed pushes the
            // following content forward, but `dropPos` is captured
            // from the initial drop coord).
            editor
              .chain()
              .focus()
              .insertContentAt(dropPos + i, {
                type: 'embed',
                attrs: {
                  assetId: asset.id,
                  mime: asset.mime,
                  originalName: asset.originalName,
                },
              })
              .run();
          } catch (err) {
            alert(
              err instanceof Error
                ? `Image upload failed: ${err.message}`
                : 'Image upload failed',
            );
          }
        }
      })();
    };

    el.addEventListener('dragover', onDragOver);
    el.addEventListener('drop', onDrop);
    return () => {
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('drop', onDrop);
    };
  }, [canEdit, editor, csrfToken]);

  // Sidebar "+ backlink" and slash "Link to note" both dispatch this
  // event with { target, label? }. Insert a wikilink node at the
  // current caret — or at the end of the body if the editor hasn't
  // been focused yet (typical path from the sidebar).
  useEffect(() => {
    if (!canEdit || !editor) return;
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent<InsertWikilinkDetail>).detail;
      if (!detail?.target) return;
      editor
        .chain()
        .focus()
        .insertContent({
          type: 'wikilink',
          attrs: {
            target: detail.target,
            label: detail.label ?? '',
            orphan: false,
          },
        })
        .insertContent(' ')
        .run();
    };
    document.addEventListener(INSERT_WIKILINK_EVENT, handler);
    return () => document.removeEventListener(INSERT_WIKILINK_EVENT, handler);
  }, [canEdit, editor]);

  return (
    <>
      <article
        ref={containerRef}
        className="note-surface prose-parchment mt-6"
        aria-label="Note content"
      >
        <EditorContent editor={editor} />
      </article>
      {canEdit && <SlashMenu editor={editor} csrfToken={csrfToken} />}
      {canEdit && <TableToolbar editor={editor} />}
    </>
  );
}
