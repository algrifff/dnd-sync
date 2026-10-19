// Every API route that takes a Note path must answer a Note the caller
// can't see exactly like a missing one, and change nothing. A Player
// (viewer) must not reach a Secret Note (dm_only); a Co-GM (editor) must
// not reach a Private Note (gm_only).
//
// The table below is checked against a glob of every route file, so a
// new route has to be listed: either as a Note-path route, which then
// runs through the gate check, or as one that takes no Note path, with
// the reason.

import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Glob } from 'bun';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import { createUser, DEFAULT_GROUP_ID as groupId } from '@/lib/users';
import { buildSessionCookies, createSession, type Session } from '@/lib/session';

// The neighbourhood route reads the GM-mode cookie through next/headers,
// which only works inside a Next request.
mock.module('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
  headers: async () => new Headers(),
}));

type Role = 'viewer' | 'editor';
type Target = 'note' | 'session' | 'character' | 'campaignIndex';
type Level = 'secret' | 'private';

/** For each Target, a missing path and a hidden Note of each Level.
 *  The hidden ones sit in folders holding nothing else, so a folder
 *  route on them sees only hidden content too. */
const PATHS: Record<Target, Record<Level | 'missing', string>> = {
  note: {
    missing: 'World Lore/Nowhere/Plain.md',
    secret: 'World Lore/Secret/Plain.md',
    private: 'World Lore/Private/Plain.md',
  },
  session: {
    missing: 'Campaigns/Ashfall/Adventure Log/nowhere.md',
    secret: 'Campaigns/Ashfall/Adventure Log/secret-session.md',
    private: 'Campaigns/Ashfall/Adventure Log/private-session.md',
  },
  character: {
    missing: 'Campaigns/Ashfall/Characters/nobody.md',
    secret: 'Campaigns/Ashfall/Characters/secret-hero.md',
    private: 'Campaigns/Ashfall/Characters/private-hero.md',
  },
  campaignIndex: {
    missing: 'Campaigns/Nowhere/index.md',
    secret: 'Campaigns/SecretCamp/index.md',
    private: 'Campaigns/PrivateCamp/index.md',
  },
};

const FRONTMATTER: Record<Target, Record<string, unknown>> = {
  note: { kind: 'note' },
  session: { kind: 'session', campaigns: ['ashfall'] },
  character: { kind: 'character', sheet: { name: 'Hero' } },
  campaignIndex: { kind: 'note' },
};

const VISIBLE = 'World Lore/Lore/Visible.md';

/** Which hidden Note each role must not reach. */
const CASES: Array<{ role: Role; level: Level; label: string }> = [
  { role: 'viewer', level: 'secret', label: 'a Player and a Secret Note' },
  { role: 'editor', level: 'private', label: 'a Co-GM and a Private Note' },
];

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, unknown>> }) => Promise<Response>;
type Call = { method: Method; url: string; body?: unknown; params?: Record<string, unknown> };

/** A route that takes a Note path: how to call one method of it on `path`. */
type NotePathRoute = {
  file: string;
  method: Method;
  target: Target;
  call: (path: string) => Call;
  /** Statuses a missing Note may get. Default 403 (role refused) or 404. */
  missingStatuses?: number[];
};

const segments = (path: string): Record<string, unknown> => ({ path: path.split('/') });

const NOTE_PATH_ROUTES: NotePathRoute[] = [
  { file: 'notes/[...path]/route.ts', method: 'GET', target: 'note',
    call: (p) => ({ method: 'GET', url: `/api/notes/${p}`, params: segments(p) }) },
  { file: 'notes/[...path]/route.ts', method: 'DELETE', target: 'note',
    call: (p) => ({ method: 'DELETE', url: `/api/notes/${p}`, params: segments(p) }) },
  { file: 'notes/move/route.ts', method: 'POST', target: 'note',
    call: (p) => ({ method: 'POST', url: '/api/notes/move', body: { from: p, to: 'World Lore/Lore/Moved.md' } }) },
  { file: 'notes/duplicate/route.ts', method: 'POST', target: 'note',
    call: (p) => ({ method: 'POST', url: '/api/notes/duplicate', body: { path: p } }) },
  { file: 'notes/promote/route.ts', method: 'POST', target: 'note',
    call: (p) => ({ method: 'POST', url: '/api/notes/promote', body: { fromPath: p, mode: 'copy' } }) },
  { file: 'notes/sheet/route.ts', method: 'PATCH', target: 'character',
    call: (p) => ({ method: 'PATCH', url: '/api/notes/sheet', body: { path: p, sheet: { level: 9 } } }) },
  { file: 'notes/visibility/route.ts', method: 'PATCH', target: 'note',
    call: (p) => ({ method: 'PATCH', url: '/api/notes/visibility', body: { path: p, dmOnly: false } }) },
  { file: 'notes/assign-player/route.ts', method: 'POST', target: 'character',
    call: (p) => ({ method: 'POST', url: '/api/notes/assign-player', body: { path: p, targetUserId: 'nobody' } }) },
  { file: 'notes/rename-folder-from-index/route.ts', method: 'POST', target: 'campaignIndex',
    call: (p) => ({ method: 'POST', url: '/api/notes/rename-folder-from-index', body: { indexPath: p, newTitle: 'Renamed' } }) },
  { file: 'notes/relations/route.ts', method: 'POST', target: 'note',
    call: (p) => ({ method: 'POST', url: '/api/notes/relations', body: { path: p, relation: 'link', otherPath: VISIBLE } }) },
  { file: 'notes/relations/route.ts', method: 'DELETE', target: 'note',
    call: (p) => ({ method: 'DELETE', url: '/api/notes/relations', body: { path: VISIBLE, relation: 'link', otherPath: p } }) },
  { file: 'note-tags/route.ts', method: 'PATCH', target: 'note',
    call: (p) => ({ method: 'PATCH', url: '/api/note-tags', body: { path: p, tags: ['renamed'] } }) },
  { file: 'graph/neighborhood/[...path]/route.ts', method: 'GET', target: 'note',
    call: (p) => ({ method: 'GET', url: `/api/graph/neighborhood/${p}`, params: segments(p) }) },
  { file: 'folders/move/route.ts', method: 'POST', target: 'note',
    call: (p) => ({ method: 'POST', url: '/api/folders/move', body: { from: p, to: 'World Lore/Elsewhere.md' } }) },
  { file: 'folders/delete/route.ts', method: 'POST', target: 'note',
    call: (p) => ({ method: 'POST', url: '/api/folders/delete', body: { path: p } }),
    // Deleting a path with nothing under it is a 200 that deleted 0.
    missingStatuses: [200, 403] },
  { file: 'sessions/mark-closed/route.ts', method: 'POST', target: 'session',
    call: (p) => ({ method: 'POST', url: '/api/sessions/mark-closed', body: { sessionPath: p } }) },
  { file: 'sessions/wrap-up/route.ts', method: 'GET', target: 'session',
    call: (p) => ({ method: 'GET', url: `/api/sessions/wrap-up?sessionPath=${encodeURIComponent(p)}` }) },
  { file: 'sessions/wrap-up/route.ts', method: 'POST', target: 'session',
    call: (p) => ({ method: 'POST', url: '/api/sessions/wrap-up', body: { sessionPath: p, mentions: [] } }) },
  { file: 'sessions/wrap-up/context/route.ts', method: 'GET', target: 'session',
    call: (p) => ({ method: 'GET', url: `/api/sessions/wrap-up/context?sessionPath=${encodeURIComponent(p)}` }) },
  { file: 'sessions/wrap-up/apply/route.ts', method: 'POST', target: 'session',
    call: (p) => ({ method: 'POST', url: '/api/sessions/wrap-up/apply', body: { sessionPath: p, generatedAt: 1, accepted: [] } }) },
];

/** Route files that take no path to an existing Note, and why. */
const NO_NOTE_PATH: Record<string, string> = {
  'admin/login/route.ts': 'super-admin login',
  'admin/vault/upload/route.ts': 'super-admin vault upload',
  'asset-tags/route.ts': 'asset id; covered by hidden-mutation-gates.test.ts',
  'assets/[id]/route.ts': 'asset id; covered by hidden-mutation-gates.test.ts',
  'assets/by-path/route.ts': 'asset vault path, gated with isAssetHiddenFrom',
  'assets/list/route.ts': 'asset list',
  'assets/upload/route.ts': 'asset upload',
  'campaigns/delete/route.ts': 'campaign slug, admin only',
  'campaigns/reorder/route.ts': 'campaign slugs',
  'characters/route.ts': 'list; covered by hidden-note-reads.test.ts',
  'dev/validate-sheet/route.ts': 'validates a sheet body, reads no Note',
  'folders/create/route.ts': 'creates a folder; hidden-content collision covered by hidden-mutation-gates.test.ts',
  'graph/route.ts': 'whole-world graph, filtered by GM mode (open question)',
  'health/route.ts': 'health check',
  'import/[id]/analyse/route.ts': 'import job id',
  'import/[id]/answer/route.ts': 'import job id',
  'import/[id]/apply/route.ts': 'import job id',
  'import/[id]/orchestrate/route.ts': 'import job id',
  'import/[id]/route.ts': 'import job id',
  'import/route.ts': 'import upload',
  'mcp/route.ts': 'bearer JSON-RPC; every tool is covered by lib/mcp/tools.test.ts',
  'me/characters/[id]/import-pdf/route.ts': 'user character id',
  'me/characters/[id]/route.ts': 'user character id',
  'me/characters/import-pdf/route.ts': 'PDF upload',
  'me/characters/route.ts': 'user characters',
  'notes/create/route.ts': 'creates a Note; a hidden Note at the path is covered by hidden-mutation-gates.test.ts',
  'notes/similar/route.ts': 'name lookup, not a path',
  'notes/suggest/route.ts': 'list; covered by hidden-note-reads.test.ts',
  'oauth/authorize/route.ts': 'OAuth',
  'oauth/grants/[id]/route.ts': 'OAuth grant id',
  'oauth/register/route.ts': 'OAuth',
  'oauth/revoke/route.ts': 'OAuth',
  'oauth/token/route.ts': 'OAuth',
  'profile/avatar/route.ts': 'profile',
  'profile/password/route.ts': 'profile',
  'profile/route.ts': 'profile',
  'sessions/create/route.ts': 'creates a Session from a campaign slug',
  'sessions/wrap-up/pending/route.ts': 'list; covered by wrap-up-routes.test.ts',
  'suggestions/[id]/accept/route.ts': 'Suggestion id; covered by suggestions-routes.test.ts',
  'suggestions/[id]/dismiss/route.ts': 'Suggestion id; covered by suggestions-routes.test.ts',
  'suggestions/route.ts': 'list; covered by suggestions-routes.test.ts',
  'tags/route.ts': 'list; covered by hidden-note-reads.test.ts',
  'templates/[kind]/route.ts': 'templates',
  'templates/route.ts': 'templates',
  'tree/route.ts': 'whole-world tree, filtered by GM mode (open question)',
  'ui/gm-mode/route.ts': 'GM mode toggle',
  'ui/search/route.ts': 'search, filtered by GM mode (open question)',
  'users/[userId]/avatar/route.ts': 'avatar',
  'worlds/[id]/campaigns/[slug]/join/route.ts': 'campaign join',
  'worlds/[id]/icon/route.ts': 'world icon',
  'worlds/[id]/invite/route.ts': 'world invite',
  'worlds/[id]/members/[userId]/route.ts': 'world members',
  'worlds/[id]/members/route.ts': 'world members',
  'worlds/[id]/route.ts': 'world settings',
  'worlds/[id]/transfer/route.ts': 'world transfer',
  'worlds/active/route.ts': 'active world',
  'worlds/order/route.ts': 'world order',
  'worlds/route.ts': 'world list',
};

const sessions = {} as Record<Role, Session>;

function request(as: Session, call: Call): NextRequest {
  const cookie = buildSessionCookies(as).map((c) => `${c.name}=${c.value}`).join('; ');
  return new NextRequest(`http://localhost${call.url}`, {
    method: call.method,
    headers: { cookie, 'x-csrf-token': as.csrfToken, 'content-type': 'application/json' },
    ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
  });
}

async function invoke(route: NotePathRoute, role: Role, path: string): Promise<{ status: number; body: unknown }> {
  const mod = (await import(`./${route.file}`)) as Record<string, Handler>;
  const call = route.call(path);
  const res = await mod[route.method]!(request(sessions[role], call), {
    params: Promise.resolve(call.params ?? {}),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* plain-text body */
  }
  return { status: res.status, body };
}

/** Everything a gate must leave alone. */
function snapshot(): unknown {
  const db = getDb();
  return {
    notes: db
      .query('SELECT path, title, frontmatter_json, content_json, dm_only, gm_only, updated_at FROM notes ORDER BY path')
      .all(),
    tags: db.query('SELECT path, tag FROM tags ORDER BY path, tag').all(),
    links: db.query('SELECT from_path, to_path FROM note_links ORDER BY from_path, to_path').all(),
    sessions: db.query('SELECT note_path, status FROM session_notes ORDER BY note_path').all(),
    folders: db.query('SELECT path FROM folder_markers ORDER BY path').all(),
  };
}

function seed(path: string, frontmatter: Record<string, unknown>, level: Level | 'plain'): void {
  const now = Date.now();
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text, content_md,
                          yjs_state, frontmatter_json, byte_size, updated_at, updated_by,
                          created_at, created_by, dm_only, gm_only)
       VALUES (?, ?, ?, ?, '{"type":"doc","content":[]}', '', '', NULL, ?, 0, ?, NULL, ?, NULL, ?, ?)`,
    )
    .run(randomUUID(), groupId, path, path.split('/').at(-2) ?? path, JSON.stringify(frontmatter), now, now,
         level === 'secret' ? 1 : 0, level === 'private' ? 1 : 0);
}

beforeAll(async () => {
  setupTestDb();
  for (const role of ['viewer', 'editor'] as const) {
    const user = await createUser({ username: `gates-${role}`, displayName: role, password: 'correct-horse-battery', role });
    sessions[role] = createSession({ userId: user.id, groupId, userAgent: null, ip: null });
  }
  getDb()
    .query('INSERT INTO campaigns (group_id, slug, name, folder_path, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(groupId, 'ashfall', 'Ashfall', 'Campaigns/Ashfall', Date.now());
});
afterAll(() => teardownTestDb());

// Fresh Notes per test, so a route whose gate is broken can't hide
// another route's broken gate by moving or deleting the shared fixture.
beforeEach(() => {
  const db = getDb();
  for (const table of ['note_links', 'note_relations', 'tags', 'session_notes', 'folder_markers', 'notes']) {
    db.exec(`DELETE FROM ${table}`);
  }
  seed(VISIBLE, { kind: 'note' }, 'plain');
  for (const target of Object.keys(PATHS) as Target[]) {
    seed(PATHS[target].secret, FRONTMATTER[target], 'secret');
    seed(PATHS[target].private, FRONTMATTER[target], 'private');
  }
});

describe('the route table', () => {
  const files = [...new Glob('**/route.ts').scanSync({ cwd: import.meta.dir })]
    .map((f) => f.replace(/\\/g, '/'))
    .sort();

  it('should list every route file exactly once', () => {
    const listed = [...new Set(NOTE_PATH_ROUTES.map((r) => r.file)), ...Object.keys(NO_NOTE_PATH)].sort();

    expect(listed).toEqual(files);
  });

  it('should cover every method a Note-path route exports', async () => {
    const missing: string[] = [];
    for (const file of new Set(NOTE_PATH_ROUTES.map((r) => r.file))) {
      const mod = (await import(`./${file}`)) as Record<string, unknown>;
      for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']) {
        const covered = NOTE_PATH_ROUTES.some((r) => r.file === file && r.method === method);
        if (typeof mod[method] === 'function' && !covered) missing.push(`${method} ${file}`);
      }
    }

    expect(missing).toEqual([]);
  });
});

for (const route of NOTE_PATH_ROUTES) {
  describe(`${route.method} ${route.file}`, () => {
    for (const { role, level, label } of CASES) {
      it(`should answer ${label} exactly like a missing Note, and change nothing`, async () => {
        const missing = await invoke(route, role, PATHS[route.target].missing);
        const before = snapshot();

        const hidden = await invoke(route, role, PATHS[route.target][level]);

        expect({ hidden, unchanged: snapshot() }).toEqual({ hidden: missing, unchanged: before });
        expect(route.missingStatuses ?? [403, 404]).toContain(missing.status);
      });
    }
  });
}
