// Canonical path resolver for AI tool calls.
//
// Every entity the AI creates MUST derive its folder from this function.
// The AI never chooses paths freely — it passes kind + campaignSlug and
// gets back the exact folder it must write to. This prevents the world
// from accumulating arbitrary folder structures when the AI operates.
//
// FOLDER CONVENTIONS (enforced by canonicalFolder + isCanonicalPath):
//
//   Campaign notes
//     Campaigns/{slug}/Characters/{name}.md   ← PCs / player characters
//     Campaigns/{slug}/People/{name}.md       ← NPCs, allies
//     Campaigns/{slug}/Enemies/{name}.md      ← villains
//     Campaigns/{slug}/Loot/{name}.md         ← items, magic items
//     Campaigns/{slug}/Places/{name}.md       ← locations
//     Campaigns/{slug}/Adventure Log/…        ← session logs
//     Campaigns/{slug}/Creatures/{name}.md    ← monsters
//     Campaigns/{slug}/index.md               ← campaign root note
//
//   World-level notes (no campaign)
//     World Lore/{name}.md                   ← lore, worldbuilding
//     Characters / People / Enemies / …      ← same sub-folders, campaign-less
//
//   Assets
//     Assets/Portraits/{filename}
//     Assets/Maps/{filename}
//     Assets/Tokens/{filename}

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
  /** When set (from `campaigns.folder_path`), used as the campaign root
   *  instead of synthesising `Campaigns/${campaignSlug}`. */
  campaignRoot?: string | undefined;
}): string {
  const base =
    opts.campaignRoot ??
    (opts.campaignSlug ? `Campaigns/${opts.campaignSlug}` : null);

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
  campaignRoot?: string | undefined;
  name: string;
}): string {
  const folder = canonicalFolder({
    kind: opts.kind,
    campaignSlug: opts.campaignSlug,
    campaignRoot: opts.campaignRoot,
  });
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

// ── Canonical-path schema ──────────────────────────────────────────────
//
// These are the only folder prefixes we allow. Any import or AI write
// path must match one of these patterns — if it doesn't, it gets
// rejected (import) or recomputed (orchestrator) rather than creating
// stray folders.

const NOTE_SUBFOLDERS = [
  'Characters',
  'People',
  'Enemies',
  'Loot',
  'Places',
  'Adventure Log',
  'Creatures',
] as const;

const WORLD_ROOTS = ['World Lore', ...NOTE_SUBFOLDERS] as const;

export function isCanonicalNotePath(path: string): boolean {
  if (!path.endsWith('.md')) return false;

  // Campaign note: Campaigns/{slug}/{subfolder}/{name}.md
  //             or Campaigns/{slug}/index.md
  if (path.startsWith('Campaigns/')) {
    const rest = path.slice('Campaigns/'.length);
    const slashIdx = rest.indexOf('/');
    if (slashIdx === -1) return false;
    const afterSlug = rest.slice(slashIdx + 1);
    if (afterSlug === 'index.md') return true;
    const validSubfolder = (NOTE_SUBFOLDERS as readonly string[]).find((f) =>
      afterSlug.startsWith(f + '/'),
    );
    if (validSubfolder) {
      const leaf = afterSlug.slice(validSubfolder.length + 1);
      return leaf.length > 0 && !leaf.includes('/');
    }
    return false;
  }

  // World-level note: {rootFolder}/{name}.md
  const validRoot = (WORLD_ROOTS as readonly string[]).find((f) =>
    path.startsWith(f + '/'),
  );
  if (validRoot) {
    const leaf = path.slice(validRoot.length + 1);
    return leaf.length > 0 && !leaf.includes('/');
  }

  return false;
}

export function isCanonicalAssetPath(path: string): boolean {
  return (
    path.startsWith('Assets/Portraits/') ||
    path.startsWith('Assets/Maps/') ||
    path.startsWith('Assets/Tokens/') ||
    path.startsWith('Assets/')
  );
}
