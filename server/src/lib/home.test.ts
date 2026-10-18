import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from '@/lib/db';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import { listRecentForUser } from '@/lib/notes';
import { acceptSuggestion, dismissSuggestion, listMySuggestions } from '@/lib/character-suggestions';
import { listCharacterWorlds, listOpenSessionsForUser } from './home';

// Each role's user is a viewer of HOME and holds `role` in SHARED. They
// are never a member of OUTSIDE. Every Home read must gate each item by
// the user's role in that item's own World.
type Role = 'admin' | 'editor' | 'viewer';
const roles: Role[] = ['admin', 'editor', 'viewer'];
const HOME = 'w-home';
const SHARED = 'w-shared';
const OUTSIDE = 'w-outside';
const users: Record<Role, string> = { admin: 'u-admin', editor: 'u-editor', viewer: 'u-viewer' };

type Flags = { dmOnly?: boolean; gmOnly?: boolean };

function seedNote(groupId: string, path: string, title: string, flags: Flags = {}, frontmatter: object = {}): string {
  const id = randomUUID();
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, content_json, title, frontmatter_json, updated_at, dm_only, gm_only)
       VALUES (?, ?, ?, '{}', ?, ?, ?, ?, ?)`,
    )
    .run(id, groupId, path, title, JSON.stringify(frontmatter), Date.now(), flags.dmOnly ? 1 : 0, flags.gmOnly ? 1 : 0);
  return id;
}

function seedSession(groupId: string, path: string, date: string, status: 'open' | 'closed', flags: Flags = {}): void {
  seedNote(groupId, path, path, flags);
  getDb()
    .query('INSERT INTO session_notes (group_id, note_path, session_date, updated_at, status) VALUES (?, ?, ?, ?, ?)')
    .run(groupId, path, date, Date.now(), status);
}

function member(groupId: string, userId: string, role: Role): void {
  getDb()
    .query('INSERT OR REPLACE INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .run(groupId, userId, role, Date.now());
}

beforeAll(() => {
  setupTestDb();
  const db = getDb();
  for (const [id, name] of [[HOME, 'Home World'], [SHARED, 'Shared World'], [OUTSIDE, 'Outside World']]) {
    db.query('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(id!, name!, Date.now());
  }
  for (const role of roles) {
    db.query(
      `INSERT INTO users (id, username, password_hash, display_name, accent_color, created_at)
       VALUES (?, ?, 'x', ?, '#000000', ?)`,
    ).run(users[role], users[role], users[role], Date.now());
  }
});
afterAll(() => teardownTestDb());

beforeEach(() => {
  const db = getDb();
  for (const t of ['character_suggestions', 'user_character_bindings', 'user_characters', 'characters', 'session_notes', 'notes', 'group_members']) {
    db.exec(`DELETE FROM ${t}`);
  }
  for (const role of roles) {
    member(HOME, users[role], 'viewer');
    member(SHARED, users[role], role);
  }
});

describe('open sessions on Home', () => {
  beforeEach(() => {
    seedSession(SHARED, 'log/plain.md', '2026-01-01', 'open');
    seedSession(SHARED, 'log/dm.md', '2026-02-01', 'open', { dmOnly: true });
    seedSession(SHARED, 'log/gm.md', '2026-03-01', 'open', { gmOnly: true });
    seedSession(SHARED, 'log/closed.md', '2026-04-01', 'closed');
    seedSession(OUTSIDE, 'log/outside.md', '2026-05-01', 'open');
  });

  const expected: Record<Role, { path: string; openCount: number }> = {
    viewer: { path: 'log/plain.md', openCount: 1 },
    editor: { path: 'log/dm.md', openCount: 2 },
    admin: { path: 'log/gm.md', openCount: 3 },
  };

  for (const role of roles) {
    it(`shows a ${role} the newest open Session they may see, counting only those`, () => {
      const rows = listOpenSessionsForUser(users[role]);

      expect(rows.map(({ worldId, path, openCount }) => ({ worldId, path, openCount }))).toEqual([
        { worldId: SHARED, ...expected[role] },
      ]);
    });
  }

  it('stops showing a World once the user leaves it', () => {
    getDb().query('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(SHARED, users.viewer);

    expect(listOpenSessionsForUser(users.viewer)).toEqual([]);
  });
});

describe('the Worlds each Character is in', () => {
  function character(ownerId: string, name: string): string {
    const id = randomUUID();
    getDb()
      .query(
        `INSERT INTO user_characters (id, owner_user_id, name, kind, sheet_json, created_at, updated_at)
         VALUES (?, ?, ?, 'character', '{}', 0, 0)`,
      )
      .run(id, ownerId, name);
    return id;
  }
  function bind(characterId: string, groupId: string, path: string, flags: Flags = {}): void {
    const noteId = seedNote(groupId, path, path, flags);
    getDb()
      .query(
        `INSERT INTO user_character_bindings (user_character_id, group_id, campaign_slug, note_id, joined_at)
         VALUES (?, ?, 'c', ?, ?)`,
      )
      .run(characterId, groupId, noteId, Date.now());
  }

  for (const role of roles) {
    it(`lists for a ${role} only the Worlds whose bound Note they may see`, () => {
      const plain = character(users[role], 'Plain');
      const secret = character(users[role], 'Secret');
      const priv = character(users[role], 'Private');
      bind(plain, HOME, `home/${role}.md`);
      bind(secret, SHARED, `shared/${role}-dm.md`, { dmOnly: true });
      bind(priv, SHARED, `shared/${role}-gm.md`, { gmOnly: true });

      const worlds = listCharacterWorlds(users[role]);

      expect(worlds).toEqual({
        [plain]: [HOME],
        ...(role !== 'viewer' ? { [secret]: [SHARED] } : {}),
        ...(role === 'admin' ? { [priv]: [SHARED] } : {}),
      });
    });
  }

  it('leaves out a World the user is not a member of', () => {
    const id = character(users.admin, 'Wanderer');
    bind(id, OUTSIDE, 'outside/wanderer.md');

    expect(listCharacterWorlds(users.admin)).toEqual({});
  });

  it("never lists another user's Characters", () => {
    const id = character(users.editor, 'Theirs');
    bind(id, SHARED, 'shared/theirs.md');

    expect(listCharacterWorlds(users.admin)).toEqual({});
  });
});

describe('Suggestions on Home', () => {
  // A Suggestion addressed to `role`'s user in `groupId`, for a Session
  // with `flags`, about a Character Note with `characterFlags`.
  function suggestion(role: Role, groupId: string, session: string, flags: Flags = {}, characterFlags: Flags = {}): string {
    const db = getDb();
    const character = `chars/${role}${characterFlags.dmOnly ? '-dm' : ''}${characterFlags.gmOnly ? '-gm' : ''}.md`;
    if (!db.query('SELECT 1 FROM notes WHERE group_id = ? AND path = ?').get(groupId, character)) {
      seedNote(groupId, character, `${role} hero`, characterFlags, { kind: 'character', sheet: { name: `${role} hero` } });
      db.query(
        `INSERT INTO characters (group_id, note_path, kind, player_user_id, display_name, updated_at)
         VALUES (?, ?, 'character', ?, ?, 0)`,
      ).run(groupId, character, users[role], `${role} hero`);
    }
    seedNote(groupId, session, session, flags);
    const id = randomUUID();
    db.query(
      `INSERT INTO character_suggestions (id, group_id, session_path, character_path, owner_user_id, story, items_json, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(id, groupId, session, character, users[role], JSON.stringify([{ name: 'Rusted Key', quantity: 1 }]), Date.now());
    return id;
  }

  for (const role of roles) {
    it(`lists for a ${role} Suggestions from every World, only where they may see the Session`, () => {
      const home = suggestion(role, HOME, 'log/home.md');
      const plain = suggestion(role, SHARED, 'log/plain.md');
      const dm = suggestion(role, SHARED, 'log/dm.md', { dmOnly: true });
      const gm = suggestion(role, SHARED, 'log/gm.md', { gmOnly: true });
      const visible = { viewer: [home, plain], editor: [home, plain, dm], admin: [home, plain, dm, gm] }[role];

      const listed = listMySuggestions({ userId: users[role] });

      expect(listed.map((s) => s.id).sort()).toEqual([...visible].sort());
    });
  }

  it('labels each Suggestion with its World', () => {
    suggestion('viewer', SHARED, 'log/plain.md');

    const [s] = listMySuggestions({ userId: users.viewer });

    expect({ worldId: s?.worldId, worldName: s?.worldName }).toEqual({ worldId: SHARED, worldName: 'Shared World' });
  });

  it('reads as not found in a World the user is not a member of', async () => {
    const id = suggestion('admin', OUTSIDE, 'log/outside.md');

    expect(listMySuggestions({ userId: users.admin })).toEqual([]);
    expect(await acceptSuggestion({ userId: users.admin, id })).toEqual({ status: 'not_found' });
    expect(dismissSuggestion({ userId: users.admin, id })).toEqual({ status: 'not_found' });
  });

  it('reads as not found to a viewer when the Session is Secret', async () => {
    const id = suggestion('viewer', SHARED, 'log/dm.md', { dmOnly: true });

    expect(await acceptSuggestion({ userId: users.viewer, id })).toEqual({ status: 'not_found' });
    expect(dismissSuggestion({ userId: users.viewer, id })).toEqual({ status: 'not_found' });
  });

  it('reads as not found to an editor when the Session is Private', async () => {
    const id = suggestion('editor', SHARED, 'log/gm.md', { gmOnly: true });

    expect(await acceptSuggestion({ userId: users.editor, id })).toEqual({ status: 'not_found' });
    expect(dismissSuggestion({ userId: users.editor, id })).toEqual({ status: 'not_found' });
  });

  it('hides a Suggestion whose Character Note is hidden from the Player', async () => {
    const secret = suggestion('viewer', SHARED, 'log/a.md', {}, { dmOnly: true });
    const priv = suggestion('editor', SHARED, 'log/b.md', {}, { gmOnly: true });

    expect(listMySuggestions({ userId: users.viewer })).toEqual([]);
    expect(listMySuggestions({ userId: users.editor })).toEqual([]);
    expect(await acceptSuggestion({ userId: users.viewer, id: secret })).toEqual({ status: 'not_found' });
    expect(dismissSuggestion({ userId: users.editor, id: priv })).toEqual({ status: 'not_found' });
  });

  it('accepts a Suggestion into its own World, whatever World the Player last opened', async () => {
    const id = suggestion('viewer', SHARED, 'log/plain.md');

    const result = await acceptSuggestion({ userId: users.viewer, id });

    const fm = getDb()
      .query<{ frontmatter_json: string }, [string, string]>('SELECT frontmatter_json FROM notes WHERE group_id = ? AND path = ?')
      .get(SHARED, 'chars/viewer.md')!.frontmatter_json;
    expect(result).toEqual({ status: 'ok', changed: true });
    expect((JSON.parse(fm) as { sheet: { items: string[] } }).sheet.items).toEqual(['Rusted Key']);
  });

  it('stops listing a Suggestion once the Player leaves its World', async () => {
    const id = suggestion('viewer', SHARED, 'log/plain.md');
    getDb().query('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(SHARED, users.viewer);

    expect(listMySuggestions({ userId: users.viewer })).toEqual([]);
    expect(await acceptSuggestion({ userId: users.viewer, id })).toEqual({ status: 'not_found' });
  });
});

describe('recent activity on Home', () => {
  it('never lists a Note from a World the user is not a member of', () => {
    seedNote(OUTSIDE, 'outside/plain.md', 'Outside');
    seedNote(SHARED, 'shared/plain.md', 'Shared');

    const worlds = new Set(listRecentForUser(users.viewer, 50).map((r) => r.groupId));

    expect([...worlds]).toEqual([SHARED]);
  });
});
