import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
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
});
