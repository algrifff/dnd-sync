// Classical parse pass for an import job.
//
// Runs inline on upload — no AI, just a walk of the ZIP to surface
// counts, file shapes, and everything the AI skill will need as
// context (known note paths, image basenames, existing tags + links).
// The result lands in import_jobs.plan_json so the review UI and the
// eventual analyse step can both read it without re-opening the zip.
//
// This is deliberately cheap: no DB writes, no hash computation, no
// MIME-sniffing beyond reading a few magic bytes for images. If the
// user cancels mid-review none of this needs to be unwound.

import { randomUUID, createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import YAML from 'yaml';
import { sniffMime, isSupportedMime } from './assets';

// The sections below are mirror-writable: stable shape consumed by
// both the chat UI and the server's AI-analyse step.
export type ParsedNote = {
  id: string;                            // stable per-entry id for review
  sourcePath: string;                    // path inside the uploaded ZIP
  basename: string;
  bytes: number;
  content: string;                       // full markdown body (post-frontmatter)
  existingFrontmatter: Record<string, unknown>;
  existingWikilinks: string[];           // [[target]] / ![[target]]
  existingTags: string[];                // frontmatter + inline #tags
  contentHash: string;                   // sha256 of raw file, for merge dedupe
};

export type ParsedAsset = {
  id: string;
  sourcePath: string;
  basename: string;
  size: number;
  mime: string;
};

export type SkippedEntry = {
  sourcePath: string;
  reason: string;
};

export type ImportPlan = {
  notes: ParsedNote[];
  assets: ParsedAsset[];
  skipped: SkippedEntry[];
  totals: {
    noteCount: number;
    assetCount: number;
    skippedCount: number;
    totalBytes: number;
  };
};

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf',
  '.mp4', '.webm', '.mov', '.mp3', '.wav', '.ogg',
]);
const SKIP_PREFIXES = [
  '.obsidian/',      // Obsidian metadata
  '.trash/',         // Obsidian trash
  '__MACOSX/',       // macOS zip artifacts
  '.git/',           // git metadata
  '.file-revisions/',// OneDrive/SharePoint revision history
  '.Trash/',         // Google Drive / generic trash
  'node_modules/',   // stray dev folders
];
const SKIP_BASENAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.localized']);
const PER_FILE_CAP = 25 * 1024 * 1024;
const TOTAL_UNCOMPRESSED_CAP = 1024 * 1024 * 1024;

export function parseImportZip(zipPath: string): ImportPlan {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  const notes: ParsedNote[] = [];
  const assets: ParsedAsset[] = [];
  const skipped: SkippedEntry[] = [];
  let totalBytes = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const relPath = entry.entryName.replace(/\\/g, '/');
    const bname = relPath.split('/').pop() ?? '';

    if (!isSafePath(relPath)) {
      skipped.push({ sourcePath: relPath, reason: 'unsafe path' });
      continue;
    }
    if (SKIP_PREFIXES.some((p) => relPath.startsWith(p))) continue;
    if (SKIP_BASENAMES.has(bname)) continue;

    const size = entry.header.size;
    if (size > PER_FILE_CAP) {
      skipped.push({ sourcePath: relPath, reason: `file > ${PER_FILE_CAP} B` });
      continue;
    }
    totalBytes += size;
    if (totalBytes > TOTAL_UNCOMPRESSED_CAP) {
      throw new Error(`zip total exceeds ${TOTAL_UNCOMPRESSED_CAP} bytes`);
    }

    const dot = bname.lastIndexOf('.');
    const ext = dot >= 0 ? bname.slice(dot).toLowerCase() : '';

    if (MARKDOWN_EXTENSIONS.has(ext)) {
      const raw = entry.getData().toString('utf-8');
      notes.push(parseNote(relPath, raw));
      continue;
    }
    if (BINARY_EXTENSIONS.has(ext)) {
      const data = entry.getData();
      const mime = sniffMime(data, bname);
      if (!isSupportedMime(mime)) {
        skipped.push({ sourcePath: relPath, reason: `unsupported mime ${mime}` });
        continue;
      }
      assets.push({
        id: randomUUID(),
        sourcePath: relPath,
        basename: bname,
        size: data.byteLength,
        mime,
      });
      continue;
    }
    skipped.push({ sourcePath: relPath, reason: `unknown extension ${ext || '(none)'}` });
  }

  return {
    notes,
    assets,
    skipped,
    totals: {
      noteCount: notes.length,
      assetCount: assets.length,
      skippedCount: skipped.length,
      totalBytes,
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

function parseNote(sourcePath: string, raw: string): ParsedNote {
  const { data: frontmatter, rest } = extractFrontmatter(raw);
  const wikilinks = extractWikilinks(rest);
  const tags = mergeTags(extractFrontmatterTags(frontmatter), extractInlineTags(rest));
  const basename = sourcePath.split('/').pop() ?? sourcePath;
  return {
    id: randomUUID(),
    sourcePath,
    basename,
    bytes: Buffer.byteLength(raw, 'utf-8'),
    content: rest,
    existingFrontmatter: frontmatter,
    existingWikilinks: wikilinks,
    existingTags: tags,
    contentHash: createHash('sha256').update(raw).digest('hex'),
  };
}

function extractFrontmatter(raw: string): {
  data: Record<string, unknown>;
  rest: string;
} {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) {
    return { data: {}, rest: raw };
  }
  const end = raw.indexOf('\n---', 4);
  if (end === -1) return { data: {}, rest: raw };
  const yaml = raw.slice(4, end);
  try {
    const parsed = YAML.parse(yaml);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        data: parsed as Record<string, unknown>,
        rest: raw.slice(end + 4),
      };
    }
  } catch {
    /* fall through */
  }
  return { data: {}, rest: raw };
}

/** Obsidian's `[[target]]` and `![[target]]` forms, with optional
 *  `|alias`. We dedupe targets; labels get thrown away (they're not
 *  useful for the AI, only the target is). */
function extractWikilinks(body: string): string[] {
  const out = new Set<string>();
  const re = /!?\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const target = match[1]!.trim();
    if (target) out.add(target);
  }
  return [...out];
}

/** Inline `#tag` mentions — anywhere a hash sits at a word boundary
 *  and precedes a valid tag charset. Avoids URLs and headings. */
function extractInlineTags(body: string): string[] {
  const out = new Set<string>();
  // Strip fenced code blocks before scanning; Obsidian follows the
  // same rule (tags inside ``` aren't real tags).
  const stripped = body.replace(/```[\s\S]*?```/g, '');
  const re = /(?:^|[^\w#&/])#([A-Za-z][A-Za-z0-9_/-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped)) !== null) {
    out.add(match[1]!.toLowerCase());
  }
  return [...out];
}

function extractFrontmatterTags(fm: Record<string, unknown>): string[] {
  const raw = fm.tags ?? fm.tag;
  if (Array.isArray(raw)) {
    return raw
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.replace(/^#/, '').toLowerCase())
      .filter(Boolean);
  }
  if (typeof raw === 'string') {
    return raw
      .split(/[,\s]+/)
      .filter(Boolean)
      .map((v) => v.replace(/^#/, '').toLowerCase());
  }
  return [];
}

function mergeTags(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

function isSafePath(relPath: string): boolean {
  if (relPath.length === 0) return false;
  if (relPath.startsWith('/')) return false;
  const parts = relPath.split('/');
  return !parts.some((p) => p === '..' || p === '');
}
