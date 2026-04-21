// POST /api/chat/upload — extract readable text from ZIP archives and PDF files
// so the AI assistant can read their contents.
//
// Auth: requireSession (cookie session).
// Body: multipart/form-data with a `file` field.
// Returns: { content: string, fileCount?: number }

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import AdmZip from 'adm-zip';

export const dynamic = 'force-dynamic';

const TEXT_EXTS = new Set([
  '.md', '.txt', '.json', '.yaml', '.yml', '.csv', '.xml',
  '.html', '.htm', '.js', '.ts', '.jsx', '.tsx', '.py',
  '.toml', '.ini', '.conf', '.log', '.rst', '.tex', '.org',
  '.css', '.scss', '.sql',
]);

function isTextEntry(entryName: string): boolean {
  const lower = entryName.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot === -1) return false;
  return TEXT_EXTS.has(lower.slice(dot));
}

/**
 * Best-effort PDF text extraction.
 * Reads string literals from the PDF binary (BT...ET text streams).
 * Works for simple PDFs; complex/scanned PDFs will return a fallback message.
 */
function extractPdfText(buffer: Buffer): string {
  const src = buffer.toString('latin1');
  const texts: string[] = [];

  // PDF string literals appear as (some text here) — capture them
  const re = /\(([^)\\]{2,300})\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const raw = (m[1] ?? '')
      .replace(/\\n/g, ' ')
      .replace(/\\r/g, ' ')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\')
      .trim();
    // Only include strings that look like natural language
    if (raw.length > 3 && /[a-zA-Z]{3,}/.test(raw)) {
      texts.push(raw);
    }
  }

  if (texts.length === 0) {
    return '[PDF content could not be extracted automatically. Consider copying and pasting the text directly into the chat instead.]';
  }

  return texts.join(' ');
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);
  if (session instanceof Response) return session;

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return json({ error: 'invalid_body', reason: 'expected multipart/form-data' }, 400);
  }

  const file = formData.get('file') as File | null;
  if (!file) {
    return json({ error: 'no_file', reason: 'file field is required' }, 400);
  }

  // 20 MB hard limit
  if (file.size > 20 * 1024 * 1024) {
    return json({ error: 'file_too_large', reason: 'maximum file size is 20 MB' }, 413);
  }

  const lower = file.name.toLowerCase();
  const buffer = Buffer.from(await file.arrayBuffer());

  // ── ZIP ──────────────────────────────────────────────────────────────
  if (lower.endsWith('.zip')) {
    try {
      const zip = new AdmZip(buffer);
      const entries = zip.getEntries();
      const parts: string[] = [];
      let fileCount = 0;

      for (const entry of entries) {
        if (entry.isDirectory) continue;
        if (!isTextEntry(entry.entryName)) continue;
        // Skip macOS metadata, hidden files
        if (entry.entryName.split('/').some((seg) => seg.startsWith('.'))) continue;
        if (entry.entryName.startsWith('__MACOSX/')) continue;

        const content = entry.getData().toString('utf-8').slice(0, 60_000);
        parts.push(`=== ${entry.entryName} ===\n${content}`);
        fileCount++;
        if (fileCount >= 150) break; // prevent enormous context
      }

      const content =
        parts.length > 0
          ? parts.join('\n\n')
          : '[No readable text files found in this ZIP archive.]';

      return json({ content, fileCount });
    } catch {
      return json({ error: 'zip_parse_error', reason: 'could not read ZIP file' }, 422);
    }
  }

  // ── PDF ──────────────────────────────────────────────────────────────
  if (lower.endsWith('.pdf')) {
    const content = extractPdfText(buffer);
    return json({ content });
  }

  return json(
    { error: 'unsupported_format', reason: 'only ZIP and PDF files are accepted at this endpoint' },
    400,
  );
}
