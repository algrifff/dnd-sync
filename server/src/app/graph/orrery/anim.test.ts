import { describe, expect, test } from 'bun:test';
import {
  advanceHover,
  bezierAt,
  DRAW_MS,
  drawProgress,
  easeOutCubic,
  HOVER_IN_MS,
  HOVER_OUT_MS,
  popScale,
  POP_MS,
  reversePath,
  splitBezier,
  staggerDelays,
  STAGGER_MS,
} from './anim';

const close = (a: number, b: number, eps = 1e-9): void => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('easeOutCubic', () => {
  test('runs 0 to 1, fast first, and clamps outside the range', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.8);
    expect(easeOutCubic(-3)).toBe(0);
    expect(easeOutCubic(9)).toBe(1);
  });
});

describe('advanceHover', () => {
  test('takes 200 ms in and 150 ms out', () => {
    close(advanceHover(0, true, HOVER_IN_MS / 2), 0.5);
    expect(advanceHover(0, true, HOVER_IN_MS)).toBe(1);
    close(advanceHover(1, false, HOVER_OUT_MS / 2), 0.5);
    expect(advanceHover(1, false, HOVER_OUT_MS)).toBe(0);
  });
  test('never leaves 0..1 however long a frame is', () => {
    expect(advanceHover(0.9, true, 5000)).toBe(1);
    expect(advanceHover(0.1, false, 5000)).toBe(0);
  });
  test('reversing mid-way continues from where it was, no snap', () => {
    const mid = advanceHover(0, true, 100);
    const back = advanceHover(mid, false, 30);
    expect(back).toBeLessThan(mid);
    expect(back).toBeGreaterThan(0.2);
  });
  test('reduced motion lands on the final state at once', () => {
    expect(advanceHover(0, true, 1, true)).toBe(1);
    expect(advanceHover(1, false, 1, true)).toBe(0);
  });
});

describe('staggerDelays', () => {
  test('spans 0 to 160 ms and orders clockwise from twelve o clock', () => {
    // Right, down, left, up (canvas y points down).
    const d = staggerDelays([0, Math.PI / 2, Math.PI, -Math.PI / 2]);
    expect(d[3]).toBe(0);
    close(d[0]!, STAGGER_MS / 3);
    close(d[1]!, (2 * STAGGER_MS) / 3);
    close(d[2]!, STAGGER_MS);
  });
  test('one link starts at once, none is fine', () => {
    expect(staggerDelays([1.2])).toEqual([0]);
    expect(staggerDelays([])).toEqual([]);
  });
  test('equal angles keep input order and stay in range', () => {
    const d = staggerDelays([0.3, 0.3, 0.3]);
    expect(d[0]!).toBeLessThan(d[1]!);
    expect(d[1]!).toBeLessThan(d[2]!);
    expect(Math.max(...d)).toBeLessThanOrEqual(STAGGER_MS);
  });
});

describe('drawProgress', () => {
  test('waits for its delay, then eases to 1 over 280 ms', () => {
    expect(drawProgress(50, 100)).toBe(0);
    expect(drawProgress(100 + DRAW_MS, 100)).toBe(1);
    const half = drawProgress(100 + DRAW_MS / 2, 100);
    expect(half).toBeGreaterThan(0.5);
    expect(half).toBeLessThan(1);
  });
});

describe('popScale', () => {
  test('1.0 before arrival, peaks at 1.25, settles at 1.15', () => {
    expect(popScale(-10)).toBe(1);
    expect(popScale(0)).toBe(1);
    close(popScale(POP_MS / 2), 1.25);
    close(popScale(POP_MS), 1.15);
    close(popScale(POP_MS * 4), 1.15);
  });
});

describe('splitBezier', () => {
  const line = [0, 0, 10, 20];
  const quad = [0, 0, 50, 100, 100, 0];
  const cubic = [0, 0, 0, 100, 100, 100, 100, 0];

  test('a line is cut in proportion', () => {
    expect(splitBezier(line, 0.5)).toEqual([0, 0, 5, 10]);
  });
  test('keeps the degree and starts where the path starts', () => {
    expect(splitBezier(quad, 0.4).length).toBe(6);
    expect(splitBezier(cubic, 0.4).length).toBe(8);
    expect(splitBezier(cubic, 0.4).slice(0, 2)).toEqual([0, 0]);
  });
  test('t = 1 is the whole path, t = 0 is a point at the start', () => {
    expect(splitBezier(cubic, 1)).toEqual(cubic);
    expect(bezierAt(cubic, 0)).toEqual([0, 0]);
  });
  test('the cut ends on the true curve point, not on the straight chord', () => {
    // Quadratic midpoint is 0.25*P0 + 0.5*P1 + 0.25*P2 = (50, 50).
    const [x, y] = bezierAt(quad, 0.5);
    close(x, 50);
    close(y, 50);
    // Cubic at 0.5 is (P0 + 3*P1 + 3*P2 + P3) / 8 = (50, 75).
    const [cx, cy] = bezierAt(cubic, 0.5);
    close(cx, 50);
    close(cy, 75);
    // The chord midpoint would be (50, 0).
    expect(cy).toBeGreaterThan(50);
  });
  test('splitting a split matches splitting once at the product', () => {
    const viaTwo = splitBezier(splitBezier(cubic, 0.8), 0.5);
    const direct = splitBezier(cubic, 0.4);
    viaTwo.forEach((v, i) => close(v, direct[i]!, 1e-9));
  });
});

describe('reversePath', () => {
  test('flips the point order so the curve can grow from its far end', () => {
    expect(reversePath([1, 2, 3, 4, 5, 6])).toEqual([5, 6, 3, 4, 1, 2]);
    const q = [0, 0, 50, 100, 100, 0];
    const [x, y] = bezierAt(reversePath(q), 0.25);
    const [fx, fy] = bezierAt(q, 0.75);
    close(x, fx);
    close(y, fy);
  });
});
