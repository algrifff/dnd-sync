import { describe, expect, test } from 'bun:test';
import { canonicalFolder, type EntityKind } from './paths';

const FOLDER: Record<EntityKind, string> = {
  character: 'Campaigns/x/Characters',
  pc: 'Campaigns/x/Characters',
  person: 'Campaigns/x/People',
  npc: 'Campaigns/x/People',
  ally: 'Campaigns/x/People',
  villain: 'Campaigns/x/People',
  creature: 'Campaigns/x/Creatures',
  monster: 'Campaigns/x/Creatures',
  item: 'Campaigns/x/Loot',
  location: 'Campaigns/x/Places',
  session: 'Campaigns/x/Adventure Log',
  quest: 'Campaigns/x/Quests',
  lore: 'World Lore',
  note: 'Campaigns/x',
};

describe('canonicalFolder', () => {
  test.each(Object.entries(FOLDER))('%s lands in %s', (kind, folder) => {
    expect(canonicalFolder({ kind: kind as EntityKind, campaignSlug: 'x' })).toBe(folder);
  });

  test('a world-level quest lands in Quests/', () => {
    expect(canonicalFolder({ kind: 'quest' })).toBe('Quests');
  });
});
