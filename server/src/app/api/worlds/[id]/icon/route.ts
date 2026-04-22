// GET    /api/worlds/[id]/icon — serve the stored world icon image.
// POST   /api/worlds/[id]/icon — upload/replace (admin only).
// DELETE /api/worlds/[id]/icon — clear (admin only).
//
// The client resizes the image to ≤ 128 px WebP before upload
// (same as user avatars) so the server doesn't need any image
// tooling. Cache-buster is icon_updated_at, appended as ?v=<ts>
// by the sidebar. GET is gated on group membership — icons may
// reveal a world's theme, so we don't expose them cross-tenant.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getDb } from '@/lib/db';
import {
  clearWorldIcon,
  isGroupMember,
  loadWorldIcon,
  setWorldIcon,
} from '@/lib/groups';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_BYTES = 512 * 1024;

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const { id } = await ctx.params;
  if (!isGroupMember(session.userId, id)) {
    return new Response(null, { status: 404 });
  }

  const icon = loadWorldIcon(id);
  if (!icon) return new Response(null, { status: 404 });

  return new Response(new Uint8Array(icon.blob), {
    status: 200,
    headers: {
      'Content-Type': icon.mime,
      // ?v=<icon_updated_at> means every new upload is a distinct URL
      // so the client's cached copy is never stale — safe to mark
      // immutable on each version.
      'Cache-Control': 'private, max-age=604800, immutable',
    },
  });
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  const { id } = await ctx.params;
  const forbid = requireAdmin(session.userId, id);
  if (forbid) return forbid;

  const mime = req.headers.get('content-type') ?? '';
  if (!ALLOWED_MIMES.has(mime)) {
    return json({ error: 'unsupported_mime', detail: mime }, 415);
  }

  const buf = await req.arrayBuffer();
  if (buf.byteLength === 0) return json({ error: 'empty_body' }, 400);
  if (buf.byteLength > MAX_BYTES) {
    return json({ error: 'too_large', detail: `max ${MAX_BYTES} bytes` }, 413);
  }

  const updatedAt = setWorldIcon(id, new Uint8Array(buf), mime);
  logAudit({
    action: 'world.icon.upload',
    actorId: session.userId,
    groupId: id,
    target: id,
    details: { mime, bytes: buf.byteLength },
  });
  return json({ ok: true, iconVersion: updatedAt });
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  const { id } = await ctx.params;
  const forbid = requireAdmin(session.userId, id);
  if (forbid) return forbid;

  clearWorldIcon(id);
  logAudit({
    action: 'world.icon.clear',
    actorId: session.userId,
    groupId: id,
    target: id,
    details: {},
  });
  return json({ ok: true });
}

function requireAdmin(userId: string, groupId: string): Response | null {
  const row = getDb()
    .query<{ role: string }, [string, string]>(
      'SELECT role FROM group_members WHERE user_id = ? AND group_id = ?',
    )
    .get(userId, groupId);
  if (!row || row.role !== 'admin') return json({ error: 'forbidden' }, 403);
  return null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
