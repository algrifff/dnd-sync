'use client';

// Plain TipTap surface for the user-character master record. No Yjs —
// these notes are single-owner so we just round-trip ProseMirror JSON
// through the PATCH endpoint. Debounced like the sheet patches.

import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import { Link } from '@tiptap/extension-link';
import { Placeholder } from '@/lib/pm-placeholder';

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

  const editor = useEditor({
    extensions: [
      StarterKit,
      Link.configure({ openOnClick: false, autolink: true }),
      Placeholder.configure({
        placeholder: 'Backstory, notes, links to anything you want to remember…',
      }),
    ],
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
      <div className="rounded-[8px] border border-[var(--rule)] bg-[var(--parchment)] px-4 py-3 prose prose-sm max-w-none text-[var(--ink)]">
        <EditorContent editor={editor} />
      </div>
    </section>
  );
}
