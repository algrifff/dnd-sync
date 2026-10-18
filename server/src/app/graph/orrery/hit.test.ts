import { describe, expect, test } from 'bun:test';
import { distToPath, pickAt, pickPath, REL_HIT_PX, type NodeHit, type PathHit } from './hit';

// A quadratic bowing down from (0,0) to (200,0) through (100,50) at its middle.
const BOW = [0, 0, 100, 100, 200, 0];
// A cubic S from (0,200) to (300,200).
const ESS = [0, 200, 100, 100, 200, 300, 300, 200];
const LINE = [0, 400, 200, 400];

describe('distToPath', () => {
  test('is zero on a straight line and the perpendicular distance beside it', () => {
    expect(distToPath(LINE, 100, 400)).toBe(0);
    expect(distToPath(LINE, 100, 410)).toBe(10);
  });

  test('follows a curve, not the chord between its ends', () => {
    const onCurve = distToPath(BOW, 100, 50);
    const onChord = distToPath(BOW, 100, 0);

    expect(onCurve).toBeLessThan(1);
    expect(onChord).toBeGreaterThan(40);
  });
});

describe('pickPath', () => {
  const paths: PathHit<string>[] = [
    { p: BOW, item: 'bow' },
    { p: ESS, item: 'ess' },
    { p: LINE, item: 'line' },
  ];

  test('picks the Relationship whose curve the pointer is near', () => {
    expect(pickPath(paths, 100, 50 + REL_HIT_PX - 1)).toBe('bow');
    expect(pickPath(paths, 150, 200)).toBe('ess');
    expect(pickPath(paths, 30, 397)).toBe('line');
  });

  test('picks nothing when the pointer is further than the tolerance', () => {
    expect(pickPath(paths, 100, 50 + REL_HIT_PX + 4)).toBeNull();
    expect(pickPath(paths, 100, 0)).toBeNull();
    expect(pickPath(paths, 900, 900)).toBeNull();
  });

  test('picks the nearer of two lines when both are within reach', () => {
    const close: PathHit<string>[] = [
      { p: [0, 0, 100, 0], item: 'upper' },
      { p: [0, 6, 100, 6], item: 'lower' },
    ];

    expect(pickPath(close, 50, 5)).toBe('lower');
    expect(pickPath(close, 50, 1)).toBe('upper');
  });
});

describe('pickAt', () => {
  const rels: PathHit<string>[] = [{ p: LINE, item: 'line' }];

  test('a node under the pointer wins over a Relationship line under it', () => {
    const nodes: NodeHit<string>[] = [{ x: 0, y: 400, r: 8, item: 'volo' }];

    expect(pickAt(nodes, rels, 3, 401)).toEqual({ type: 'node', item: 'volo' });
  });

  test('falls back to the line when no node is under the pointer', () => {
    const nodes: NodeHit<string>[] = [{ x: 0, y: 400, r: 8, item: 'volo' }];

    expect(pickAt(nodes, rels, 100, 403)).toEqual({ type: 'rel', item: 'line' });
  });

  test('is null over empty space', () => {
    expect(pickAt([], rels, 100, 300)).toBeNull();
  });
});
