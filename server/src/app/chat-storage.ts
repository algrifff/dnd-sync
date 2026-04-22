// Shared localStorage helpers for the AI chat surfaces (HomeChat + ChatPane).
//
// Chat history is persisted only to the current browser's localStorage and is
// never sent to the server for storage. The key is scoped by user + world so
// that (a) two accounts sharing a browser never see each other's chat, and
// (b) switching worlds starts with a fresh chat — history stays with the
// world it was created in. The v2 prefix forces a clean break from the
// un-scoped v1 blob so no previous world's chat bleeds through.

export function chatStorageKey(userId: string, worldId: string): string {
  return `compendium-home-chat-v2:${userId}:${worldId}`;
}

// One-shot migration: the pre-v2 key was a single global blob shared across
// all users and worlds on this browser. It's no longer read, so evict it the
// first time any v2 chat surface mounts. Module-level guard means this runs
// at most once per page load, regardless of how many HomeChat / ChatPane
// instances mount.
const LEGACY_KEY = 'compendium-home-chat-v1';
let legacyCleanupDone = false;

export function cleanupLegacyChatStorage(): void {
  if (legacyCleanupDone) return;
  legacyCleanupDone = true;
  try {
    window.localStorage.removeItem(LEGACY_KEY);
  } catch {
    // Ignore storage failures (Safari private mode, quota, etc.).
  }
}
