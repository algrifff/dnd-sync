import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { clearNoteRace, setupTestDb, simulateNoteRace, teardownTestDb } from '@/lib/test-utils';
import { createUser, DEFAULT_GROUP_ID } from '@/lib/users';
import { buildSessionCookies, createSession, type Session } from '@/lib/session';
import { createUserCharacter } from '@/lib/userCharacters';
import { POST } from './route';

const SLUG = 'mill';
const FOLDER = 'Campaigns/mill';

let session: Session;

function joinRequest(userCharacterId: string): NextRequest {
  const cookie = buildSessionCookies(session)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  return new Request(`http://localhost/api/worlds/${DEFAULT_GROUP_ID}/campaigns/${SLUG}/join`, {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ userCharacterId }),
  }) as unknown as NextRequest;
}

function join(userCharacterId: string): Promise<Response> {
  return POST(joinRequest(userCharacterId), {
    params: Promise.resolve({ id: DEFAULT_GROUP_ID, slug: SLUG }),
  });
}

function countRows(table: string): number {
  return getDb().query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
}

beforeAll(async () => {
  setupTestDb();
  const user = await createUser({
    username: 'joiner',
    displayName: 'Joiner',
    password: 'correct-horse-battery',
    role: 'viewer',
  });
  session = createSession({ userId: user.id, groupId: DEFAULT_GROUP_ID, userAgent: null, ip: null });
  getDb()
    .query('INSERT INTO campaigns (group_id, slug, name, folder_path, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(DEFAULT_GROUP_ID, SLUG, 'The Mill', FOLDER, Date.now());
});
afterAll(() => teardownTestDb());

describe('POST /api/worlds/[id]/campaigns/[slug]/join', () => {
  it('creates the character note and its binding', async () => {
    const uc = createUserCharacter(session.userId, { name: 'Brann' });

    const res = await join(uc.id);

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, path: `${FOLDER}/Characters/PCs/Brann.md` });
    expect(countRows('user_character_bindings')).toBe(1);
  });

  it('answers 409 exists when a note already sits at the path', async () => {
    const uc = createUserCharacter(session.userId, { name: 'Taken' });
    getDb()
      .query(
        `INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                            content_md, yjs_state, frontmatter_json, byte_size,
                            updated_at, updated_by, created_at, created_by)
         VALUES ('squatter', ?, ?, 'Taken', '{}', '', '', NULL, '{}', 0, 0, ?, 0, ?)`,
      )
      .run(DEFAULT_GROUP_ID, `${FOLDER}/Characters/PCs/Taken.md`, session.userId, session.userId);

    const res = await join(uc.id);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'exists', path: `${FOLDER}/Characters/PCs/Taken.md` });
  });

  it('answers 409 exists and leaves no binding when a concurrent join wins the path', async () => {
    const uc = createUserCharacter(session.userId, { name: 'Racer' });
    const bindingsBefore = countRows('user_character_bindings');
    simulateNoteRace(`${FOLDER}/Characters/PCs/Racer.md`, 'insert');
    try {
      const res = await join(uc.id);

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'exists', path: `${FOLDER}/Characters/PCs/Racer.md` });
    } finally {
      clearNoteRace('insert');
    }

    expect(countRows('user_character_bindings')).toBe(bindingsBefore);
    const note = getDb()
      .query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM notes WHERE path = ?')
      .get(`${FOLDER}/Characters/PCs/Racer.md`)!;
    expect(note.n).toBe(0);
  });
});
