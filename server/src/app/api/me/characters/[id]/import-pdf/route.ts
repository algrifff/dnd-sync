// POST /api/me/characters/[id]/import-pdf — extract a D&D character
// sheet PDF and return a proposed patch. Does NOT write to the DB —
// the client previews + applies via the existing PATCH endpoint.
//
// Body: multipart/form-data with a `file` field (application/pdf).
// Auth: requireSession + CSRF.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { getUserCharacter } from '@/lib/userCharacters';
import { importCharacterFromPdf } from '@/lib/pdfImport';

export const dynamic = 'force-dynamic';

const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10 MB

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  if (!process.env.OPENAI_API_KEY) {
    return json({ error: 'ai_unavailable', reason: 'OPENAI_API_KEY not set' }, 503);
  }

  const { id } = await ctx.params;
  const character = getUserCharacter(id, session.userId);
  if (!character) return json({ error: 'not_found' }, 404);

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    return json(
      { error: 'invalid_body', reason: err instanceof Error ? err.message : 'bad form data' },
      400,
    );
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return json({ error: 'invalid_body', reason: 'missing file field' }, 400);
  }
  if (file.size === 0) {
    return json({ error: 'empty_file' }, 400);
  }
  if (file.size > MAX_PDF_BYTES) {
    return json(
      { error: 'too_large', reason: `max ${MAX_PDF_BYTES} bytes` },
      400,
    );
  }
  if (!isPdfMimeOrName(file)) {
    return json({ error: 'unsupported_type', reason: 'PDF only' }, 400);
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch (err) {
    return json(
      { error: 'read_failed', reason: err instanceof Error ? err.message : 'bad' },
      400,
    );
  }

  try {
    const result = await importCharacterFromPdf(buffer);
    return json(
      {
        ok: true,
        patch: {
          name: result.name,
          sheet: result.sheet,
          bodyJson: result.bodyJson,
          bodyMd: result.bodyMd || null,
        },
      },
      200,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'import failed';
    console.error('[me/characters/import-pdf] failed:', err);
    if (msg.startsWith('pdf_no_text')) {
      return json({ error: 'pdf_no_text', reason: msg }, 422);
    }
    if (msg.includes('pdftotext_missing') || msg.includes('ENOENT')) {
      return json({ error: 'pdftotext_unavailable', reason: msg }, 503);
    }
    return json({ error: 'import_failed', reason: msg }, 500);
  }
}

function isPdfMimeOrName(file: File): boolean {
  if (file.type === 'application/pdf') return true;
  return file.name.toLowerCase().endsWith('.pdf');
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
