import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { clearNoteRace, setupTestDb, simulateNoteRace, teardownTestDb } from '@/lib/test-utils';
import { createUser, DEFAULT_GROUP_ID } from '@/lib/users';
import { buildSessionCookies, createSession, type Session } from '@/lib/session';
import { POST } from './route';

let session: Session;

function seedGmNote(path: string): void {
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                          content_md, yjs_state, frontmatter_json, byte_size,
                          updated_at, updated_by, created_at, created_by, gm_only)
       VALUES (?, ?, ?, ?, '{}', '', '', NULL, '{}', 0, ?, ?, ?, ?, 1)`,
    )
    .run(
      randomUUID(),
      DEFAULT_GROUP_ID,
      path,
      path.replace(/\.md$/, '').split('/').pop()!,
      Date.now(),
      session.userId,
      Date.now(),
      session.userId,
    );
}

function promoteRequest(body: unknown): NextRequest {
  const cookie = buildSessionCookies(session)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  return new Request('http://localhost/api/notes/promote', {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function gmOnlyAt(path: string): number | undefined {
  return getDb()
    .query<{ gm_only: number }, [string, string]>(
      'SELECT gm_only FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(DEFAULT_GROUP_ID, path)?.gm_only;
}

beforeAll(async () => {
  setupTestDb();
  const user = await createUser({
    username: 'promoter',
    displayName: 'Promoter',
    password: 'correct-horse-battery',
    role: 'admin',
  });
  session = createSession({ userId: user.id, groupId: DEFAULT_GROUP_ID, userAgent: null, ip: null });
});
afterAll(() => teardownTestDb());

describe('POST /api/notes/promote', () => {
  it('copies a GM note into the player namespace', async () => {
    seedGmNote('World Lore/Secret.md');

    const res = await POST(
      promoteRequest({ fromPath: 'World Lore/Secret.md', toPath: 'World Lore/Public.md', mode: 'copy' }),
    );

    expect(res.status).toBe(201);
    expect(gmOnlyAt('World Lore/Public.md')).toBe(0);
    expect(gmOnlyAt('World Lore/Secret.md')).toBe(1);
  });

  it('answers 409 exists, not a 500, when a copy loses the race for the destination', async () => {
    seedGmNote('World Lore/CopySrc.md');
    simulateNoteRace('World Lore/CopyDst.md', 'insert');
    try {
      const res = await POST(
        promoteRequest({ fromPath: 'World Lore/CopySrc.md', toPath: 'World Lore/CopyDst.md', mode: 'copy' }),
      );

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'exists', path: 'World Lore/CopyDst.md' });
    } finally {
      clearNoteRace('insert');
    }
    expect(gmOnlyAt('World Lore/CopySrc.md')).toBe(1);
  });

  it('answers 409 exists and leaves the source untouched when a move loses the race', async () => {
    seedGmNote('World Lore/MoveSrc.md');
    simulateNoteRace('World Lore/MoveDst.md', 'rename');
    try {
      const res = await POST(
        promoteRequest({ fromPath: 'World Lore/MoveSrc.md', toPath: 'World Lore/MoveDst.md', mode: 'move' }),
      );

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'exists', path: 'World Lore/MoveDst.md' });
    } finally {
      clearNoteRace('rename');
    }
    expect(gmOnlyAt('World Lore/MoveSrc.md')).toBe(1);
    expect(gmOnlyAt('World Lore/MoveDst.md')).toBeUndefined();
  });
});
