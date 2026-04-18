// Vault ingest. Takes a ZIP file path, scans entries, writes the
// parsed vault into SQLite atomically, replacing any prior state for
// the given group_id.
//
// Safety gates:
//   - Skip .obsidian/, .trash/, .DS_Store, __MACOSX/, .canvas (v1)
//   - Reject any entry path containing .., null bytes, Windows drives
//   - Per-file cap: 50 MB
//   - Total uncompressed cap: 1 GB
//
// Ordering:
//   1. Walk the ZIP once to classify every entry (asset vs note vs
//      skip) and compute the list of note paths + the alias map.
//   2. Store each asset (content-addressed on disk, dedup on hash).
//   3. Ingest each note (md-to-pm with resolved context), build a
//      Y.Doc from the PM JSON, serialise to yjs_state.
//   4. One SQLite transaction: wipe old rows for this group, insert
//      the new ones. audit_log records the upload.

import AdmZip from 'adm-zip';
import * as Y from 'yjs';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import { getDb } from './db';
import { getPmSchema } from './pm-schema';
import { ingestMarkdown, type IngestContext, type NoteIngest } from './md-to-pm';
import { pmToMarkdown } from './pm-to-md';
import { sniffMime, isSupportedMime, assetPath } from './assets';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { logAudit } from './audit';

const PER_FILE_CAP = 50 * 1024 * 1024;
const TOTAL_UNCOMPRESSED_CAP = 1024 * 1024 * 1024;

const SKIP_PREFIXES = ['.obsidian/', '.trash/', '__MACOSX/'];
const SKIP_BASENAMES = new Set(['.DS_Store', 'Thumbs.db']);
const MARKDOWN_EXTENSIONS = new Set(['.md']);
const BINARY_EXTENSIONS_HINT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf',
  '.mp4', '.webm', '.mov', '.mp3', '.wav', '.ogg',
]);

export type IngestSummary = {
  notes: number;
  assets: number;
  assetsReused: number;
  links: number;
  tags: number;
  durationMs: number;
  skipped: Array<{ path: string; reason: string }>;
};

export type IngestOptions = {
  zipPath: string;
  groupId: string;
  actorId: string | null;
};

export async function ingestZip(opts: IngestOptions): Promise<IngestSummary> {
  const t0 = Date.now();
  const zip = new AdmZip(opts.zipPath);
  const entries = zip.getEntries();

  const skipped: IngestSummary['skipped'] = [];
  const noteEntries: Array<{ path: string; raw: string }> = [];
  const assetEntries: Array<{ path: string; data: Buffer }> = [];

  let totalUncompressed = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const relPath = entry.entryName.replace(/\\/g, '/');
    const bname = relPath.split('/').pop() ?? '';

    if (!isSafePath(relPath)) {
      skipped.push({ path: relPath, reason: 'unsafe path' });
      continue;
    }
    if (SKIP_PREFIXES.some((p) => relPath.startsWith(p))) {
      // Silently skip — user never wanted these.
      continue;
    }
    if (SKIP_BASENAMES.has(bname)) continue;

    const size = entry.header.size;
    if (size > PER_FILE_CAP) {
      skipped.push({ path: relPath, reason: `file exceeds ${PER_FILE_CAP} bytes` });
      continue;
    }
    totalUncompressed += size;
    if (totalUncompressed > TOTAL_UNCOMPRESSED_CAP) {
      throw new Error(`zip total exceeds ${TOTAL_UNCOMPRESSED_CAP} bytes`);
    }

    const ext = bname.slice(bname.lastIndexOf('.')).toLowerCase();

    if (MARKDOWN_EXTENSIONS.has(ext)) {
      noteEntries.push({ path: relPath, raw: entry.getData().toString('utf-8') });
      continue;
    }

    if (ext === '.canvas') {
      skipped.push({ path: relPath, reason: '.canvas files not supported in v1' });
      continue;
    }

    if (BINARY_EXTENSIONS_HINT.has(ext)) {
      assetEntries.push({ path: relPath, data: entry.getData() });
      continue;
    }

    skipped.push({ path: relPath, reason: `unknown file type: ${ext}` });
  }

  // ── Phase A: hash + stage every asset, build filename→asset map ─────

  type StagedAsset = {
    id: string;
    hash: string;
    mime: string;
    size: number;
    originalName: string;
    originalPath: string;
    diskPath: string;
    data: Buffer;
  };

  const staged: StagedAsset[] = [];
  const filenameToAsset = new Map<string, { id: string; mime: string }>();

  for (const a of assetEntries) {
    const basename = a.path.split('/').pop() ?? a.path;
    const mime = sniffMime(a.data, basename);
    if (!isSupportedMime(mime)) {
      skipped.push({ path: a.path, reason: `unsupported mime ${mime}` });
      continue;
    }
    const hash = createHash('sha256').update(a.data).digest('hex');
    staged.push({
      id: randomUUID(),
      hash,
      mime,
      size: a.data.byteLength,
      originalName: basename,
      originalPath: a.path,
      diskPath: assetPath(hash, mime),
      data: a.data,
    });
  }

  // ── Phase B: first note pass to extract allPaths + aliases ──────────

  const allPaths = new Set<string>(noteEntries.map((e) => e.path));
  const aliasMap = new Map<string, string>();

  // Preliminary walk that only parses frontmatter for alias collection.
  for (const note of noteEntries) {
    const fm = extractFrontmatter(note.raw);
    const aliases = readAliases(fm);
    for (const alias of aliases) {
      aliasMap.set(alias.toLowerCase(), note.path);
    }
  }

  // Second: register assets in the filenameToAsset map — we don't yet
  // know if assets will reuse existing DB rows, so emit new UUIDs here
  // and let the transaction resolve dedup below.
  for (const s of staged) {
    filenameToAsset.set(s.originalName, { id: s.id, mime: s.mime });
    filenameToAsset.set(s.originalName.toLowerCase(), { id: s.id, mime: s.mime });
  }

  const ctx: IngestContext = { allPaths, aliasMap, assetsByName: filenameToAsset };

  // ── Phase C: full ingest ─────────────────────────────────────────────

  type PreparedNote = {
    ingest: NoteIngest;
    contentMd: string;
    yjsState: Uint8Array;
    byteSize: number;
  };

  const prepared: PreparedNote[] = [];
  for (const note of noteEntries) {
    try {
      const ingest = ingestMarkdown(note.path, note.raw, ctx);
      // Rebuild canonical markdown for the cache + future export.
      const contentMd = pmToMarkdown(ingest.contentJson, ingest.frontmatter);
      // Build Y.Doc (fragment name 'default' matches Tiptap defaults).
      const schema = getPmSchema();
      const ydoc = prosemirrorJSONToYDoc(schema, ingest.contentJson, 'default');
      // Seed the collaborative title field with the parsed title so the
      // TitleEditor renders the right name without round-tripping a
      // rename on first load.
      if (ingest.title) {
        ydoc.getText('title').insert(0, ingest.title);
      }
      const yjsState = Y.encodeStateAsUpdate(ydoc);
      prepared.push({
        ingest,
        contentMd,
        yjsState,
        byteSize: contentMd.length,
      });
    } catch (err) {
      skipped.push({
        path: note.path,
        reason: err instanceof Error ? err.message : 'ingest failed',
      });
    }
  }

  // ── Phase D: write assets to disk (outside transaction — FS isn't
  //             rolled back, but content-addressed so a retry is safe).
  mkdirSync(assetPath('_probe', 'application/octet-stream').replace(/\/_probe\.bin$/, ''), {
    recursive: true,
  });

  let assetsReused = 0;
  const db = getDb();
  const existingByHash = new Map<string, { id: string }>();
  for (const row of db
    .query<{ id: string; hash: string }, [string]>(
      'SELECT id, hash FROM assets WHERE group_id = ?',
    )
    .all(opts.groupId)) {
    existingByHash.set(row.hash, { id: row.id });
  }

  const assetsToInsert: StagedAsset[] = [];
  for (const s of staged) {
    const dup = existingByHash.get(s.hash);
    if (dup) {
      assetsReused++;
      // Rewrite filenameToAsset to point at the existing id so note
      // embeds reference the canonical row.
      const existing = filenameToAsset.get(s.originalName);
      if (existing) existing.id = dup.id;
      const existingLower = filenameToAsset.get(s.originalName.toLowerCase());
      if (existingLower) existingLower.id = dup.id;
      continue;
    }
    if (!existsSync(s.diskPath)) {
      writeFileSync(s.diskPath, s.data);
    }
    assetsToInsert.push(s);
  }

  // ── Phase E: atomic DB swap ──────────────────────────────────────────

  db.transaction(() => {
    // Wipe prior group state. note_links, tags, aliases are keyed on
    // group_id so we can drop them directly. notes has CASCADE on
    // group_id FK so deleting all rows for the group is enough.
    db.query('DELETE FROM aliases     WHERE group_id = ?').run(opts.groupId);
    db.query('DELETE FROM note_links  WHERE group_id = ?').run(opts.groupId);
    db.query('DELETE FROM tags        WHERE group_id = ?').run(opts.groupId);
    db.query('DELETE FROM notes       WHERE group_id = ?').run(opts.groupId);

    // Assets: insert new, leave existing alone.
    const insertAsset = db.query(
      `INSERT INTO assets (id, group_id, hash, mime, size, original_name, uploaded_by, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    for (const a of assetsToInsert) {
      insertAsset.run(
        a.id,
        opts.groupId,
        a.hash,
        a.mime,
        a.size,
        a.originalName,
        opts.actorId,
        now,
      );
    }

    const insertNote = db.query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text, content_md,
                          yjs_state, frontmatter_json, byte_size, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertLink = db.query(
      `INSERT OR IGNORE INTO note_links (group_id, from_path, to_path) VALUES (?, ?, ?)`,
    );
    const insertTag = db.query(
      `INSERT OR IGNORE INTO tags (group_id, path, tag) VALUES (?, ?, ?)`,
    );
    const insertAlias = db.query(
      `INSERT OR IGNORE INTO aliases (group_id, alias, path) VALUES (?, ?, ?)`,
    );

    for (const p of prepared) {
      insertNote.run(
        randomUUID(),
        opts.groupId,
        p.ingest.path,
        p.ingest.title,
        JSON.stringify(p.ingest.contentJson),
        p.ingest.contentText,
        p.contentMd,
        p.yjsState,
        JSON.stringify(p.ingest.frontmatter),
        p.byteSize,
        now,
        opts.actorId,
      );
      for (const link of p.ingest.wikilinks) {
        insertLink.run(opts.groupId, p.ingest.path, link);
      }
      for (const tag of p.ingest.tags) {
        insertTag.run(opts.groupId, p.ingest.path, tag);
      }
      for (const alias of p.ingest.aliases) {
        insertAlias.run(opts.groupId, alias, p.ingest.path);
      }
    }
  })();

  // Count summary totals from what we just inserted.
  const linkCount = prepared.reduce((n, p) => n + p.ingest.wikilinks.length, 0);
  const tagCount = prepared.reduce((n, p) => n + new Set(p.ingest.tags).size, 0);

  logAudit({
    action: 'vault.upload',
    actorId: opts.actorId,
    groupId: opts.groupId,
    details: {
      notes: prepared.length,
      assets: staged.length,
      assetsReused,
      skipped: skipped.length,
    },
  });

  return {
    notes: prepared.length,
    assets: staged.length,
    assetsReused,
    links: linkCount,
    tags: tagCount,
    durationMs: Date.now() - t0,
    skipped,
  };
}

// ── helpers ────────────────────────────────────────────────────────────

function isSafePath(p: string): boolean {
  if (p.length === 0) return false;
  if (p.includes('\0')) return false;
  if (/^[A-Za-z]:[\\/]/.test(p)) return false; // Windows drive
  const parts = p.split('/');
  for (const part of parts) {
    if (part === '..' || part === '.') return false;
  }
  return true;
}

function extractFrontmatter(raw: string): Record<string, unknown> {
  const trimmed = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  if (!trimmed.startsWith('---\n') && !trimmed.startsWith('---\r\n')) return {};
  const end = trimmed.indexOf('\n---', 4);
  if (end === -1) return {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const YAML = require('yaml') as { parse(s: string): unknown };
    const parsed = YAML.parse(trimmed.slice(4, end));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore */
  }
  return {};
}

function readAliases(fm: Record<string, unknown>): string[] {
  const a = fm.aliases ?? fm.alias;
  if (Array.isArray(a)) {
    return a.filter((v): v is string => typeof v === 'string' && v.length > 0);
  }
  if (typeof a === 'string' && a.length > 0) return [a];
  return [];
}
