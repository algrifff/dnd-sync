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
  touchedAt: number;
};

// Public endpoints key buckets on attacker-influenced strings, so the map
// is bounded: past this size, buckets idle for a full lockout are swept.
const MAX_BUCKETS = 10_000;

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
      if (!existing && buckets.size >= MAX_BUCKETS) {
        for (const [k, v] of buckets) if (now - v.touchedAt >= lockoutMs) buckets.delete(k);
        if (buckets.size >= MAX_BUCKETS) buckets.clear();
      }
      const b: Bucket = existing ?? { fails: 0, lockedUntil: 0, notified: false, touchedAt: now };
      b.touchedAt = now;
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

// Similar-name lookup while typing a new Note's name. Each call scans the
// World's titles, so 60 per minute per user (debounced typing stays far
// under it).
export const similarNotesLimiter = createLimiter(60, 60_000);

// Self-service signup. 5 per hour per IP — a real user creates one
// account per device, anything faster is a script.
export const signupLimiter = createLimiter(5, 60 * 60_000);

// Forgot-password requests. 5 per hour per IP — limits both enumeration
// attempts and accidental mail-storms from a stuck tab.
export const resetRequestLimiter = createLimiter(5, 60 * 60_000);

// Resend-verification-email clicks. 3 per hour per IP.
export const verifyResendLimiter = createLimiter(3, 60 * 60_000);

// /api/admin/login. Gates the __sa super-admin cookie that unlocks all of
// /admin/*, off a single bearer token compared with timingSafeEqual — no
// username, so there's nothing to lock per-account, only per-IP. 10 fails /
// 5 min mirrors webLoginLimiter: the auto-generated default token is 192-bit
// (unguessable regardless), so this bound exists for the weak-operator-set
// ADMIN_TOKEN case — tight enough to kill unlimited brute force, loose
// enough that a real operator mistyping a saved token isn't locked out.
export const adminLoginLimiter = createLimiter(10, 5 * 60_000);

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

// OAuth token endpoint for the MCP connector. Keyed per IP; every
// rejected exchange (bad code, bad verifier, dead refresh token) counts.
// 30 fails / 5 min: a real client retries a couple of times at most.
export const oauthTokenLimiter = createLimiter(30, 5 * 60_000);

// OAuth dynamic client registration. Every call counts, success or not,
// because each one inserts a row. 20 / hour per IP is far above what
// one person adding a connector to a few Claude surfaces produces.
export const oauthRegisterLimiter = createLimiter(20, 60 * 60_000);

// Ceiling across all callers, so rotating source addresses cannot flood
// oauth_clients. Recorded under one fixed key.
export const oauthRegisterGlobalLimiter = createLimiter(200, 60 * 60_000);
