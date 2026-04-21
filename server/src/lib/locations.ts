// Location index derivation. A note with frontmatter `kind: location`
// gets a row in `locations` so the UI can build a tree / region view.

import { getDb } from './db';

type FrontmatterShape = {
  kind?: unknown;
  sheet?: Record<string, unknown>;
};

export function deriveLocationFromFrontmatter(opts: {
  groupId: string;
  notePath: string;
  frontmatterJson: string;
}): void {
  const db = getDb();

  let fm: FrontmatterShape;
  try {
    fm = JSON.parse(opts.frontmatterJson) as FrontmatterShape;
  } catch {
    fm = {};
  }

  if (fm.kind !== 'location') {
    db.query('DELETE FROM locations WHERE group_id = ? AND note_path = ?').run(
      opts.groupId,
      opts.notePath,
    );
    return;
  }

  const sheet = (fm.sheet && typeof fm.sheet === 'object' ? fm.sheet : {}) as Record<
    string,
    unknown
  >;

  const name = strOrNull(sheet.name) ?? filenameDisplayName(opts.notePath);
  const type = strOrNull(sheet.type);
  const region = strOrNull(sheet.region);
  const parentPath = strOrNull(sheet.parent_path);

  db.query(
    `INSERT INTO locations
       (group_id, note_path, name, type, region, parent_path, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (group_id, note_path) DO UPDATE SET
       name = excluded.name,
       type = excluded.type,
       region = excluded.region,
       parent_path = excluded.parent_path,
       updated_at = excluded.updated_at`,
  ).run(opts.groupId, opts.notePath, name, type, region, parentPath, Date.now());
}

export type LocationListRow = {
  notePath: string;
  name: string;
  type: string | null;
  region: string | null;
  parentPath: string | null;
  updatedAt: number;
};

export function listLocations(groupId: string): LocationListRow[] {
  return getDb()
    .query<
      {
        note_path: string;
        name: string;
        type: string | null;
        region: string | null;
        parent_path: string | null;
        updated_at: number;
      },
      [string]
    >(
      `SELECT note_path, name, type, region, parent_path, updated_at
         FROM locations
        WHERE group_id = ?
        ORDER BY name COLLATE NOCASE`,
    )
    .all(groupId)
    .map((r) => ({
      notePath: r.note_path,
      name: r.name,
      type: r.type,
      region: r.region,
      parentPath: r.parent_path,
      updatedAt: r.updated_at,
    }));
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function filenameDisplayName(notePath: string): string {
  return (notePath.split('/').pop() ?? notePath).replace(/\.(md|canvas)$/i, '');
}
