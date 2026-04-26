// Folder-index auto-managed body block.
//
// Every folder under `Campaigns/<slug>/` (the campaign root itself,
// the canonical subfolders like Sessions/Characters/Loot, AND any
// custom folder a user has created) carries a shallow index.md whose
// body opens with a callout block we own. The callout lists the
// folder's *immediate* children — direct subfolders link to their own
// index.md, direct notes link to themselves. Recursion is intentionally
// one level deep so the graph view stays sane (each note has exactly
// one auto-derived index edge pointing at it, not one per ancestor).
//
// Anything written outside the callout is left alone — users can keep
// their own narrative or notes around the auto-managed block.
//
// Sync model: rewrite content_json + content_md + content_text in
// place, refresh yjs_state via prosemirrorJSONToYDoc, then
// closeDocumentConnections() so any open editor reconnects against
// the new state instead of overwriting it on save.

import * as Y from 'yjs';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import { getDb } from './db';
import { getPmSchema } from './pm-schema';
import { pmToMarkdown } from './pm-to-md';
import { extractPlaintext, type PmNode } from './md-to-pm';
import { closeDocumentConnections } from '@/collab/server';
import { ensureIndexNote } from './index-notes';

/** Callout title marker — used both as the user-visible heading and as
 *  the detection sentinel when we look for the managed block. */
const MANAGED_TITLE = '📚 Folder Index';

/** Canonical campaign subfolder names. Kept duplicated from
 *  `index-notes.ts` so this module has no upward import — the list is
 *  small and rarely changes. If you add a new canonical subfolder,
 *  update both sites in the same commit. */
const CANONICAL_SUBFOLDERS = new Set(
  [
    'Characters',
    'People',
    'Enemies',
    'Loot',
    'Adventure Log',
    'Places',
    'Creatures',
    'Quests',
  ].map((s) => s.toLowerCase()),
);

function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Tags we automatically apply to a folder's index.md. The folder's
 *  own slugified name is always included; canonical campaign
 *  subfolders additionally carry the campaign slug so e.g. the
 *  Characters/index.md inside Dragon-Heist is tagged
 *  `#characters #dragon-heist`. The campaign-root index gets just
 *  the campaign tag (its name is the campaign slug). */
function autoTagsForFolder(folderPath: string): string[] {
  const parts = folderPath.split('/');
  if (parts[0] !== 'Campaigns' || !parts[1]) return [];
  const campaignTag = slugify(parts[1]);
  if (parts.length === 2) {
    // Campaign root.
    return [campaignTag];
  }
  const lastSeg = parts[parts.length - 1]!;
  const ownTag = slugify(lastSeg);
  if (CANONICAL_SUBFOLDERS.has(lastSeg.toLowerCase())) {
    // Canonical subfolder — include the parent campaign tag too.
    return [ownTag, campaignTag];
  }
  // Custom subfolder — just its own tag.
  return [ownTag];
}

/** Match any folder under `Campaigns/<slug>/` at any depth, including
 *  the campaign root itself. Rejects bare "Campaigns". */
const UNDER_CAMPAIGN_RE = /^Campaigns\/[^/]+(?:\/.+)?$/;

/** True when this folder path is somewhere we want a managed index. */
export function isUnderCampaign(folderPath: string): boolean {
  return UNDER_CAMPAIGN_RE.test(folderPath);
}

/** The `Campaigns/<slug>` segment for any path that lives under a
 *  campaign, or null otherwise. Kept for callsites that reason about
 *  campaign-scope (boot backfill, AI tools). */
export function campaignFolderOfPath(path: string): string | null {
  const m = /^(Campaigns\/[^/]+)/.exec(path);
  return m ? m[1]! : null;
}

/** Immediate parent folder of a path, but only if that parent lives
 *  under `Campaigns/<slug>/`. Used by lifecycle hooks: when a note is
 *  written/moved/deleted at P, the index that needs refreshing is the
 *  parent folder of P. */
export function parentFolderUnderCampaign(path: string): string | null {
  const lastSlash = path.lastIndexOf('/');
  if (lastSlash === -1) return null;
  const parent = path.slice(0, lastSlash);
  if (!isUnderCampaign(parent)) return null;
  return parent;
}

/** Distinct parent folders of a list of paths, scoped to under-campaign
 *  folders only. Drives bulk lifecycle hooks (folder move / delete /
 *  bulk import) so we derive each affected index exactly once. */
export function uniqueFoldersFor(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const parent = parentFolderUnderCampaign(p);
    if (parent) out.add(parent);
  }
  return [...out];
}

/** Re-derive the managed callout in `<folderPath>/index.md` from the
 *  current set of direct children.
 *
 *  When `ensureWith` is supplied AND the folder actually has content
 *  (any note or folder marker under it), the index.md is auto-created
 *  if missing so the AI tool / import pipeline doesn't have to know
 *  about every brand-new subfolder it just spawned a note in.
 *
 *  No-op when there's no index.md and no ensureWith — covers the
 *  delete path where we don't want to resurrect an index for a folder
 *  that was just removed. */
export async function deriveFolderIndex(
  groupId: string,
  folderPath: string,
  ensureWith?: { userId: string },
): Promise<void> {
  if (!isUnderCampaign(folderPath)) return;

  const indexPath = `${folderPath}/index.md`;
  const db = getDb();

  const queryIndex = (): {
    content_json: string;
    title: string;
    frontmatter_json: string;
  } | null =>
    (db
      .query<
        { content_json: string; title: string; frontmatter_json: string },
        [string, string]
      >(
        'SELECT content_json, title, frontmatter_json FROM notes WHERE group_id = ? AND path = ?',
      )
      .get(groupId, indexPath) ?? null);

  let indexRow = queryIndex();
  if (!indexRow && ensureWith && folderHasContent(groupId, folderPath)) {
    ensureIndexNote(
      groupId,
      ensureWith.userId,
      folderPath,
      prettifyFolderName(folderPath),
    );
    indexRow = queryIndex();
  }
  if (!indexRow) return;

  // Auto-tags: every index folder carries a tag matching its own
  // name; canonical subfolders additionally carry the campaign tag.
  // We merge into the note's existing tags so user-added entries
  // survive the rewrite.
  const autoTags = autoTagsForFolder(folderPath);
  let fm: Record<string, unknown>;
  try {
    fm = JSON.parse(indexRow.frontmatter_json) as Record<string, unknown>;
  } catch {
    fm = {};
  }
  const existingTags = Array.isArray(fm.tags)
    ? (fm.tags as unknown[]).filter((t): t is string => typeof t === 'string')
    : [];
  const mergedTags = [
    ...new Set(
      [...existingTags.map((t) => t.replace(/^#/, '').toLowerCase()), ...autoTags].filter(
        (t) => t.length > 0,
      ),
    ),
  ];
  const nextFm = { ...fm, tags: mergedTags };
  const nextFmJson = JSON.stringify(nextFm);
  const fmChanged = nextFmJson !== indexRow.frontmatter_json;

  // Apply the frontmatter tag merge + tags-table sync FIRST and as a
  // standalone write. The body rewrite below could legitimately fail
  // (legacy doc with shapes the current schema rejects) and we don't
  // want one bad doc to block the auto-tags from landing on the rest
  // of an existing world's indexes.
  //
  // Strictly additive on both layers: frontmatter `tags` is the union
  // of existing + auto tags, and the tags table gets INSERT OR IGNORE
  // for each auto tag with no preceding DELETE — anything the user
  // already had (frontmatter entries, inline #mentions derived by
  // derive.ts) is left alone.
  if (fmChanged) {
    db.query(
      'UPDATE notes SET frontmatter_json = ?, updated_at = ? WHERE group_id = ? AND path = ?',
    ).run(nextFmJson, Date.now(), groupId, indexPath);
  }
  const insertTag = db.query(
    'INSERT OR IGNORE INTO tags (group_id, path, tag) VALUES (?, ?, ?)',
  );
  for (const tag of autoTags) {
    if (tag.length > 0) insertTag.run(groupId, indexPath, tag);
  }

  const { folders, notes } = listDirectChildren(groupId, folderPath, indexPath);
  const callout = buildIndexCallout(folders, notes);

  let doc: PmNode;
  try {
    doc = JSON.parse(indexRow.content_json) as PmNode;
  } catch {
    doc = { type: 'doc', content: [] };
  }
  const next = injectManagedCallout(doc, callout);

  const newJson = JSON.stringify(next);
  const newMd = pmToMarkdown(next);
  const newText = extractPlaintext(next);

  let yjsState: Uint8Array;
  try {
    const schema = getPmSchema();
    schema.nodeFromJSON(next); // throws on invalid shape
    const ydoc = prosemirrorJSONToYDoc(schema, next, 'default');
    if (indexRow.title) ydoc.getText('title').insert(0, indexRow.title);
    yjsState = Y.encodeStateAsUpdate(ydoc);
  } catch (err) {
    console.error(
      '[folder-index] schema validation failed for',
      indexPath,
      err,
    );
    return;
  }

  db.query(
    `UPDATE notes
        SET content_json = ?,
            content_text = ?,
            content_md   = ?,
            yjs_state    = ?,
            byte_size    = ?,
            updated_at   = ?
      WHERE group_id = ? AND path = ?`,
  ).run(
    newJson,
    newText,
    newMd,
    yjsState,
    newMd.length,
    Date.now(),
    groupId,
    indexPath,
  );

  db.query('DELETE FROM notes_fts WHERE path = ? AND group_id = ?').run(
    indexPath,
    groupId,
  );
  db.query(
    'INSERT INTO notes_fts(path, group_id, title, content) VALUES (?, ?, ?, ?)',
  ).run(indexPath, groupId, indexRow.title, newText);

  // Re-seed links in both directions so the graph shows a fully connected
  // hierarchy. Two categories:
  //
  //   Forward  (is_manual=0, is_index=0): index → child
  //     Derived from the wikilinks in the managed callout body. Collab
  //     derive also writes these on every edit, so this is idempotent.
  //
  //   Reverse  (is_index=1): child → index
  //     Not present in any note body — purely structural. They survive
  //     normal note-save derive (derive.ts excludes is_index=1 from its
  //     DELETE) so the hierarchy stays visible in the graph even while
  //     users are editing child notes.
  db.query(
    'DELETE FROM note_links WHERE group_id = ? AND from_path = ? AND is_manual = 0 AND is_index = 0',
  ).run(groupId, indexPath);
  // Wipe old reverse edges TO this index before re-inserting the current
  // child set. This handles children that have moved away since last derive.
  db.query(
    'DELETE FROM note_links WHERE group_id = ? AND to_path = ? AND is_index = 1',
  ).run(groupId, indexPath);

  const insertForward = db.query(
    'INSERT OR IGNORE INTO note_links (group_id, from_path, to_path) VALUES (?, ?, ?)',
  );
  const insertReverse = db.query(
    'INSERT OR IGNORE INTO note_links (group_id, from_path, to_path, is_index) VALUES (?, ?, ?, 1)',
  );
  for (const f of folders) {
    insertForward.run(groupId, indexPath, f.indexPath);
    insertReverse.run(groupId, f.indexPath, indexPath);
  }
  for (const n of notes) {
    if (n.path === indexPath) continue;
    insertForward.run(groupId, indexPath, n.path);
    insertReverse.run(groupId, n.path, indexPath);
  }

  await closeDocumentConnections(indexPath);
}

/** Drive the derive across every distinct affected folder for a list
 *  of paths. Each path's parent (when under Campaigns/<slug>/) is
 *  deduplicated and derived once. Pass `ensureWith` to auto-create
 *  any missing index.md (only fires when the folder still has
 *  content — empty source folders after a move stay un-indexed). */
export async function deriveFolderIndexesFor(
  groupId: string,
  paths: string[],
  ensureWith?: { userId: string },
): Promise<void> {
  for (const folder of uniqueFoldersFor(paths)) {
    try {
      await deriveFolderIndex(groupId, folder, ensureWith);
    } catch (err) {
      console.error('[folder-index] derive failed for', folder, err);
    }
  }
}

/** Backfill every existing folder under every campaign in the DB. Walks
 *  notes + folder_markers to discover the union of folder paths, then
 *  derives each. Index notes themselves must already exist (the
 *  matching backfill in index-notes.ts ensures that on boot). */
export async function backfillCampaignIndexes(): Promise<void> {
  for (const folder of allCampaignFoldersInDb()) {
    try {
      await deriveFolderIndex(folder.groupId, folder.path);
    } catch (err) {
      console.error(
        '[folder-index] backfill failed for',
        folder.path,
        err,
      );
    }
  }
}

// ── Backwards-compat aliases (kept so older callsites keep compiling) ──

export const deriveCampaignIndex = deriveFolderIndex;
export const deriveCampaignIndexesFor = deriveFolderIndexesFor;

// ── Folder discovery ──────────────────────────────────────────────────

/** True when the folder has at least one note or folder marker
 *  underneath it (or sitting on it). Used as a guard before
 *  auto-creating an index.md so we don't resurrect indexes for
 *  empty/deleted folders. */
function folderHasContent(groupId: string, folderPath: string): boolean {
  const db = getDb();
  const noteRow = db
    .query<{ x: number }, [string, string]>(
      "SELECT 1 AS x FROM notes WHERE group_id = ? AND path LIKE ? || '/%' LIMIT 1",
    )
    .get(groupId, folderPath);
  if (noteRow) return true;
  const markerRow = db
    .query<{ x: number }, [string, string, string]>(
      "SELECT 1 AS x FROM folder_markers WHERE group_id = ? AND (path = ? OR path LIKE ? || '/%') LIMIT 1",
    )
    .get(groupId, folderPath, folderPath);
  return !!markerRow;
}

/** Title-case the last segment of a folder path so the auto-created
 *  index reads as e.g. "Adventure Log" rather than "adventure-log". */
function prettifyFolderName(folderPath: string): string {
  const last = folderPath.split('/').pop() ?? '';
  return (
    last
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase()) || 'Index'
  );
}

/** Every distinct folder path under any `Campaigns/<slug>/` in any
 *  group. Includes campaign roots, canonical subfolders (via
 *  folder_markers), user-created subfolders (via folder_markers), and
 *  any folder implied by a note's path. */
export function allCampaignFoldersInDb(): Array<{
  groupId: string;
  path: string;
}> {
  const db = getDb();
  const out = new Map<string, { groupId: string; path: string }>();

  const seen = (groupId: string, p: string): void => {
    if (!isUnderCampaign(p)) return;
    out.set(`${groupId}::${p}`, { groupId, path: p });
  };

  const noteRows = db
    .query<{ group_id: string; path: string }, []>(
      "SELECT group_id, path FROM notes WHERE path LIKE 'Campaigns/%'",
    )
    .all();
  for (const r of noteRows) {
    // Walk every parent prefix of the note path under Campaigns/<slug>/.
    const parts = r.path.split('/');
    for (let i = 2; i < parts.length; i++) {
      seen(r.group_id, parts.slice(0, i).join('/'));
    }
  }

  const markerRows = db
    .query<{ group_id: string; path: string }, []>(
      "SELECT group_id, path FROM folder_markers WHERE path LIKE 'Campaigns/%'",
    )
    .all();
  for (const r of markerRows) {
    seen(r.group_id, r.path);
    // Also walk parents — a marker like `Campaigns/X/Sessions/Sub`
    // implies its parents exist as folders too.
    const parts = r.path.split('/');
    for (let i = 2; i < parts.length; i++) {
      seen(r.group_id, parts.slice(0, i).join('/'));
    }
  }

  return [...out.values()];
}

/** Direct-child notes + direct-child subfolders for one folder. The
 *  `index.md` of the folder itself is excluded from notes. Subfolders
 *  are paired with their own `index.md` paths so the table can wikilink
 *  to them. */
type ChildNote = { path: string; title: string };
type ChildFolder = { name: string; path: string; indexPath: string };

function listDirectChildren(
  groupId: string,
  folderPath: string,
  indexPath: string,
): { notes: ChildNote[]; folders: ChildFolder[] } {
  const db = getDb();
  const prefix = folderPath + '/';

  // Direct child notes: starts with `<folder>/`, no further slashes.
  const directNotes = db
    .query<{ path: string; title: string }, [string, string, string, string]>(
      `SELECT path, title FROM notes
        WHERE group_id = ?
          AND path LIKE ? || '/%'
          AND path NOT LIKE ? || '/%/%'
          AND path != ?
        ORDER BY title COLLATE NOCASE`,
    )
    .all(groupId, folderPath, folderPath, indexPath);

  const noteEntries = directNotes
    .filter((n) => !/(^|\/)index\.(md|canvas)$/i.test(n.path))
    .map((n) => ({
      path: n.path,
      title: n.title || filenameTitle(n.path),
    }));

  // Direct child folders: take the segment immediately after `<folder>/`
  // from any note path with at least 2 deeper segments OR from any
  // folder marker under this folder.
  const folderSet = new Set<string>();

  const deeperNotes = db
    .query<{ path: string }, [string, string]>(
      `SELECT DISTINCT path FROM notes
        WHERE group_id = ? AND path LIKE ? || '/%/%'`,
    )
    .all(groupId, folderPath);
  for (const r of deeperNotes) {
    const seg = r.path.slice(prefix.length).split('/')[0];
    if (seg) folderSet.add(seg);
  }

  const markerRows = db
    .query<{ path: string }, [string, string]>(
      `SELECT DISTINCT path FROM folder_markers
        WHERE group_id = ? AND path LIKE ? || '/%'`,
    )
    .all(groupId, folderPath);
  for (const r of markerRows) {
    const rel = r.path.slice(prefix.length);
    const seg = rel.split('/')[0];
    if (seg) folderSet.add(seg);
  }

  const folders: ChildFolder[] = [...folderSet]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      path: prefix + name,
      indexPath: prefix + name + '/index.md',
    }));

  return { notes: noteEntries, folders };
}

function filenameTitle(path: string): string {
  const last = path.split('/').pop() ?? path;
  return last.replace(/\.(md|canvas)$/i, '');
}

// ── PM JSON construction ──────────────────────────────────────────────

function buildIndexCallout(
  folders: ChildFolder[],
  notes: ChildNote[],
): PmNode {
  const children: PmNode[] = [
    paragraph('Auto-managed — edit your own notes outside this block.'),
  ];

  if (folders.length === 0 && notes.length === 0) {
    children.push(paragraph('No notes yet.'));
  } else {
    if (folders.length > 0) {
      children.push(heading3('Folders'));
      children.push(
        buildLinkTable(
          folders.map((f) => ({
            target: f.indexPath,
            label: f.name,
            display: f.path,
          })),
        ),
      );
    }
    if (notes.length > 0) {
      children.push(heading3('Notes'));
      children.push(
        buildLinkTable(
          notes.map((n) => ({
            target: n.path,
            label: n.title,
            display: n.path,
          })),
        ),
      );
    }
  }

  return {
    type: 'callout',
    attrs: { kind: 'info', title: MANAGED_TITLE },
    content: children,
  };
}

type LinkRow = { target: string; label: string; display: string };

function buildLinkTable(rows: LinkRow[]): PmNode {
  const headerRow: PmNode = {
    type: 'tableRow',
    content: [tableHeader('Name'), tableHeader('Path')],
  };
  const bodyRows: PmNode[] = rows.map((row) => ({
    type: 'tableRow',
    content: [
      tableCell([
        {
          type: 'paragraph',
          content: [
            {
              type: 'wikilink',
              attrs: {
                target: row.target,
                label: row.label,
                anchor: null,
                orphan: false,
              },
            },
          ],
        },
      ]),
      tableCell([paragraph(row.display)]),
    ],
  }));
  return { type: 'table', content: [headerRow, ...bodyRows] };
}

function heading3(text: string): PmNode {
  return {
    type: 'heading',
    attrs: { level: 3 },
    content: [{ type: 'text', text }],
  };
}

function tableHeader(text: string): PmNode {
  // Match the shape md-to-pm emits — omit attrs so the Tiptap Table
  // extension fills its own colspan/rowspan/colwidth defaults.
  return { type: 'tableHeader', content: [paragraph(text)] };
}

function tableCell(content: PmNode[]): PmNode {
  return { type: 'tableCell', content };
}

function paragraph(text: string): PmNode {
  if (!text) return { type: 'paragraph', content: [] };
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

/** Find the existing managed callout (by sentinel title) and replace
 *  it. If absent, insert as the doc's second child when a level-1
 *  heading sits at the top, else prepend it. */
function injectManagedCallout(doc: PmNode, callout: PmNode): PmNode {
  const baseContent = Array.isArray(doc.content) ? [...doc.content] : [];

  // Detect the current managed block: today it carries the new
  // "📚 Folder Index" title; legacy indexes from the campaign-only
  // version used "📚 Campaign Index". Replace either.
  const existingIdx = baseContent.findIndex(
    (n) =>
      n.type === 'callout' &&
      typeof n.attrs?.title === 'string' &&
      ((n.attrs.title as string).trim() === MANAGED_TITLE ||
        (n.attrs.title as string).trim() === '📚 Campaign Index'),
  );
  if (existingIdx !== -1) {
    baseContent[existingIdx] = callout;
    return { ...doc, type: 'doc', content: baseContent };
  }

  const insertAt =
    baseContent[0]?.type === 'heading' && (baseContent[0]?.attrs?.level ?? 1) === 1
      ? 1
      : 0;
  baseContent.splice(insertAt, 0, callout);
  return { ...doc, type: 'doc', content: baseContent };
}
