import { describe, expect, it } from 'bun:test';
import {
  connectionOptions,
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
  sessionTitle: null,
  createdBy: null,
  canRemove: true,
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
      relationProvenance({ sessionPath: 'Logs/s1.md', sessionTitle: 'The Mill', createdBy: 'Alex' }),
    ).toEqual({ kind: 'session', path: 'Logs/s1.md', title: 'The Mill' });
  });

  it('falls back to who added it, then to nothing', () => {
    expect(relationProvenance({ sessionPath: null, sessionTitle: null, createdBy: 'Alex' })).toEqual({
      kind: 'author',
      name: 'Alex',
    });
    expect(relationProvenance({ sessionPath: null, sessionTitle: null, createdBy: null })).toBeNull();
  });
});

describe('connectionOptions', () => {
  const options = connectionOptions();

  it('starts with a plain link', () => {
    expect(options[0]).toEqual({ value: 'link', label: 'just linked' });
  });

  it('offers every type and every inverse once, labelled from this side', () => {
    const byValue = Object.fromEntries(options.map((o) => [o.value, o.label]));

    expect(byValue.works_for).toBe('works for');
    expect(byValue.employs).toBe('employs');
    expect(byValue.contains).toBe('contains');
    expect(byValue.ally_of).toBe('ally of');
    expect(new Set(options.map((o) => o.value)).size).toBe(options.length);
    // 9 types + 6 inverses of the directed ones + the plain link.
    expect(options).toHaveLength(1 + 9 + 6);
  });
});
