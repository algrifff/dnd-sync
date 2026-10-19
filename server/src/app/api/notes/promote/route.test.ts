import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import * as collab from '@/collab/server';
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

function seedPlayerNote(path: string): void {
  seedGmNote(path);
  getDb().query('UPDATE notes SET gm_only = 0 WHERE group_id = ? AND path = ?').run(DEFAULT_GROUP_ID, path);
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
    simulateNoteRace('World Lore/CopyDst.md');
    try {
      const res = await POST(
        promoteRequest({ fromPath: 'World Lore/CopySrc.md', toPath: 'World Lore/CopyDst.md', mode: 'copy' }),
      );

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'exists', path: 'World Lore/CopyDst.md' });
    } finally {
      clearNoteRace();
    }
    expect(gmOnlyAt('World Lore/CopySrc.md')).toBe(1);
  });

  it('answers 409 exists and leaves the source untouched when a move loses the race', async () => {
    seedGmNote('World Lore/MoveSrc.md');
    // The drain runs after the pre-check; a concurrent create committing
    // while it waits is what we simulate.
    const realDrain = collab.closeDocumentForWrite;
    const spy = spyOn(collab, 'closeDocumentForWrite').mockImplementation(async (...args) => {
      seedPlayerNote('World Lore/MoveDst.md');
      return realDrain(...args);
    });
    try {
      const res = await POST(
        promoteRequest({ fromPath: 'World Lore/MoveSrc.md', toPath: 'World Lore/MoveDst.md', mode: 'move' }),
      );

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'exists', path: 'World Lore/MoveDst.md' });
    } finally {
      spy.mockRestore();
    }
    expect(gmOnlyAt('World Lore/MoveSrc.md')).toBe(1);
    expect(gmOnlyAt('World Lore/MoveDst.md')).toBe(0); // the concurrent winner, untouched
  });

  it('moves and renames a Character note, carrying its derived row instead of failing the FK check', async () => {
    seedGmNote('World Lore/Hero.md');
    getDb()
      .query(
        `INSERT INTO characters (group_id, note_path, kind, display_name, updated_at)
         VALUES (?, 'World Lore/Hero.md', 'character', 'Hero', 0)`,
      )
      .run(DEFAULT_GROUP_ID);

    const res = await POST(
      promoteRequest({ fromPath: 'World Lore/Hero.md', toPath: 'World Lore/Hero Public.md', mode: 'move' }),
    );

    expect(res.status).toBe(200);
    expect(gmOnlyAt('World Lore/Hero Public.md')).toBe(0);
    const row = getDb()
      .query<{ note_path: string }, [string]>('SELECT note_path FROM characters WHERE group_id = ?')
      .get(DEFAULT_GROUP_ID);
    expect(row?.note_path).toBe('World Lore/Hero Public.md');
  });

  it('merges note_links instead of failing when a stale edge to the destination already exists', async () => {
    seedGmNote('World Lore/DupSrc.md');
    seedPlayerNote('World Lore/DupLinker.md');
    const insertLink = getDb().query(
      'INSERT INTO note_links (group_id, from_path, to_path) VALUES (?, ?, ?)',
    );
    // DupDst has no note (it was deleted) but derive re-added the edge to it.
    insertLink.run(DEFAULT_GROUP_ID, 'World Lore/DupLinker.md', 'World Lore/DupDst.md');
    insertLink.run(DEFAULT_GROUP_ID, 'World Lore/DupLinker.md', 'World Lore/DupSrc.md');

    const res = await POST(
      promoteRequest({ fromPath: 'World Lore/DupSrc.md', toPath: 'World Lore/DupDst.md', mode: 'move' }),
    );

    expect(res.status).toBe(200);
    const targets = getDb()
      .query<{ to_path: string }, [string, string]>(
        'SELECT to_path FROM note_links WHERE group_id = ? AND from_path = ?',
      )
      .all(DEFAULT_GROUP_ID, 'World Lore/DupLinker.md')
      .map((r) => r.to_path);
    expect(targets).toEqual(['World Lore/DupDst.md']);
    expect(gmOnlyAt('World Lore/DupDst.md')).toBe(0);
  });
});
