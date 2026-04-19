// Markdown → ProseMirror JSON converter. Pure module — no DB, no I/O
// beyond string parsing. Used by the vault ingest pipeline + the
// round-trip fidelity test.
//
// Pipeline:
//   1. Strip YAML frontmatter; parse via `yaml`.
//   2. Parse body with unified + remark-parse + remark-gfm + remark-frontmatter.
//   3. Walk MDAST → PM JSON nodes matching our pm-schema.
//   4. In inline text, post-process for:
//        [[Target|Label]]   → wikilink inline node
//        ![[Asset.png]]     → embed block (if an asset) / embedNote (if a note) / image (if external URL)
//        #tag               → tagMention inline node
//        ==text==           → highlight mark
//   5. Detect Obsidian callouts `> [!note] title` → callout block.

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import * as YAML from 'yaml';

// Explicit any[] typing for MDAST is unavoidable without pulling the
// @types/mdast package; MDAST nodes are heterogeneous and narrowing via
// string-literal `type` is enough for our walker's safety.
type Mdast = {
  type: string;
  children?: Mdast[];
  value?: string;
  depth?: number;
  lang?: string | null;
  url?: string;
  alt?: string | null;
  title?: string | null;
  ordered?: boolean;
  start?: number | null;
  spread?: boolean;
  checked?: boolean | null;
  align?: Array<'left' | 'right' | 'center' | null>;
};

export type PmNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PmNode[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
};

export type WikilinkResolution = { path: string; orphan: boolean };

export type IngestContext = {
  /** Paths of every note in the vault. Case-sensitive storage, but
   *  resolution is case-insensitive. */
  allPaths: ReadonlySet<string>;
  /** alias (lower-case) → canonical note path */
  aliasMap: ReadonlyMap<string, string>;
  /** basename (with or without extension) → asset id + mime */
  assetsByName: ReadonlyMap<string, { id: string; mime: string }>;
};

export type NoteIngest = {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  aliases: string[];
  contentJson: PmNode;
  contentText: string;
  wikilinks: string[];
  tags: string[];
  /** Image references that couldn't be resolved against the asset
   *  index — most often a typo, or an image the ZIP didn't include. */
  unresolvedImages: string[];
};

const MD_PARSER = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml']);

/** Main entry. */
export function ingestMarkdown(path: string, raw: string, ctx: IngestContext): NoteIngest {
  const normalised = stripBom(raw);
  const frontmatter = extractFrontmatter(normalised);
  const aliases = readAliasList(frontmatter.data);
  const fmTags = readTagList(frontmatter.data);

  const tree = MD_PARSER.parse(normalised) as Mdast;
  const body = (tree.children ?? []).filter((n) => n.type !== 'yaml');

  const title = findFirstHeading(body) ?? filenameTitle(path);

  const ctxForWalk: IngestContext = ctx;
  const collected: Collected = {
    wikilinks: new Set<string>(),
    tags: new Set<string>(fmTags),
    unresolvedImages: new Set<string>(),
  };
  const content = body.flatMap((n) => walkBlock(n, ctxForWalk, collected));

  const doc: PmNode = { type: 'doc', content };
  return {
    path,
    title,
    frontmatter: frontmatter.data,
    aliases,
    contentJson: doc,
    contentText: extractPlaintext(doc),
    wikilinks: [...collected.wikilinks],
    tags: [...collected.tags],
    unresolvedImages: [...collected.unresolvedImages],
  };
}

// ── Frontmatter ────────────────────────────────────────────────────────

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function extractFrontmatter(raw: string): { data: Record<string, unknown>; rest: string } {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) {
    return { data: {}, rest: raw };
  }
  const end = raw.indexOf('\n---', 4);
  if (end === -1) return { data: {}, rest: raw };
  const yaml = raw.slice(4, end);
  try {
    const parsed = YAML.parse(yaml);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { data: parsed as Record<string, unknown>, rest: raw.slice(end + 4) };
    }
  } catch {
    /* fall through — treat as plain */
  }
  return { data: {}, rest: raw };
}

function readAliasList(fm: Record<string, unknown>): string[] {
  const a = fm.aliases ?? fm.alias;
  if (Array.isArray(a)) return a.filter((x): x is string => typeof x === 'string' && x.length > 0);
  if (typeof a === 'string' && a.length > 0) return [a];
  return [];
}

function readTagList(fm: Record<string, unknown>): string[] {
  const t = fm.tags ?? fm.tag;
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string' && x.length > 0).map(normaliseTag);
  if (typeof t === 'string' && t.length > 0) return t.split(/[,\s]+/).filter(Boolean).map(normaliseTag);
  return [];
}

function normaliseTag(t: string): string {
  return t.replace(/^#/, '').toLowerCase();
}

function findFirstHeading(nodes: Mdast[]): string | null {
  for (const n of nodes) {
    if (n.type === 'heading' && n.depth === 1) {
      return plainText(n.children ?? []);
    }
  }
  return null;
}

function filenameTitle(path: string): string {
  const last = path.split('/').pop() ?? path;
  return last.replace(/\.(md|canvas)$/i, '');
}

// ── MDAST block walker ────────────────────────────────────────────────

type Collected = {
  wikilinks: Set<string>;
  tags: Set<string>;
  /** Image URLs that couldn't be matched to a vault asset. Surfaces
   *  into the ingest summary so users can see which references still
   *  need fixing rather than silently falling through as broken
   *  <img> tags. */
  unresolvedImages: Set<string>;
};

function walkBlock(n: Mdast, ctx: IngestContext, coll: Collected): PmNode[] {
  switch (n.type) {
    case 'heading':
      return [
        {
          type: 'heading',
          attrs: { level: clampHeadingDepth(n.depth ?? 1) },
          content: walkInline(n.children ?? [], ctx, coll),
        },
      ];
    case 'paragraph': {
      // An embed-only paragraph becomes a block-level embed/embedNote.
      const lifted = liftBlockEmbeds(n.children ?? [], ctx, coll);
      if (lifted) return lifted;
      return [{ type: 'paragraph', content: walkInline(n.children ?? [], ctx, coll) }];
    }
    case 'blockquote': {
      const callout = detectCallout(n, ctx, coll);
      if (callout) return [callout];
      return [{ type: 'blockquote', content: (n.children ?? []).flatMap((c) => walkBlock(c, ctx, coll)) }];
    }
    case 'list':
      return [walkList(n, ctx, coll)];
    case 'code':
      return [
        {
          type: 'codeBlock',
          attrs: { language: n.lang ?? null },
          content: n.value ? [{ type: 'text', text: n.value }] : [],
        },
      ];
    case 'thematicBreak':
      return [{ type: 'horizontalRule' }];
    case 'table':
      return [walkTable(n, ctx, coll)];
    case 'html':
      // Skip raw HTML blocks (rare). Could be added in a future iteration.
      return [];
    default:
      // Unknown block — fall back to a paragraph carrying its plaintext.
      return n.children
        ? (n.children ?? []).flatMap((c) => walkBlock(c, ctx, coll))
        : [];
  }
}

function clampHeadingDepth(d: number): number {
  return Math.max(1, Math.min(6, d));
}

function walkList(n: Mdast, ctx: IngestContext, coll: Collected): PmNode {
  const items = (n.children ?? []).filter((c) => c.type === 'listItem');
  const anyTasks = items.some((i) => i.checked !== null && i.checked !== undefined);
  if (anyTasks) {
    return {
      type: 'taskList',
      content: items.map((i) => ({
        type: 'taskItem',
        attrs: { checked: i.checked === true },
        content: (i.children ?? []).flatMap((c) => walkBlock(c, ctx, coll)),
      })),
    };
  }
  const base: PmNode = {
    type: n.ordered ? 'orderedList' : 'bulletList',
    content: items.map((i) => ({
      type: 'listItem',
      content: (i.children ?? []).flatMap((c) => walkBlock(c, ctx, coll)),
    })),
  };
  if (n.ordered) base.attrs = { start: n.start ?? 1 };
  return base;
}

function walkTable(n: Mdast, ctx: IngestContext, coll: Collected): PmNode {
  const rows = (n.children ?? []).filter((c) => c.type === 'tableRow');
  if (rows.length === 0) return { type: 'paragraph', content: [] };
  const header = rows[0];
  const body = rows.slice(1);

  return {
    type: 'table',
    content: [
      {
        type: 'tableRow',
        content: (header?.children ?? []).map((cell) => ({
          type: 'tableHeader',
          content: [{ type: 'paragraph', content: walkInline(cell.children ?? [], ctx, coll) }],
        })),
      },
      ...body.map((row) => ({
        type: 'tableRow',
        content: (row.children ?? []).map((cell) => ({
          type: 'tableCell',
          content: [{ type: 'paragraph', content: walkInline(cell.children ?? [], ctx, coll) }],
        })),
      })),
    ],
  };
}

// ── Callout detection ──────────────────────────────────────────────────

const CALLOUT_KINDS = new Set(['note', 'tip', 'warning', 'danger', 'info', 'quote', 'important', 'example']);

function detectCallout(n: Mdast, ctx: IngestContext, coll: Collected): PmNode | null {
  const firstChild = (n.children ?? [])[0];
  if (!firstChild || firstChild.type !== 'paragraph') return null;
  const leading = (firstChild.children ?? [])[0];
  if (!leading || leading.type !== 'text' || typeof leading.value !== 'string') return null;

  // remark concatenates blockquote lines into a single text value with
  // `\n` separators. Match only up to the first newline — the callout
  // marker + title live on line 1; everything after is body content.
  const m = /^\[!([a-zA-Z]+)\]([^\n]*)/.exec(leading.value);
  if (!m) return null;
  const kind = m[1]!.toLowerCase();
  if (!CALLOUT_KINDS.has(kind)) return null;

  const title = m[2]?.trim() || null;

  // Rewrite the first child: strip the marker + title line. If the text
  // had content after the first newline, keep it. Also keep any further
  // inline siblings in the first paragraph.
  const remainderText = leading.value.slice(m[0].length);
  const trimmed = remainderText.startsWith('\n') ? remainderText.slice(1) : remainderText;

  const rewrittenFirst: Mdast = {
    type: 'paragraph',
    children: [
      ...(trimmed.length ? [{ type: 'text' as const, value: trimmed }] : []),
      ...((firstChild.children ?? []).slice(1) as Mdast[]),
    ],
  };

  const bodyBlocks = [rewrittenFirst, ...((n.children ?? []).slice(1) as Mdast[])];
  const content = bodyBlocks
    .flatMap((c) => walkBlock(c, ctx, coll))
    .filter((pm) => !(pm.type === 'paragraph' && (!pm.content || pm.content.length === 0)));

  const safeContent = content.length > 0 ? content : [{ type: 'paragraph', content: [] }];

  return {
    type: 'callout',
    attrs: { kind, title },
    content: safeContent,
  };
}

// ── Inline walk (text + marks + custom nodes) ──────────────────────────

function walkInline(nodes: Mdast[], ctx: IngestContext, coll: Collected, marks: Mark[] = []): PmNode[] {
  const out: PmNode[] = [];
  for (const n of nodes) {
    out.push(...walkOneInline(n, ctx, coll, marks));
  }
  return out;
}

type Mark = { type: string; attrs?: Record<string, unknown> };

function walkOneInline(n: Mdast, ctx: IngestContext, coll: Collected, marks: Mark[]): PmNode[] {
  switch (n.type) {
    case 'text':
      return textToInline(n.value ?? '', ctx, coll, marks);
    case 'strong':
      return walkInline(n.children ?? [], ctx, coll, mergeMark(marks, { type: 'bold' }));
    case 'emphasis':
      return walkInline(n.children ?? [], ctx, coll, mergeMark(marks, { type: 'italic' }));
    case 'delete':
      return walkInline(n.children ?? [], ctx, coll, mergeMark(marks, { type: 'strike' }));
    case 'inlineCode':
      return [{ type: 'text', text: n.value ?? '', marks: mergeMark(marks, { type: 'code' }) }];
    case 'link': {
      const linkMark: Mark = { type: 'link', attrs: { href: n.url ?? '', title: n.title ?? null } };
      return walkInline(n.children ?? [], ctx, coll, mergeMark(marks, linkMark));
    }
    case 'image': {
      // Standard markdown `![alt](cat.png)` or `![alt](Attachments/cat.png)`
      // — the URL is a vault-relative path referring to a ZIP-ingested
      // asset. Resolve it against the filename index and rewrite src
      // to our /api/assets/<id> endpoint so the rendered <img> hits
      // the authed content-addressed store instead of a dead relative
      // path. External URLs (http/https/data/blob/absolute) pass
      // through unchanged. `![[foo.png]]` wikilink form is handled
      // separately in textToInline as a block embed.
      const rawUrl = n.url ?? '';
      const src = resolveImageUrl(rawUrl, ctx, coll);
      return [
        {
          type: 'image',
          attrs: {
            src,
            alt: n.alt ?? null,
            title: n.title ?? null,
          },
        },
      ];
    }
    case 'break':
      return [{ type: 'hardBreak' }];
    case 'html': {
      // Obsidian notes commonly embed images via raw HTML
      // (`<img src="...">`). Pull the src out and emit an image
      // node so those render instead of showing up as literal tags
      // in the prose. Everything else in the HTML value is dropped
      // for v1 safety — a future pass can be more permissive.
      const value = n.value ?? '';
      if (!value) return [];
      const imgMatch = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/i.exec(
        value,
      );
      if (imgMatch) {
        const rawSrc = imgMatch[1] ?? imgMatch[2] ?? imgMatch[3] ?? '';
        const altMatch = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(value);
        const alt = altMatch ? (altMatch[1] ?? altMatch[2] ?? null) : null;
        return [
          {
            type: 'image',
            attrs: { src: resolveImageUrl(rawSrc, ctx, coll), alt, title: null },
          },
        ];
      }
      return [{ type: 'text', text: value, marks }];
    }
    default:
      return n.children ? walkInline(n.children, ctx, coll, marks) : [];
  }
}

function mergeMark(existing: Mark[], add: Mark): Mark[] {
  if (existing.some((m) => m.type === add.type)) return existing;
  return [...existing, add];
}

// ── Text-level custom node splitting ───────────────────────────────────

const EMBED_RE = /!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/;
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/;
const TAG_RE = /(^|[^\w/])#([a-zA-Z][a-zA-Z0-9_/-]*)/;
const HIGHLIGHT_RE = /==([^=]+)==/;

const COMBINED = new RegExp(
  [EMBED_RE.source, WIKILINK_RE.source, TAG_RE.source, HIGHLIGHT_RE.source].join('|'),
  'g',
);

function textToInline(
  text: string,
  ctx: IngestContext,
  coll: Collected,
  marks: Mark[],
): PmNode[] {
  if (!text) return [];
  const out: PmNode[] = [];
  let cursor = 0;
  COMBINED.lastIndex = 0;

  while (true) {
    const m = COMBINED.exec(text);
    if (!m) break;
    const matchStart = m.index;
    const full = m[0];

    if (full.startsWith('![[')) {
      pushText(out, text.slice(cursor, matchStart), marks);
      const [_, target, label] = EMBED_RE.exec(full) ?? [];
      out.push(...buildEmbed(target ?? '', label ?? undefined, ctx, coll, marks));
      cursor = matchStart + full.length;
      continue;
    }
    if (full.startsWith('[[')) {
      pushText(out, text.slice(cursor, matchStart), marks);
      const [_, target, label] = WIKILINK_RE.exec(full) ?? [];
      out.push(buildWikilink(target ?? '', label ?? undefined, ctx, coll, marks));
      cursor = matchStart + full.length;
      continue;
    }
    if (full.startsWith('==')) {
      pushText(out, text.slice(cursor, matchStart), marks);
      const inner = HIGHLIGHT_RE.exec(full)?.[1] ?? '';
      out.push({ type: 'text', text: inner, marks: mergeMark(marks, { type: 'highlight' }) });
      cursor = matchStart + full.length;
      continue;
    }
    // Tag branch — the tag regex includes a leading character group so
    // we don't match inside URLs. Recover it into the output text.
    const tm = TAG_RE.exec(full);
    if (tm) {
      const leading = tm[1] ?? '';
      const tag = tm[2] ?? '';
      const absStart = matchStart + leading.length;
      pushText(out, text.slice(cursor, absStart), marks);
      coll.tags.add(tag.toLowerCase());
      out.push({ type: 'tagMention', attrs: { tag: tag.toLowerCase() } });
      cursor = matchStart + full.length;
      continue;
    }
    // Shouldn't reach — break to avoid infinite loop.
    break;
  }
  pushText(out, text.slice(cursor), marks);
  return out;
}

function pushText(out: PmNode[], s: string, marks: Mark[]): void {
  if (!s) return;
  out.push(marks.length ? { type: 'text', text: s, marks } : { type: 'text', text: s });
}

function buildWikilink(
  target: string,
  label: string | undefined,
  ctx: IngestContext,
  coll: Collected,
  _marks: Mark[],
): PmNode {
  const { anchor, target: stripped } = splitAnchor(target);
  const resolved = resolveWikilink(stripped, ctx);
  coll.wikilinks.add(resolved.orphan ? `__orphan__:${stripped}` : resolved.path);
  return {
    type: 'wikilink',
    attrs: {
      target: resolved.path,
      label: (label ?? labelFromTarget(stripped)).trim(),
      anchor,
      orphan: resolved.orphan,
    },
  };
}

function splitAnchor(target: string): { target: string; anchor: string | null } {
  const hash = target.indexOf('^');
  if (hash === -1) return { target, anchor: null };
  return { target: target.slice(0, hash), anchor: target.slice(hash + 1) };
}

function labelFromTarget(t: string): string {
  const last = t.split('/').pop() ?? t;
  return last.replace(/\.(md|canvas)$/i, '');
}

function buildEmbed(
  target: string,
  label: string | undefined,
  ctx: IngestContext,
  coll: Collected,
  marks: Mark[],
): PmNode[] {
  // Decide: asset, note-transclusion, or orphan. Inline variants get
  // wrapped by the paragraph; block-level lifting happens in walkBlock.
  const trimmed = target.trim();
  const asset = resolveAsset(trimmed, ctx);
  if (asset) {
    return [
      {
        type: 'embed',
        attrs: {
          assetId: asset.id,
          mime: asset.mime,
          caption: label ?? null,
          originalName: trimmed,
        },
      },
    ];
  }
  // Note transclusion — render as an embedNote card.
  const note = resolveWikilink(trimmed, ctx);
  if (!note.orphan) {
    coll.wikilinks.add(note.path);
    return [
      {
        type: 'embedNote',
        attrs: { target: note.path, label: (label ?? labelFromTarget(trimmed)).trim() },
      },
    ];
  }
  // Last resort: show as plain text so nothing is silently lost.
  return [
    {
      type: 'text',
      text: `![[${trimmed}${label ? `|${label}` : ''}]]`,
      ...(marks.length ? { marks } : {}),
    },
  ];
}

function liftBlockEmbeds(
  children: Mdast[],
  ctx: IngestContext,
  coll: Collected,
): PmNode[] | null {
  // Only lift when the paragraph consists of exactly one text node that
  // is itself a single `![[...]]` token (optionally surrounded by
  // whitespace). Anything else stays inline.
  if (children.length !== 1) return null;
  const only = children[0];
  if (!only || only.type !== 'text' || typeof only.value !== 'string') return null;
  const raw = only.value.trim();
  const m = /^!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(raw);
  if (!m) return null;
  return buildEmbed(m[1] ?? '', m[2] ?? undefined, ctx, coll, []);
}

// ── Resolvers ──────────────────────────────────────────────────────────

export function resolveWikilink(target: string, ctx: IngestContext): WikilinkResolution {
  const norm = target.trim();
  if (!norm) return { path: '', orphan: true };
  const lower = norm.toLowerCase();

  // 1. Exact path match (case-insensitive)
  for (const p of ctx.allPaths) {
    if (p.toLowerCase() === lower) return { path: p, orphan: false };
    if (p.toLowerCase() === lower + '.md') return { path: p, orphan: false };
  }

  // 2. Alias
  const aliased = ctx.aliasMap.get(lower);
  if (aliased) return { path: aliased, orphan: false };

  // 3. Basename
  for (const p of ctx.allPaths) {
    const base = (p.split('/').pop() ?? '').replace(/\.(md|canvas)$/i, '').toLowerCase();
    if (base === lower) return { path: p, orphan: false };
  }

  // 4. Suffix match (longest wins)
  let best: string | null = null;
  for (const p of ctx.allPaths) {
    const pl = p.toLowerCase();
    if (pl.endsWith('/' + lower + '.md') || pl.endsWith('/' + lower)) {
      if (!best || p.length > best.length) best = p;
    }
  }
  if (best) return { path: best, orphan: false };

  return { path: norm, orphan: true };
}

function resolveAsset(
  target: string,
  ctx: IngestContext,
): { id: string; mime: string } | null {
  const name = target.split('/').pop() ?? target;
  return ctx.assetsByName.get(name) ?? ctx.assetsByName.get(name.toLowerCase()) ?? null;
}

/** Rewrite a markdown image URL. Vault-relative paths that resolve to
 *  an ingested asset get remapped to the /api/assets/<id> endpoint;
 *  external (http/https/data/blob/absolute) URLs pass through; an
 *  unresolved relative path is returned as-is so the broken-image
 *  symptom is visible and fixable rather than silently hidden. `coll`
 *  records unresolved refs for the ingest summary. */
function resolveImageUrl(url: string, ctx: IngestContext, coll?: Collected): string {
  if (!url) return '';
  if (/^(https?:|data:|blob:|\/)/i.test(url)) return url;
  let basename = url.split('/').pop() ?? url;
  try {
    basename = decodeURIComponent(basename);
  } catch {
    /* leave encoded */
  }
  const asset = resolveAsset(basename, ctx);
  if (asset) return `/api/assets/${encodeURIComponent(asset.id)}`;
  if (coll) coll.unresolvedImages.add(url);
  return url;
}

// ── Helpers ────────────────────────────────────────────────────────────

function plainText(nodes: Mdast[]): string {
  return nodes
    .map((n) => {
      if (n.type === 'text' || n.type === 'inlineCode') return n.value ?? '';
      if (n.children) return plainText(n.children);
      return '';
    })
    .join('');
}

export function extractPlaintext(doc: PmNode): string {
  const chunks: string[] = [];
  walk(doc);
  return chunks.join(' ').replace(/\s+/g, ' ').trim();

  function walk(n: PmNode): void {
    if (n.type === 'text' && typeof n.text === 'string') {
      chunks.push(n.text);
      return;
    }
    if (n.type === 'wikilink') {
      chunks.push(String(n.attrs?.label ?? n.attrs?.target ?? ''));
      return;
    }
    if (n.type === 'tagMention') {
      chunks.push('#' + String(n.attrs?.tag ?? ''));
      return;
    }
    if (n.type === 'codeBlock') {
      if (n.content) for (const c of n.content) walk(c);
      chunks.push('\n');
      return;
    }
    if (n.content) for (const c of n.content) walk(c);
  }
}
