// Single ProseMirror schema shared by server ingest and the browser
// editor. Built from Tiptap extensions + our custom nodes (wikilink,
// embed, embedNote, callout, tagMention). The server uses the schema
// to validate ingested JSON and to seed Y.Docs; the browser uses the
// identical schema to mount Tiptap. They MUST match — otherwise the
// server writes JSON the client can't render (or vice versa).

import {
  getSchema,
  mergeAttributes,
  Node,
  type AnyExtension,
} from '@tiptap/core';
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
import { Placeholder } from './pm-placeholder';

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
    const targetStr = String(target ?? '');
    const labelStr = String(label ?? '');
    const href = orphan ? '#orphan' : targetStr ? '/notes/' + encodePath(targetStr) : '#';
    // Prefer an explicit label. Otherwise show the target's basename
    // without the .md/.canvas extension so e.g. "Campaign 3/NPCs/
    // Arin.md" reads as "Arin" in the prose — the full path is still
    // available in data-target + the href for navigation.
    const display = labelStr || niceWikilinkLabel(targetStr);
    return [
      'a',
      {
        class: `wikilink${orphan ? ' wikilink-orphan' : ''}`,
        'data-target': targetStr,
        ...(anchor ? { 'data-anchor': String(anchor) } : {}),
        href,
      },
      display,
    ];
  },
});

function niceWikilinkLabel(target: string): string {
  if (!target) return '';
  const last = target.split('/').pop() ?? target;
  return last.replace(/\.(md|canvas)$/i, '');
}

function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

/** Block-level embed for images, videos, PDFs, other binaries. Renders
 *  the appropriate media element driven by the node's mime attribute;
 *  the src points at /api/assets/<id> which auth-gates the blob. */
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
    const assetId = String(node.attrs?.assetId ?? '');
    const mime = String(node.attrs?.mime ?? 'application/octet-stream');
    const caption = node.attrs?.caption ? String(node.attrs.caption) : '';
    const name = node.attrs?.originalName ? String(node.attrs.originalName) : '';
    const src = assetId ? `/api/assets/${encodeURIComponent(assetId)}` : '';
    const alt = caption || name || '';

    const figureAttrs = {
      'data-embed': assetId,
      'data-mime': mime,
      class: 'embed',
    };

    let media: unknown[];
    if (!src) {
      media = ['div', { class: 'embed-missing' }, 'Missing asset'];
    } else if (mime.startsWith('image/')) {
      media = ['img', { src, alt, loading: 'lazy' }];
    } else if (mime.startsWith('video/')) {
      media = ['video', { src, controls: 'true', preload: 'metadata' }];
    } else if (mime.startsWith('audio/')) {
      media = ['audio', { src, controls: 'true', preload: 'metadata' }];
    } else if (mime === 'application/pdf') {
      media = ['iframe', { src, class: 'embed-pdf', title: name || 'PDF', loading: 'lazy' }];
    } else {
      media = [
        'a',
        { href: src, download: name || 'download', class: 'embed-download' },
        name || 'Download file',
      ];
    }

    const children = caption
      ? [media, ['figcaption', {}, caption]]
      : [media];
    return ['figure', figureAttrs, ...children] as unknown as [
      string,
      Record<string, string>,
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
    const t = String(tag);
    return [
      'a',
      { class: 'tag', 'data-tag': t, href: '/tags/' + encodeURIComponent(t) },
      '#' + t,
    ];
  },
});

// ── Extension registry + schema ────────────────────────────────────────

/** The full set of extensions used by both server ingest and the
 *  browser editor. Order matters for Tiptap: nodes defined later may
 *  extend or override earlier ones. Keep this in sync with Phase 4's
 *  editor-mount call. */
/** Image node with a render-time src rewriter. ProseMirror JSON may
 *  still carry raw vault-relative paths (e.g.
 *  `Campaign 2/Assets/Portraits/lumen_portrait.jpg`) from older
 *  ingests, and new markdown references whose ingest-time resolver
 *  missed. Rather than touching the stored JSON we rewrite the src
 *  on the way into the DOM — anything that isn't http(s)/data/blob/
 *  already-served-absolute gets routed through /api/assets/by-path,
 *  which 302-redirects to the canonical /api/assets/<id> URL. */
const ResolvingImage = Image.extend({
  renderHTML({ HTMLAttributes }) {
    const raw = HTMLAttributes.src as string | undefined;
    const rewritten = raw ? resolveImageSrc(raw) : raw;
    return [
      'img',
      mergeAttributes(HTMLAttributes, {
        src: rewritten ?? HTMLAttributes.src,
      }),
    ];
  },
});

function resolveImageSrc(src: string): string {
  if (!src) return src;
  // Absolute URLs, protocol-prefixed URLs, and app-absolute paths
  // (/api/...) pass through untouched.
  if (/^(https?:|data:|blob:|\/)/i.test(src)) return src;
  return `/api/assets/by-path?path=${encodeURIComponent(src)}`;
}

export const BASE_EXTENSIONS: AnyExtension[] = [
  StarterKit.configure({
    // Yjs owns history; disable Tiptap's.
    undoRedo: false,
    // We inline Link below to configure openOnClick=false.
    link: false,
  }),
  Link.configure({ openOnClick: false, autolink: true }),
  ResolvingImage,
  Table.configure({ resizable: false }),
  TableRow,
  TableCell,
  TableHeader,
  TaskList,
  TaskItem.configure({ nested: true }),
  Highlight,
  Placeholder,
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
