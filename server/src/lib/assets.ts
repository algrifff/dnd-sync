// Content-addressed asset storage. Assets live on disk at
// /data/assets/<sha256>.<ext>; the `assets` table holds metadata.
// Same file uploaded twice (across any note or user) lands as one
// blob on disk — the UNIQUE(group_id, hash) constraint dedupes.
//
// Magic-byte MIME sniffing protects against content-type spoofing on
// upload (an image.png extension that's actually a .exe payload).
// Allowlist below reflects what we'll actually render.

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getDb } from './db';

export type AssetRow = {
  id: string;
  group_id: string;
  hash: string;
  mime: string;
  size: number;
  original_name: string;
  uploaded_by: string | null;
  uploaded_at: number;
};

const SUPPORTED_MIMES = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'application/octet-stream', // last-resort fallback
]);

const EXTENSION_FOR_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'application/octet-stream': 'bin',
};

function assetRootDir(): string {
  const raw = process.env.DATA_DIR ?? './.data';
  const abs = resolve(raw);
  const dir = join(abs, 'assets');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function assetPath(hash: string, mime: string): string {
  const ext = EXTENSION_FOR_MIME[mime] ?? 'bin';
  return join(assetRootDir(), `${hash}.${ext}`);
}

/** Magic-byte MIME sniffer. Reads the first 16 bytes of a buffer and
 *  returns a conservative MIME string. Falls back to
 *  application/octet-stream rather than trusting the client. */
export function sniffMime(buf: Uint8Array, filename: string | null): string {
  const hex = (start: number, end: number): string =>
    Array.from(buf.slice(start, end))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

  const first4 = hex(0, 4);
  const first8 = hex(0, 8);
  const first12 = hex(0, 12);

  // Images
  if (first8 === '89504e470d0a1a0a') return 'image/png';
  if (first4 === 'ffd8ffe0' || first4 === 'ffd8ffe1' || first4 === 'ffd8ffdb' || first4 === 'ffd8ffee')
    return 'image/jpeg';
  if (first4 === '47494638') return 'image/gif';
  if (first4 === '52494646' && hex(8, 12) === '57454250') return 'image/webp';
  // SVG is text-based — sniff by heuristic
  if (buf.byteLength > 10) {
    const head = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, 256)).trimStart();
    if (head.startsWith('<?xml') || head.startsWith('<svg')) return 'image/svg+xml';
  }

  // PDF
  if (first4 === '25504446') return 'application/pdf';

  // Video containers: MP4/MOV share `ftyp` at offset 4
  if (hex(4, 8) === '66747970') {
    const brand = new TextDecoder().decode(buf.slice(8, 12)).replace(/\0+$/, '');
    if (brand === 'qt  ') return 'video/quicktime';
    if (brand === 'isom' || brand === 'iso2' || brand === 'mp41' || brand === 'mp42' || brand === 'avc1')
      return 'video/mp4';
    return 'video/mp4';
  }
  if (first4 === '1a45dfa3') return 'video/webm';

  // Audio
  if (first4 === '52494646' && hex(8, 12) === '57415645') return 'audio/wav';
  if (first4 === '4f676753') return 'audio/ogg';
  if (first12.startsWith('494433') || first4.startsWith('fff')) {
    // ID3 tag or MPEG audio frame sync.
    return 'audio/mpeg';
  }

  // Filename extension as a last hint (only for types we allow).
  const ext = filename?.split('.').pop()?.toLowerCase() ?? '';
  const fromExt: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
  };
  return fromExt[ext] ?? 'application/octet-stream';
}

export function isSupportedMime(mime: string): boolean {
  return SUPPORTED_MIMES.has(mime);
}

export type StoredAsset = {
  id: string;
  hash: string;
  mime: string;
  size: number;
  originalName: string;
  reused: boolean;
};

/** Write a buffer to /data/assets/<hash>.<ext> and insert a row.
 *  Returns `reused: true` if the (group_id, hash) was already stored. */
export function storeAssetFromBuffer(
  buf: Uint8Array,
  originalName: string,
  groupId: string,
  uploadedBy: string | null,
): StoredAsset {
  const mime = sniffMime(buf, originalName);
  if (!isSupportedMime(mime)) {
    throw new Error(`rejected asset ${originalName}: unsupported mime ${mime}`);
  }

  const hasher = createHash('sha256');
  hasher.update(buf);
  const hash = hasher.digest('hex');

  // Dedup.
  const existing = getDb()
    .query<AssetRow, [string, string]>(
      'SELECT * FROM assets WHERE group_id = ? AND hash = ?',
    )
    .get(groupId, hash);
  if (existing) {
    return {
      id: existing.id,
      hash: existing.hash,
      mime: existing.mime,
      size: existing.size,
      originalName: existing.original_name,
      reused: true,
    };
  }

  const path = assetPath(hash, mime);
  if (!existsSync(path)) writeFileSync(path, buf);

  const id = randomUUID();
  const now = Date.now();
  getDb()
    .query(
      `INSERT INTO assets (id, group_id, hash, mime, size, original_name, uploaded_by, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, groupId, hash, mime, buf.byteLength, originalName, uploadedBy, now);

  return {
    id,
    hash,
    mime,
    size: buf.byteLength,
    originalName,
    reused: false,
  };
}

/** Atomically move a temp file into the asset store; returns StoredAsset.
 *  Used when uploads streamed to disk (so we never hold 100 MB in RAM). */
export function storeAssetFromTempFile(
  tempPath: string,
  originalName: string,
  sniffBuffer: Uint8Array,
  hash: string,
  size: number,
  groupId: string,
  uploadedBy: string | null,
): StoredAsset {
  const mime = sniffMime(sniffBuffer, originalName);
  if (!isSupportedMime(mime)) {
    safelyRemove(tempPath);
    throw new Error(`rejected asset ${originalName}: unsupported mime ${mime}`);
  }

  const existing = getDb()
    .query<AssetRow, [string, string]>(
      'SELECT * FROM assets WHERE group_id = ? AND hash = ?',
    )
    .get(groupId, hash);
  if (existing) {
    safelyRemove(tempPath);
    return {
      id: existing.id,
      hash: existing.hash,
      mime: existing.mime,
      size: existing.size,
      originalName: existing.original_name,
      reused: true,
    };
  }

  const dest = assetPath(hash, mime);
  if (existsSync(dest)) safelyRemove(tempPath);
  else renameSync(tempPath, dest);

  const id = randomUUID();
  const now = Date.now();
  getDb()
    .query(
      `INSERT INTO assets (id, group_id, hash, mime, size, original_name, uploaded_by, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, groupId, hash, mime, size, originalName, uploadedBy, now);

  return { id, hash, mime, size, originalName, reused: false };
}

function safelyRemove(p: string): void {
  try {
    rmSync(p, { force: true });
  } catch {
    /* best-effort */
  }
}

/** Look up by (group_id, id). Used by the /api/assets/[id] route. */
export type AssetListEntry = {
  id: string;
  mime: string;
  size: number;
  originalName: string;
  originalPath: string;
  uploadedAt: number;
};

type AssetListDbRow = {
  id: string;
  mime: string;
  size: number;
  original_name: string;
  original_path: string | null;
  uploaded_at: number;
};

/** All assets in a group, for the /assets gallery. */
export function listGroupAssets(groupId: string): AssetListEntry[] {
  return getDb()
    .query<AssetListDbRow, [string]>(
      `SELECT id, mime, size, original_name, original_path, uploaded_at
         FROM assets
        WHERE group_id = ?
        ORDER BY original_path COLLATE NOCASE`,
    )
    .all(groupId)
    .map((r) => ({
      id: r.id,
      mime: r.mime,
      size: r.size,
      originalName: r.original_name,
      originalPath: r.original_path ?? r.original_name,
      uploadedAt: r.uploaded_at,
    }));
}

export type AssetListEntryWithTags = AssetListEntry & { tags: string[] };

/** All assets in a group with their tags, for the /assets gallery. */
export function listGroupAssetsWithTags(groupId: string): AssetListEntryWithTags[] {
  const assets = listGroupAssets(groupId);

  const tagRows = getDb()
    .query<{ asset_id: string; tag: string }, [string]>(
      'SELECT asset_id, tag FROM asset_tags WHERE group_id = ? ORDER BY tag ASC',
    )
    .all(groupId);

  const tagMap = new Map<string, string[]>();
  for (const row of tagRows) {
    const arr = tagMap.get(row.asset_id) ?? [];
    arr.push(row.tag);
    tagMap.set(row.asset_id, arr);
  }

  return assets.map((a) => ({ ...a, tags: tagMap.get(a.id) ?? [] }));
}

export function getAssetById(id: string, groupId: string): AssetRow | null {
  return (
    getDb()
      .query<AssetRow, [string, string]>(
        'SELECT * FROM assets WHERE id = ? AND group_id = ?',
      )
      .get(id, groupId) ?? null
  );
}

/** Runtime fallback lookup for image `<img src="Campaign 2/...">` style
 *  references that slipped past ingest-time resolution. Tries the full
 *  vault path first (original_path), then the basename (original_name).
 *  Matching is case-insensitive. If multiple rows share a basename we
 *  take the most recently uploaded; precise full-path matches already
 *  beat that path. */
export function getAssetByVaultPath(
  path: string,
  groupId: string,
): AssetRow | null {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    /* leave as-is */
  }
  const db = getDb();
  const byPath = db
    .query<AssetRow, [string, string]>(
      `SELECT * FROM assets
         WHERE group_id = ?
           AND LOWER(original_path) = LOWER(?)
         LIMIT 1`,
    )
    .get(groupId, decoded);
  if (byPath) return byPath;

  const basename = decoded.split('/').pop() ?? decoded;
  return (
    db
      .query<AssetRow, [string, string]>(
        `SELECT * FROM assets
           WHERE group_id = ?
             AND LOWER(original_name) = LOWER(?)
           ORDER BY uploaded_at DESC
           LIMIT 1`,
      )
      .get(groupId, basename) ?? null
  );
}
