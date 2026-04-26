// moveFolder() end-to-end: seed a campaign with a canonical
// subfolder, a third note linking [[Characters]] / [[Characters/Alice]],
// then rename the folder and assert paths + wikilinks both follow.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { setupTestDb, teardownTestDb } from './test-utils';
import { moveFolder } from './move-folder';
import { getRenameableFolderForIndex } from './folder-rename';

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());

const groupId = 'g_test_movefolder';
const userId = 'u_test_movefolder';

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM note_links');
  db.exec('DELETE FROM notes');
  db.exec('DELETE FROM notes_fts');
  db.exec('DELETE FROM folder_markers');
  db.exec(`DELETE FROM groups WHERE id = '${groupId}'`);
  db.exec(`DELETE FROM users WHERE id = '${userId}'`);
  db.query('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(
    groupId,
    'Test',
    Date.now(),
  );
  db.query(
    `INSERT INTO users (id, username, display_name, password_hash, accent_color, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(userId, 'tester', 'Tester', 'x', '#000', Date.now());
});

function seedNote(args: {
  path: string;
  title: string;
  contentJson?: unknown;
}): void {
  const db = getDb();
  const json = JSON.stringify(args.contentJson ?? { type: 'doc', content: [] });
  db.query(
    `INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                        content_md, yjs_state, frontmatter_json, byte_size,
                        updated_at, updated_by, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, '', '', ?, '{}', 0, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    groupId,
    args.path,
    args.title,
    json,
    new Uint8Array(),
    Date.now(),
    userId,
    Date.now(),
    userId,
  );
  db.query(
    'INSERT INTO notes_fts(path, group_id, title, content) VALUES (?, ?, ?, ?)',
  ).run(args.path, groupId, args.title, '');
}

function noteExists(path: string): boolean {
  const row = getDb()
    .query<{ n: number }, [string, string]>(
      'SELECT COUNT(*) AS n FROM notes WHERE group_id = ? AND path = ?',
    )
    .get(groupId, path);
  return (row?.n ?? 0) > 0;
}

describe('getRenameableFolderForIndex', () => {
  it('returns the folder for a campaign-root index', () => {
    const r = getRenameableFolderForIndex('Campaigns/Dragon-Heist/index.md');
    expect(r?.folderPath).toBe('Campaigns/Dragon-Heist');
    expect(r?.parentPath).toBe('Campaigns');
    expect(r?.currentName).toBe('Dragon-Heist');
    expect(r?.isCampaignRoot).toBe(true);
  });

  it('rejects canonical subfolder index notes (locked)', () => {
    expect(
      getRenameableFolderForIndex('Campaigns/Dragon-Heist/Characters/index.md'),
    ).toBeNull();
  });

  it('rejects non-index notes', () => {
    expect(
      getRenameableFolderForIndex('Campaigns/Dragon-Heist/Characters/Alice.md'),
    ).toBeNull();
  });

  it('rejects non-canonical custom subfolders', () => {
    expect(
      getRenameableFolderForIndex('Campaigns/Dragon-Heist/Custom/index.md'),
    ).toBeNull();
  });
});

describe('moveFolder — canonical subfolder rename', () => {
  it('moves every child path and rewrites wikilinks pointing at the prefix', async () => {
    // Arrange: a campaign with a Characters subfolder + a backlink note
    // in a sibling folder that references both the folder index and a
    // child via wikilinks.
    const fromFolder = 'Campaigns/Dragon-Heist/Characters';
    const toFolder = 'Campaigns/Dragon-Heist/Party Members';
    const indexPath = `${fromFolder}/index.md`;
    const aliceOld = `${fromFolder}/Alice.md`;
    const bobOld = `${fromFolder}/Bob.md`;
    const linkerPath = 'Campaigns/Dragon-Heist/People/Lore.md';

    seedNote({ path: indexPath, title: 'Characters' });
    seedNote({ path: aliceOld, title: 'Alice' });
    seedNote({ path: bobOld, title: 'Bob' });
    seedNote({
      path: linkerPath,
      title: 'Lore',
      contentJson: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'wikilink',
                attrs: {
                  target: fromFolder,
                  label: 'Characters',
                  anchor: null,
                  orphan: false,
                },
              },
              { type: 'text', text: ' and ' },
              {
                type: 'wikilink',
                attrs: {
                  target: aliceOld,
                  label: 'Alice',
                  anchor: null,
                  orphan: false,
                },
              },
            ],
          },
        ],
      },
    });
    // Edges that the wikilink rewriter relies on to find the linker.
    const db = getDb();
    db.query(
      'INSERT INTO note_links (group_id, from_path, to_path) VALUES (?, ?, ?)',
    ).run(groupId, linkerPath, fromFolder);
    db.query(
      'INSERT INTO note_links (group_id, from_path, to_path) VALUES (?, ?, ?)',
    ).run(groupId, linkerPath, aliceOld);

    // Act
    const result = await moveFolder({
      groupId,
      userId,
      from: fromFolder,
      to: toFolder,
    });

    // Assert: success + paths moved
    expect(result.ok).toBe(true);
    expect(noteExists(indexPath)).toBe(false);
    expect(noteExists(aliceOld)).toBe(false);
    expect(noteExists(bobOld)).toBe(false);
    expect(noteExists(`${toFolder}/index.md`)).toBe(true);
    expect(noteExists(`${toFolder}/Alice.md`)).toBe(true);
    expect(noteExists(`${toFolder}/Bob.md`)).toBe(true);

    // FTS mirror tracks new paths
    const ftsRow = db
      .query<{ n: number }, [string, string]>(
        'SELECT COUNT(*) AS n FROM notes_fts WHERE group_id = ? AND path = ?',
      )
      .get(groupId, `${toFolder}/Alice.md`);
    expect(ftsRow?.n).toBe(1);

    // Wikilink targets in the linker note now point at the new prefix
    const linkerRow = db
      .query<{ content_json: string }, [string, string]>(
        'SELECT content_json FROM notes WHERE group_id = ? AND path = ?',
      )
      .get(groupId, linkerPath);
    expect(linkerRow).not.toBeNull();
    const updated = JSON.parse(linkerRow!.content_json);
    const wikilinks: string[] = [];
    function walk(node: { type?: string; attrs?: { target?: string }; content?: unknown[] }): void {
      if (node.type === 'wikilink' && node.attrs?.target) {
        wikilinks.push(node.attrs.target);
      }
      if (Array.isArray(node.content)) {
        for (const c of node.content) walk(c as Parameters<typeof walk>[0]);
      }
    }
    walk(updated);
    expect(wikilinks).toContain(toFolder);
    expect(wikilinks).toContain(`${toFolder}/Alice.md`);
    expect(wikilinks).not.toContain(fromFolder);
    expect(wikilinks).not.toContain(aliceOld);

    // note_links graph follows the rename
    const edgeRow = db
      .query<{ n: number }, [string, string, string]>(
        `SELECT COUNT(*) AS n FROM note_links
          WHERE group_id = ? AND from_path = ? AND to_path = ?`,
      )
      .get(groupId, linkerPath, toFolder);
    expect(edgeRow?.n).toBe(1);
  });

  it('rejects with `exists` when the destination folder is occupied', async () => {
    seedNote({
      path: 'Campaigns/Dragon-Heist/Characters/index.md',
      title: 'Characters',
    });
    seedNote({
      path: 'Campaigns/Dragon-Heist/Party Members/index.md',
      title: 'Party Members',
    });
    const result = await moveFolder({
      groupId,
      userId,
      from: 'Campaigns/Dragon-Heist/Characters',
      to: 'Campaigns/Dragon-Heist/Party Members',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('exists');
  });
});
