'use client';

// @ mention trigger. Watches the Tiptap editor for an @ character typed
// at the end of a paragraph word; while active, shows a NotePicker anchored
// to the caret. On selection it deletes the @… trigger text and inserts a
// wikilink node, which Hocuspocus derives into a note_links graph edge.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { NotePicker } from './NotePicker';

type Trigger = { from: number; to: number; anchor: { left: number; top: number } };

function detectAtTrigger(editor: Editor): Trigger | null {
  const { state, view } = editor;
  const { selection } = state;
  if (!selection.empty) return null;
  const $from = selection.$from;
  if ($from.parent.type.name !== 'paragraph') return null;
  const textBefore = $from.parent.textBetween(0, $from.parentOffset);
  const match = /@(\w*)$/.exec(textBefore);
  if (!match) return null;

  const from = $from.pos - match[0].length;
  const to = $from.pos;

  const PICKER_W = 320;
  const PICKER_H = 320;
  let anchor = { left: 8, top: 8 };
  try {
    const coords = view.coordsAtPos(from);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(8, Math.min(coords.left, vw - PICKER_W - 8));
    const top =
      coords.bottom + 6 + PICKER_H > vh
        ? Math.max(8, coords.top - PICKER_H - 6)
        : coords.bottom + 6;
    anchor = { left, top };
  } catch {
    /* ignore — falls back to top-left */
  }

  return { from, to, anchor };
}

export function AtMentionMenu({
  editor,
  excludePath,
}: {
  editor: Editor | null;
  excludePath?: string;
}): React.JSX.Element | null {
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const triggerRef = useRef<Trigger | null>(null);

  useEffect(() => {
    if (!editor) return;
    const update = (): void => {
      const t = detectAtTrigger(editor);
      triggerRef.current = t;
      setTrigger(t);
    };
    editor.on('selectionUpdate', update);
    editor.on('update', update);
    update();
    return () => {
      editor.off('selectionUpdate', update);
      editor.off('update', update);
    };
  }, [editor]);

  const close = useCallback((): void => {
    triggerRef.current = null;
    setTrigger(null);
  }, []);

  const onSelect = useCallback(
    (path: string): void => {
      const t = triggerRef.current;
      if (!editor || !t) return;
      const target = path.replace(/\.(md|canvas)$/i, '');
      editor
        .chain()
        .focus()
        .deleteRange({ from: t.from, to: t.to })
        .insertContent({ type: 'wikilink', attrs: { target, label: '', orphan: false } })
        .insertContent(' ')
        .run();
      close();
    },
    [editor, close],
  );

  if (!trigger) return null;

  return (
    <NotePicker
      anchor={trigger.anchor}
      onSelect={onSelect}
      onClose={close}
      {...(excludePath !== undefined ? { excludePath } : {})}
    />
  );
}
