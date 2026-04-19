// GET /api/assets/<id> — streams a binary asset from the Railway
// volume. Range support makes <video> seeking and large-file downloads
// efficient. Cache is private because the asset is scoped to the user's
// group; hash-based id makes it safe to cache forever (immutable).

import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { getAssetById, assetPath } from '@/lib/assets';

export const dynamic = 'force-dynamic';

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const { id } = await ctx.params;
  if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) {
    return new Response('invalid_id', { status: 400 });
  }

  const asset = getAssetById(id, session.currentGroupId);
  if (!asset) return new Response('not_found', { status: 404 });

  const filePath = assetPath(asset.hash, asset.mime);
  if (!existsSync(filePath)) {
    return new Response('asset_missing_from_disk', { status: 410 });
  }

  // Freshen size from stat — the `assets.size` column is authoritative
  // at insert time but falling back to fs.stat is cheap and keeps us
  // robust against any mismatch.
  const diskSize = (await stat(filePath)).size;

  const range = req.headers.get('range');
  const baseHeaders: Record<string, string> = {
    'Content-Type': effectiveMime(asset.mime),
    'Cache-Control': 'private, max-age=3600, immutable',
    'Accept-Ranges': 'bytes',
    ...svgDefenceHeaders(asset.mime),
  };

  if (range) {
    const parsed = parseRange(range, diskSize);
    if (!parsed) {
      return new Response('bad_range', {
        status: 416,
        headers: { 'Content-Range': `bytes */${diskSize}` },
      });
    }
    const [start, end] = parsed;
    const chunk = createReadStream(filePath, { start, end });
    return new Response(toWebStream(chunk), {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Range': `bytes ${start}-${end}/${diskSize}`,
        'Content-Length': String(end - start + 1),
      },
    });
  }

  return new Response(toWebStream(createReadStream(filePath)), {
    status: 200,
    headers: {
      ...baseHeaders,
      'Content-Length': String(diskSize),
    },
  });
}

// Adapter from Node's stream.Readable to the Web Streams API's
// ReadableStream that the fetch Response constructor expects.
// Node 18+ supports Readable.toWeb natively.
function toWebStream(node: Readable): ReadableStream {
  return Readable.toWeb(node) as unknown as ReadableStream;
}

function parseRange(header: string, size: number): [number, number] | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const rawStart = m[1] ?? '';
  const rawEnd = m[2] ?? '';
  let start: number;
  let end: number;
  if (rawStart === '' && rawEnd !== '') {
    // suffix length
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end >= size || start > end) return null;
  return [start, end];
}

function effectiveMime(mime: string): string {
  // Defence in depth: if a browser ever saw an SVG served inline
  // with user-generated content, it could run embedded JS. We mark
  // it as application/octet-stream for delivery and set
  // Content-Disposition: attachment so it doesn't render inline.
  if (mime === 'image/svg+xml') return 'application/octet-stream';
  return mime;
}

function svgDefenceHeaders(mime: string): Record<string, string> {
  if (mime === 'image/svg+xml') return { 'Content-Disposition': 'attachment' };
  return {};
}
