// Tiny pub-sub channel for "the file tree just changed". Mutation
// helpers (create / move / delete / rename for notes + folders) fire
// `broadcastTreeChange()` after a successful write; PresenceClient
// listens, writes the bump into its awareness state, and every
// connected peer responds by calling router.refresh() so their
// server-rendered sidebar catches up without a manual reload.
//
// Browser-only: the event bus is the DOM's CustomEvent channel, which
// keeps the helpers free of React/provider plumbing. Calling from the
// server is a no-op.

export const TREE_CHANGE_EVENT = 'compendium:tree-change';

export function broadcastTreeChange(): void {
  if (typeof document === 'undefined') return;
  document.dispatchEvent(new CustomEvent(TREE_CHANGE_EVENT));
}
