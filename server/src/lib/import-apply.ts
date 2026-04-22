// Commit an accepted import plan to the database.
//
// For every accepted PlannedNote:
//   1. Pick the target path (AI's canonical_path or — for confidence
//      below the threshold / plain kind — keep the source path).
//   2. If a note already lives there, merge: existing frontmatter
//      wins per-key, tags union, incoming body is appended under a
//      marker separator. Otherwise insert fresh.
//   3. Rewrite wikilinks that the classifier suggested, but only
//      when their anchor text literally appears in the body and
//      isn't already wrapped.
//   4. Move associated images into Assets/<Category>/<basename>;
//      the owning note's frontmatter.portrait is set to the
//      portrait image's vault path.
//   5. Insert + run the full derive pipeline (characters, sessions,
//      campaigns, note_links, tags, assets_by_path).
//
// Per-note transactions so one bad note doesn't kill the batch.
// The job's stats_json ends up with running counts + error lines.

import { randomUUID, createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import AdmZip from 'adm-zip';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import * as Y from 'yjs';
import YAML from 'yaml';
import { getDb } from './db';
import {
  assetPath,
  isSupportedMime,
  sniffMime,
  type AssetRow,
} from './assets';
import {
  deleteJobZip,
  getImportJob,
  updateImportJob,
  type ImportJob,
} from './imports';
import type { ImportPlan, ParsedAsset } from './import-parse';
import { deriveAllIndexes } from './derive-indexes';
import { getPmSchema } from './pm-schema';
import { ingestMarkdown, type IngestContext, type NoteIngest } from './md-to-pm';
import { pmToMarkdown } from './pm-to-md';
import type { PlannedNote } from './import-analyse';
import type { ImportClassifyResult } from './ai/skills/types';
import { runMerge } from './ai/skills/merge';

export type ApplySummary = {
  moved: number;
  merged: number;
  keptInPlace: number;
  failed: number;
  assetsCommitted: number;
  mergeSkillCalls: number;       // # of AI merge calls billed this run
  mergeSkillCostUsd: number;
  errors: Array<{ sourcePath: string; message: string }>;
};

// ── Entry point ────────────────────────────────────────────────────────

export async function applyImportJob(jobId: string): Promise<ApplySummary> {
  const job = getImportJob(jobId);
  if (!job) throw new Error('not_found');
  if (job.status !== 'ready' && job.status !== 'uploaded') {
    throw new Error(`job not in an applyable state: ${job.status}`);
  }

  const plan = job.plan as (ImportPlan & { plannedNotes?: PlannedNote[] }) | null;
  if (!plan) throw new Error('no plan on job');
  if (!job.rawZipPath || !existsSync(job.rawZipPath)) {
    throw new Error('raw zip missing — cancel and re-upload');
  }
  const zip = new AdmZip(job.rawZipPath);

  // Index every zip entry by its relative path so we can read contents
  // quickly during the apply loop.
  const entryByPath = new Map<string, AdmZip.IZipEntry>();
  for (const e of zip.getEntries()) {
    entryByPath.set(e.entryName.replace(/\\/g, '/'), e);
  }

  const assetsByBasename = new Map<string, ParsedAsset>();
  for (const a of plan.assets) {
    assetsByBasename.set(a.basename.toLowerCase(), a);
  }

  const summary: ApplySummary = {
    moved: 0,
    merged: 0,
    keptInPlace: 0,
    failed: 0,
    assetsCommitted: 0,
    mergeSkillCalls: 0,
    mergeSkillCostUsd: 0,
    errors: [],
  };

  // Track which assets we've committed so un-associated ones can
  // still land in the vault at the end.
  const committedAssets = new Set<string>();

  // First pass: every note that was either accepted by the DM or
  // whose classification landed at confidence below 0.4 and kind
  // 'plain' — keep those in place as-is.
  const planned = plan.plannedNotes ?? [];
  for (const pn of planned) {
    try {
      if (!pn.accepted) {
        // Row was rejected (or kind=plain and DM didn't opt in).
        // Still commit it at its original path as a plain page so
        // nothing is lost.
        await commitPlannedNote(
          job,
          pn,
          null,
          entryByPath,
          assetsByBasename,
          committedAssets,
          summary,
          { forceKeepInPlace: true },
        );
        continue;
      }
      await commitPlannedNote(
        job,
        pn,
        pn.classification,
        entryByPath,
        assetsByBasename,
        committedAssets,
        summary,
        {},
      );
    } catch (err) {
      summary.failed++;
      summary.errors.push({
        sourcePath: pn.sourcePath,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Second pass: any asset that wasn't picked up by a note goes into
  // Assets/<basename> uncategorised. Idempotent via content-addressed
  // storage + per-group dedup so re-runs don't duplicate.
  for (const a of plan.assets) {
    if (committedAssets.has(a.basename.toLowerCase())) continue;
    const entry = entryByPath.get(a.sourcePath);
    if (!entry) continue;
    try {
      commitAsset(
        job,
        entry.getData(),
        `Assets/${a.basename}`,
      );
      summary.assetsCommitted++;
      committedAssets.add(a.basename.toLowerCase());
    } catch (err) {
      summary.errors.push({
        sourcePath: a.sourcePath,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Clean up the temp zip + flip the job terminal.
  deleteJobZip(job);
  updateImportJob(jobId, {
    status: 'applied',
    rawZipPath: null,
    stats: mergeStats(job, summary),
  });

  return summary;
}

// ── Per-note commit ────────────────────────────────────────────────────

async function commitPlannedNote(
  job: ImportJob,
  pn: PlannedNote,
  classification: ImportClassifyResult | null,
  entryByPath: Map<string, AdmZip.IZipEntry>,
  assetsByBasename: Map<string, ParsedAsset>,
  committedAssets: Set<string>,
  summary: ApplySummary,
  opts: { forceKeepInPlace?: boolean },
): Promise<void> {
  const groupId = job.groupId;
  const userId = job.createdBy;
  const db = getDb();

  const entry = entryByPath.get(pn.sourcePath);
  if (!entry) throw new Error('zip entry missing');
  const raw = entry.getData().toString('utf-8');

  // Determine final path.
  const targetPath = opts.forceKeepInPlace
    ? pn.sourcePath
    : pickTargetPath(pn, classification);

  // Commit any associated images first so portrait / body references
  // have their canonical paths recorded.
  const portraitVaultPath = classification
    ? commitAssociatedImages(
        job,
        classification,
        assetsByBasename,
        entryByPath,
        committedAssets,
        summary,
      )
    : null;

  // Build the incoming markdown body — wikilink rewrites applied at
  // the markdown layer so the md-to-pm pipeline picks them up.
  const { body } = splitFrontmatter(raw);
  const rewrittenBody = classification
    ? rewriteWikilinks(body, classification.wikilinks)
    : body;

  // Incoming frontmatter = existing (authoritative) + AI-derived
  // fills + kind-specific shape.
  const incomingFm = buildIncomingFrontmatter(
    pn.existingFrontmatter,
    classification,
    portraitVaultPath,
  );

  // Does something already live at target?
  const existing = db
    .query<
      {
        id: string;
        content_md: string;
        frontmatter_json: string;
      },
      [string, string]
    >(
      'SELECT id, content_md, frontmatter_json FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(groupId, targetPath);

  // For characters / sessions / etc., build the final markdown
  // package (frontmatter + body) then run the existing
  // md-to-pm + Y.Doc pipeline so every derive hook runs.
  let finalFm: Record<string, unknown>;
  let finalBody: string;
  if (existing) {
    const existingFm = parseJson(existing.frontmatter_json);
    if (process.env.OPENAI_API_KEY) {
      // Use the merge skill to produce a coherent combined body
      // and suggest any missing frontmatter. Existing frontmatter
      // keys still win per the merge rule.
      try {
        const m = await runMerge({
          path: targetPath,
          existing: { frontmatter: existingFm, body: existing.content_md },
          incoming: {
            frontmatter: incomingFm,
            body: rewrittenBody,
            sourceFilename: pn.basename,
          },
        });
        summary.mergeSkillCalls++;
        summary.mergeSkillCostUsd += m.costUsd;
        // Merge: existing → + AI suggestions → + incoming (blank-fill).
        const withSuggestions = mergeFrontmatter(
          existingFm,
          m.result.frontmatterSuggestions,
        );
        finalFm = mergeFrontmatter(withSuggestions, incomingFm);
        // Tag union includes the merge skill's tag list.
        const mergedTags = new Set([
          ...readTagList(finalFm.tags),
          ...m.result.tags,
        ]);
        if (mergedTags.size > 0) finalFm.tags = [...mergedTags];
        finalBody = m.result.mergedBody;
      } catch (err) {
        console.warn(
          '[import.apply] merge skill failed, falling back to append:',
          err,
        );
        finalFm = mergeFrontmatter(existingFm, incomingFm);
        finalBody = appendMergeBody(
          existing.content_md,
          rewrittenBody,
          pn.basename,
        );
      }
    } else {
      finalFm = mergeFrontmatter(existingFm, incomingFm);
      finalBody = appendMergeBody(
        existing.content_md,
        rewrittenBody,
        pn.basename,
      );
    }
  } else {
    finalFm = incomingFm;
    finalBody = rewrittenBody;
  }

  const finalMd = composeMarkdown(finalFm, finalBody);

  writeNote({
    groupId,
    userId,
    path: targetPath,
    markdown: finalMd,
    frontmatter: finalFm,
    isUpdate: !!existing,
    noteId: existing?.id,
  });

  if (existing) summary.merged++;
  else if (opts.forceKeepInPlace) summary.keptInPlace++;
  else summary.moved++;
}

function pickTargetPath(
  pn: PlannedNote,
  classification: ImportClassifyResult | null,
): string {
  if (!classification) return pn.sourcePath;
  if (classification.kind === 'plain') return pn.sourcePath;
  if (classification.confidence < 0.4) return pn.sourcePath;
  const proposed = classification.canonicalPath.trim();
  if (!proposed) return pn.sourcePath;
  return proposed.replace(/^\/+|\/+$/g, '');
}

// ── Frontmatter + body merging ─────────────────────────────────────────

function buildIncomingFrontmatter(
  existingFm: Record<string, unknown>,
  c: ImportClassifyResult | null,
  portraitVaultPath: string | null,
): Record<string, unknown> {
  const fm: Record<string, unknown> = { ...existingFm };
  if (!c) return fm;

  // Kind + template + role.
  if (c.kind === 'character' && c.role) {
    fm.kind = 'character';
    fm.role = c.role;
    fm.template = c.role;
  } else if (c.kind === 'item' || c.kind === 'location' || c.kind === 'session') {
    fm.kind = c.kind;
    fm.template = c.kind;
  }

  // Sheet: AI-extracted fields fill blanks; existing values win.
  const incomingSheet = c.sheet ?? {};
  const currentSheet =
    fm.sheet && typeof fm.sheet === 'object'
      ? ({ ...(fm.sheet as Record<string, unknown>) } as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  // Seed name from the classifier when the sheet has none.
  if (!currentSheet.name && c.displayName) {
    currentSheet.name = c.displayName;
  }
  for (const [k, v] of Object.entries(incomingSheet)) {
    if (currentSheet[k] == null) currentSheet[k] = v;
  }
  if (Object.keys(currentSheet).length > 0) fm.sheet = currentSheet;

  // Portrait.
  if (portraitVaultPath && !fm.portrait) {
    fm.portrait = portraitVaultPath;
  }

  // Tags — union of existing + classifier's suggestions, lowercased,
  // capped so a runaway model can't spam.
  const existingTags = readTagList(fm.tags);
  const merged = [...new Set([...existingTags, ...c.tags.map((t) => t.toLowerCase())])];
  if (merged.length > 0) fm.tags = merged.slice(0, 12);

  return fm;
}

function mergeFrontmatter(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  // Existing keys win per the merge rule; incoming fills blanks.
  // Tags + sheet get deep-merged.
  const out: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(incoming)) {
    if (k === 'tags') {
      const a = readTagList(existing.tags);
      const b = readTagList(v);
      out.tags = [...new Set([...a, ...b])];
      continue;
    }
    if (k === 'sheet') {
      const a =
        existing.sheet && typeof existing.sheet === 'object'
          ? (existing.sheet as Record<string, unknown>)
          : {};
      const b = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...a };
      for (const [sk, sv] of Object.entries(b)) {
        if (merged[sk] == null) merged[sk] = sv;
      }
      out.sheet = merged;
      continue;
    }
    if (out[k] == null) out[k] = v;
  }
  return out;
}

function appendMergeBody(
  existingMd: string,
  incomingBody: string,
  incomingBasename: string,
): string {
  if (incomingBody.trim().length === 0) return existingMd;
  const today = new Date().toISOString().slice(0, 10);
  return (
    existingMd.trimEnd() +
    `\n\n---\n_Imported ${today} from ${incomingBasename}_\n---\n\n` +
    incomingBody
  );
}

// ── Wikilink rewriting ─────────────────────────────────────────────────

function rewriteWikilinks(
  body: string,
  links: Array<{ anchorText: string; target: string }>,
): string {
  let out = body;
  for (const link of links) {
    const anchor = link.anchorText?.trim();
    const target = link.target?.trim();
    if (!anchor || !target) continue;
    // Strip the .md suffix for rendering — ingestMarkdown handles
    // resolution based on path.
    const niceTarget = target.replace(/\.md$/i, '');
    const idx = out.indexOf(anchor);
    if (idx === -1) continue;
    const before = idx >= 2 ? out.slice(idx - 2, idx) : '';
    const afterStart = idx + anchor.length;
    const after = out.slice(afterStart, afterStart + 2);
    if (before === '[[' || after === ']]') continue; // already wikilinked
    // Use target|anchor to preserve the prose label.
    out =
      out.slice(0, idx) +
      `[[${niceTarget}|${anchor}]]` +
      out.slice(afterStart);
  }
  return out;
}

// ── Persistence ────────────────────────────────────────────────────────

export type WriteOpts = {
  groupId: string;
  userId: string;
  path: string;
  markdown: string;
  frontmatter: Record<string, unknown>;
  isUpdate: boolean;
  noteId?: string | undefined;
};

export function writeNote(opts: WriteOpts): void {
  const db = getDb();

  // Run md-to-pm so we generate the same contentJson + wikilinks /
  // tags index that a live save would. The context here intentionally
  // carries no allPaths — we haven't committed the full drop yet, so
  // everything resolves either against the vault (existing notes)
  // or as an orphan wikilink. The vault-wide resolver runs on
  // subsequent saves anyway.
  const vaultPaths = db
    .query<{ path: string }, [string]>(
      'SELECT path FROM notes WHERE group_id = ?',
    )
    .all(opts.groupId)
    .map((r) => r.path);
  const assetsByName = new Map<string, { id: string; mime: string }>();
  for (const a of db
    .query<AssetRow, [string]>(
      'SELECT * FROM assets WHERE group_id = ?',
    )
    .all(opts.groupId)) {
    assetsByName.set(a.original_name, { id: a.id, mime: a.mime });
    assetsByName.set(a.original_name.toLowerCase(), { id: a.id, mime: a.mime });
  }

  const ctx: IngestContext = {
    allPaths: new Set(vaultPaths),
    aliasMap: new Map(),
    assetsByName,
  };

  // Re-attach the frontmatter for ingestMarkdown to read — it
  // expects a raw file string with `---\n…\n---\n<body>`.
  const fullRaw = composeMarkdown(opts.frontmatter, stripFrontmatter(opts.markdown));
  const ingest: NoteIngest = ingestMarkdown(opts.path, fullRaw, ctx);

  const schema = getPmSchema();
  const ydoc = prosemirrorJSONToYDoc(
    schema,
    ingest.contentJson as object,
    'default',
  );
  ydoc.getText('title').insert(0, ingest.title);
  const yjsState = Y.encodeStateAsUpdate(ydoc);
  const contentMd = pmToMarkdown(ingest.contentJson);

  const now = Date.now();

  if (opts.isUpdate && opts.noteId) {
    db.query(
      `UPDATE notes SET title = ?, content_json = ?, content_text = ?,
                         content_md = ?, yjs_state = ?, frontmatter_json = ?,
                         byte_size = ?, updated_at = ?, updated_by = ?
         WHERE id = ?`,
    ).run(
      ingest.title,
      JSON.stringify(ingest.contentJson),
      ingest.contentText,
      contentMd,
      yjsState,
      JSON.stringify(ingest.frontmatter),
      contentMd.length,
      now,
      opts.userId,
      opts.noteId,
    );
  } else {
    const id = randomUUID();
    db.query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                          content_md, yjs_state, frontmatter_json, byte_size,
                          updated_at, updated_by, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      opts.groupId,
      opts.path,
      ingest.title,
      JSON.stringify(ingest.contentJson),
      ingest.contentText,
      contentMd,
      yjsState,
      JSON.stringify(ingest.frontmatter),
      contentMd.length,
      now,
      opts.userId,
      now,
      opts.userId,
    );
  }

  // Replace denormalised tags + links.
  db.query('DELETE FROM note_links WHERE group_id = ? AND from_path = ?').run(
    opts.groupId,
    opts.path,
  );
  db.query('DELETE FROM tags WHERE group_id = ? AND path = ?').run(
    opts.groupId,
    opts.path,
  );
  const insertLink = db.query(
    'INSERT OR IGNORE INTO note_links (group_id, from_path, to_path) VALUES (?, ?, ?)',
  );
  for (const link of ingest.wikilinks) insertLink.run(opts.groupId, opts.path, link);
  const insertTag = db.query(
    'INSERT OR IGNORE INTO tags (group_id, path, tag) VALUES (?, ?, ?)',
  );
  for (const tag of ingest.tags) insertTag.run(opts.groupId, opts.path, tag);

  // Structured-note derivation + campaign auto-registration.
  try {
    deriveAllIndexes({
      groupId: opts.groupId,
      notePath: opts.path,
      frontmatterJson: JSON.stringify(ingest.frontmatter),
    });
  } catch (err) {
    console.error('[import.apply] derive failed for', opts.path, err);
  }
}

// ── Asset handling ─────────────────────────────────────────────────────

function commitAssociatedImages(
  job: ImportJob,
  c: ImportClassifyResult,
  assetsByBasename: Map<string, ParsedAsset>,
  entryByPath: Map<string, AdmZip.IZipEntry>,
  committedAssets: Set<string>,
  summary: ApplySummary,
): string | null {
  let portraitPath: string | null = null;
  const folder = pickAssetFolder(c);

  for (const basename of c.associatedImages ?? []) {
    const key = basename.toLowerCase();
    const asset = assetsByBasename.get(key);
    if (!asset) continue;
    const entry = entryByPath.get(asset.sourcePath);
    if (!entry) continue;
    const canonical = `${folder}/${asset.basename}`;
    try {
      commitAsset(job, entry.getData(), canonical);
      summary.assetsCommitted++;
      committedAssets.add(key);
      if (
        !portraitPath &&
        c.portraitImage &&
        c.portraitImage.toLowerCase() === key
      ) {
        portraitPath = canonical;
      }
    } catch (err) {
      summary.errors.push({
        sourcePath: asset.sourcePath,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // If no images were associated but a portrait was named, still try it.
  if (!portraitPath && c.portraitImage) {
    const key = c.portraitImage.toLowerCase();
    const asset = assetsByBasename.get(key);
    if (asset) {
      const entry = entryByPath.get(asset.sourcePath);
      if (entry) {
        const canonical = `${folder}/${asset.basename}`;
        try {
          commitAsset(job, entry.getData(), canonical);
          summary.assetsCommitted++;
          committedAssets.add(key);
          portraitPath = canonical;
        } catch {
          /* ignore — surfaced in loop above if double-processing */
        }
      }
    }
  }
  return portraitPath;
}

function pickAssetFolder(c: ImportClassifyResult): string {
  switch (c.kind) {
    case 'character':
      return 'Assets/Portraits';
    case 'location':
      return 'Assets/Maps';
    default:
      return 'Assets';
  }
}

/** Idempotent content-addressed asset write + row insert. `Canonical
 *  path` lands in the assets.original_path column so the by-path
 *  resolver can find it; the on-disk blob is deduped via sha256. */
export function commitAsset(
  job: ImportJob,
  data: Buffer,
  canonicalPath: string,
): void {
  const basename = canonicalPath.split('/').pop()!;
  const mime = sniffMime(data, basename);
  if (!isSupportedMime(mime)) {
    throw new Error(`unsupported mime ${mime}`);
  }
  const hash = createHash('sha256').update(data).digest('hex');
  const db = getDb();

  const existing = db
    .query<AssetRow, [string, string]>(
      'SELECT * FROM assets WHERE group_id = ? AND hash = ?',
    )
    .get(job.groupId, hash);
  if (existing) {
    // The asset already exists in this group — just reuse. Its
    // original_path may differ; the resolver falls back to basename
    // for new references.
    return;
  }

  const diskPath = assetPath(hash, mime);
  if (!existsSync(diskPath)) writeFileSync(diskPath, data);

  const id = randomUUID();
  const now = Date.now();
  db.query(
    `INSERT INTO assets
       (id, group_id, hash, mime, size, original_name, original_path,
        uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    job.groupId,
    hash,
    mime,
    data.byteLength,
    basename,
    canonicalPath,
    job.createdBy,
    now,
  );
}

// ── Helpers ────────────────────────────────────────────────────────────

function splitFrontmatter(raw: string): { body: string } {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) {
    return { body: raw };
  }
  const end = raw.indexOf('\n---', 4);
  if (end === -1) return { body: raw };
  return { body: raw.slice(end + 4) };
}

function stripFrontmatter(raw: string): string {
  return splitFrontmatter(raw).body;
}

export function composeMarkdown(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  if (Object.keys(frontmatter).length === 0) return body.trimStart();
  const yaml = YAML.stringify(frontmatter).trimEnd();
  const trimmedBody = body.replace(/^\s+/, '');
  return `---\n${yaml}\n---\n\n${trimmedBody}`;
}

function parseJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readTagList(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.replace(/^#/, '').toLowerCase())
      .filter(Boolean);
  }
  if (typeof v === 'string') {
    return v
      .split(/[,\s]+/)
      .filter(Boolean)
      .map((t) => t.replace(/^#/, '').toLowerCase());
  }
  return [];
}

function mergeStats(job: ImportJob, summary: ApplySummary): unknown {
  const prior = (job.stats ?? {}) as Record<string, unknown>;
  return {
    ...prior,
    apply: summary,
    appliedAt: Date.now(),
  };
}
