// Canonical path resolver for AI tool calls.
//
// Every entity the AI creates MUST derive its folder from this function.
// The AI never chooses paths freely — it passes kind + campaignSlug and
// gets back the exact folder it must write to. This prevents the vault
// from accumulating arbitrary folder structures when the AI operates.

export type EntityKind =
  | 'character'
  | 'person'
  | 'creature'
  | 'item'
  | 'location'
  | 'session'
  | 'lore'
  | 'note'
  // legacy aliases kept for back-compat with older tool calls
  | 'pc'
  | 'npc'
  | 'ally'
  | 'villain'
  | 'monster';

export function canonicalFolder(opts: {
  kind: EntityKind;
  campaignSlug?: string | undefined;
}): string {
  const base = opts.campaignSlug ? `Campaigns/${opts.campaignSlug}` : null;

  switch (opts.kind) {
    case 'character':
    case 'pc':       return base ? `${base}/Characters`    : 'Characters';
    case 'person':
    case 'npc':
    case 'ally':     return base ? `${base}/People`        : 'People';
    case 'villain':  return base ? `${base}/Enemies`       : 'Enemies';
    case 'item':     return base ? `${base}/Loot`          : 'Loot';
    case 'location': return base ? `${base}/Places`        : 'Places';
    case 'session':  return base ? `${base}/Adventure Log` : 'Adventure Log';
    case 'creature':
    case 'monster':  return base ? `${base}/Creatures`     : 'Creatures';
    case 'lore':     return 'World Lore';
    case 'note':     return base ?? 'World Lore';
  }
}

export function canonicalPath(opts: {
  kind: EntityKind;
  campaignSlug?: string | undefined;
  name: string;
}): string {
  const folder = canonicalFolder({ kind: opts.kind, campaignSlug: opts.campaignSlug });
  const slug = nameToSlug(opts.name);
  return `${folder}/${slug}.md`;
}

export function nameToSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
