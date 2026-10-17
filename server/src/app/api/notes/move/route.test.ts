import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import * as moveRewrite from '@/lib/move-rewrite';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import { createUser, DEFAULT_GROUP_ID } from '@/lib/users';
import { buildSessionCookies, createSession, type Session } from '@/lib/session';
import { POST } from './route';

let session: Session;

function seedNote(path: string, content: unknown[]): void {
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                          content_md, yjs_state, frontmatter_json, byte_size,
                          updated_at, updated_by, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, '', '', NULL, '{}', 0, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      DEFAULT_GROUP_ID,
      path,
      path.replace(/\.md$/, '').split('/').pop()!,
      JSON.stringify({ type: 'doc', content }),
      Date.now(),
      session.userId,
      Date.now(),
      session.userId,
    );
}

function moveRequest(from: string, to: string): NextRequest {
  const cookie = buildSessionCookies(session)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  return new Request('http://localhost/api/notes/move', {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to }),
  }) as unknown as NextRequest;
}

beforeAll(async () => {
  setupTestDb();
  const user = await createUser({
    username: 'mover',
    displayName: 'Mover',
    password: 'correct-horse-battery',
    role: 'editor',
  });
  session = createSession({ userId: user.id, groupId: DEFAULT_GROUP_ID, userAgent: null, ip: null });
});
afterAll(() => teardownTestDb());

describe('POST /api/notes/move', () => {
  it('rewrites wikilinks in notes that link to the renamed note', async () => {
    seedNote('World Lore/Aldric.md', []);
    seedNote('World Lore/Session One.md', [
      {
        type: 'paragraph',
        content: [{ type: 'wikilink', attrs: { target: 'World Lore/Aldric.md', label: null, orphan: false } }],
      },
    ]);
    getDb()
      .query('INSERT INTO note_links (group_id, from_path, to_path) VALUES (?, ?, ?)')
      .run(DEFAULT_GROUP_ID, 'World Lore/Session One.md', 'World Lore/Aldric.md');

    const res = await POST(moveRequest('World Lore/Aldric.md', 'World Lore/Aldric the Bold.md'));
    expect(res.status).toBe(200);

    const linker = getDb()
      .query<{ content_json: string }, [string, string]>(
        'SELECT content_json FROM notes WHERE group_id = ? AND path = ?',
      )
      .get(DEFAULT_GROUP_ID, 'World Lore/Session One.md')!;
    expect(linker.content_json).toContain('"target":"World Lore/Aldric the Bold.md"');
    expect(linker.content_json).not.toContain('"target":"World Lore/Aldric.md"');
  });

  it('answers 409 exists when the destination is taken at the pre-check', async () => {
    seedNote('World Lore/Taken/From.md', []);
    seedNote('World Lore/Taken/To.md', []);

    const res = await POST(moveRequest('World Lore/Taken/From.md', 'World Lore/Taken/To.md'));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'exists', path: 'World Lore/Taken/To.md' });
  });

  it('merges note_links instead of failing when a stale edge to the destination already exists', async () => {
    seedNote('World Lore/Dup/From.md', []);
    seedNote('World Lore/Dup/Linker.md', []);
    const insertLink = getDb().query(
      'INSERT INTO note_links (group_id, from_path, to_path) VALUES (?, ?, ?)',
    );
    // X has no note (it was deleted) but derive re-added the edge to it.
    insertLink.run(DEFAULT_GROUP_ID, 'World Lore/Dup/Linker.md', 'World Lore/Dup/X.md');
    insertLink.run(DEFAULT_GROUP_ID, 'World Lore/Dup/Linker.md', 'World Lore/Dup/From.md');

    const res = await POST(moveRequest('World Lore/Dup/From.md', 'World Lore/Dup/X.md'));

    expect(res.status).toBe(200);
    const targets = getDb()
      .query<{ to_path: string }, [string, string]>(
        'SELECT to_path FROM note_links WHERE group_id = ? AND from_path = ?',
      )
      .all(DEFAULT_GROUP_ID, 'World Lore/Dup/Linker.md')
      .map((r) => r.to_path);
    expect(targets).toEqual(['World Lore/Dup/X.md']);
  });

  it('answers 409 exists, not a 500, when a concurrent write wins the destination after the pre-check', async () => {
    seedNote('World Lore/Race/From.md', []);
    getDb()
      .query('INSERT INTO note_links (group_id, from_path, to_path) VALUES (?, ?, ?)')
      .run(DEFAULT_GROUP_ID, 'World Lore/Race/From.md', 'World Lore/Race/Elsewhere.md');
    // The route reads linkers after its pre-check and before the write;
    // a concurrent create committing in that window is what we simulate.
    const realFind = moveRewrite.findWikilinkLinkers;
    const spy = spyOn(moveRewrite, 'findWikilinkLinkers').mockImplementation((...args) => {
      seedNote('World Lore/Race/To.md', []);
      return realFind(...args);
    });
    try {
      const res = await POST(moveRequest('World Lore/Race/From.md', 'World Lore/Race/To.md'));

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'exists', path: 'World Lore/Race/To.md' });
    } finally {
      spy.mockRestore();
    }

    const paths = getDb()
      .query<{ path: string }, [string]>('SELECT path FROM notes WHERE group_id = ? ORDER BY path')
      .all(DEFAULT_GROUP_ID)
      .map((r) => r.path);
    expect(paths).toContain('World Lore/Race/From.md');
    expect(paths).toContain('World Lore/Race/To.md'); // the concurrent winner
    const link = getDb()
      .query<{ from_path: string }, [string]>(
        "SELECT from_path FROM note_links WHERE group_id = ? AND to_path = 'World Lore/Race/Elsewhere.md'",
      )
      .get(DEFAULT_GROUP_ID);
    expect(link?.from_path).toBe('World Lore/Race/From.md');
  });
});
