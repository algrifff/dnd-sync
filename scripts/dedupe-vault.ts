#!/usr/bin/env bun
// One-shot cleanup for vaults corrupted by the compounding reconcile bug.
//
// Every merge produced: `serverText + "\n\n<!-- compendium: offline edits
// from NAME -->\n" + localText`. Because the next reconcile treated the
// whole string as the new serverText, compounding stacked copies of the
// content on top of each other — most files ended up with exactly
// doubled content and a trailing marker.
//
// Strategy per file:
//   1. Find the first `<!-- compendium: offline edits from` marker.
//      Everything from there onward is accumulated cruft — discard it.
//   2. If the remaining content starts with a YAML frontmatter block and
//      the exact same frontmatter appears again later, that's a doubling
//      boundary — keep only the first copy of the content.
//   3. Otherwise, if the remaining content's first half equals its second
//      half (byte-identical), keep only the first half.
//   4. Write the cleaned content back; trim trailing whitespace to one \n.
//
// Usage:
//   bun run scripts/dedupe-vault.ts <vault-path>            # dry-run
//   bun run scripts/dedupe-vault.ts <vault-path> --apply    # write changes

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const MARKER = '<!-- compendium: offline edits from';

type Stats = {
  scanned: number;
  dirty: number;
  cleaned: number;
  unchanged: number;
  unhandled: string[];
};

async function walk(root: string, out: string[]): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const e of entries) {
    // Skip Obsidian internals + git + any dotfolder to be safe.
    if (e.name.startsWith('.')) continue;
    const p = join(root, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
}

/** Return true if `content` starts with a complete YAML frontmatter block. */
function frontmatterEnd(content: string): number | null {
  if (!content.startsWith('---\n')) return null;
  // Look for closing '---' on its own line, after the opening.
  const idx = content.indexOf('\n---\n', 4);
  if (idx === -1) return null;
  return idx + 5; // position just after the closing '---\n'
}

/**
 * Try to find a duplicated frontmatter block inside `content`. Returns the
 * byte position where the duplicate starts, or null if none found. A valid
 * duplicate means: the first frontmatter block appears verbatim again
 * somewhere later in the file, starting on its own line.
 */
function findFrontmatterRepeat(content: string): number | null {
  const end = frontmatterEnd(content);
  if (end === null) return null;
  const block = content.slice(0, end); // "---\n...---\n"
  // Search for the same block appearing again. Must start on a fresh line
  // (after a newline or at position 0). We always expect it to be preceded
  // by a newline because the first block starts the file.
  const repeat = content.indexOf('\n' + block, end);
  if (repeat === -1) return null;
  return repeat + 1; // skip the leading newline
}

/** Halve-and-compare: if the content is exactly duplicated, return the
 *  first half; otherwise null. Handles subtle cases where doubling did
 *  NOT preserve a frontmatter boundary. */
function halveIfDoubled(content: string): string | null {
  const trimmed = content.replace(/\s+$/, '');
  if (trimmed.length < 20 || trimmed.length % 2 !== 0) return null;
  const half = trimmed.length / 2;
  const left = trimmed.slice(0, half);
  const right = trimmed.slice(half);
  if (left === right) return left;
  // Allow a single newline separator between halves (serverText + "\n\n"
  // + localText where both halves equal).
  const halfAlt = Math.floor((trimmed.length - 2) / 2);
  const leftAlt = trimmed.slice(0, halfAlt);
  const rightAlt = trimmed.slice(halfAlt + 2);
  const sep = trimmed.slice(halfAlt, halfAlt + 2);
  if (sep === '\n\n' && leftAlt === rightAlt) return leftAlt;
  return null;
}

function clean(original: string): { cleaned: string; strategy: string } | null {
  const markerIdx = original.indexOf(MARKER);
  let body = markerIdx >= 0 ? original.slice(0, markerIdx) : original;
  // Strip trailing whitespace that was inserted before the marker by the
  // merge format (the "\n\n" separator).
  body = body.replace(/\s+$/, '');

  // Strategy 1: frontmatter doubling.
  let lastCut: number | null = null;
  for (let pass = 0; pass < 5; pass++) {
    const cut = findFrontmatterRepeat(body);
    if (cut === null) break;
    body = body.slice(0, cut).replace(/\s+$/, '');
    lastCut = cut;
  }
  if (lastCut !== null) {
    return { cleaned: body + '\n', strategy: 'frontmatter-repeat' };
  }

  // Strategy 2: exact halving.
  const halved = halveIfDoubled(body);
  if (halved !== null) {
    return { cleaned: halved + '\n', strategy: 'halved' };
  }

  // Strategy 3: if the only change was stripping a trailing marker,
  // that's still a cleanup worth doing.
  if (markerIdx >= 0) {
    return { cleaned: body + '\n', strategy: 'marker-only' };
  }

  return null;
}

async function main(): Promise<void> {
  const vaultPath = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!vaultPath) {
    console.error('usage: bun run scripts/dedupe-vault.ts <vault-path> [--apply]');
    process.exit(1);
  }
  const s = await stat(vaultPath);
  if (!s.isDirectory()) {
    console.error(`not a directory: ${vaultPath}`);
    process.exit(1);
  }

  const files: string[] = [];
  await walk(vaultPath, files);

  const stats: Stats = { scanned: 0, dirty: 0, cleaned: 0, unchanged: 0, unhandled: [] };
  const report: Array<{ path: string; strategy: string; before: number; after: number }> = [];

  for (const file of files) {
    stats.scanned++;
    const content = await readFile(file, 'utf8');
    if (!content.includes(MARKER)) {
      // Also check for frontmatter-doubled files without a marker, just
      // in case the marker got manually edited out at some point.
      const result = clean(content);
      if (result && result.cleaned !== content) {
        stats.dirty++;
        report.push({
          path: file,
          strategy: result.strategy + ' (no marker)',
          before: content.length,
          after: result.cleaned.length,
        });
        if (apply) {
          await writeFile(file, result.cleaned, 'utf8');
          stats.cleaned++;
        }
      } else {
        stats.unchanged++;
      }
      continue;
    }

    stats.dirty++;
    const result = clean(content);
    if (!result) {
      stats.unhandled.push(file);
      continue;
    }
    report.push({
      path: file,
      strategy: result.strategy,
      before: content.length,
      after: result.cleaned.length,
    });
    if (apply) {
      await writeFile(file, result.cleaned, 'utf8');
      stats.cleaned++;
    }
  }

  console.log(`Scanned: ${stats.scanned}`);
  console.log(`Dirty (had marker or doubled frontmatter): ${stats.dirty}`);
  console.log(`Unchanged: ${stats.unchanged}`);
  console.log(`Cleaned: ${stats.cleaned}${apply ? '' : ' (dry-run — pass --apply to write)'}`);
  if (stats.unhandled.length > 0) {
    console.log(`\nUnhandled (${stats.unhandled.length}) — inspect manually:`);
    for (const p of stats.unhandled) console.log('  ' + p);
  }
  if (report.length > 0) {
    console.log('\nFirst 20 changes:');
    for (const r of report.slice(0, 20)) {
      const saved = r.before - r.after;
      console.log(`  [-${saved}b ${r.strategy}] ${r.path}`);
    }
    if (report.length > 20) console.log(`  ... and ${report.length - 20} more`);
  }
}

await main();
