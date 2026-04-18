// Single ProseMirror schema shared by server ingest and the browser
// editor. Built from Tiptap extensions + our custom nodes (wikilink,
// embed, embedNote, callout, tagMention). The server uses the schema
// to validate ingested JSON and to seed Y.Docs; the browser uses the
// identical schema to mount Tiptap. They MUST match — otherwise the
// server writes JSON the client can't render (or vice versa).

import { getSchema, Node } from '@tiptap/core';
import type { Schema } from 'prosemirror-model';
import { StarterKit } from '@tiptap/starter-kit';
import { Image } from '@tiptap/extension-image';
import { Link } from '@tiptap/extension-link';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { Highlight } from '@tiptap/extension-highlight';

// ── Custom nodes ───────────────────────────────────────────────────────

/** Inline wiki-link — `[[target|label]]` in markdown. `orphan` is set
 *  true when ingest couldn't resolve the target to an existing note. */
export const WikiLink = Node.create({
  name: 'wikilink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      target: { default: '' },
      label: { default: '' },
      anchor: { default: null as string | null },
      orphan: { default: false },
    };
  },
  parseHTML() {
    return [{ tag: 'a.wikilink' }];
  },
  renderHTML({ node }) {
    const { target, label, anchor, orphan } = node.attrs as Record<string, unknown>;
    return [
      'a',
      {
        class: `wikilink${orphan ? ' wikilink-orphan' : ''}`,
        'data-target': String(target),
        ...(anchor ? { 'data-anchor': String(anchor) } : {}),
        href: '#', // client maps to /notes/<target> at render time
      },
      String(label || target || ''),
    ];
  },
});

/** Block-level embed for images, videos, PDFs, other binaries. */
export const Embed = Node.create({
  name: 'embed',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      assetId: { default: '' },
      mime: { default: 'application/octet-stream' },
      caption: { default: null as string | null },
      originalName: { default: null as string | null },
    };
  },
  parseHTML() {
    return [{ tag: 'figure[data-embed]' }];
  },
  renderHTML({ node }) {
    const { assetId, mime } = node.attrs as Record<string, unknown>;
    return [
      'figure',
      { 'data-embed': String(assetId), 'data-mime': String(mime), class: 'embed' },
      0,
    ];
  },
});

/** Link-card for transcluded notes — `![[OtherNote]]` becomes this. */
export const EmbedNote = Node.create({
  name: 'embedNote',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      target: { default: '' },
      label: { default: '' },
    };
  },
  parseHTML() {
    return [{ tag: 'aside.note-embed' }];
  },
  renderHTML({ node }) {
    const { target, label } = node.attrs as Record<string, unknown>;
    return [
      'aside',
      { class: 'note-embed', 'data-target': String(target) },
      String(label || target || ''),
    ];
  },
});

/** Obsidian-style callout — `> [!note] Title\n> body`. */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      kind: { default: 'note' }, // note | tip | warning | danger | info | quote
      title: { default: null as string | null },
    };
  },
  parseHTML() {
    return [{ tag: 'aside[data-callout]' }];
  },
  renderHTML({ node }) {
    const { kind, title } = node.attrs as Record<string, unknown>;
    return [
      'aside',
      { 'data-callout': String(kind || 'note'), 'data-title': title ? String(title) : null },
      0,
    ];
  },
});

/** Inline tag mention — `#tag`. */
export const TagMention = Node.create({
  name: 'tagMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      tag: { default: '' },
    };
  },
  parseHTML() {
    return [{ tag: 'a.tag' }];
  },
  renderHTML({ node }) {
    const { tag } = node.attrs as Record<string, unknown>;
    return ['a', { class: 'tag', 'data-tag': String(tag), href: '#' }, '#' + String(tag)];
  },
});

// ── Extension registry + schema ────────────────────────────────────────

/** The full set of extensions used by both server ingest and the
 *  browser editor. Order matters for Tiptap: nodes defined later may
 *  extend or override earlier ones. Keep this in sync with Phase 4's
 *  editor-mount call. */
export const BASE_EXTENSIONS = [
  StarterKit.configure({
    // Yjs owns history; disable Tiptap's.
    undoRedo: false,
    // We inline Link below to configure openOnClick=false.
    link: false,
  }),
  Link.configure({ openOnClick: false, autolink: true }),
  Image,
  Table.configure({ resizable: false }),
  TableRow,
  TableCell,
  TableHeader,
  TaskList,
  TaskItem.configure({ nested: true }),
  Highlight,
  WikiLink,
  Embed,
  EmbedNote,
  Callout,
  TagMention,
];

let cachedSchema: Schema | null = null;

/** Build (or fetch the cached copy of) the PM schema. Tiptap's
 *  getSchema() is deterministic so callers always see the same object. */
export function getPmSchema(): Schema {
  cachedSchema ??= getSchema(BASE_EXTENSIONS);
  return cachedSchema;
}
