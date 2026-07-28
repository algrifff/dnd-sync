import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { setupTestDb, teardownTestDb } from './test-utils';
import { createUser } from './users';
import { createUserCharacter, updateUserCharacter, getUserCharacter } from './userCharacters';
import { syncMasterToNotes, syncNoteToMaster } from './userCharacterSync';

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM user_character_bindings');
  db.exec('DELETE FROM user_characters');
  db.exec('DELETE FROM notes');
  db.exec('DELETE FROM group_members');
  db.exec(`DELETE FROM groups WHERE id != 'default'`);
  db.exec('DELETE FROM sessions');
  db.exec('DELETE FROM users');
});

type Ctx = {
  userId: string;
  groupId: string;
  ucId: string;
  noteId: string;
  notePath: string;
};

async function seed(initialSheet: Record<string, unknown> = {}): Promise<Ctx> {
  const db = getDb();
  const user = await createUser({
    username: `u${randomUUID().slice(0, 6)}`,
    displayName: 'Tester',
    password: 'password123',
    role: 'editor',
  });
  const groupId = `g_${randomUUID()}`;
  db.query('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(
    groupId,
    'Test World',
    Date.now(),
  );
  db.query(
    'INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
  ).run(groupId, user.id, 'editor', Date.now());

  const uc = createUserCharacter(user.id, {
    name: 'Bob',
    kind: 'character',
    sheet: initialSheet,
  });

  const noteId = randomUUID();
  const notePath = 'Campaigns/spring/Characters/PCs/Bob.md';
  const fm = {
    kind: 'character',
    role: 'pc',
    player: user.username,
    sheet: { name: 'Bob', ...initialSheet },
  };
  const now = Date.now();
  db.query(
    `INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                        content_md, yjs_state, frontmatter_json, byte_size,
                        updated_at, updated_by, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    noteId,
    groupId,
    notePath,
    'Bob',
    '{}',
    '',
    '',
    new Uint8Array(),
    JSON.stringify(fm),
    0,
    now,
    user.id,
    now,
    user.id,
  );

  db.query(
    `INSERT INTO user_character_bindings
       (user_character_id, group_id, campaign_slug, note_id, joined_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(uc.id, groupId, 'spring', noteId, now);

  return { userId: user.id, groupId, ucId: uc.id, noteId, notePath };
}

function readNoteSheet(noteId: string): Record<string, unknown> {
  const row = getDb()
    .query<{ frontmatter_json: string }, [string]>(
      'SELECT frontmatter_json FROM notes WHERE id = ?',
    )
    .get(noteId);
  if (!row) return {};
  const fm = JSON.parse(row.frontmatter_json) as { sheet?: Record<string, unknown> };
  return fm.sheet ?? {};
}

function setNoteSheet(noteId: string, sheet: Record<string, unknown>): void {
  const db = getDb();
  const row = db
    .query<{ frontmatter_json: string }, [string]>(
      'SELECT frontmatter_json FROM notes WHERE id = ?',
    )
    .get(noteId);
  const fm = row ? JSON.parse(row.frontmatter_json) : {};
  fm.sheet = sheet;
  db.query('UPDATE notes SET frontmatter_json = ? WHERE id = ?').run(
    JSON.stringify(fm),
    noteId,
  );
}

describe('syncMasterToNotes', () => {
  it('pushes master sheet changes into every bound note', async () => {
    const ctx = await seed();
    updateUserCharacter(ctx.ucId, ctx.userId, {
      sheet: { hit_points: { current: 12, max: 20, temporary: 0 } },
    });
    const sheet = readNoteSheet(ctx.noteId);
    expect(sheet.hit_points).toEqual({ current: 12, max: 20, temporary: 0 });
  });

  it('mirrors nested fields to legacy flat keys for the old sidebar', async () => {
    const ctx = await seed();
    updateUserCharacter(ctx.ucId, ctx.userId, {
      sheet: {
        hit_points: { current: 10, max: 10, temporary: 0 },
        armor_class: { value: 15 },
        ability_scores: { str: 16, dex: 12, con: 14, int: 10, wis: 8, cha: 18 },
      },
    });
    const sheet = readNoteSheet(ctx.noteId);
    expect(sheet.hp_current).toBe(10);
    expect(sheet.hp_max).toBe(10);
    expect(sheet.ac).toBe(15);
    expect(sheet.str).toBe(16);
    expect(sheet.cha).toBe(18);
  });

  it('propagates renames into the bound note sheet.name', async () => {
    const ctx = await seed();
    updateUserCharacter(ctx.ucId, ctx.userId, { name: 'Bobby' });
    expect(readNoteSheet(ctx.noteId).name).toBe('Bobby');
  });

  it('is a no-op when the master has no bindings', async () => {
    const ctx = await seed();
    getDb().exec('DELETE FROM user_character_bindings');
    // Should not throw; the note's sheet stays untouched.
    updateUserCharacter(ctx.ucId, ctx.userId, { sheet: { level: 5 } });
    expect(readNoteSheet(ctx.noteId).level).toBeUndefined();
  });
});

describe('syncNoteToMaster', () => {
  it('reverse-merges the note sheet into the master record', async () => {
    const ctx = await seed();
    setNoteSheet(ctx.noteId, {
      name: 'Bob',
      hit_points: { current: 5, max: 10, temporary: 0 },
      level: 3,
    });
    syncNoteToMaster(ctx.noteId);
    const uc = getUserCharacter(ctx.ucId, ctx.userId);
    expect(uc?.sheet.hit_points).toEqual({ current: 5, max: 10, temporary: 0 });
    expect(uc?.sheet.level).toBe(3);
  });

  it('adopts a renamed note title as the new master name', async () => {
    const ctx = await seed();
    setNoteSheet(ctx.noteId, { name: 'Robert' });
    syncNoteToMaster(ctx.noteId);
    expect(getUserCharacter(ctx.ucId, ctx.userId)?.name).toBe('Robert');
  });

  it('is a no-op on a note that is not bound to any master', async () => {
    const ctx = await seed();
    getDb().exec('DELETE FROM user_character_bindings');
    setNoteSheet(ctx.noteId, { name: 'Bob', hit_points: { current: 1, max: 1 } });
    syncNoteToMaster(ctx.noteId);
    const uc = getUserCharacter(ctx.ucId, ctx.userId);
    expect(uc?.sheet.hit_points).toBeUndefined();
  });
});

describe('loop guard', () => {
  it('a master write does not re-enter itself through syncNoteToMaster', async () => {
    const ctx = await seed();
    const db = getDb();

    // Count real UPDATEs against user_characters via a SQL-level spy,
    // instead of comparing `updated_at` timestamps. The old assertion
    // (`toBeGreaterThan` on two Date.now() reads) raced at millisecond
    // resolution: seed() + updateUserCharacter() + syncNoteToMaster()
    // can all land in the same tick, so "before" and "after" tied and
    // the test failed ~60-65% of runs — a false flake report, not a
    // real regression. A call count proves the actual loop-guard
    // property directly and has no timing dependency.
    const originalQuery = db.query.bind(db);
    let masterWrites = 0;
    (db as unknown as { query: typeof db.query }).query = ((sql: string) => {
      const stmt = originalQuery(sql) as { run: (...args: unknown[]) => unknown };
      if (/UPDATE\s+user_characters\b/i.test(sql)) {
        const originalRun = stmt.run.bind(stmt);
        stmt.run = (...args: unknown[]) => {
          masterWrites++;
          return originalRun(...args);
        };
      }
      return stmt;
    }) as typeof db.query;

    try {
      updateUserCharacter(ctx.ucId, ctx.userId, {
        sheet: { hit_points: { current: 7, max: 10, temporary: 0 } },
      });
      // updateUserCharacter's own write to the master row.
      expect(masterWrites).toBe(1);

      // Calling syncNoteToMaster here runs entirely after
      // syncMasterToNotes's guarded window has already closed, so it's
      // a legitimate, out-of-band reverse sync — not a re-entrant one.
      // This proves the guard's Set is released cleanly (the call is
      // NOT permanently blocked) while also proving it doesn't cascade
      // into more than one write (no runaway ping-pong): exactly one
      // additional write, no more, no fewer.
      syncNoteToMaster(ctx.noteId);
      expect(masterWrites).toBe(2);
    } finally {
      (db as unknown as { query: typeof db.query }).query = originalQuery;
    }

    // The bound note saw the update from the master side.
    expect(readNoteSheet(ctx.noteId).hit_points).toEqual({
      current: 7,
      max: 10,
      temporary: 0,
    });
  });

  it('blocks a syncNoteToMaster call issued from inside syncMasterToNotes\'s guarded window (exercises userCharacterSync.ts:165 directly)', async () => {
    const ctx = await seed();
    const db = getDb();

    // The test above proves the guard is RELEASED (no permanent lock)
    // but never proves it actually FIRES: it calls syncNoteToMaster
    // only after syncMasterToNotes has already returned, i.e. after
    // `syncingNoteIds.delete(b.note_id)` has run in the `finally` at
    // userCharacterSync.ts:159. That call is a legitimate later sync,
    // not a re-entrant one, so it never reaches the `if
    // (syncingNoteIds.has(noteId)) return;` branch at line 165.
    //
    // To exercise line 165 for real we need a synchronous callback that
    // runs WHILE `b.note_id` is still in `syncingNoteIds` — i.e. from
    // inside the `notes` UPDATE that syncMasterToNotes issues per
    // binding (userCharacterSync.ts:145-148), which happens strictly
    // between the `.add()` (line 66) and the `finally`'s `.delete()`
    // (line 159). We hook that UPDATE's `.run()` the same way the test
    // above hooks `user_characters` writes, and call
    // syncNoteToMaster(ctx.noteId) from inside it.
    const originalQuery = db.query.bind(db);
    let masterWrites = 0;
    let reentered = false;

    (db as unknown as { query: typeof db.query }).query = ((sql: string) => {
      const stmt = originalQuery(sql) as { run: (...args: unknown[]) => unknown };
      if (/UPDATE\s+user_characters\b/i.test(sql)) {
        const originalRun = stmt.run.bind(stmt);
        stmt.run = (...args: unknown[]) => {
          masterWrites++;
          return originalRun(...args);
        };
      } else if (/UPDATE\s+notes\s+SET/i.test(sql)) {
        const originalRun = stmt.run.bind(stmt);
        stmt.run = (...args: unknown[]) => {
          const result = originalRun(...args);
          if (!reentered) {
            reentered = true;
            // Fires synchronously here, i.e. still inside
            // syncMasterToNotes's try block for ctx.noteId — the guard
            // at line 165 must return early, or this would proceed to
            // its own `UPDATE user_characters` below.
            syncNoteToMaster(ctx.noteId);
          }
          return result;
        };
      }
      return stmt;
    }) as typeof db.query;

    try {
      updateUserCharacter(ctx.ucId, ctx.userId, {
        sheet: { hit_points: { current: 9, max: 10, temporary: 0 } },
      });
    } finally {
      (db as unknown as { query: typeof db.query }).query = originalQuery;
    }

    expect(reentered).toBe(true);
    // Only updateUserCharacter's own write should have landed. If the
    // guard at userCharacterSync.ts:165 were replaced with a comment,
    // the reentrant syncNoteToMaster call above would run to
    // completion and issue a second `UPDATE user_characters`, making
    // this 2.
    expect(masterWrites).toBe(1);
  });

  it('calling syncMasterToNotes inside syncNoteToMaster does not recurse', async () => {
    const ctx = await seed();
    // Seed the note with a different value; syncNoteToMaster should
    // reverse-merge it and NOT then push back through master→notes.
    setNoteSheet(ctx.noteId, {
      name: 'Bob',
      hit_points: { current: 3, max: 10, temporary: 0 },
    });
    syncNoteToMaster(ctx.noteId);
    // If recursion leaked, the note's frontmatter would get a second
    // write reflecting the legacy-mirror keys written by master→notes.
    // Confirm it didn't: the note's sheet still has no hp_current
    // mirror because only syncMasterToNotes adds those.
    const sheet = readNoteSheet(ctx.noteId);
    expect(sheet.hp_current).toBeUndefined();
    // Master updated correctly.
    expect(getUserCharacter(ctx.ucId, ctx.userId)?.sheet.hit_points).toEqual({
      current: 3,
      max: 10,
      temporary: 0,
    });
  });
});

// Reference the imports to quiet unused warnings in strict configs.
void syncMasterToNotes;
