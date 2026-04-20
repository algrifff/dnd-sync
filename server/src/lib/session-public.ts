// Edge-runtime-safe slice of the session module. Contains only pure
// constants + string helpers — no DB imports — so `middleware.ts` (which
// runs on the Edge runtime and can't load `bun:sqlite`) can import from
// here without dragging the native binding.

export const SESSION_COOKIE = 'compendium.sid';
export const CSRF_COOKIE = 'compendium.csrf';

export function sessionCookieName(): string {
  return SESSION_COOKIE;
}

export function csrfCookieName(): string {
  return CSRF_COOKIE;
}
