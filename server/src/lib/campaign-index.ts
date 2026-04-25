// Campaign-index auto-managed body block.
//
// Every `Campaigns/<slug>/index.md` carries a callout block at the top
// of its body that we own and rewrite on every note lifecycle event
// inside that campaign. The callout contains one table per immediate
// subfolder of the campaign (Sessions, Characters, Places, …) plus an
// "Overview" table for loose notes sitting at the campaign root. Each
// row is a wikilink to the note, so the index doubles as a clickable
// directory and feeds note_links / backlinks for free.
//
// The rest of the index body is left alone — users can write narrative
// or reminders below the managed callout and we won't clobber them.
//
// Callsites: note + folder create/move/delete routes, the matching AI
// tools, and the boot-time backfill in index-notes.ts.
//
// Sync model:
//   - Rewrite content_json + content_md + content_text in place.
//   - Round-trip the new PM JSON through prosemirrorJSONToYDoc to get
//     a fresh yjs_state (mirrors the move-rewrite.ts pattern).
//   - Call closeDocumentConnections() so any open editor reconnects
//     against the new state instead of overwriting it on save.

import * as Y from 'yjs';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import { getDb } from './db';
import { getPmSchema } from './pm-schema';
import { pmToMarkdown } from './pm-to-md';
import { extractPlaintext, type PmNode } from './md-to-pm';
import { closeDocumentConnections } from '@/collab/server';

/** Callout title marker — used both as the user-visible heading and as
 *  the detection sentinel when we look for the managed block. */
const MANAGED_TITLE = '📚 Campaign Index';

/** Match `Campaigns/<slug>` (no trailing slash). The slug segment must
 *  not be empty and must not contain a slash. */
const CAMPAIGN_FOLDER_RE = /^(Campaigns\/[^/]+)(?:\/|$)/;

/** Return the `Campaigns/<slug>` prefix for any path that lives under
 *  a campaign folder, or null otherwise. */
export function campaignFolderOfPath(path: string): string | null {
  const m = CAMPAIGN_FOLDER_RE.exec(path);
  return m ? m[1]! : null;
}

/** Distinct campaign folders touched by a list of paths. Used by bulk
 *  lifecycle hooks (folder move / folder delete) to drive a single
 *  derive per affected campaign. */
export function uniqueCampaignFoldersFor(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const f = campaignFolderOfPath(p);
    if (f) out.add(f);
  }
  return [...out];
}

/** Re-derive the managed callout in `<campaignFolder>/index.md` from
 *  the current set of notes under that campaign. No-op if the campaign
 *  no longer has any notes (e.g. its folder was just deleted) — the
 *  index row will already be gone via the cascade. Async because we
 *  kick live editor connections after the write. */
export async function deriveCampaignIndex(
  groupId: string,
  campaignFolder: string,
): Promise<void> {
  if (!CAMPAIGN_FOLDER_RE.test(campaignFolder + '/')) return;

  const indexPath = `${campaignFolder}/index.md`;
  const db = getDb();

  const indexRow = db
    .query<
      { content_json: string; title: string },
      [string, string]
    >(
      'SELECT content_json, title FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(groupId, indexPath);
  if (!indexRow) return;

  // Pull every note under the campaign folder except the index itself.
  // Order doesn't matter here — we sort after grouping.
  const noteRows = db
    .query<
      { path: string; title: string },
      [string, string, string, string]
    >(
      `SELECT path, title FROM notes
        WHERE group_id = ?
          AND (path = ? OR path LIKE ? || '/%')
          AND path != ?`,
    )
    .all(groupId, campaignFolder, campaignFolder, indexPath);

  const sections = bucketByImmediateSubfolder(campaignFolder, noteRows);
  const callout = buildIndexCallout(sections);

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

  // Round-trip through yjs to refresh the persisted CRDT state. The
  // title sidecar is restored from the existing row so the title
  // editor doesn't see an empty Y.Text on reconnect. If the produced
  // JSON fails schema validation we abort the write entirely — better
  // to leave the index untouched than write a malformed yjs_state
  // that loads as an empty doc on next open.
  let yjsState: Uint8Array;
  try {
    const schema = getPmSchema();
    schema.nodeFromJSON(next); // throws on invalid shape
    const ydoc = prosemirrorJSONToYDoc(schema, next, 'default');
    if (indexRow.title) ydoc.getText('title').insert(0, indexRow.title);
    yjsState = Y.encodeStateAsUpdate(ydoc);
  } catch (err) {
    console.error(
      '[campaign-index] schema validation failed for',
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

  // Re-seed FTS so search hits track the new body.
  db.query('DELETE FROM notes_fts WHERE path = ? AND group_id = ?').run(
    indexPath,
    groupId,
  );
  db.query(
    'INSERT INTO notes_fts(path, group_id, title, content) VALUES (?, ?, ?, ?)',
  ).run(indexPath, groupId, indexRow.title, newText);

  // Re-seed note_links for the index so the graph reflects the new
  // wikilinks immediately, without waiting for the user to open the
  // page in the editor (which would trigger derive.ts).
  db.query(
    'DELETE FROM note_links WHERE group_id = ? AND from_path = ? AND is_manual = 0',
  ).run(groupId, indexPath);
  const insertLink = db.query(
    'INSERT OR IGNORE INTO note_links (group_id, from_path, to_path) VALUES (?, ?, ?)',
  );
  for (const section of sections) {
    for (const entry of section.entries) {
      if (entry.path === indexPath) continue;
      insertLink.run(groupId, indexPath, entry.path);
    }
  }

  await closeDocumentConnections(indexPath);
}

/** Drive the derive across every distinct campaign in a list of
 *  paths. Useful for bulk operations like folder moves. */
export async function deriveCampaignIndexesFor(
  groupId: string,
  paths: string[],
): Promise<void> {
  for (const folder of uniqueCampaignFoldersFor(paths)) {
    try {
      await deriveCampaignIndex(groupId, folder);
    } catch (err) {
      console.error('[campaign-index] derive failed for', folder, err);
    }
  }
}

/** Backfill every existing campaign in the database. Cheap to call on
 *  boot: scans the campaigns table and runs derive once per row. */
export async function backfillCampaignIndexes(): Promise<void> {
  const db = getDb();
  const rows = db
    .query<{ group_id: string; folder_path: string }, []>(
      'SELECT group_id, folder_path FROM campaigns',
    )
    .all();
  for (const r of rows) {
    try {
      await deriveCampaignIndex(r.group_id, r.folder_path);
    } catch (err) {
      console.error(
        '[campaign-index] backfill failed for',
        r.folder_path,
        err,
      );
    }
  }
}

// ── Section building ───────────────────────────────────────────────────

type IndexEntry = { path: string; title: string };
type IndexSection = { name: string; entries: IndexEntry[] };

const OVERVIEW_BUCKET = 'Overview';

function bucketByImmediateSubfolder(
  campaignFolder: string,
  rows: Array<{ path: string; title: string }>,
): IndexSection[] {
  const buckets = new Map<string, IndexEntry[]>();
  const prefix = campaignFolder + '/';
  for (const row of rows) {
    if (!row.path.startsWith(prefix)) continue;
    const rel = row.path.slice(prefix.length);
    const slash = rel.indexOf('/');
    const bucket = slash === -1 ? OVERVIEW_BUCKET : rel.slice(0, slash);
    const list = buckets.get(bucket) ?? [];
    list.push({ path: row.path, title: row.title || filenameTitle(row.path) });
    buckets.set(bucket, list);
  }

  // Sort entries alphabetically inside each bucket; sort buckets too,
  // but always pin "Overview" first.
  const sections: IndexSection[] = [];
  for (const [name, entries] of buckets) {
    entries.sort((a, b) => a.title.localeCompare(b.title));
    sections.push({ name, entries });
  }
  sections.sort((a, b) => {
    if (a.name === OVERVIEW_BUCKET) return -1;
    if (b.name === OVERVIEW_BUCKET) return 1;
    return a.name.localeCompare(b.name);
  });
  return sections;
}

function filenameTitle(path: string): string {
  const last = path.split('/').pop() ?? path;
  return last.replace(/\.(md|canvas)$/i, '');
}

// ── PM JSON construction ──────────────────────────────────────────────

function buildIndexCallout(sections: IndexSection[]): PmNode {
  const children: PmNode[] = [
    paragraph('Auto-managed — edit your own notes outside this block.'),
  ];

  if (sections.length === 0) {
    children.push(paragraph('No notes yet.'));
  } else {
    for (const section of sections) {
      children.push({
        type: 'heading',
        attrs: { level: 3 },
        content: [{ type: 'text', text: section.name }],
      });
      children.push(buildSectionTable(section.entries));
    }
  }

  return {
    type: 'callout',
    attrs: { kind: 'info', title: MANAGED_TITLE },
    content: children,
  };
}

function buildSectionTable(entries: IndexEntry[]): PmNode {
  const headerRow: PmNode = {
    type: 'tableRow',
    content: [
      tableHeader('Name'),
      tableHeader('Path'),
    ],
  };
  const rows: PmNode[] = entries.map((e) => ({
    type: 'tableRow',
    content: [
      tableCell([
        {
          type: 'paragraph',
          content: [
            {
              type: 'wikilink',
              attrs: {
                target: e.path,
                label: '',
                anchor: null,
                orphan: false,
              },
            },
          ],
        },
      ]),
      tableCell([paragraph(e.path)]),
    ],
  }));
  return { type: 'table', content: [headerRow, ...rows] };
}

function tableHeader(text: string): PmNode {
  // Match the shape md-to-pm emits — omit attrs so the Tiptap Table
  // extension fills its own colspan/rowspan/colwidth defaults. Setting
  // them explicitly with mismatched types fails schema validation in
  // prosemirrorJSONToYDoc and leaves us with an empty Y.Doc.
  return {
    type: 'tableHeader',
    content: [paragraph(text)],
  };
}

function tableCell(content: PmNode[]): PmNode {
  return {
    type: 'tableCell',
    content,
  };
}

function paragraph(text: string): PmNode {
  if (!text) return { type: 'paragraph', content: [] };
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

/** Find the existing managed callout (by sentinel title) and replace
 *  it. If absent, insert the callout as the doc's second child when a
 *  level-1 heading sits at the top, else prepend it. Mutates a fresh
 *  copy — never the original. */
function injectManagedCallout(doc: PmNode, callout: PmNode): PmNode {
  const baseContent = Array.isArray(doc.content) ? [...doc.content] : [];

  const existingIdx = baseContent.findIndex(
    (n) =>
      n.type === 'callout' &&
      typeof n.attrs?.title === 'string' &&
      (n.attrs.title as string).trim() === MANAGED_TITLE,
  );
  if (existingIdx !== -1) {
    baseContent[existingIdx] = callout;
    return { ...doc, type: 'doc', content: baseContent };
  }

  // Otherwise insert. Keep the H1 at the top of the page if it has one.
  const insertAt =
    baseContent[0]?.type === 'heading' && (baseContent[0]?.attrs?.level ?? 1) === 1
      ? 1
      : 0;
  baseContent.splice(insertAt, 0, callout);
  return { ...doc, type: 'doc', content: baseContent };
}
