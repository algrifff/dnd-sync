import { describe, expect, it } from 'bun:test';

import { planImport } from './import-plan';

describe('planImport — Main-Notes shape (structured)', () => {
  it('routes a campaign-rooted character through Characters/ + parses sheet', () => {
    const r = planImport({
      files: [
        {
          sourcePath: 'Campaign 3 - Vacant Thrones/Characters/Duke Davis.md',
          content: [
            '---',
            'name: Duke Davis',
            'player: Alucard8008',
            'class: Barbarian',
            'subclass: Wild Magic',
            'race: Orc',
            'level: 17',
            '---',
            '# Duke Davis',
            '',
            '## Basics',
            '| Field | Value |',
            '|-------|-------|',
            '| HP | 206 |',
            '| AC | 16 |',
            '',
            '## Ability Scores',
            '| STR | DEX | CON | INT | WIS | CHA |',
            '|-----|-----|-----|-----|-----|-----|',
            '| 19 (+4) | 14 (+2) | 18 (+4) | 9 (-1) | 9 (-1) | 11 (+0) |',
          ].join('\n'),
        },
      ],
      assets: [],
      defaultPlayerUsername: 'algrifff',
    });

    expect(r.files).toHaveLength(1);
    const f = r.files[0]!;
    expect(f.targetPath).toBe(
      'Campaigns/vacant-thrones/Characters/Duke Davis.md',
    );
    expect(f.kind).toBe('character');
    expect(f.campaignSlug).toBe('vacant-thrones');
    const sheet = f.frontmatter.sheet as Record<string, unknown>;
    expect(sheet.armor_class).toEqual({ value: 16 });
    expect(sheet.hit_points).toMatchObject({ max: 206, current: 206 });
    expect(sheet.ability_scores).toEqual({
      str: 19, dex: 14, con: 18, int: 9, wis: 9, cha: 11,
    });
    expect(r.campaigns).toEqual([
      { slug: 'vacant-thrones', name: 'Vacant Thrones' },
    ]);
  });

  it('renames campaign-root index file and registers original-name alias', () => {
    const r = planImport({
      files: [
        {
          sourcePath: 'Campaign 1 - The Hired Help/index -The Hired Help.md',
          content: '# The Hired Help\n',
        },
      ],
      assets: [],
    });

    expect(r.files[0]!.targetPath).toBe('Campaigns/the-hired-help/index.md');
    expect(r.files[0]!.aliases).toEqual(['index -The Hired Help']);
  });

  it('pads single-digit Episode/Session numbers + aliases the unpadded form', () => {
    const r = planImport({
      files: [
        {
          sourcePath: 'Campaign 2 - Sins/Adventure Log/Episode 1.md',
          content: '# Episode 1',
        },
        {
          sourcePath: 'Campaign 2 - Sins/Adventure Log/Episode 12.md',
          content: '# Episode 12',
        },
      ],
      assets: [],
    });

    const ep01 = r.files.find((f) => f.targetPath.endsWith('Episode 01.md'));
    const ep12 = r.files.find((f) => f.targetPath.endsWith('Episode 12.md'));
    expect(ep01).toBeDefined();
    expect(ep01!.aliases).toEqual(['Episode 1']);
    expect(ep12).toBeDefined();
    expect(ep12!.aliases).toEqual([]);
  });

  it('flattens Adventure Log when only one player has populated logs', () => {
    const sourceFiles = [
      { sourcePath: 'Campaign 3 - Vt/Adventure Log/Ben/Session 1.md', content: '' },
      { sourcePath: 'Campaign 3 - Vt/Adventure Log/Ben/Session 2.md', content: '' },
      { sourcePath: 'Campaign 3 - Vt/Adventure Log/Cash/Untitled.md', content: '' },
    ];
    const r = planImport({ files: sourceFiles, assets: [] });
    const ben1 = r.files.find((f) => f.sourcePath.endsWith('Ben/Session 1.md'));
    const cash = r.files.find((f) => f.sourcePath.endsWith('Cash/Untitled.md'));
    expect(ben1!.targetPath).toBe('Campaigns/vt/Adventure Log/Session 01.md');
    // Cash's stray file is NOT the flattened player; gets player-prefix.
    expect(cash!.targetPath).toBe('Campaigns/vt/Adventure Log/Cash - Untitled.md');
  });

  it('classifies World Lore notes into custom subfolders', () => {
    const files = [
      { sourcePath: 'World Lore/Pelor.md', content: '# Pelor' },
      { sourcePath: 'World Lore/House Esquin.md', content: '# House Esquin' },
      { sourcePath: 'World Lore/Some Random.md', content: '# Some Random' },
    ];
    const r = planImport({ files, assets: [] });
    expect(r.files.find((f) => f.sourcePath.endsWith('Pelor.md'))!.targetPath).toBe(
      'World Lore/Gods/Pelor.md',
    );
    expect(
      r.files.find((f) => f.sourcePath.endsWith('House Esquin.md'))!.targetPath,
    ).toBe('World Lore/Houses/House Esquin.md');
    // Unmatched goes to the root.
    expect(
      r.files.find((f) => f.sourcePath.endsWith('Some Random.md'))!.targetPath,
    ).toBe('World Lore/Some Random.md');
  });

  it('promotes a top-level non-canonical folder to one-shot campaigns', () => {
    const r = planImport({
      files: [
        { sourcePath: 'One-Shots/The Dancing Demon.md', content: '# Dancing Demon' },
        { sourcePath: 'One-Shots/Party/Bailin Silverchord.md', content: '' },
      ],
      assets: [],
    });
    const idx = r.files.find((f) => f.sourcePath.endsWith('Dancing Demon.md'));
    expect(idx!.targetPath).toBe(
      'Campaigns/one-shots-the-dancing-demon/index.md',
    );
    expect(idx!.aliases).toEqual(['The Dancing Demon']);
    const pc = r.files.find((f) => f.sourcePath.endsWith('Bailin Silverchord.md'));
    expect(pc!.targetPath).toContain('/Characters/Bailin Silverchord.md');
    expect(pc!.kind).toBe('character');
  });
});

describe('planImport — ambiguous source with AI classifications', () => {
  it('uses the AI classification to compute a canonical path', () => {
    const r = planImport({
      files: [
        { sourcePath: 'inbox/random-character-dump.md', content: '# Some PC\n\n## Basics' },
      ],
      assets: [],
      aiClassifications: new Map([
        [
          'inbox/random-character-dump.md',
          {
            kind: 'character',
            campaignSlug: 'mycampaign',
            displayName: 'Some PC',
          },
        ],
      ]),
    });
    expect(r.files[0]!.targetPath).toBe(
      'Campaigns/mycampaign/Characters/random-character-dump.md',
    );
    expect(r.files[0]!.kind).toBe('character');
  });

  it('falls back to World Lore for an unclassified flat file', () => {
    const r = planImport({
      files: [{ sourcePath: 'mystery.md', content: '# Mystery' }],
      assets: [],
    });
    expect(r.files[0]!.targetPath).toBe('World Lore/mystery.md');
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe('planImport — assets', () => {
  it('preserves canonical asset categories and falls back to root', () => {
    const r = planImport({
      files: [],
      assets: [
        {
          sourcePath: 'Campaign 1/Assets/Portraits/x.png',
          basename: 'x.png',
          mime: 'image/png',
        },
        {
          sourcePath: 'random/y.png',
          basename: 'y.png',
          mime: 'image/png',
        },
      ],
    });
    expect(r.assets[0]!.destPath).toBe('Assets/Portraits/x.png');
    expect(r.assets[1]!.destPath).toBe('Assets/y.png');
  });
});
