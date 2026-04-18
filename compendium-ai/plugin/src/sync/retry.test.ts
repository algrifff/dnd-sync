import { describe, expect, it } from 'bun:test';
import { retryWithBackoff, shortError } from './retry';

const noSleep = (): Promise<void> => Promise.resolve();

describe('retryWithBackoff', () => {
  it('should return the result when the first attempt succeeds', async () => {
    let calls = 0;
    const result = await retryWithBackoff(
      async () => {
        calls++;
        return 'ok';
      },
      { sleep: noSleep },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('should retry until success and return that result', async () => {
    let calls = 0;
    const result = await retryWithBackoff(
      async () => {
        calls++;
        if (calls < 3) throw new Error('fail');
        return 42;
      },
      { sleep: noSleep },
    );
    expect(result).toBe(42);
    expect(calls).toBe(3);
  });

  it('should throw the last error after exhausting all attempts', async () => {
    let calls = 0;
    let caught: unknown;
    try {
      await retryWithBackoff(
        async () => {
          calls++;
          throw new Error(`fail #${calls}`);
        },
        { attempts: 3, sleep: noSleep },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('fail #3');
    expect(calls).toBe(3);
  });

  it('should call onAttempt once per failed attempt with the 1-based index', async () => {
    const reports: number[] = [];
    try {
      await retryWithBackoff(
        async () => {
          throw new Error('nope');
        },
        {
          attempts: 4,
          sleep: noSleep,
          onAttempt: (n) => reports.push(n),
        },
      );
    } catch {
      /* expected */
    }
    expect(reports).toEqual([1, 2, 3, 4]);
  });

  it('should not call onAttempt on a successful call', async () => {
    let reported = 0;
    await retryWithBackoff(async () => 'ok', {
      sleep: noSleep,
      onAttempt: () => reported++,
    });
    expect(reported).toBe(0);
  });

  it('should reject invalid attempt counts', async () => {
    await expect(
      retryWithBackoff(async () => 'ok', { attempts: 0, sleep: noSleep }),
    ).rejects.toThrow('attempts must be >= 1');
  });
});

describe('shortError', () => {
  it('should extract Error message', () => {
    expect(shortError(new Error('boom'))).toBe('boom');
  });

  it('should pass strings through', () => {
    expect(shortError('literal')).toBe('literal');
  });

  it('should truncate long messages', () => {
    const long = 'x'.repeat(500);
    expect(shortError(new Error(long)).length).toBe(120);
  });

  it('should fall back for non-string non-Error values', () => {
    expect(shortError(42)).toBe('unknown error');
    expect(shortError(null)).toBe('unknown error');
    expect(shortError(undefined)).toBe('unknown error');
  });
});
