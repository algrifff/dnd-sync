// Module-level peer store + pub/sub. PresenceClient writes the current
// list of remote peers here on every awareness change; any component
// that wants to render "who's on this note" subscribes via
// useSyncExternalStore. Keeps presence data out of React context,
// which would otherwise re-render the world whenever someone moved
// their mouse pointer (the awareness feed is noisy).
//
// The path extractor maps a peer's `viewing` pathname ("/notes/foo%20bar/baz.md")
// to the vault-internal note path ("foo bar/baz.md") so per-row filters
// in the FileTree can compare by value.

export type PresencePeerLite = {
  clientId: number;
  userId: string;
  name: string;
  color: string;
  avatarVersion: number;
  viewing: string | null;
  notePath: string | null;
};

let snapshot: ReadonlyArray<PresencePeerLite> = [];
const listeners = new Set<() => void>();

export function setPresencePeers(next: ReadonlyArray<PresencePeerLite>): void {
  snapshot = next;
  for (const fn of listeners) fn();
}

export function subscribePresence(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getPresenceSnapshot(): ReadonlyArray<PresencePeerLite> {
  return snapshot;
}

/** Render-safe server snapshot: always empty. Avoids hydration mismatch
 *  when useSyncExternalStore runs on the server. */
export function getPresenceServerSnapshot(): ReadonlyArray<PresencePeerLite> {
  return EMPTY;
}
const EMPTY: ReadonlyArray<PresencePeerLite> = Object.freeze([]);

/** Decode a viewing pathname into its vault note path, or null. */
export function notePathFromPathname(pathname: string | null): string | null {
  if (!pathname || !pathname.startsWith('/notes/')) return null;
  const rest = pathname.slice('/notes/'.length);
  try {
    return rest
      .split('/')
      .map((s) => decodeURIComponent(s))
      .join('/');
  } catch {
    return rest;
  }
}
