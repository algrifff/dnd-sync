// Orchestrator for "import from PDF" — runs text extraction, ships the
// text to OpenAI for structured parsing, and reshapes the flat result
// into the patch shape `updateUserCharacter` expects.

import { ingestMarkdown } from '../md-to-pm';
import { extractCharacterFromText } from './extractCharacter';
import { extractPdfText } from './extractText';
import { buildImportPatch } from './transform';
import type { CharacterImportResult } from './transform';

export type { CharacterImportResult };

export type ImportResult = CharacterImportResult & {
  bodyJson: Record<string, unknown> | null;
};

export async function importCharacterFromPdf(
  pdf: Buffer,
  opts: { signal?: AbortSignal } = {},
): Promise<ImportResult> {
  const text = await extractPdfText(pdf);
  if (text.trim().length < 50) {
    throw new Error('pdf_no_text: extracted text is empty or too short');
  }
  const data = await extractCharacterFromText(text, opts.signal);
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
      console.error('[pdfImport] markdown→pm failed:', err);
    }
  }

  return { ...patch, bodyJson };
}
