// In-memory rate-limiting buckets keyed by IP (or any string key).
// The store rebuilds on restart — acceptable for a self-hosted single-
// admin deployment. Never stores passwords / tokens, just keys and fail
// counts.
//
// Two named buckets are exported:
//   - `wsAuth`     — used by the legacy WS upgrade handler
//                    (30 fails / 5 min; plugin reconnect bursts must not trip)
//   - `webLogin`   — used by the web /login Server Action
//                    (10 fails / 5 min; tighter because a real user retries
//                     the form slowly by hand)

type Bucket = {
  fails: number;
  lockedUntil: number;
  notified: boolean;
};

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

export type Limiter = {
  check(key: string, exempt: boolean): RateLimitDecision;
  recordFailure(key: string, exempt: boolean): boolean;
  recordSuccess(key: string): void;
};

function createLimiter(maxFails: number, lockoutMs: number): Limiter {
  const buckets = new Map<string, Bucket>();

  return {
    check(key, exempt) {
      if (exempt) return { allowed: true };
      const b = buckets.get(key);
      if (!b) return { allowed: true };
      const now = Date.now();
      if (b.lockedUntil > now) return { allowed: false, retryAfterMs: b.lockedUntil - now };
      return { allowed: true };
    },
    recordFailure(key, exempt) {
      if (exempt) return false;
      const now = Date.now();
      const existing = buckets.get(key);
      const b: Bucket = existing ?? { fails: 0, lockedUntil: 0, notified: false };
      if (b.lockedUntil && b.lockedUntil <= now) {
        b.fails = 0;
        b.lockedUntil = 0;
        b.notified = false;
      }
      b.fails += 1;
      if (b.fails >= maxFails) {
        b.lockedUntil = now + lockoutMs;
        const firstNotice = !b.notified;
        b.notified = true;
        buckets.set(key, b);
        return firstNotice;
      }
      buckets.set(key, b);
      return false;
    },
    recordSuccess(key) {
      buckets.delete(key);
    },
  };
}

// Existing WS-auth bucket. Kept at the same 30 / 5 min as before so the
// plugin's burst-reconnect behaviour doesn't regress.
export const wsAuthLimiter = createLimiter(30, 5 * 60_000);

// Web-app login bucket. Tighter because humans retry the form slowly;
// 10 fails in 5 minutes is still plenty of headroom for a typo spree.
export const webLoginLimiter = createLimiter(10, 5 * 60_000);

// Admin vault upload. 5 full ingests per hour is far more than a
// reasonable admin workflow requires; anything faster is a script.
export const adminUploadLimiter = createLimiter(5, 60 * 60_000);

// Asset upload from the editor. 30 per minute per user covers bulk
// drag-drop of session images without tripping.
export const assetUploadLimiter = createLimiter(30, 60_000);

// ── Backwards-compatible shims for the WS upgrade handler ──────────────

export function checkAuthAttempt(ip: string, isLocalhost: boolean): RateLimitDecision {
  return wsAuthLimiter.check(ip, isLocalhost);
}

export function recordAuthFailure(ip: string, isLocalhost: boolean): boolean {
  return wsAuthLimiter.recordFailure(ip, isLocalhost);
}

export function recordAuthSuccess(ip: string): void {
  wsAuthLimiter.recordSuccess(ip);
}
