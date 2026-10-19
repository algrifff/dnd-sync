// Lossless edits to a note body, applied directly to its ProseMirror
// JSON. Nothing here round-trips through markdown: a node the edit
// does not touch is carried over by reference, so it survives
// byte-identically.
//
// The pure edits (`addHistoryEntry`, `linkMention`) never mutate their
// input. `applyNoteEdit` runs any edit against a stored note under the
// live-document write protocol.

import * as Y from 'yjs';
import { getDb } from '@/lib/db';
import { loadNote, type NoteRow } from '@/lib/notes';
import { getPmSchema } from '@/lib/pm-schema';
import { rebuildYjsState } from '@/lib/yjs-rebuild';
import type { PmNode } from '@/lib/md-to-pm';
import { deriveIndexesFor, writeNoteState } from '@/collab/derive';
import {
  closeDocumentForWrite,
  closeDocumentConnections,
  releaseServerWrite,
  type ServerWriteToken,
} from '@/collab/server';

export type PmDoc = { type: 'doc'; content?: PmNode[] };

export type EditResult = { status: 'changed'; doc: PmDoc } | { status: 'unchanged' };

export type EditOutcome = EditResult | { status: 'rejected'; reason: string };

export type ApplyResult =
  | { status: 'applied' }
  | { status: 'unchanged' }
  | { status: 'rejected'; reason: string }
  | { status: 'not_found' };

/** What `applyNoteEdit` needs from the collab server: drain open
 *  editors and take a write token, evict anyone who reattached once the
 *  write is done (discarding their stale doc), and give the token back
 *  on every path. */
export type LiveDocuments = {
  closeForWrite(groupId: string, path: string): Promise<ServerWriteToken>;
  evictAfterWrite(groupId: string, path: string, token: ServerWriteToken): Promise<void>;
  release(token: ServerWriteToken): void;
};

/** The production adapter: the Hocuspocus server in `collab/server`. */
export const hocuspocusDocuments: LiveDocuments = {
  closeForWrite: (groupId, path) => closeDocumentForWrite(groupId, path),
  evictAfterWrite: (groupId, path, token) => closeDocumentConnections(groupId, path, token),
  release: (token) => releaseServerWrite(token),
};

const HISTORY_HEADING = 'History';

/** Appends `[[Session]]: text` as a list item under the doc's History
 *  heading, adding a `## History` heading at the end when there is
 *  none. Unchanged when the History section already links the
 *  Session. */
export function addHistoryEntry(
  doc: PmDoc,
  entry: { sessionPath: string; sessionTitle: string; text: string },
): EditResult {
  const nodes = doc.content ?? [];
  const item = historyListItem(entry);
  const headingIndex = nodes.findIndex(isHistoryHeading);

  if (headingIndex === -1) {
    const heading: PmNode = {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: HISTORY_HEADING }],
    };
    return changed(doc, [...nodes, heading, bulletList([item])]);
  }

  const end = historySectionEnd(nodes, headingIndex);
  const section = nodes.slice(headingIndex + 1, end);
  if (section.some((n) => linksTo(n, entry.sessionPath))) return { status: 'unchanged' };

  const last = nodes[end - 1]!;
  if (end - 1 > headingIndex && last.type === 'bulletList') {
    const extended: PmNode = { ...last, content: [...(last.content ?? []), item] };
    return changed(doc, [...nodes.slice(0, end - 1), extended, ...nodes.slice(end)]);
  }
  return changed(doc, [...nodes.slice(0, end), bulletList([item]), ...nodes.slice(end)]);
}

/** True when the doc's History section already links `sessionPath`. */
export function hasHistoryEntry(doc: PmDoc, sessionPath: string): boolean {
  const nodes = doc.content ?? [];
  const headingIndex = nodes.findIndex(isHistoryHeading);
  if (headingIndex === -1) return false;
  return nodes
    .slice(headingIndex + 1, historySectionEnd(nodes, headingIndex))
    .some((n) => linksTo(n, sessionPath));
}

/** Index one past the last node of the section under the heading at
 *  `headingIndex`. */
function historySectionEnd(nodes: PmNode[], headingIndex: number): number {
  const level = headingLevel(nodes[headingIndex]!);
  let end = headingIndex + 1;
  while (end < nodes.length && !endsSection(nodes[end]!, level)) end++;
  return end;
}

/** Turns the first plain-text occurrence of `text` (case-insensitive,
 *  whole word, outside code and links) into a wikilink to
 *  `targetPath`. The link shows `label`, or the words as written when
 *  no label is given. Unchanged when the doc already links the target
 *  or the text never appears. */
export function linkMention(
  doc: PmDoc,
  mention: { text: string; targetPath: string; label?: string },
): EditResult {
  const nodes = doc.content ?? [];
  const needle = mention.text.trim();
  if (!needle || nodes.some((n) => linksTo(n, mention.targetPath))) {
    return { status: 'unchanged' };
  }
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapeRegex(needle)}(?![\\p{L}\\p{N}_])`,
    'iu',
  );
  const next = linkFirstMatch(nodes, pattern, mention);
  return next ? changed(doc, next) : { status: 'unchanged' };
}

/** Applies `edit` to the stored note at `path` with the live-document
 *  write protocol: drain live editors, re-read the post-drain row,
 *  write yjs_state and every derived column the way a live save does,
 *  then evict anyone who reattached during the drain. An `unchanged`
 *  or `rejected` edit writes nothing and evicts nobody. Callers gate
 *  visibility before calling, since the drain disconnects editors.
 *  `live` defaults to the Hocuspocus server. */
export async function applyNoteEdit(opts: {
  groupId: string;
  path: string;
  userId: string | null;
  edit: (doc: PmDoc, note: NoteRow) => EditOutcome;
  live?: LiveDocuments;
}): Promise<ApplyResult> {
  const { groupId, path, userId } = opts;
  const live = opts.live ?? hocuspocusDocuments;
  const token = await live.closeForWrite(groupId, path);
  try {
    const note = loadNote(groupId, path);
    if (!note) return { status: 'not_found' };

    const outcome = opts.edit(parseDoc(note.content_json), note);
    if (outcome.status !== 'changed') return outcome;

    const state = rebuildYjsState(
      getPmSchema(),
      loadYjsState(groupId, path),
      outcome.doc,
      note.title || undefined,
    );
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, state);
    writeNoteState({ groupId, path, userId, state, doc: ydoc });
    deriveIndexesFor(groupId, path);

    await live.evictAfterWrite(groupId, path, token);
    return { status: 'applied' };
  } finally {
    live.release(token);
  }
}

function changed(doc: PmDoc, content: PmNode[]): EditResult {
  return { status: 'changed', doc: { ...doc, content } };
}

function historyListItem(entry: { sessionPath: string; sessionTitle: string; text: string }): PmNode {
  const text = entry.text.trim();
  const inline: PmNode[] = [wikilink(entry.sessionPath, entry.sessionTitle)];
  if (text) inline.push({ type: 'text', text: `: ${text}` });
  return { type: 'listItem', content: [{ type: 'paragraph', content: inline }] };
}

function bulletList(items: PmNode[]): PmNode {
  return { type: 'bulletList', content: items };
}

function wikilink(target: string, label: string): PmNode {
  return { type: 'wikilink', attrs: { target, label, anchor: null, orphan: false } };
}

function isHistoryHeading(node: PmNode): boolean {
  return (
    node.type === 'heading' &&
    plainText(node).trim().toLowerCase() === HISTORY_HEADING.toLowerCase()
  );
}

function headingLevel(node: PmNode): number {
  return Number(node.attrs?.level ?? 1);
}

function endsSection(node: PmNode, level: number): boolean {
  return node.type === 'heading' && headingLevel(node) <= level;
}

function plainText(node: PmNode): string {
  if (node.type === 'text') return node.text ?? '';
  return (node.content ?? []).map(plainText).join('');
}

function linksTo(node: PmNode, target: string): boolean {
  if (node.type === 'wikilink') {
    return String(node.attrs?.target ?? '').toLowerCase() === target.toLowerCase();
  }
  return (node.content ?? []).some((c) => linksTo(c, target));
}

const UNLINKABLE_MARKS = new Set(['code', 'link']);

/** New sibling array with the first match replaced, or null when no
 *  text node in `nodes` matches. Only the nodes on the path to the
 *  match are copied. */
function linkFirstMatch(
  nodes: PmNode[],
  pattern: RegExp,
  mention: { targetPath: string; label?: string },
): PmNode[] | null {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    let replacement: PmNode[] | null = null;

    if (node.type === 'text') {
      if (node.marks?.some((m) => UNLINKABLE_MARKS.has(m.type))) continue;
      const text = node.text ?? '';
      const match = pattern.exec(text);
      if (!match) continue;
      const before = text.slice(0, match.index);
      const after = text.slice(match.index + match[0].length);
      const link = wikilink(mention.targetPath, mention.label ?? match[0]);
      if (node.marks?.length) link.marks = node.marks;
      replacement = [
        ...(before ? [{ ...node, text: before }] : []),
        link,
        ...(after ? [{ ...node, text: after }] : []),
      ];
    } else if (node.type !== 'codeBlock' && node.content) {
      const inner = linkFirstMatch(node.content, pattern, mention);
      if (inner) replacement = [{ ...node, content: inner }];
    }

    if (replacement) return [...nodes.slice(0, i), ...replacement, ...nodes.slice(i + 1)];
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseDoc(json: string): PmDoc {
  try {
    const parsed = JSON.parse(json) as PmDoc;
    if (parsed && parsed.type === 'doc') return parsed;
  } catch {
    /* fall through to an empty doc */
  }
  return { type: 'doc', content: [] };
}

/** `loadNote()` leaves out the yjs_state blob; the rebuild seeds from
 *  it so other Y roots (drawing strokes, excalidraw layers) survive. */
function loadYjsState(groupId: string, path: string): Uint8Array | null {
  const row = getDb()
    .query<{ yjs_state: Uint8Array | null }, [string, string]>(
      'SELECT yjs_state FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(groupId, path);
  return row?.yjs_state ?? null;
}
