import { describe, expect, it } from 'bun:test';
import {
  groupRelations,
  mergeLinks,
  relationProvenance,
  type RelationRow,
} from './connections';

const rel = (label: string, path: string, title: string): RelationRow => ({
  relation: label.replace(/ /g, '_') as RelationRow['relation'],
  label,
  path,
  title,
  sessionPath: null,
  fromSession: false,
  sessionTitle: null,
  createdBy: null,
});

describe('groupRelations', () => {
  it('groups by label, labels and rows sorted', () => {
    const groups = groupRelations([
      rel('Works for', 'b.md', 'Bree'),
      rel('Located in', 'k.md', 'Kingsport'),
      rel('Works for', 'a.md', 'Ada'),
    ]);

    expect(groups.map((g) => g.label)).toEqual(['Located in', 'Works for']);
    expect(groups[1]?.rows.map((r) => r.title)).toEqual(['Ada', 'Bree']);
  });

  it('is empty for no Relationships', () => {
    expect(groupRelations([])).toEqual([]);
  });
});

describe('mergeLinks', () => {
  const me = 'me.md';

  it('gives each direction its own arrow and merges both into one row', () => {
    const rows = mergeLinks({
      currentPath: me,
      outgoing: [
        { to_path: 'a.md', title: 'A', is_manual: 1 },
        { to_path: 'c.md', title: 'C', is_manual: 0 },
      ],
      backlinks: [
        { from_path: 'b.md', title: 'B', is_manual: 0 },
        { from_path: 'c.md', title: 'C', is_manual: 1 },
      ],
    });

    expect(rows.map((r) => [r.path, r.direction])).toEqual([
      ['a.md', 'out'],
      ['b.md', 'in'],
      ['c.md', 'both'],
    ]);
    expect(rows[2]?.edges).toEqual([
      { fromPath: me, toPath: 'c.md' },
      { fromPath: 'c.md', toPath: me },
    ]);
  });

  it('leaves out paths already shown under Relationships', () => {
    const rows = mergeLinks({
      currentPath: me,
      outgoing: [{ to_path: 'a.md', title: 'A', is_manual: 1 }],
      backlinks: [{ from_path: 'a.md', title: 'A', is_manual: 1 }, { from_path: 'b.md', title: 'B', is_manual: 0 }],
      exclude: new Set(['a.md']),
    });

    expect(rows.map((r) => r.path)).toEqual(['b.md']);
  });

  it('ignores a self link', () => {
    expect(
      mergeLinks({ currentPath: me, outgoing: [{ to_path: me, title: 'Me', is_manual: 0 }], backlinks: [] }),
    ).toEqual([]);
  });
});

describe('relationProvenance', () => {
  it('prefers the Session', () => {
    expect(
      relationProvenance({ sessionPath: 'Logs/s1.md', fromSession: true, sessionTitle: 'The Mill', createdBy: 'Alex' }),
    ).toEqual({ kind: 'session', path: 'Logs/s1.md', title: 'The Mill' });
  });

  it('names the Session by its file when the title is empty', () => {
    expect(
      relationProvenance({ sessionPath: 'Logs/s1.md', fromSession: true, sessionTitle: '', createdBy: 'Alex' }),
    ).toEqual({ kind: 'session', path: 'Logs/s1.md', title: 's1' });
  });

  it('says "from a Session" without a link when the Session is not visible', () => {
    expect(
      relationProvenance({ sessionPath: null, fromSession: true, sessionTitle: null, createdBy: 'Alex' }),
    ).toEqual({ kind: 'hidden-session' });
  });

  it('falls back to who added it, then to nothing', () => {
    expect(relationProvenance({ sessionPath: null, fromSession: false, sessionTitle: null, createdBy: 'Alex' })).toEqual({
      kind: 'author',
      name: 'Alex',
    });
    expect(relationProvenance({ sessionPath: null, fromSession: false, sessionTitle: null, createdBy: null })).toBeNull();
  });
});
