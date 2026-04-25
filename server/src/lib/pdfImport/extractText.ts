// Run `pdftotext -layout` on a PDF buffer and return the result.
//
// Why pdftotext (poppler) over a JS-only library: D&D character sheets
// are aggressively multi-column with absolute-positioned form fields,
// and pdftotext's `-layout` flag is the only extractor we tested that
// preserves column boundaries cleanly enough for downstream LLM parsing.
// Pure-JS readers (pdfjs-dist) reflow into one stream of text and lose
// the spatial cues the model needs.
//
// Runtime requirement: poppler-utils on PATH. Dev = brew install poppler;
// prod = apt-get install poppler-utils in the Dockerfile runtime stage.

import { spawn } from 'node:child_process';

const MAX_OUTPUT_BYTES = 2_000_000; // ~2MB of text — plenty for 30-page sheets
const PROCESS_TIMEOUT_MS = 30_000;

export class PdfTextExtractError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'PdfTextExtractError';
  }
}

export async function extractPdfText(pdf: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('pdftotext', ['-layout', '-q', '-', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const chunks: Buffer[] = [];
    let total = 0;
    let stderr = '';
    let aborted = false;

    const timer = setTimeout(() => {
      aborted = true;
      child.kill('SIGKILL');
      reject(new PdfTextExtractError('pdftotext timed out', 'timeout'));
    }, PROCESS_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_OUTPUT_BYTES) {
        aborted = true;
        child.kill('SIGKILL');
        clearTimeout(timer);
        reject(new PdfTextExtractError('pdftotext output too large', 'too_large'));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (aborted) return;
      clearTimeout(timer);
      const code =
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'pdftotext_missing'
          : 'spawn_failed';
      reject(new PdfTextExtractError(err.message, code));
    });

    child.on('close', (code) => {
      if (aborted) return;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new PdfTextExtractError(
            `pdftotext exited ${code}: ${stderr.slice(0, 400)}`,
            'pdftotext_failed',
          ),
        );
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    child.stdin.end(pdf);
  });
}
