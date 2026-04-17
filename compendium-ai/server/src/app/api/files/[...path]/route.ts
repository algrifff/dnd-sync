// Binary file storage. GET reads a blob, PUT writes one, DELETE removes.
// Paths can be nested (e.g. /api/files/Assets/Portraits/arin.png).

import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { requireRequestAuth } from '@/lib/auth';
import { getDb } from '@/lib/db';

type RouteCtx = { params: Promise<{ path: string[] }> };

function decodePath(segments: string[]): string {
  return segments.map((s) => decodeURIComponent(s)).join('/');
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const auth = requireRequestAuth(req);
  if (auth instanceof Response) return auth;

  const { path: segments } = await ctx.params;
  const path = decodePath(segments);

  const row = getDb()
    .query<
      { data: Uint8Array; mime_type: string; size: number; updated_at: number },
      [string]
    >('SELECT data, mime_type, size, updated_at FROM binary_files WHERE path = ?')
    .get(path);

  if (!row) return new Response('not found', { status: 404 });

  // Copy into a fresh ArrayBuffer-backed Uint8Array so BlobPart's narrow
  // BufferSource type accepts it (SharedArrayBuffer-safe view). The data
  // fits in memory because we already chose to store blobs in SQLite.
  const copy = new Uint8Array(row.data.byteLength);
  copy.set(row.data);
  const body = new Blob([copy], { type: row.mime_type });
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': row.mime_type,
      'Content-Length': String(row.size),
      'Last-Modified': new Date(row.updated_at).toUTCString(),
      'Cache-Control': 'no-store',
    },
  });
}

export async function PUT(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const auth = requireRequestAuth(req);
  if (auth instanceof Response) return auth;

  const { path: segments } = await ctx.params;
  const path = decodePath(segments);

  const buf = await req.arrayBuffer();
  const data = new Uint8Array(buf);
  const mime = req.headers.get('content-type') ?? 'application/octet-stream';
  const now = Date.now();
  const contentHash = createHash('sha256').update(data).digest('hex');

  getDb()
    .query(
      `INSERT INTO binary_files (path, data, mime_type, size, content_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           data         = excluded.data,
           mime_type    = excluded.mime_type,
           size         = excluded.size,
           content_hash = excluded.content_hash,
           updated_at   = excluded.updated_at`,
    )
    .run(path, data, mime, data.byteLength, contentHash, now);

  return Response.json({ ok: true, path, size: data.byteLength, updatedAt: now, contentHash });
}

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const auth = requireRequestAuth(req);
  if (auth instanceof Response) return auth;

  const { path: segments } = await ctx.params;
  const path = decodePath(segments);

  const res = getDb().query('DELETE FROM binary_files WHERE path = ?').run(path);
  return Response.json({ ok: true, deleted: Number(res.changes) });
}
