// Exponential-backoff retry helper used by the sync layer when the server
// is flaky. Schedule is fixed — 1s, 2s, 4s, 8s, 16s — then give up and
// rethrow the last error. The caller surfaces per-attempt progress through
// the onAttempt callback so the user sees "inventory retry 3/5" in the
// status-bar tooltip instead of an empty red dot.

export type RetryOptions = {
  /** Total attempts including the first. Defaults to 5. */
  attempts?: number;
  /** Called after every failed attempt (not on success). `n` is 1-based. */
  onAttempt?: (n: number, err: unknown) => void;
  /** Override the default sleep for tests. Real code should not pass this. */
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function retryWithBackoff<T>(
  op: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 5;
  if (attempts < 1) throw new Error('retryWithBackoff: attempts must be >= 1');
  const sleep = opts.sleep ?? defaultSleep;

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      opts.onAttempt?.(i + 1, err);
      if (i === attempts - 1) break;
      await sleep(1000 * 2 ** i);
    }
  }
  throw lastErr;
}

/** Short, tokenless description of an unknown error for UI surfaces. */
export function shortError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 120);
  if (typeof err === 'string') return err.slice(0, 120);
  return 'unknown error';
}
