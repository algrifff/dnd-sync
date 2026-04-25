// POST /api/me/characters/import-pdf — extract a D&D character sheet PDF
// and create a NEW user-level character with the extracted data in one
// shot. Streams NDJSON progress events so the client can render live
// feedback during the OpenAI extraction (which typically runs 20–30s).
//
// Body: multipart/form-data with a `file` field (application/pdf).
// Response: stream of newline-delimited JSON, one event per line:
//   { "stage": "reading_text" | "extracting" | "building" | "saving" }
//   { "field": <label>, "value": <string> }
//   { "result": { "id": string, "name": string } }
//   { "error": <code>, "reason"?: <string> }
// Auth: requireSession + CSRF.

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import { createUserCharacter, updateUserCharacter } from '@/lib/userCharacters';
import { extractPdfText } from '@/lib/pdfImport/extractText';
import { extractCharacterFromText } from '@/lib/pdfImport/extractCharacter';
import { buildImportPatch } from '@/lib/pdfImport/transform';
import { ingestMarkdown } from '@/lib/md-to-pm';

export const dynamic = 'force-dynamic';

const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10 MB

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  if (!process.env.OPENAI_API_KEY) {
    return jsonError('ai_unavailable', 'OPENAI_API_KEY not set', 503);
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    return jsonError(
      'invalid_body',
      err instanceof Error ? err.message : 'bad form data',
      400,
    );
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return jsonError('invalid_body', 'missing file field', 400);
  }
  if (file.size === 0) return jsonError('empty_file', null, 400);
  if (file.size > MAX_PDF_BYTES) {
    return jsonError('too_large', `max ${MAX_PDF_BYTES} bytes`, 400);
  }
  if (!isPdfMimeOrName(file)) {
    return jsonError('unsupported_type', 'PDF only', 400);
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch (err) {
    return jsonError(
      'read_failed',
      err instanceof Error ? err.message : 'bad',
      400,
    );
  }

  const userId = session.userId;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (obj: unknown): void => {
        controller.enqueue(enc.encode(JSON.stringify(obj) + '\n'));
      };
      try {
        send({ stage: 'reading_text' });
        const text = await extractPdfText(buffer);
        if (text.trim().length < 50) {
          send({ error: 'pdf_no_text', reason: 'extracted text is empty or too short' });
          controller.close();
          return;
        }

        send({ stage: 'extracting' });
        const data = await extractCharacterFromText(text);

        if (data.name) send({ field: 'Name', value: data.name });
        if (data.race) send({ field: 'Race', value: data.race });
        if (data.classes && data.classes.length > 0) {
          send({
            field: 'Class',
            value: data.classes
              .map((c) =>
                c.subclass ? `${c.name} ${c.level} (${c.subclass})` : `${c.name} ${c.level}`,
              )
              .join(' / '),
          });
        }
        if (data.background) send({ field: 'Background', value: data.background });
        if (data.ability_scores) {
          const a = data.ability_scores;
          send({
            field: 'Abilities',
            value: `STR ${a.str} · DEX ${a.dex} · CON ${a.con} · INT ${a.int} · WIS ${a.wis} · CHA ${a.cha}`,
          });
        }
        if (data.hit_points_max != null) {
          const cur = data.hit_points_current ?? data.hit_points_max;
          send({ field: 'HP', value: `${cur} / ${data.hit_points_max}` });
        }
        if (data.armor_class != null) {
          send({ field: 'AC', value: String(data.armor_class) });
        }
        if (data.skill_proficiencies && data.skill_proficiencies.length > 0) {
          send({
            field: 'Skill proficiencies',
            value: String(data.skill_proficiencies.length),
          });
        }
        if (data.inventory && data.inventory.length > 0) {
          send({ field: 'Inventory', value: `${data.inventory.length} items` });
        }

        send({ stage: 'building' });
        const patch = buildImportPatch(data);
        let bodyJson: Record<string, unknown> | null = null;
        if (patch.bodyMd.trim()) {
          try {
            const ingest = ingestMarkdown('imported.md', patch.bodyMd, {
              allPaths: new Set<string>(),
              aliasMap: new Map<string, string>(),
              assetsByName: new Map<string, { id: string; mime: string }>(),
            });
            bodyJson = ingest.contentJson as Record<string, unknown>;
          } catch (err) {
            console.error('[me/characters/import-pdf] markdown→pm failed:', err);
          }
        }

        send({ stage: 'saving' });
        const created = createUserCharacter(userId, {
          name: patch.name,
          kind: 'character',
          sheet: patch.sheet,
        });
        if (bodyJson || patch.bodyMd) {
          updateUserCharacter(created.id, userId, {
            bodyJson,
            bodyMd: patch.bodyMd || null,
          });
        }
        send({ result: { id: created.id, name: created.name } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'import failed';
        console.error('[me/characters/import-pdf] failed:', err);
        if (msg.startsWith('pdf_no_text')) {
          send({ error: 'pdf_no_text', reason: msg });
        } else if (msg.includes('pdftotext_missing') || msg.includes('ENOENT')) {
          send({ error: 'pdftotext_unavailable', reason: msg });
        } else if (msg.startsWith('invalid_sheet')) {
          send({ error: 'invalid_sheet', reason: msg });
        } else {
          send({ error: 'import_failed', reason: msg });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}

function isPdfMimeOrName(file: File): boolean {
  if (file.type === 'application/pdf') return true;
  return file.name.toLowerCase().endsWith('.pdf');
}

function jsonError(error: string, reason: string | null, status: number): Response {
  const body = reason ? { error, reason } : { error };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
