'use client';

// Floating toolbar that hovers above the table containing the current
// selection. Today it offers "Delete table"; more grid ops (add row /
// add column / delete row / delete column) can slot in later.

import { useCallback, useEffect, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { Trash2, Plus, Minus } from 'lucide-react';

type Anchor = {
  left: number;
  top: number;
  width: number;
};

export function TableToolbar({
  editor,
}: {
  editor: Editor | null;
}): React.JSX.Element | null {
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  useEffect(() => {
    if (!editor) return;
    const recompute = (): void => setAnchor(computeAnchor(editor));
    editor.on('selectionUpdate', recompute);
    editor.on('update', recompute);
    editor.on('focus', recompute);
    editor.on('blur', () => setAnchor(null));
    const onScroll = (): void => recompute();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    recompute();
    return () => {
      editor.off('selectionUpdate', recompute);
      editor.off('update', recompute);
      editor.off('focus', recompute);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [editor]);

  const run = useCallback(
    (fn: (chain: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => {
      if (!editor) return;
      fn(editor.chain().focus()).run();
    },
    [editor],
  );

  if (!editor || !anchor) return null;

  return (
    <div
      className="fixed z-20 flex items-center gap-1 rounded-[8px] border border-[#D4C7AE] bg-[#FBF5E8] px-1 py-0.5 shadow-[0_6px_18px_rgba(42,36,30,0.18)]"
      style={{ left: anchor.left, top: anchor.top - 34 }}
    >
      <TbButton
        title="Add row below"
        onClick={() => run((c) => c.addRowAfter())}
        icon={<Plus size={12} aria-hidden />}
        label="Row"
      />
      <TbButton
        title="Add column after"
        onClick={() => run((c) => c.addColumnAfter())}
        icon={<Plus size={12} aria-hidden />}
        label="Col"
      />
      <TbDivider />
      <TbButton
        title="Delete row"
        onClick={() => run((c) => c.deleteRow())}
        icon={<Minus size={12} aria-hidden />}
        label="Row"
      />
      <TbButton
        title="Delete column"
        onClick={() => run((c) => c.deleteColumn())}
        icon={<Minus size={12} aria-hidden />}
        label="Col"
      />
      <TbDivider />
      <TbButton
        title="Delete table"
        onClick={() => run((c) => c.deleteTable())}
        icon={<Trash2 size={12} aria-hidden />}
        label="Table"
        tone="danger"
      />
    </div>
  );
}

function TbButton({
  title,
  onClick,
  icon,
  label,
  tone,
}: {
  title: string;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  tone?: 'danger';
}): React.JSX.Element {
  const colour =
    tone === 'danger'
      ? 'text-[#8B4A52] hover:bg-[#8B4A52]/10'
      : 'text-[#5A4F42] hover:bg-[#D4A85A]/15 hover:text-[#2A241E]';
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onMouseDown={(e) => {
        e.preventDefault();
        onClick();
      }}
      className={`flex items-center gap-1 rounded-[6px] px-1.5 py-1 text-xs transition ${colour}`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function TbDivider(): React.JSX.Element {
  return <span aria-hidden className="mx-0.5 h-4 w-px bg-[#D4C7AE]" />;
}

function computeAnchor(editor: Editor): Anchor | null {
  const { state, view } = editor;
  if (!view.hasFocus()) return null;
  const $from = state.selection.$from;
  let tablePos = -1;
  for (let d = $from.depth; d >= 0; d--) {
    if ($from.node(d).type.name === 'table') {
      tablePos = $from.before(d);
      break;
    }
  }
  if (tablePos < 0) return null;
  const dom = view.nodeDOM(tablePos) as HTMLElement | null;
  if (!dom || !(dom instanceof HTMLElement)) return null;
  const rect = dom.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width };
}
