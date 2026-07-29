// Shared localStorage helpers for the AI chat surfaces (HomeChat + ChatPane).
//
// Chat history is persisted only to the current browser's localStorage and is
// never sent to the server for storage. The key is scoped by user + world so
// that (a) two accounts sharing a browser never see each other's chat, and
// (b) switching worlds starts with a fresh chat — history stays with the
// world it was created in. The v2 prefix forces a clean break from the
// un-scoped v1 blob so no previous world's chat bleeds through.

import type { UIMessage } from 'ai';
import { MAX_CHAT_INPUT_CHARS, MAX_CHAT_MESSAGES } from '@/lib/ai/input-limits';

export function chatStorageKey(userId: string, worldId: string): string {
  return `compendium-home-chat-v2:${userId}:${worldId}`;
}

// ── Retention / trim ────────────────────────────────────────────────────
//
// POST /api/chat replays the client's ENTIRE message array on every turn
// (see lib/ai/input-limits.ts) and rejects requests over MAX_CHAT_MESSAGES
// entries or MAX_CHAT_INPUT_CHARS serialized characters with a 400. The
// client must never let its retained history exceed what the server will
// accept, or the panel starts failing mid-conversation with no recovery
// short of "clear chat". These caps sit comfortably below the server's so
// there's headroom for the rest of the request body (groupId, campaign
// context, etc.) and so trimming kicks in before the server would ever
// reject anything.
const CLIENT_MAX_MESSAGES = Math.floor(MAX_CHAT_MESSAGES * 0.7); // 210
const CLIENT_MAX_CHARS = Math.floor(MAX_CHAT_INPUT_CHARS * 0.75); // 300,000

/** Character-length heuristic mirroring input-limits.ts's estimateChars —
 *  never throws; an unserializable array is treated as "too big" so it
 *  trims rather than silently keeping something too large to send. */
function estimateChars(messages: readonly UIMessage[]): number {
  try {
    const s = JSON.stringify(messages);
    return s ? s.length : 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Drop oldest-first until the array is within both the message-count and
 *  serialized-size budgets. A whole UIMessage is the trim unit (never a
 *  partial message) — the AI SDK nests a full turn's tool calls/results as
 *  `parts` inside one UIMessage, so trimming at message granularity can
 *  never separate a tool call from its result. Returns the same array
 *  reference when nothing needs trimming, so callers can cheaply detect a
 *  no-op with `===`. */
export function trimChatMessages(messages: UIMessage[]): UIMessage[] {
  let trimmed = messages;
  if (trimmed.length > CLIENT_MAX_MESSAGES) {
    trimmed = trimmed.slice(trimmed.length - CLIENT_MAX_MESSAGES);
  }
  // Rare in practice (a handful of huge tool-result payloads could hit the
  // char budget before the count budget does) but cheap to guard.
  while (trimmed.length > 1 && estimateChars(trimmed) > CLIENT_MAX_CHARS) {
    trimmed = trimmed.slice(1);
  }
  return trimmed;
}

/** Persist trimmed chat history to localStorage, degrading gracefully
 *  instead of throwing when the quota is exceeded (Safari private mode,
 *  a browser near its storage cap, etc.). Tries progressively smaller
 *  suffixes of the (already-trimmed) history before giving up silently —
 *  losing older local-only history is much better than crashing the
 *  panel or spamming the console on every keystroke. */
export function persistChatHistory(storageKey: string, messages: UIMessage[]): void {
  const attempts: UIMessage[][] = [
    messages,
    messages.slice(-50),
    messages.slice(-10),
    [],
  ];
  for (const attempt of attempts) {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(attempt));
      return;
    } catch {
      // Quota exceeded or storage unavailable — try the next, smaller
      // attempt. The final attempt ([]) at worst clears the key; if even
      // that throws, storage is unusable and there's nothing more to do.
    }
  }
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
