// GET /api/inventory — cheap listing of every known path (both text docs
// and binary files) with metadata. The plugin calls this at startup to
// discover docs that exist on the server but not on the local disk yet.

import type { NextRequest } from 'next/server';
import { requireRequestAuth } from '@/lib/auth';
import { getDb } from '@/lib/db';

type TextEntry = { path: string; updatedAt: number; bytes: number };
type BinaryEntry = {
  path: string;
  mimeType: string;
  size: number;
  updatedAt: number;
  contentHash: string;
};

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const auth = requireRequestAuth(req);
  if (auth instanceof Response) return auth;

  const db = getDb();

  const textDocs = db
    .query<TextEntry, []>(
      `SELECT path, updated_at AS updatedAt, length(yjs_state) AS bytes
         FROM text_docs
         ORDER BY path`,
    )
    .all();

  const binaryFiles = db
    .query<BinaryEntry, []>(
      `SELECT path,
              mime_type     AS mimeType,
              size,
              updated_at    AS updatedAt,
              content_hash  AS contentHash
         FROM binary_files
         ORDER BY path`,
    )
    .all();

  return Response.json({ textDocs, binaryFiles });
}
