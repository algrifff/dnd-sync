import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

// Two copies of a prosemirror package in one bundle break the editor at
// runtime: objects built by one copy fail the other's instanceof checks.
// Tiptap 3.32 left a stale prosemirror-view at the root and every note
// page crashed with "reading 'localsInner'". Root `overrides` keep one copy.
const ROOT = join(import.meta.dir, '..', '..', '..');

describe('prosemirror packages', () => {
  test('each one is installed exactly once', () => {
    const patterns = [
      'node_modules/prosemirror-*/package.json',
      'node_modules/*/node_modules/prosemirror-*/package.json',
      'node_modules/@*/*/node_modules/prosemirror-*/package.json',
    ];
    const seen = new Map<string, string[]>();
    for (const pattern of patterns) {
      for (const path of new Bun.Glob(pattern).scanSync({ cwd: ROOT })) {
        const name = path.split(/[\\/]/).at(-2) as string;
        seen.set(name, [...(seen.get(name) ?? []), path]);
      }
    }
    const duplicates = [...seen.values()].filter((paths) => paths.length > 1);
    expect(seen.has('prosemirror-view')).toBe(true);
    expect(duplicates).toEqual([]);
  });
});
