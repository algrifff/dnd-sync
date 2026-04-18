// In-memory per-IP failed-auth bucket. Used by the WS upgrade handler to
// throttle brute-force token guessing without adding a DB dependency.
// The bucket rebuilds on restart — acceptable for a self-hosted single-
// admin deployment. Never stores tokens, just IPs and fail counts.

type Bucket = {
  fails: number;
  lockedUntil: number;
  notified: boolean;
};

// A real attacker can't brute-force a 48-char random token in any
// realistic timeframe anyway, so we bias toward never punishing real
// users. Y-websocket backs off exponentially on connection failure and
// each plugin instance opens ~1 WS per tracked markdown file; a burst
// of legitimate reconnects after a server restart must NOT trip this.
const MAX_FAILS = 30;
const LOCKOUT_MS = 5 * 60_000;
const buckets = new Map<string, Bucket>();

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

/** Call before verifying the token. `isLocalhost` should be true when the
 *  request originated on the same host and NODE_ENV !== 'production', so
 *  admins typing on their own box don't lock themselves out. */
export function checkAuthAttempt(ip: string, isLocalhost: boolean): RateLimitDecision {
  if (isLocalhost) return { allowed: true };
  const b = buckets.get(ip);
  if (!b) return { allowed: true };
  const now = Date.now();
  if (b.lockedUntil > now) return { allowed: false, retryAfterMs: b.lockedUntil - now };
  return { allowed: true };
}

/** Record a failed auth attempt. Returns true if the caller should log a
 *  "rate-limited <ip>" line (first-time lockout only). */
export function recordAuthFailure(ip: string, isLocalhost: boolean): boolean {
  if (isLocalhost) return false;
  const now = Date.now();
  const existing = buckets.get(ip);
  const b: Bucket = existing ?? { fails: 0, lockedUntil: 0, notified: false };
  // Reset the fail counter if the previous lockout expired.
  if (b.lockedUntil && b.lockedUntil <= now) {
    b.fails = 0;
    b.lockedUntil = 0;
    b.notified = false;
  }
  b.fails += 1;
  if (b.fails >= MAX_FAILS) {
    b.lockedUntil = now + LOCKOUT_MS;
    const firstNotice = !b.notified;
    b.notified = true;
    buckets.set(ip, b);
    return firstNotice;
  }
  buckets.set(ip, b);
  return false;
}

/** Clear a bucket after a successful auth so honest users never accumulate
 *  counter state from an earlier typo. */
export function recordAuthSuccess(ip: string): void {
  buckets.delete(ip);
}
