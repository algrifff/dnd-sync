// GET /api/plugin/bundle — streams the current main.js bytes.
// Any authenticated caller (admin OR player) can download.

import type { NextRequest } from 'next/server';
import { requireRequestAuth } from '@/lib/auth';
import { getPluginBundle } from '@/lib/plugin-bundle';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const auth = requireRequestAuth(req);
  if (auth instanceof Response) return auth;

  const { bytes, hash } = getPluginBundle();
  // Copy into a fresh ArrayBuffer-backed view so BodyInit accepts it.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);

  return new Response(copy, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Content-Length': String(bytes.byteLength),
      'X-Compendium-Hash': hash,
      'Cache-Control': 'no-store',
    },
  });
}
