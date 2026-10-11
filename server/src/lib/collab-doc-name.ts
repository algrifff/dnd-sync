// Wire names for Hocuspocus documents, shared by the collab server and
// every browser client. Pure on purpose: no DB, no Hocuspocus import, so
// a client component can use it.
//
// Every document is addressed as `${groupId}:${path}`. The server's
// `onAuthenticate` (collab/server.ts) rejects a name whose group is not
// the caller's session group, so a client that builds a name by hand and
// forgets the prefix is refused. Build names here instead.

/** Wire + `documents`-map name for a document. Group ids are
 *  `randomUUID()` or the literal `'default'`, so they never contain a
 *  colon. */
export function qualifiedDocName(groupId: string, path: string): string {
  return `${groupId}:${path}`;
}

/** Split a wire name back into its group id and BARE path.
 *
 *  Splits on the FIRST colon only. Note paths may legitimately contain
 *  colons (`isAllowedPath` constrains only the first segment) and the
 *  meta docs embed one by design (`graph-groups:<id>`,
 *  `.graph-state:<id>`), so `split(':')` would silently corrupt them.
 *
 *  Returns null for anything without a colon, with an empty group id,
 *  or with an empty path — including a pre-deploy client still sending
 *  a bare path. That is deliberate: a fallback to the bare name would
 *  keep the collision reachable for as long as one stale tab lives, so
 *  an unparseable name is a clean rejection instead. */
export function parseDocName(
  documentName: string,
): { groupId: string; path: string } | null {
  const sep = documentName.indexOf(':');
  if (sep <= 0) return null;
  const path = documentName.slice(sep + 1);
  if (path.length === 0) return null;
  return { groupId: documentName.slice(0, sep), path };
}

/** Full wire names for the three world-scoped meta docs. The group id
 *  appears twice (prefix and suffix) by design: the server's storage
 *  hooks use the suffix as a second check that the two agree. */
export const presenceDocName = (groupId: string): string =>
  qualifiedDocName(groupId, `.presence:${groupId}`);
export const graphStateDocName = (groupId: string): string =>
  qualifiedDocName(groupId, `.graph-state:${groupId}`);
export const graphGroupsDocName = (groupId: string): string =>
  qualifiedDocName(groupId, `graph-groups:${groupId}`);
