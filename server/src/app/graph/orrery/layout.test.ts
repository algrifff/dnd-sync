import { describe, expect, test } from 'bun:test';
import type { GraphNode, GraphPayload } from '@/lib/graph';
import {
  aggregateLinks,
  buildModel,
  campaignLabel,
  computeFocus,
  computeWheel,
  episodeOf,
  focusTargets,
  groupKey,
  neighbours,
  ring2Cap,
  searchNotes,
  sessionOrder,
  UNFILED,
  wheelTargets,
  type Filters,
  type Model,
  type ONode,
} from './layout';

type NodeSeed = Partial<GraphNode> & { id: string };

function node(seed: NodeSeed): GraphNode {
  return {
    title: seed.id.split('/').pop()!.replace(/\.md$/, ''),
    tags: [],
    degree: 0,
    kind: 'note',
    campaign: /^Campaigns\/([^/]+)/.exec(seed.id)?.[1] ?? null,
    isIndex: false,
    ...seed,
  };
}

function payload(nodes: GraphNode[], edges: Array<[string, string]> = [], relations: GraphPayload['relations'] = []): Pick<GraphPayload, 'nodes' | 'edges' | 'relations'> {
  const degree = new Map<string, number>();
  for (const [a, b] of edges) {
    degree.set(a, (degree.get(a) ?? 0) + 1);
    degree.set(b, (degree.get(b) ?? 0) + 1);
  }
  return {
    nodes: nodes.map((n) => ({ ...n, degree: degree.get(n.id) ?? 0 })),
    edges: edges.map(([source, target]) => ({ source, target })),
    relations,
  };
}

function filtersFor(model: Model, over: Partial<Filters> = {}): Filters {
  return {
    kinds: new Set(['character', 'person', 'creature', 'location', 'item', 'quest', 'lore', 'note']),
    camps: new Set(model.camps),
    showIndex: false,
    showSessions: false,
    ...over,
  };
}

/** Two campaigns plus loose World Lore, with sessions and index notes. */
function sampleWorld(): ReturnType<typeof payload> {
  const nodes: GraphNode[] = [
    node({ id: 'Campaigns/alpha/index.md', isIndex: true, title: 'Alpha' }),
    node({ id: 'Campaigns/alpha/Characters/index.md', isIndex: true, title: 'Characters' }),
    node({ id: 'Campaigns/alpha/Characters/Ayla.md', kind: 'character' }),
    node({ id: 'Campaigns/alpha/Characters/Brom.md', kind: 'character' }),
    node({ id: 'Campaigns/alpha/People/Cass.md', kind: 'person' }),
    node({ id: 'Campaigns/alpha/People/Dov.md', kind: 'person' }),
    node({ id: 'Campaigns/alpha/Places/Eld.md', kind: 'location' }),
    node({ id: 'Campaigns/alpha/Adventure Log/Episode 2.md', kind: 'session', title: 'Episode 2' }),
    node({ id: 'Campaigns/alpha/Adventure Log/Episode 10.md', kind: 'session', title: 'Episode 10' }),
    node({ id: 'Campaigns/alpha/Adventure Log/Episode 1.md', kind: 'session', title: 'Episode 1' }),
    node({ id: 'Campaigns/beta/Loot/Sword.md', kind: 'item' }),
    node({ id: 'Campaigns/beta/Creatures/Wyrm.md', kind: 'creature' }),
    node({ id: 'Campaigns/beta/Misc/index.md', isIndex: true, title: 'Misc' }),
    node({ id: 'World Lore/index.md', isIndex: true, campaign: null, title: 'World Lore' }),
    node({ id: 'World Lore/Gods.md', kind: 'lore', campaign: null }),
    node({ id: 'World Lore/Tides.md', kind: 'lore', campaign: null }),
  ];
  const edges: Array<[string, string]> = [
    ['Campaigns/alpha/Characters/Ayla.md', 'Campaigns/alpha/People/Cass.md'],
    ['Campaigns/alpha/Characters/Ayla.md', 'Campaigns/alpha/People/Dov.md'],
    ['Campaigns/alpha/Characters/Ayla.md', 'Campaigns/alpha/Places/Eld.md'],
    ['Campaigns/alpha/Characters/Ayla.md', 'Campaigns/alpha/Adventure Log/Episode 1.md'],
    ['Campaigns/alpha/Characters/Ayla.md', 'Campaigns/alpha/index.md'],
    ['Campaigns/alpha/People/Cass.md', 'Campaigns/alpha/Characters/Brom.md'],
    ['Campaigns/alpha/People/Dov.md', 'Campaigns/beta/Loot/Sword.md'],
    ['Campaigns/beta/Loot/Sword.md', 'World Lore/Gods.md'],
    ['Campaigns/alpha/Places/Eld.md', 'World Lore/Gods.md'],
  ];
  const relations: GraphPayload['relations'] = [
    { source: 'Campaigns/alpha/Characters/Ayla.md', target: 'Campaigns/alpha/People/Dov.md', relation: 'ally_of' },
  ];
  return payload(nodes, edges, relations);
}

const id = (m: Model, path: string): ONode => {
  const n = m.byId.get(path);
  if (!n) throw new Error(`no node ${path}`);
  return n;
};

describe('buildModel', () => {
  test('should group a note with no campaign by its top-level folder', () => {
    const m = buildModel(sampleWorld());
    expect(id(m, 'World Lore/Gods.md').campaign).toBe('World Lore');
  });

  test('should group a root-level note under the unfiled key', () => {
    const m = buildModel(payload([node({ id: 'Loose.md', campaign: null })]));
    expect(m.camps).toEqual([UNFILED]);
  });

  test('should order campaigns by note count, biggest first', () => {
    const m = buildModel(sampleWorld());
    expect(m.camps).toEqual(['alpha', 'beta', 'World Lore']);
  });

  test('should drop edges whose ends are missing or the same note', () => {
    const m = buildModel(payload([node({ id: 'a.md' })], [['a.md', 'a.md'], ['a.md', 'gone.md']]));
    expect(m.links).toHaveLength(0);
  });

  test('should mark the folder index of a campaign as its hub', () => {
    const m = buildModel(sampleWorld());
    expect(id(m, 'Campaigns/alpha/index.md').role).toBe('camp');
  });

  test('should give a kind folder index the majority kind of its members', () => {
    const m = buildModel(sampleWorld());
    const hub = id(m, 'Campaigns/alpha/Characters/index.md');
    expect([hub.role, hub.bandKind]).toEqual(['band', 'character']);
  });
});

describe('link counting', () => {
  const trio = [node({ id: 'a.md' }), node({ id: 'b.md' }), node({ id: 'c.md' })];

  test('should count two notes that link to each other as one link', () => {
    const m = buildModel(payload(trio, [['a.md', 'b.md'], ['b.md', 'a.md'], ['b.md', 'c.md']]));
    expect(m.links).toHaveLength(2);
  });

  test('should count a pair once however many times it is listed', () => {
    const m = buildModel(payload(trio, [['a.md', 'b.md'], ['a.md', 'b.md'], ['b.md', 'a.md']]));
    expect(m.links).toHaveLength(1);
  });

  test('should keep the first direction seen and the index flag of the pair', () => {
    const nodes = [node({ id: 'a.md' }), node({ id: 'idx/index.md', isIndex: true })];
    const m = buildModel(payload(nodes, [['idx/index.md', 'a.md'], ['a.md', 'idx/index.md']]));
    expect(m.links.map((l) => [l.s.id, l.t.id, l.index])).toEqual([['idx/index.md', 'a.md', true]]);
  });

  test('should give a note a degree of distinct linked notes, not directed edges', () => {
    const m = buildModel(payload(trio, [['a.md', 'b.md'], ['b.md', 'a.md'], ['c.md', 'b.md']]));
    expect([id(m, 'a.md').degree, id(m, 'b.md').degree, id(m, 'c.md').degree]).toEqual([1, 2, 1]);
  });
});

describe('session episode order', () => {
  test('should read the episode number from a title or a path', () => {
    expect([episodeOf('Episode 12', 'x.md'), episodeOf('Untitled', 'Log/session 03.md'), episodeOf('Untitled', 'x.md')]).toEqual([12, 3, null]);
  });

  test('should play numbered sessions in numeric order and unnumbered ones last', () => {
    const m = buildModel(
      payload([
        node({ id: 'c/Episode 10.md', kind: 'session', title: 'Episode 10', campaign: null }),
        node({ id: 'c/Prologue.md', kind: 'session', title: 'Prologue', campaign: null }),
        node({ id: 'c/Episode 2.md', kind: 'session', title: 'Episode 2', campaign: null }),
      ]),
    );
    expect(sessionOrder(m.nodes).map((n) => n.title)).toEqual(['Episode 2', 'Episode 10', 'Prologue']);
  });
});

describe('wheel layout', () => {
  test('should position every visible node with finite coordinates', () => {
    const m = buildModel(sampleWorld());
    const f = filtersFor(m, { showIndex: true, showSessions: true });
    const t = wheelTargets(m, computeWheel(m, f, 400), f);
    const bad = m.nodes.filter((n) => {
      const x = t.get(n)!;
      return x.a === 0 || !Number.isFinite(x.x) || !Number.isFinite(x.y);
    });
    expect(bad.map((n) => n.id)).toEqual([]);
  });

  test('should hide sessions until their toggle is on', () => {
    const m = buildModel(sampleWorld());
    const f = filtersFor(m);
    const t = wheelTargets(m, computeWheel(m, f, 400), f);
    const shown = m.nodes.filter((n) => n.kind === 'session' && t.get(n)!.a > 0);
    expect(shown).toEqual([]);
  });

  test('should hide the index of an empty folder until the index toggle is on', () => {
    const m = buildModel(sampleWorld());
    const misc = id(m, 'Campaigns/beta/Misc/index.md');
    const off = filtersFor(m);
    const on = filtersFor(m, { showIndex: true });
    const a = (f: Filters): number => wheelTargets(m, computeWheel(m, f, 400), f).get(misc)!.a;
    expect([a(off), a(on)]).toEqual([0, 1]);
  });

  test('should keep the campaign hub visible even with index notes off', () => {
    const m = buildModel(sampleWorld());
    const f = filtersFor(m);
    const t = wheelTargets(m, computeWheel(m, f, 400), f);
    expect(t.get(id(m, 'Campaigns/alpha/index.md'))!.a).toBe(1);
  });

  test('should remove a kind from the wheel when its toggle is off', () => {
    const m = buildModel(sampleWorld());
    const f = filtersFor(m, { kinds: new Set(['character']) });
    const t = wheelTargets(m, computeWheel(m, f, 400), f);
    expect(t.get(id(m, 'Campaigns/alpha/People/Cass.md'))!.a).toBe(0);
    expect(t.get(id(m, 'Campaigns/alpha/Characters/Ayla.md'))!.a).toBe(1);
  });

  test('should remove a campaign from the wheel when its chip is off', () => {
    const m = buildModel(sampleWorld());
    const f = filtersFor(m, { camps: new Set(['alpha']) });
    const W = computeWheel(m, f, 400);
    expect(W.sectors.map((s) => s.camp)).toEqual(['alpha']);
    expect(wheelTargets(m, W, f).get(id(m, 'Campaigns/beta/Loot/Sword.md'))!.a).toBe(0);
  });

  test('should lay sessions on the outer arc in episode order', () => {
    const m = buildModel(sampleWorld());
    const f = filtersFor(m, { showSessions: true });
    const W = computeWheel(m, f, 400);
    const th = ['Episode 1', 'Episode 2', 'Episode 10'].map((t) => W.pos.get(m.nodes.find((n) => n.title === t)!)!.th);
    expect(th[0]! < th[1]! && th[1]! < th[2]!).toBe(true);
  });

  test('should give each sector an angle proportional to its notes', () => {
    const m = buildModel(sampleWorld());
    const W = computeWheel(m, filtersFor(m), 400);
    const span = (c: string): number => W.by.get(c)!.span;
    expect(span('alpha')).toBeGreaterThan(span('beta'));
  });

  test('should give the drilled campaign the largest sector', () => {
    const m = buildModel(sampleWorld());
    const W = computeWheel(m, filtersFor(m), 400, 'beta');
    expect(W.by.get('beta')!.span).toBeGreaterThan(W.by.get('alpha')!.span);
  });

  test('should be deterministic', () => {
    const m = buildModel(sampleWorld());
    const f = filtersFor(m, { showIndex: true, showSessions: true });
    const snap = (): string => JSON.stringify([...wheelTargets(m, computeWheel(m, f, 400), f)].map(([n, t]) => [n.id, t]));
    expect(snap()).toBe(snap());
  });

  test('should render a world with no notes as an empty wheel', () => {
    const m = buildModel(payload([]));
    const W = computeWheel(m, filtersFor(m), 400);
    expect(W.sectors).toEqual([]);
  });

  test('should render a world with one note', () => {
    const m = buildModel(payload([node({ id: 'Only.md', campaign: null })]));
    const f = filtersFor(m);
    const t = wheelTargets(m, computeWheel(m, f, 400), f);
    expect(t.get(m.nodes[0]!)!.a).toBe(1);
  });
});

describe('link grouping', () => {
  test('should fold links between two groups into one bundle with a count', () => {
    const m = buildModel(sampleWorld());
    const bundles = aggregateLinks(m.links.filter((l) => !l.index), () => 1);
    const ab = bundles.find((b) => groupKey(b.a).startsWith('alpha|character') && groupKey(b.b).startsWith('alpha|person'));
    expect(ab?.n).toBe(3);
  });

  test('should drop links that stay inside one group', () => {
    const m = buildModel(
      payload([node({ id: 'Campaigns/a/People/X.md', kind: 'person' }), node({ id: 'Campaigns/a/People/Y.md', kind: 'person' })], [['Campaigns/a/People/X.md', 'Campaigns/a/People/Y.md']]),
    );
    expect(aggregateLinks(m.links, () => 1)).toEqual([]);
  });

  test('should drop links that are not visible yet', () => {
    const m = buildModel(sampleWorld());
    expect(aggregateLinks(m.links, () => 0)).toEqual([]);
  });

  test('should bundle every session of a campaign together', () => {
    const m = buildModel(sampleWorld());
    const keys = m.nodes.filter((n) => n.kind === 'session').map(groupKey);
    expect(new Set(keys).size).toBe(1);
  });
});

describe('focus layout', () => {
  test('should put exactly the visible direct neighbours on ring 1', () => {
    const m = buildModel(sampleWorld());
    const f = filtersFor(m);
    const ayla = id(m, 'Campaigns/alpha/Characters/Ayla.md');
    const F = computeFocus(m, f, ayla, 400);
    const expected = [...neighbours(ayla)].filter((n) => n.isIndex === false && n.kind !== 'session').map((n) => n.id).sort();
    expect(F.N1.map((n) => n.id).sort()).toEqual(expected);
  });

  test('should count linked index notes and sessions that are switched off', () => {
    const m = buildModel(sampleWorld());
    const F = computeFocus(m, filtersFor(m), id(m, 'Campaigns/alpha/Characters/Ayla.md'), 400);
    expect(F.hidden).toEqual({ index: 1, session: 1, filtered: 0 });
  });

  test('should bring switched-on sessions and index notes into ring 1', () => {
    const m = buildModel(sampleWorld());
    const f = filtersFor(m, { showIndex: true, showSessions: true });
    const F = computeFocus(m, f, id(m, 'Campaigns/alpha/Characters/Ayla.md'), 400);
    expect(F.N1.map((n) => n.title)).toContain('Episode 1');
    expect(F.N1.map((n) => n.title)).toContain('Alpha');
  });

  test('should remove a kind from ring 1 when its toggle is off', () => {
    const m = buildModel(sampleWorld());
    const f = filtersFor(m, { kinds: new Set(['character', 'location']) });
    const F = computeFocus(m, f, id(m, 'Campaigns/alpha/Characters/Ayla.md'), 400);
    expect(F.N1.map((n) => n.kind)).not.toContain('person');
    expect(F.hidden.filtered).toBe(2);
  });

  test('should treat a Relationship as a direct link', () => {
    const m = buildModel(
      payload([node({ id: 'a.md', campaign: null }), node({ id: 'b.md', campaign: null })], [], [{ source: 'a.md', target: 'b.md', relation: 'enemy_of' }]),
    );
    const F = computeFocus(m, filtersFor(m), id(m, 'a.md'), 400);
    expect(F.N1.map((n) => n.id)).toEqual(['b.md']);
  });

  test('should reach two-step notes on ring 2 and never repeat a ring-1 note', () => {
    const m = buildModel(sampleWorld());
    const F = computeFocus(m, filtersFor(m), id(m, 'Campaigns/alpha/Characters/Ayla.md'), 400);
    const ring2 = F.N2.map((n) => n.title).sort();
    expect(ring2).toEqual(['Brom', 'Gods', 'Sword']);
    expect(F.N2.some((n) => F.N1s.has(n))).toBe(false);
  });

  test('should cap ring 2 and report the overflow', () => {
    const hub = node({ id: 'Hub.md', campaign: null });
    const spokes = Array.from({ length: 3 }, (_, i) => node({ id: `S${i}.md`, campaign: null }));
    const far = Array.from({ length: 100 }, (_, i) => node({ id: `Far${String(i).padStart(3, '0')}.md`, campaign: null }));
    const edges: Array<[string, string]> = [
      ...spokes.map((s): [string, string] => ['Hub.md', s.id]),
      ...far.map((n, i): [string, string] => [spokes[i % 3]!.id, n.id]),
    ];
    const m = buildModel(payload([hub, ...spokes, ...far], edges));
    const F = computeFocus(m, filtersFor(m), id(m, 'Hub.md'), 400);
    expect([F.N2.length, F.overflow]).toEqual([ring2Cap(3), 100 - ring2Cap(3)]);
  });

  test('should shrink the ring-2 cap when ring 1 is crowded', () => {
    expect(ring2Cap(61)).toBeLessThan(ring2Cap(60));
  });

  test('should give every placed note a finite position and the centre the origin', () => {
    const m = buildModel(sampleWorld());
    const F = computeFocus(m, filtersFor(m), id(m, 'Campaigns/alpha/Characters/Ayla.md'), 400);
    const t = focusTargets(F);
    expect(t.get(F.c)).toMatchObject({ x: 0, y: 0, a: 1 });
    const placed = [F.c, ...F.N1, ...F.N2];
    expect(placed.every((n) => Number.isFinite(t.get(n)!.x) && Number.isFinite(t.get(n)!.y))).toBe(true);
  });

  test('should give each kind its own sector', () => {
    const m = buildModel(sampleWorld());
    const F = computeFocus(m, filtersFor(m), id(m, 'Campaigns/alpha/Characters/Ayla.md'), 400);
    const kinds = F.sectors.map((s) => s.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  test('should be deterministic', () => {
    const m = buildModel(sampleWorld());
    const f = filtersFor(m);
    const ayla = id(m, 'Campaigns/alpha/Characters/Ayla.md');
    const snap = (): string => JSON.stringify([...focusTargets(computeFocus(m, f, ayla, 400))].map(([n, t]) => [n.id, t]));
    expect(snap()).toBe(snap());
  });

  test('should lay out a note with no links as a lone centre', () => {
    const m = buildModel(payload([node({ id: 'Alone.md', campaign: null })]));
    const F = computeFocus(m, filtersFor(m), m.nodes[0]!, 400);
    expect([F.N1.length, F.N2.length, F.sectors.length]).toEqual([0, 0, 0]);
    expect(focusTargets(F).get(F.c)).toMatchObject({ x: 0, y: 0 });
  });
});

describe('compact focus (sidebar)', () => {
  const hub = node({ id: 'Hub.md', kind: 'character' });
  const spokes = Array.from({ length: 70 }, (_, i) => node({ id: `Spoke ${String(i).padStart(2, '0')}.md`, kind: i % 2 ? 'person' : 'location' }));
  const far = node({ id: 'Far.md' });
  const edges: Array<[string, string]> = [...spokes.map((n): [string, string] => ['Hub.md', n.id]), [spokes[0]!.id, 'Far.md']];
  const m = buildModel(payload([hub, ...spokes, far], edges));
  const f = filtersFor(m);

  test('should show direct links only, with no second ring', () => {
    const F = computeFocus(m, f, id(m, 'Hub.md'), 120, { compact: true });
    expect(F.N1).toHaveLength(70);
    expect([F.N2.length, F.overflow]).toEqual([0, 0]);
  });

  test('should keep the default layout unchanged without the option', () => {
    const F = computeFocus(m, f, id(m, 'Hub.md'), 120);
    expect(F.N2.map((n) => n.id)).toEqual(['Far.md']);
  });

  test('should place every satellite inside the disc, spread over several tracks', () => {
    const F = computeFocus(m, f, id(m, 'Hub.md'), 120, { compact: true });
    const rhos = [...F.pos.values()].map((p) => p.rho);
    expect(Math.max(...rhos)).toBeLessThanOrEqual(0.93 * 120 + 1e-9);
    expect(new Set(rhos.map((r) => Math.round(r))).size).toBeGreaterThan(1);
  });

  test('should keep one sector per kind', () => {
    const F = computeFocus(m, f, id(m, 'Hub.md'), 120, { compact: true });
    expect(F.sectors.map((s) => s.kind).sort()).toEqual(['location', 'person']);
  });

  test('should keep a note with no links centred with nothing around it', () => {
    const lone = buildModel(payload([node({ id: 'Lone.md' })]));
    const F = computeFocus(lone, filtersFor(lone), id(lone, 'Lone.md'), 120, { compact: true });
    expect([F.N1.length, F.sectors.length]).toEqual([0, 0]);
  });
});

describe('search and labels', () => {
  test('should rank a prefix match above a substring match', () => {
    const m = buildModel(payload([node({ id: 'a/Old Solistra.md', campaign: null }), node({ id: 'a/Solistra.md', campaign: null })]));
    expect(searchNotes(m, 'solis')[0]!.id).toBe('a/Solistra.md');
  });

  test('should find nothing for a name no note has', () => {
    const m = buildModel(sampleWorld());
    expect(searchNotes(m, 'zzzz')).toEqual([]);
  });

  test('should title-case a campaign slug the table does not know', () => {
    expect(campaignLabel('the-hired-help', {})).toBe('The Hired Help');
  });

  test('should prefer the name from the campaigns table', () => {
    expect(campaignLabel('the-hired-help', { 'the-hired-help': 'Hired Help, Inc.' })).toBe('Hired Help, Inc.');
  });

  test('should not read a label off the object prototype', () => {
    expect(campaignLabel('constructor', {})).toBe('Constructor');
  });
});
