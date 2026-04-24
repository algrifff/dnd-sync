'use client';

// Rich TipTap surface for the user-character master record. Mirrors
// NoteSurface (slash menu, @-mentions, wiki links, embeds, callouts,
// tables) but without Yjs — these notes are single-owner so we
// round-trip ProseMirror JSON through the PATCH endpoint with a debounce.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EditorContent, useEditor } from '@tiptap/react';
import type { AnyExtension } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import { BASE_EXTENSIONS } from '@/lib/pm-schema';
import { SlashMenu } from '@/app/notes/SlashMenu';
import { AtMentionMenu } from '@/app/notes/AtMentionMenu';
import { TableToolbar } from '@/app/notes/TableToolbar';
import {
  imageFilesFromDataTransfer,
  uploadImageAsset,
} from '@/lib/image-upload';

const SAVE_DEBOUNCE_MS = 600;

const EMPTY_DOC = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
} as const;

export function UserCharacterBody({
  characterId,
  csrfToken,
  initialBody,
}: {
  characterId: string;
  csrfToken: string;
  initialBody: Record<string, unknown> | null;
}): React.JSX.Element {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingBody = useRef<Record<string, unknown> | null>(null);

  const flush = useCallback(async (): Promise<void> => {
    const body = pendingBody.current;
    if (!body) return;
    pendingBody.current = null;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/me/characters/${encodeURIComponent(characterId)}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ bodyJson: body }),
        },
      );
      if (!res.ok) {
        const reply = (await res.json().catch(() => ({}))) as {
          error?: string;
          reason?: string;
        };
        setError(reply.reason ?? reply.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error');
    } finally {
      setSaving(false);
    }
  }, [characterId, csrfToken]);

  // BASE_EXTENSIONS configures StarterKit with `undoRedo: false` because
  // the in-world editor lets Yjs own history. We have no Yjs here, so
  // swap in a StarterKit with the default history enabled.
  const extensions = useMemo<AnyExtension[]>(() => {
    const filtered = BASE_EXTENSIONS.filter((e) => e.name !== 'starterKit');
    return [StarterKit.configure({ link: false }), ...filtered];
  }, []);

  const editor = useEditor({
    extensions,
    content: (initialBody ?? EMPTY_DOC) as object,
    editable: true,
    immediatelyRender: false,
    onUpdate: ({ editor: ed }) => {
      pendingBody.current = ed.getJSON() as Record<string, unknown>;
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        void flush();
      }, SAVE_DEBOUNCE_MS);
    },
  });

  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      void flush();
    };
  }, [flush]);

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

  // Drag-drop image upload — same pattern as NoteSurface.
  useEffect(() => {
    if (!editor) return;
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
  }, [editor, csrfToken]);

  return (
    <section className="mb-6">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="font-serif text-base text-[var(--ink)]">Notes</h2>
        <span
          className={
            'text-[10px] ' +
            (error ? 'text-[var(--wine)]' : 'text-[var(--ink-muted)]')
          }
        >
          {error ? `Error: ${error}` : saving ? 'Saving…' : ''}
        </span>
      </div>
      <article
        ref={containerRef}
        className="note-surface prose-parchment relative rounded-[8px] border border-[var(--rule)] bg-[var(--parchment)] px-4 py-3"
        aria-label="Character notes"
      >
        <EditorContent editor={editor} />
      </article>
      <SlashMenu editor={editor} csrfToken={csrfToken} />
      <AtMentionMenu editor={editor} />
      <TableToolbar editor={editor} />
    </section>
  );
}
