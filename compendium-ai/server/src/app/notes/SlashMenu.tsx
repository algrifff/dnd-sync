'use client';

// Notion-style `/` command palette. Watches the Tiptap editor for a
// fresh `/` at the start of an empty paragraph; while active, captures
// Arrow/Enter/Escape, filters the command list by the trailing query,
// and on selection replaces the `/query` range with the chosen block.
//
// No new dep: we reach into the underlying ProseMirror view for coords.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import {
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  Code,
  Minus,
  Info,
  Lightbulb,
  AlertTriangle,
  ShieldAlert,
  Table as TableIcon,
  Image as ImageIcon,
  Link2 as LinkIcon,
} from 'lucide-react';
import { uploadImageAsset } from '@/lib/image-upload';
import { NotePicker } from './NotePicker';

type Range = { from: number; to: number };
type CmdOpts = {
  csrfToken: string;
  pickImage: () => Promise<File | null>;
  pickNote: (anchor: { left: number; top: number }) => Promise<string | null>;
};

type Cmd = {
  id: string;
  label: string;
  hint: string;
  icon: React.ReactNode;
  keywords: string[];
  run: (editor: Editor, range: Range) => void;
};

function buildCommands(opts: CmdOpts): Cmd[] {
  return [
  {
    id: 'h1',
    label: 'Heading 1',
    hint: 'Large section title',
    icon: <Heading1 size={16} aria-hidden />,
    keywords: ['h1', 'heading', 'title'],
    run: (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 1 }).run(),
  },
  {
    id: 'h2',
    label: 'Heading 2',
    hint: 'Medium section title',
    icon: <Heading2 size={16} aria-hidden />,
    keywords: ['h2', 'heading', 'subheading'],
    run: (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 2 }).run(),
  },
  {
    id: 'h3',
    label: 'Heading 3',
    hint: 'Small section title',
    icon: <Heading3 size={16} aria-hidden />,
    keywords: ['h3', 'heading'],
    run: (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 3 }).run(),
  },
  {
    id: 'bullets',
    label: 'Bulleted list',
    hint: 'Simple bulleted list',
    icon: <List size={16} aria-hidden />,
    keywords: ['ul', 'bullet', 'unordered', 'list'],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run(),
  },
  {
    id: 'numbers',
    label: 'Numbered list',
    hint: '1. 2. 3.',
    icon: <ListOrdered size={16} aria-hidden />,
    keywords: ['ol', 'numbered', 'ordered', 'list'],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run(),
  },
  {
    id: 'tasks',
    label: 'Task list',
    hint: 'Checkboxes you can tick',
    icon: <ListTodo size={16} aria-hidden />,
    keywords: ['todo', 'task', 'checkbox'],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run(),
  },
  {
    id: 'quote',
    label: 'Quote',
    hint: 'Blockquote',
    icon: <Quote size={16} aria-hidden />,
    keywords: ['quote', 'blockquote'],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run(),
  },
  {
    id: 'code',
    label: 'Code block',
    hint: 'Monospaced, syntax-ready',
    icon: <Code size={16} aria-hidden />,
    keywords: ['code', 'pre', 'snippet'],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run(),
  },
  {
    id: 'divider',
    label: 'Divider',
    hint: 'Horizontal rule',
    icon: <Minus size={16} aria-hidden />,
    keywords: ['divider', 'hr', 'separator', 'line'],
    run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run(),
  },
  {
    id: 'callout-note',
    label: 'Callout · Note',
    hint: 'Highlighted note block',
    icon: <Info size={16} aria-hidden />,
    keywords: ['callout', 'note', 'info'],
    run: (e, r) => insertCallout(e, r, 'note'),
  },
  {
    id: 'callout-tip',
    label: 'Callout · Tip',
    hint: 'Green hint block',
    icon: <Lightbulb size={16} aria-hidden />,
    keywords: ['callout', 'tip', 'hint'],
    run: (e, r) => insertCallout(e, r, 'tip'),
  },
  {
    id: 'callout-warning',
    label: 'Callout · Warning',
    hint: 'Amber warning block',
    icon: <AlertTriangle size={16} aria-hidden />,
    keywords: ['callout', 'warning', 'warn', 'caution'],
    run: (e, r) => insertCallout(e, r, 'warning'),
  },
  {
    id: 'callout-danger',
    label: 'Callout · Danger',
    hint: 'Red danger block',
    icon: <ShieldAlert size={16} aria-hidden />,
    keywords: ['callout', 'danger', 'error', 'stop'],
    run: (e, r) => insertCallout(e, r, 'danger'),
  },
  {
    id: 'table',
    label: 'Table',
    hint: '3×3 starter table',
    icon: <TableIcon size={16} aria-hidden />,
    keywords: ['table', 'grid'],
    run: (e, r) =>
      e
        .chain()
        .focus()
        .deleteRange(r)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run(),
  },
  {
    id: 'image',
    label: 'Image',
    hint: 'Upload and embed an image',
    icon: <ImageIcon size={16} aria-hidden />,
    keywords: ['image', 'img', 'photo', 'picture', 'upload', 'file'],
    run: (e, r) => {
      // Delete the `/query` text immediately so the trigger doesn't
      // linger on screen while the file picker / upload run. If the
      // user cancels the picker we're left with a clean caret.
      e.chain().focus().deleteRange(r).run();
      void (async () => {
        const file = await opts.pickImage();
        if (!file) return;
        try {
          const asset = await uploadImageAsset(file, opts.csrfToken);
          e.chain()
            .focus()
            .insertContent({
              type: 'embed',
              attrs: {
                assetId: asset.id,
                mime: asset.mime,
                originalName: asset.originalName,
              },
            })
            .run();
        } catch (err) {
          alert(err instanceof Error ? err.message : 'image upload failed');
        }
      })();
    },
  },
  {
    id: 'link',
    label: 'Link to note',
    hint: 'Pick a note to wikilink',
    icon: <LinkIcon size={16} aria-hidden />,
    keywords: ['link', 'wikilink', 'connect', 'reference', 'mention'],
    run: (e, r) => {
      // Capture the caret position in viewport coords BEFORE
      // deleting the trigger range — once the range disappears the
      // coords would shift by a few pixels as surrounding text
      // reflows.
      let anchor = { left: 0, top: 0 };
      try {
        const coords = e.view.coordsAtPos(r.from);
        anchor = { left: coords.left, top: coords.bottom + 4 };
      } catch {
        /* ignore — picker falls back to viewport origin */
      }
      e.chain().focus().deleteRange(r).run();
      void (async () => {
        const path = await opts.pickNote(anchor);
        if (!path) return;
        const target = path.replace(/\.(md|canvas)$/i, '');
        e.chain()
          .focus()
          .insertContent({
            type: 'wikilink',
            attrs: { target, label: '', orphan: false },
          })
          .insertContent(' ')
          .run();
      })();
    },
  },
  ];
}

function insertCallout(
  editor: Editor,
  range: { from: number; to: number },
  kind: 'note' | 'tip' | 'warning' | 'danger',
): void {
  editor
    .chain()
    .focus()
    .deleteRange(range)
    .insertContent({
      type: 'callout',
      attrs: { kind },
      content: [{ type: 'paragraph' }],
    })
    .run();
}

type Trigger = {
  from: number;
  to: number;
  query: string;
  rect: { left: number; top: number; bottom: number };
};

export function SlashMenu({
  editor,
  csrfToken,
}: {
  editor: Editor | null;
  csrfToken: string;
}): React.JSX.Element | null {
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [highlight, setHighlight] = useState<number>(0);
  const popoverRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pickResolverRef = useRef<((file: File | null) => void) | null>(null);
  const [notePicker, setNotePicker] = useState<{
    anchor: { left: number; top: number };
  } | null>(null);
  const notePickResolverRef = useRef<((path: string | null) => void) | null>(null);

  // Opens the hidden <input type="file"> and resolves once the user
  // either picks a file or dismisses the dialog (detected via focus
  // returning to the window without a change event).
  const pickImage = useCallback((): Promise<File | null> => {
    const input = fileInputRef.current;
    if (!input) return Promise.resolve(null);
    input.value = ''; // allow re-selecting the same file twice in a row
    return new Promise<File | null>((resolve) => {
      pickResolverRef.current = resolve;
      input.click();
    });
  }, []);

  // Opens a NotePicker popover at the given anchor and resolves with
  // the selected note path (or null if dismissed).
  const pickNote = useCallback(
    (anchor: { left: number; top: number }): Promise<string | null> => {
      setNotePicker({ anchor });
      return new Promise<string | null>((resolve) => {
        notePickResolverRef.current = resolve;
      });
    },
    [],
  );

  const closeNotePicker = useCallback(() => {
    notePickResolverRef.current?.(null);
    notePickResolverRef.current = null;
    setNotePicker(null);
  }, []);

  const selectNote = useCallback((path: string) => {
    notePickResolverRef.current?.(path);
    notePickResolverRef.current = null;
    setNotePicker(null);
  }, []);

  const commands = buildCommands({ csrfToken, pickImage, pickNote });

  // Detect the trigger on each editor update.
  useEffect(() => {
    if (!editor) return;
    const recompute = (): void => {
      setTrigger(detectTrigger(editor));
    };
    editor.on('selectionUpdate', recompute);
    editor.on('update', recompute);
    recompute();
    return () => {
      editor.off('selectionUpdate', recompute);
      editor.off('update', recompute);
    };
  }, [editor]);

  // Reset highlight whenever the query changes.
  useEffect(() => {
    setHighlight(0);
  }, [trigger?.query]);

  const options = trigger ? filterCommands(commands, trigger.query) : [];

  const close = useCallback(() => setTrigger(null), []);

  const run = useCallback(
    (cmd: Cmd) => {
      if (!editor || !trigger) return;
      cmd.run(editor, { from: trigger.from, to: trigger.to });
      setTrigger(null);
    },
    [editor, trigger],
  );

  // Intercept keyboard navigation while the menu is open. Using a DOM
  // listener keyed to the editor's content element keeps it scoped to
  // the active editor instance.
  useEffect(() => {
    if (!editor || !trigger) return;
    const el = editor.view.dom;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => (options.length === 0 ? 0 : (h + 1) % options.length));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) =>
          options.length === 0 ? 0 : (h - 1 + options.length) % options.length,
        );
      } else if (e.key === 'Enter') {
        if (options.length === 0) return;
        const pick = options[highlight] ?? options[0];
        if (!pick) return;
        e.preventDefault();
        run(pick);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    el.addEventListener('keydown', onKey, true);
    return () => el.removeEventListener('keydown', onKey, true);
  }, [editor, trigger, options, highlight, run, close]);

  // Hidden file input for the Image slash command. Mounted always so
  // it outlives the popover: the picker resolves AFTER the menu
  // closes (the command selection dismisses the popover, then the
  // user interacts with the native file dialog).
  const hiddenFileInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept="image/*"
      hidden
      onChange={(e) => {
        const file = e.target.files?.[0] ?? null;
        const resolve = pickResolverRef.current;
        pickResolverRef.current = null;
        resolve?.(file);
      }}
    />
  );

  const notePickerEl = notePicker ? (
    <NotePicker
      anchor={notePicker.anchor}
      onSelect={selectNote}
      onClose={closeNotePicker}
    />
  ) : null;

  if (!trigger) {
    return (
      <>
        {hiddenFileInput}
        {notePickerEl}
      </>
    );
  }

  const { rect } = trigger;
  return (
    <>
      {hiddenFileInput}
      {notePickerEl}
      <div
        ref={popoverRef}
        role="listbox"
        aria-label="Slash commands"
        className="fixed z-30 w-72 overflow-hidden rounded-[10px] border border-[#D4C7AE] bg-[#FBF5E8] shadow-[0_12px_32px_rgba(42,36,30,0.18)]"
        style={{ left: rect.left, top: rect.bottom + 6 }}
      >
        {options.length === 0 ? (
          <div className="px-3 py-2 text-xs text-[#5A4F42]">No matches</div>
        ) : (
          <ul className="max-h-80 overflow-y-auto py-1">
            {options.map((cmd, i) => (
              <li key={cmd.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === highlight}
                  onMouseEnter={() => setHighlight(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    run(cmd);
                  }}
                  className={
                    'flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition ' +
                    (i === highlight
                      ? 'bg-[#D4A85A]/20 text-[#2A241E]'
                      : 'text-[#2A241E] hover:bg-[#D4A85A]/10')
                  }
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] border border-[#D4C7AE] bg-[#F4EDE0] text-[#5A4F42]">
                    {cmd.icon}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{cmd.label}</span>
                    <span className="truncate text-xs text-[#5A4F42]">{cmd.hint}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

// Finds `/query` at the end of the current paragraph iff the paragraph
// contains no inline nodes other than the text. Returns the range that
// covers the '/' through the cursor, so a command can delete it before
// inserting its block.
function detectTrigger(editor: Editor): Trigger | null {
  const { state, view } = editor;
  const { selection } = state;
  if (!selection.empty) return null;
  const $from = selection.$from;

  const parent = $from.parent;
  if (parent.type.name !== 'paragraph') return null;

  const textBefore = parent.textBetween(0, $from.parentOffset, undefined, '\ufffc');
  const match = /(?:^|\s)(\/[^\s/]*)$/.exec(textBefore);
  if (!match) return null;

  // Only trigger when the paragraph's content up to the cursor is purely
  // text (no atoms/embeds in the way). The \ufffc placeholder flags any
  // non-text leaf — if we see one before the slash, skip.
  if (textBefore.includes('\ufffc')) return null;

  const slashText = match[1] ?? ''; // e.g. "/head"
  if (!slashText.startsWith('/')) return null;
  const query = slashText.slice(1);
  const to = $from.pos;
  const from = to - slashText.length;

  let rect: { left: number; top: number; bottom: number };
  try {
    const coords = view.coordsAtPos(from);
    rect = { left: coords.left, top: coords.top, bottom: coords.bottom };
  } catch {
    return null;
  }

  return { from, to, query, rect };
}

function filterCommands(commands: Cmd[], query: string): Cmd[] {
  const q = query.toLowerCase();
  if (!q) return commands;
  return commands.filter((c) => {
    if (c.id.includes(q)) return true;
    if (c.label.toLowerCase().includes(q)) return true;
    return c.keywords.some((k) => k.includes(q));
  });
}
