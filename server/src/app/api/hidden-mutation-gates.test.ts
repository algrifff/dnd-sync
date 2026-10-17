// Mutation routes must treat a note or asset the caller can't see as
// missing (#83): an editor acting on the admin's gm_only content gets
// the same response a missing target gets, and nothing changes. The
// admin, who can see it, still succeeds.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { setupTestDb, teardownTestDb } from '@/lib/test-utils';
import { createUser, DEFAULT_GROUP_ID } from '@/lib/users';
import { buildSessionCookies, createSession, type Session } from '@/lib/session';
import { POST as moveNote } from './notes/move/route';
import { DELETE as deleteNote } from './notes/[...path]/route';
import { PATCH as setVisibility } from './notes/visibility/route';
import { POST as deleteFolder } from './folders/delete/route';
import { POST as moveFolder } from './folders/move/route';
import { DELETE as deleteAsset } from './assets/[id]/route';
import { PATCH as setAssetTags } from './asset-tags/route';

type Role = 'admin' | 'editor' | 'viewer';
const sessions = {} as Record<Role, Session>;

function seedNote(
  path: string,
  flags: { gmOnly?: boolean; contentJson?: string } = {},
): void {
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                          content_md, yjs_state, frontmatter_json, byte_size,
                          updated_at, updated_by, created_at, created_by, dm_only, gm_only)
       VALUES (?, ?, ?, ?, ?, '', '', NULL, '{}', 0, ?, NULL, ?, NULL, 0, ?)`,
    )
    .run(
      randomUUID(),
      DEFAULT_GROUP_ID,
      path,
      path.split('/').pop()!.replace(/\.md$/, ''),
      flags.contentJson ?? '{"type":"doc","content":[]}',
      Date.now(),
      Date.now(),
      flags.gmOnly ? 1 : 0,
    );
}

function seedAsset(id: string, gmOnly: boolean): void {
  getDb()
    .query(
      `INSERT INTO assets (id, group_id, hash, mime, size, original_name, uploaded_at, gm_only)
       VALUES (?, ?, ?, 'image/png', 1, ?, ?, ?)`,
    )
    .run(id, DEFAULT_GROUP_ID, randomUUID(), `${id}.png`, Date.now(), gmOnly ? 1 : 0);
}

function notePaths(): string[] {
  return getDb()
    .query<{ path: string }, [string]>('SELECT path FROM notes WHERE group_id = ? ORDER BY path')
    .all(DEFAULT_GROUP_ID)
    .map((r) => r.path);
}

function assetExists(id: string): boolean {
  return !!getDb().query('SELECT 1 FROM assets WHERE id = ?').get(id);
}

function request(method: string, url: string, role: Role, body?: unknown): NextRequest {
  const session = sessions[role];
  const cookie = buildSessionCookies(session)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  return new Request(`http://localhost${url}`, {
    method,
    headers: { cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as unknown as NextRequest;
}

async function result(res: Response): Promise<{ status: number; body: unknown }> {
  return { status: res.status, body: await res.json() };
}

const call = {
  moveNote: async (role: Role, from: string, to: string) =>
    result(await moveNote(request('POST', '/api/notes/move', role, { from, to }))),
  deleteNote: async (role: Role, path: string) =>
    result(
      await deleteNote(request('DELETE', `/api/notes/${path}`, role), {
        params: Promise.resolve({ path: path.split('/') }),
      }),
    ),
  setVisibility: async (role: Role, path: string, dmOnly: boolean) =>
    result(await setVisibility(request('PATCH', '/api/notes/visibility', role, { path, dmOnly }))),
  deleteFolder: async (role: Role, path: string) =>
    result(await deleteFolder(request('POST', '/api/folders/delete', role, { path }))),
  moveFolder: async (role: Role, from: string, to: string) =>
    result(await moveFolder(request('POST', '/api/folders/move', role, { from, to }))),
  deleteAsset: async (role: Role, id: string) =>
    result(
      await deleteAsset(request('DELETE', `/api/assets/${id}`, role), {
        params: Promise.resolve({ id }),
      }),
    ),
  setAssetTags: async (role: Role, assetId: string, tags: string[]) =>
    result(await setAssetTags(request('PATCH', '/api/asset-tags', role, { assetId, tags }))),
};

const NOT_FOUND = { status: 404, body: { error: 'not_found' } };

beforeAll(async () => {
  setupTestDb();
  for (const role of ['admin', 'editor', 'viewer'] as const) {
    const user = await createUser({
      username: `gate-${role}`,
      displayName: role,
      password: 'correct-horse-battery',
      role,
    });
    sessions[role] = createSession({
      userId: user.id,
      groupId: DEFAULT_GROUP_ID,
      userAgent: null,
      ip: null,
    });
  }
});
afterAll(() => teardownTestDb());

beforeEach(() => {
  const db = getDb();
  for (const table of ['note_links', 'tags', 'notes', 'folder_markers', 'asset_tags', 'assets']) {
    db.exec(`DELETE FROM ${table}`);
  }
  seedNote('World Lore/Lore/Visible.md');
  seedNote('World Lore/Lore/Secret.md', { gmOnly: true });
  seedNote('World Lore/Vault/Plot.md', { gmOnly: true });
});

describe('POST /api/notes/move', () => {
  it('should answer an editor moving a gm_only note exactly like a missing note', async () => {
    const missing = await call.moveNote('editor', 'World Lore/Lore/Nope.md', 'World Lore/Lore/Moved.md');
    const hidden = await call.moveNote('editor', 'World Lore/Lore/Secret.md', 'World Lore/Lore/Moved.md');

    expect({ missing, hidden, paths: notePaths() }).toEqual({
      missing: NOT_FOUND,
      hidden: NOT_FOUND,
      paths: ['World Lore/Lore/Secret.md', 'World Lore/Lore/Visible.md', 'World Lore/Vault/Plot.md'],
    });
  });

  it('should let the admin move a gm_only note', async () => {
    const res = await call.moveNote('admin', 'World Lore/Lore/Secret.md', 'World Lore/Lore/Moved.md');

    expect({ res, paths: notePaths() }).toEqual({
      res: { status: 200, body: { ok: true, path: 'World Lore/Lore/Moved.md' } },
      paths: ['World Lore/Lore/Moved.md', 'World Lore/Lore/Visible.md', 'World Lore/Vault/Plot.md'],
    });
  });

  it('should still answer 409 exists when the destination is a hidden note', async () => {
    const res = await call.moveNote('editor', 'World Lore/Lore/Visible.md', 'World Lore/Lore/Secret.md');

    expect(res).toEqual({ status: 409, body: { error: 'exists', path: 'World Lore/Lore/Secret.md' } });
  });
});

describe('DELETE /api/notes/<path>', () => {
  it('should answer an editor deleting a gm_only note exactly like a missing note', async () => {
    const missing = await call.deleteNote('editor', 'World Lore/Lore/Nope.md');
    const hidden = await call.deleteNote('editor', 'World Lore/Lore/Secret.md');

    expect({ missing, hidden, paths: notePaths() }).toEqual({
      missing: NOT_FOUND,
      hidden: NOT_FOUND,
      paths: ['World Lore/Lore/Secret.md', 'World Lore/Lore/Visible.md', 'World Lore/Vault/Plot.md'],
    });
  });

  it('should let the admin delete a gm_only note', async () => {
    const res = await call.deleteNote('admin', 'World Lore/Lore/Secret.md');

    expect({ status: res.status, paths: notePaths() }).toEqual({
      status: 200,
      paths: ['World Lore/Lore/Visible.md', 'World Lore/Vault/Plot.md'],
    });
  });
});

describe('PATCH /api/notes/visibility', () => {
  function dmOnly(path: string): number {
    return getDb()
      .query<{ dm_only: number }, [string]>('SELECT dm_only FROM notes WHERE path = ?')
      .get(path)!.dm_only;
  }

  it('should answer an editor flipping a gm_only note exactly like a missing note', async () => {
    const missing = await call.setVisibility('editor', 'World Lore/Lore/Nope.md', true);
    const hidden = await call.setVisibility('editor', 'World Lore/Lore/Secret.md', true);

    expect({ missing, hidden, dmOnly: dmOnly('World Lore/Lore/Secret.md') }).toEqual({
      missing: NOT_FOUND,
      hidden: NOT_FOUND,
      dmOnly: 0,
    });
  });

  it('should let the admin flip a gm_only note', async () => {
    const res = await call.setVisibility('admin', 'World Lore/Lore/Secret.md', true);

    expect({ status: res.status, dmOnly: dmOnly('World Lore/Lore/Secret.md') }).toEqual({
      status: 200,
      dmOnly: 1,
    });
  });
});

describe('POST /api/folders/delete', () => {
  it('should skip and not count gm_only notes when an editor deletes their folder', async () => {
    const res = await call.deleteFolder('editor', 'World Lore/Lore');

    expect({ res, paths: notePaths() }).toEqual({
      res: { status: 200, body: { ok: true, deleted: 1, redirectTo: null } },
      paths: ['World Lore/Lore/Secret.md', 'World Lore/Vault/Plot.md'],
    });
  });

  it('should answer an editor deleting a gm_only note by its exact path like a missing path', async () => {
    const missing = await call.deleteFolder('editor', 'World Lore/Lore/Nope.md');
    const hidden = await call.deleteFolder('editor', 'World Lore/Lore/Secret.md');

    expect({ hidden, paths: notePaths() }).toEqual({
      hidden: missing,
      paths: ['World Lore/Lore/Secret.md', 'World Lore/Lore/Visible.md', 'World Lore/Vault/Plot.md'],
    });
  });

  it('should answer an editor deleting a folder of only gm_only notes like a missing folder', async () => {
    const missing = await call.deleteFolder('editor', 'World Lore/Nowhere');
    const hidden = await call.deleteFolder('editor', 'World Lore/Vault');

    expect({ hidden, paths: notePaths() }).toEqual({
      hidden: missing,
      paths: ['World Lore/Lore/Secret.md', 'World Lore/Lore/Visible.md', 'World Lore/Vault/Plot.md'],
    });
  });

  it('should delete and count gm_only notes when the admin deletes their folder', async () => {
    const res = await call.deleteFolder('admin', 'World Lore/Lore');

    expect({ res, paths: notePaths() }).toEqual({
      res: { status: 200, body: { ok: true, deleted: 2, redirectTo: null } },
      paths: ['World Lore/Vault/Plot.md'],
    });
  });
});

describe('POST /api/folders/move', () => {
  it('should not count gm_only notes in the moved total for an editor', async () => {
    const res = await call.moveFolder('editor', 'World Lore/Lore', 'World Lore/Legends');

    expect({ res, paths: notePaths() }).toEqual({
      res: { status: 200, body: { ok: true, path: 'World Lore/Legends', moved: 1 } },
      paths: ['World Lore/Legends/Secret.md', 'World Lore/Legends/Visible.md', 'World Lore/Vault/Plot.md'],
    });
  });

  it('should answer an editor moving a folder of only gm_only notes like a missing folder', async () => {
    const missing = await call.moveFolder('editor', 'World Lore/Nowhere', 'World Lore/Elsewhere');
    const hidden = await call.moveFolder('editor', 'World Lore/Vault', 'World Lore/Elsewhere');

    expect({ missing, hidden, paths: notePaths() }).toEqual({
      missing: NOT_FOUND,
      hidden: NOT_FOUND,
      paths: ['World Lore/Lore/Secret.md', 'World Lore/Lore/Visible.md', 'World Lore/Vault/Plot.md'],
    });
  });

  it('should count gm_only notes in the moved total for the admin', async () => {
    const res = await call.moveFolder('admin', 'World Lore/Vault', 'World Lore/Archive');

    expect({ res, paths: notePaths() }).toEqual({
      res: { status: 200, body: { ok: true, path: 'World Lore/Archive', moved: 1 } },
      paths: ['World Lore/Archive/Plot.md', 'World Lore/Lore/Secret.md', 'World Lore/Lore/Visible.md'],
    });
  });
});

describe('DELETE /api/assets/<id>', () => {
  it('should answer an editor deleting a gm_only asset exactly like a missing asset', async () => {
    seedAsset('gm-asset', true);

    const missing = await call.deleteAsset('editor', 'no-such-asset');
    const hidden = await call.deleteAsset('editor', 'gm-asset');

    expect({ missing, hidden, exists: assetExists('gm-asset') }).toEqual({
      missing: NOT_FOUND,
      hidden: NOT_FOUND,
      exists: true,
    });
  });

  it('should let the admin delete a gm_only asset', async () => {
    seedAsset('gm-asset', true);

    const res = await call.deleteAsset('admin', 'gm-asset');

    expect({ res, exists: assetExists('gm-asset') }).toEqual({
      res: { status: 200, body: { ok: true } },
      exists: false,
    });
  });

  it('should refuse without counting a reference from a gm_only note for an editor', async () => {
    seedAsset('shared-asset', false);
    seedNote('World Lore/Vault/Embeds.md', {
      gmOnly: true,
      contentJson: '{"type":"doc","content":[{"type":"image","attrs":{"assetId":"shared-asset"}}]}',
    });

    const res = await call.deleteAsset('editor', 'shared-asset');

    expect({ res, exists: assetExists('shared-asset') }).toEqual({
      res: {
        status: 409,
        body: {
          error: 'asset_in_use',
          reason: 'still referenced — remove the embed or portrait reference first',
        },
      },
      exists: true,
    });
  });

  it('should count a reference from a gm_only note for the admin', async () => {
    seedAsset('shared-asset', false);
    seedNote('World Lore/Vault/Embeds.md', {
      gmOnly: true,
      contentJson: '{"type":"doc","content":[{"type":"image","attrs":{"assetId":"shared-asset"}}]}',
    });

    const res = await call.deleteAsset('admin', 'shared-asset');

    expect(res.body).toEqual({
      error: 'asset_in_use',
      reason: 'still referenced by 1 note — remove the embed or portrait reference first',
    });
  });
});

describe('PATCH /api/asset-tags', () => {
  function assetTags(id: string): string[] {
    return getDb()
      .query<{ tag: string }, [string]>('SELECT tag FROM asset_tags WHERE asset_id = ? ORDER BY tag')
      .all(id)
      .map((r) => r.tag);
  }

  it('should answer an editor tagging a gm_only asset exactly like a missing asset', async () => {
    seedAsset('gm-asset', true);

    const missing = await call.setAssetTags('editor', 'no-such-asset', ['map']);
    const hidden = await call.setAssetTags('editor', 'gm-asset', ['map']);

    expect({ missing, hidden, tags: assetTags('gm-asset') }).toEqual({
      missing: NOT_FOUND,
      hidden: NOT_FOUND,
      tags: [],
    });
  });

  it('should let the admin tag a gm_only asset', async () => {
    seedAsset('gm-asset', true);

    const res = await call.setAssetTags('admin', 'gm-asset', ['map']);

    expect({ status: res.status, tags: assetTags('gm-asset') }).toEqual({
      status: 200,
      tags: ['map'],
    });
  });
});

describe('viewers', () => {
  it('should be forbidden from every one of these mutations, visible target or not', async () => {
    seedAsset('open-asset', false);

    const statuses = [
      (await call.moveNote('viewer', 'World Lore/Lore/Visible.md', 'World Lore/Lore/Moved.md')).status,
      (await call.deleteNote('viewer', 'World Lore/Lore/Visible.md')).status,
      (await call.setVisibility('viewer', 'World Lore/Lore/Visible.md', true)).status,
      (await call.deleteFolder('viewer', 'World Lore/Lore')).status,
      (await call.moveFolder('viewer', 'World Lore/Lore', 'World Lore/Legends')).status,
      (await call.deleteAsset('viewer', 'open-asset')).status,
      (await call.setAssetTags('viewer', 'open-asset', ['map'])).status,
    ];

    expect({ statuses, paths: notePaths(), asset: assetExists('open-asset') }).toEqual({
      statuses: [403, 403, 403, 403, 403, 403, 403],
      paths: ['World Lore/Lore/Secret.md', 'World Lore/Lore/Visible.md', 'World Lore/Vault/Plot.md'],
      asset: true,
    });
  });
});
