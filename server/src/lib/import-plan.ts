// Deterministic import planner. Takes a heterogeneous bundle of
// markdown files + assets (already parsed into memory by the upstream
// caller — bulk-import script, AI import pipeline, manual upload) and
// produces a fully-resolved plan of where each file should land in the
// canonical vault structure, what frontmatter it should have, what
// aliases to register, and which assets to upload globally.
//
// Two modes — mostly transparent to the caller:
//
//   1. STRUCTURED: source paths follow the well-known Main-Notes
//      shape — top-level `Campaign N - Name/` or `Campaigns/<slug>/`
//      folders with canonical subfolders (Characters / People / Loot
//      / Places / Adventure Log / Creatures / Quests / Enemies). The
//      planner classifies by source folder name with no AI input.
//
//   2. AMBIGUOUS: source paths are arbitrary (a flat dump, an Obsidian
//      vault with bespoke layout, a single ZIP from a player). The
//      caller passes per-file AI classifications and the planner
//      respects them — funnelling the AI's `kind` + `campaignSlug` +
//      `displayName` through `canonicalFolder()` for canonical paths.
//
// Both modes share the same downstream rules:
//   * Adventure Log player-folder flattening (only one player tracks
//     real session logs — drop the per-player wrapping)
//   * Single-digit Episode/Session padding (Episode 1 → Episode 01,
//     with the unpadded form registered as an alias)
//   * Campaign root index files normalised to `index.md` with the
//     original filename registered as an alias so wikilinks like
//     `[[index -The Hired Help]]` keep working
//   * World Lore subfolder classification (Gods / Orders / Houses /
//     Parties / Places / Races / Events) by filename keyword match
//   * One-Shots / loose top-level non-canonical roots become their
//     own `Campaigns/<slug>/` campaigns
//   * Character notes run through `parseCharacter()` to extract
//     structured stats from body tables into `frontmatter.sheet`
//   * Filenames are preserved (not slugified) so wikilink
//     basename-match resolves user references like `[[Atoxis]]` to
//     `Campaigns/.../People/Atoxis.md`

import * as YAML from 'yaml';

import { parseCharacter } from './character-parser';
import {
  canonicalFolder,
  nameToSlug,
  type EntityKind,
} from './ai/paths';

export type PlanInputFile = {
  /** Arbitrary key — filesystem path or zip-relative path. The
   *  planner uses this to classify by folder ancestry but never
   *  writes through it. */
  sourcePath: string;
  /** Raw file content (markdown body + optional frontmatter). */
  content: string;
};

export type PlanInputAsset = {
  sourcePath: string;
  basename: string;
  /** Pre-sniffed MIME (the caller already has the bytes). */
  mime: string;
};

export type AiClassification = {
  kind: EntityKind;
  campaignSlug?: string | undefined;
  /** Friendly display name (overrides filename-derived name when set). */
  displayName?: string | undefined;
  /** Optional fully-resolved canonical path from a smarter AI. When
   *  set the planner only validates + normalises; it doesn't recompute. */
  canonicalPath?: string | undefined;
  /** Optional pre-extracted sheet to seed character/person/item etc. */
  sheet?: Record<string, unknown> | undefined;
};

export type PlanInput = {
  files: PlanInputFile[];
  assets: PlanInputAsset[];
  /** Username for `frontmatter.player` on character notes when not
   *  already set in the source file. */
  defaultPlayerUsername?: string;
  /** AI classifications keyed by sourcePath — used when the source
   *  folder structure doesn't reveal the kind. */
  aiClassifications?: Map<string, AiClassification>;
};

export type PlannedFile = {
  sourcePath: string;
  targetPath: string;
  kind: EntityKind;
  campaignSlug?: string | undefined;
  frontmatter: Record<string, unknown>;
  body: string;
  /** Additional title strings that should resolve to this targetPath
   *  via the wikilink resolver's aliasMap. */
  aliases: string[];
};

export type PlannedAsset = {
  sourcePath: string;
  basename: string;
  /** Destination under `Assets/<Category>/<basename>`. The category
   *  is preserved from the source asset's parent folder when it
   *  matches a canonical Asset subfolder (Portraits / Maps / Tokens),
   *  otherwise falls back to top-level `Assets/`. */
  destPath: string;
};

export type PlanResult = {
  files: PlannedFile[];
  assets: PlannedAsset[];
  /** Campaigns the caller should ensure exist (slug + friendly name). */
  campaigns: Array<{ slug: string; name: string }>;
  /** Folder paths the caller should add to `folder_markers` so the
   *  sidebar shows them even before notes land. Useful for the
   *  custom World Lore subfolders. */
  folderMarkers: string[];
  /** Per-file warnings — orphan assets, ambiguous classifications,
   *  files we couldn't slot anywhere meaningful. The caller can
   *  surface these to the user. */
  warnings: string[];
};

// ── Source-folder classification ───────────────────────────────────────

/** Per-source-subfolder canonical kind mapping. Match against the
 *  immediate parent folder name of a source file once we're below a
 *  campaign root. */
const SUBFOLDER_KIND: Record<string, { folder: string; kind: EntityKind }> = {
  Characters: { folder: 'Characters', kind: 'character' },
  People: { folder: 'People', kind: 'person' },
  Enemies: { folder: 'Enemies', kind: 'creature' },
  Loot: { folder: 'Loot', kind: 'item' },
  Places: { folder: 'Places', kind: 'location' },
  'Adventure Log': { folder: 'Adventure Log', kind: 'session' },
  Creatures: { folder: 'Creatures', kind: 'creature' },
  Quests: { folder: 'Quests', kind: 'quest' },
};

/** Match the first segment of a source path. Either:
 *    - `Campaigns/<slug>/...` — already canonical (rare for raw imports)
 *    - `Campaign N - Name/...` / `Campaign-N-Name/...` — Main-Notes shape
 *    - `One-Shots/...` — collapses to per-file campaigns
 *  Returns the campaign slug+name when matched, else null.
 */
function detectCampaignRoot(
  segments: string[],
): { slug: string; name: string; depth: number } | null {
  if (segments.length === 0) return null;
  const first = segments[0]!;

  // Already-canonical: `Campaigns/<slug>/...`
  if (first === 'Campaigns' && segments[1]) {
    return { slug: segments[1], name: prettifySlug(segments[1]), depth: 2 };
  }

  // Main-Notes: `Campaign 2 - The Seven Deadly Sins`
  const m = first.match(/^Campaign\s+\d+\s*-\s*(.+)$/i);
  if (m) {
    const name = m[1]!.trim();
    return { slug: nameToSlug(name), name, depth: 1 };
  }

  return null;
}

function prettifySlug(slug: string): string {
  return slug
    .split('-')
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

// ── World Lore subfolder classification ────────────────────────────────

const WORLD_LORE_GODS = new Set(
  ['Pelor', 'Kord', 'Sehanine', 'Erathis', 'Lordbringer', 'Katha', 'Rudus', 'Heal'].map(
    (s) => s.toLowerCase(),
  ),
);
const WORLD_LORE_ORDERS = new Set(
  [
    'Holy Order',
    'Real Holy Order',
    'Silver Order',
    'Copper Order',
    'Oathbreaker Knight',
    'Bronze Battalion',
  ].map((s) => s.toLowerCase()),
);
const WORLD_LORE_RACES = new Set(['Dragonborn', 'Tiefling'].map((s) => s.toLowerCase()));
const WORLD_LORE_PARTIES = new Set(
  ['The Sin Slayers', 'Pit Pals', 'Wave Cult'].map((s) => s.toLowerCase()),
);
const WORLD_LORE_PLACES = new Set(
  ['Debraxus', 'Elandria', 'Iarozan'].map((s) => s.toLowerCase()),
);
const WORLD_LORE_EVENTS = new Set(
  ['Blackwater Festival', 'Plane Shift', 'Seven Deadly Sins'].map((s) => s.toLowerCase()),
);

/** Best-guess subfolder for a World Lore note based on its filename.
 *  Falls back to top-level `World Lore/` when nothing matches. The
 *  caller can override by editing `frontmatter.world_lore_folder`
 *  during review (not implemented yet — see TODO). */
function classifyWorldLore(filename: string): string {
  const stem = filename.replace(/\.md$/i, '');
  const lower = stem.toLowerCase();
  if (lower.startsWith('house ')) return 'World Lore/Houses';
  if (WORLD_LORE_GODS.has(lower)) return 'World Lore/Gods';
  if (WORLD_LORE_ORDERS.has(lower)) return 'World Lore/Orders';
  if (WORLD_LORE_RACES.has(lower)) return 'World Lore/Races';
  if (WORLD_LORE_PARTIES.has(lower)) return 'World Lore/Parties';
  if (WORLD_LORE_PLACES.has(lower)) return 'World Lore/Places';
  if (WORLD_LORE_EVENTS.has(lower)) return 'World Lore/Events';
  return 'World Lore';
}

// ── Single-digit padding ───────────────────────────────────────────────

/** If the leaf is an Episode/Session log with a single-digit number,
 *  pad to two digits and produce an alias for the unpadded form. */
function padSingleDigitEpisode(
  leaf: string,
): { leaf: string; aliasOf?: string } {
  const m = leaf.match(/^(Session|Episode)\s+(\d+)(.*?)(\.md)$/i);
  if (!m) return { leaf };
  const [, word, num, rest, ext] = m;
  if (num!.length !== 1) return { leaf };
  const original = leaf.slice(0, -ext!.length);
  return {
    leaf: `${word} ${num!.padStart(2, '0')}${rest}${ext}`,
    aliasOf: original,
  };
}

// ── Adventure Log flattening ───────────────────────────────────────────

/** Group source files by their Adventure Log player folder so we can
 *  detect "only one player has real logs, drop the per-player nesting".
 *  Returns a map `<campaignSlug>` → set of player folder names that have
 *  more than 1 .md file. If the set has size 1, that's the player to
 *  flatten. If 0 or >1, we keep the nesting as-is. */
function detectAdventureLogFlattening(
  files: PlanInputFile[],
): Map<string, string | null> {
  const counts = new Map<string, Map<string, number>>();
  for (const f of files) {
    const segs = f.sourcePath.split('/').filter((s) => s.length > 0);
    const root = detectCampaignRoot(segs);
    if (!root) continue;
    const subSegs = segs.slice(root.depth);
    if (subSegs.length < 3) continue; // need .../Adventure Log/<player>/<file>.md
    if (subSegs[0] !== 'Adventure Log') continue;
    const player = subSegs[1]!;
    if (!counts.has(root.slug)) counts.set(root.slug, new Map());
    const sub = counts.get(root.slug)!;
    sub.set(player, (sub.get(player) ?? 0) + 1);
  }
  const result = new Map<string, string | null>();
  for (const [slug, sub] of counts) {
    const populated = [...sub.entries()].filter(([, n]) => n > 1);
    result.set(slug, populated.length === 1 ? populated[0]![0] : null);
  }
  return result;
}

// ── Asset folder picking ───────────────────────────────────────────────

const ASSET_CATEGORY_ALLOWED = new Set(['Portraits', 'Maps', 'Tokens']);

function pickAssetDest(asset: PlanInputAsset): string {
  // If the source path includes an `Assets/<Category>/` segment, keep
  // the category. Otherwise drop it under top-level `Assets/`.
  const segs = asset.sourcePath.split('/');
  const idx = segs.indexOf('Assets');
  if (idx !== -1 && segs[idx + 1] && ASSET_CATEGORY_ALLOWED.has(segs[idx + 1]!)) {
    return `Assets/${segs[idx + 1]}/${asset.basename}`;
  }
  return `Assets/${asset.basename}`;
}

// ── Frontmatter ensure ─────────────────────────────────────────────────

function ensureBaseFrontmatter(
  raw: string,
  defaultKind: EntityKind,
  defaultPlayer: string | undefined,
  campaignSlug: string | undefined,
): { frontmatter: Record<string, unknown>; body: string } {
  // Tiny YAML extractor — see md-to-pm.ts for the canonical behaviour.
  // Duplicating here keeps the planner pure (no DB).
  let body = raw;
  let fm: Record<string, unknown> = {};
  if (raw.startsWith('---\n') || raw.startsWith('---\r\n')) {
    const end = raw.indexOf('\n---', 4);
    if (end !== -1) {
      const yamlText = raw.slice(raw.indexOf('\n') + 1, end).trim();
      try {
        const parsed = YAML.parse(yamlText);
        if (parsed && typeof parsed === 'object') {
          fm = parsed as Record<string, unknown>;
        }
      } catch {
        /* leave body untouched */
      }
      body = raw.slice(end + 4).replace(/^\s*\n/, '');
    }
  }
  if (typeof fm.kind !== 'string') fm.kind = defaultKind;
  const templated: EntityKind[] = [
    'character',
    'person',
    'creature',
    'item',
    'location',
    'session',
  ];
  if (templated.includes(fm.kind as EntityKind) && typeof fm.template !== 'string') {
    fm.template = fm.kind;
  }
  if (fm.kind === 'character' && fm.player == null && defaultPlayer) {
    fm.player = defaultPlayer;
  }
  if (campaignSlug && fm.campaigns == null) {
    fm.campaigns = [campaignSlug];
  }
  return { frontmatter: fm, body };
}

// ── Main planner ───────────────────────────────────────────────────────

export function planImport(input: PlanInput): PlanResult {
  const warnings: string[] = [];
  const plannedFiles: PlannedFile[] = [];
  const plannedAssets: PlannedAsset[] = [];
  const campaignsByName = new Map<string, { slug: string; name: string }>();
  const folderMarkers = new Set<string>();

  const adventureLogFlatten = detectAdventureLogFlattening(input.files);

  // Pre-aggregate top-level non-canonical roots that contain notes, to
  // promote them to per-campaign roots (e.g. `One-Shots/...`).
  const oneShotCandidates = new Set<string>();
  for (const f of input.files) {
    const segs = f.sourcePath.split('/').filter(Boolean);
    if (segs.length < 2) continue;
    const root = segs[0]!;
    if (root === 'Campaigns') continue;
    if (root === 'World Lore') continue;
    if (root === 'Assets') continue;
    if (detectCampaignRoot(segs)) continue;
    // Non-canonical top-level folder with files inside → candidate
    // for "one-shot per leaf file" promotion. We register the root
    // as a candidate; per-file logic decides slug.
    oneShotCandidates.add(root);
  }

  // ── Files ──
  for (const f of input.files) {
    try {
      const planned = planSingleFile(
        f,
        input,
        adventureLogFlatten,
        oneShotCandidates,
        warnings,
      );
      if (!planned) continue;
      plannedFiles.push(planned);
      if (planned.campaignSlug) {
        const name =
          input.aiClassifications?.get(f.sourcePath)?.displayName ??
          friendlyCampaignName(f.sourcePath, planned.campaignSlug);
        if (!campaignsByName.has(planned.campaignSlug)) {
          campaignsByName.set(planned.campaignSlug, {
            slug: planned.campaignSlug,
            name,
          });
        }
      }
      // Track parent folder markers under World Lore so empty
      // subfolders still appear in the tree.
      const parent = planned.targetPath.slice(
        0,
        planned.targetPath.lastIndexOf('/'),
      );
      if (parent.startsWith('World Lore/')) folderMarkers.add(parent);
    } catch (err) {
      warnings.push(`plan failed for ${f.sourcePath}: ${(err as Error).message}`);
    }
  }

  // ── Assets ──
  for (const a of input.assets) {
    plannedAssets.push({
      sourcePath: a.sourcePath,
      basename: a.basename,
      destPath: pickAssetDest(a),
    });
  }

  return {
    files: plannedFiles,
    assets: plannedAssets,
    campaigns: [...campaignsByName.values()],
    folderMarkers: [...folderMarkers],
    warnings,
  };
}

function friendlyCampaignName(sourcePath: string, slug: string): string {
  const segs = sourcePath.split('/').filter(Boolean);
  const detected = detectCampaignRoot(segs);
  if (detected && detected.slug === slug) return detected.name;
  return prettifySlug(slug);
}

function planSingleFile(
  f: PlanInputFile,
  input: PlanInput,
  adventureLogFlatten: Map<string, string | null>,
  oneShotCandidates: Set<string>,
  warnings: string[],
): PlannedFile | null {
  const segs = f.sourcePath.split('/').filter((s) => s.length > 0);
  if (segs.length === 0) return null;
  const filename = segs[segs.length - 1]!;

  // ── 1. Campaign-rooted file ──
  const root = detectCampaignRoot(segs);
  if (root) {
    return planCampaignFile(
      f,
      filename,
      root,
      segs,
      input,
      adventureLogFlatten,
    );
  }

  // ── 2. World Lore root ──
  if (segs[0] === 'World Lore') {
    const folder = classifyWorldLore(filename);
    return finishCharOrPlain({
      f,
      filename,
      kind: 'lore',
      campaignSlug: undefined,
      targetPath: `${folder}/${filename}`,
      defaultPlayer: input.defaultPlayerUsername,
      aliases: [],
    });
  }

  // ── 3. AI classification wins over one-shot detection ──
  // The AI gets the final say on what kind a flat-source file is.
  // Only fall through to the one-shot heuristic if the AI hasn't
  // classified this file at all.
  const ai = input.aiClassifications?.get(f.sourcePath);
  if (ai) {
    return planFromAi(f, filename, ai, input);
  }

  // ── 4. Top-level non-canonical → one-shot campaign ──
  if (oneShotCandidates.has(segs[0]!) && segs.length >= 2) {
    return planOneShotFile(f, filename, segs, input);
  }

  // ── 5. Fallback: keep the file in `World Lore/` so it's visible. ──
  warnings.push(`unclassified file kept under World Lore: ${f.sourcePath}`);
  return finishCharOrPlain({
    f,
    filename,
    kind: 'lore',
    campaignSlug: undefined,
    targetPath: `World Lore/${filename}`,
    defaultPlayer: input.defaultPlayerUsername,
    aliases: [],
  });
}

function planCampaignFile(
  f: PlanInputFile,
  filename: string,
  root: { slug: string; name: string; depth: number },
  segs: string[],
  input: PlanInput,
  adventureLogFlatten: Map<string, string | null>,
): PlannedFile {
  const subSegs = segs.slice(root.depth);

  // Campaign root file — index.md + alias for the original filename.
  if (subSegs.length === 1) {
    const aliases: string[] = [];
    const stem = filename.replace(/\.md$/i, '');
    if (filename !== 'index.md') aliases.push(stem);
    return finishCharOrPlain({
      f,
      filename,
      kind: 'session',
      campaignSlug: root.slug,
      targetPath: `Campaigns/${root.slug}/index.md`,
      defaultPlayer: input.defaultPlayerUsername,
      aliases,
    });
  }

  // Subfolder file.
  const sub = subSegs[0]!;
  const map = SUBFOLDER_KIND[sub];
  if (!map) {
    // Unknown subfolder under a campaign — fall through to keeping the
    // path under `Campaigns/<slug>/<sub>/...`. Trees are happy with
    // arbitrary depth; AI tools may not be.
    return finishCharOrPlain({
      f,
      filename,
      kind: 'note',
      campaignSlug: root.slug,
      targetPath: `Campaigns/${root.slug}/${subSegs.join('/')}`,
      defaultPlayer: input.defaultPlayerUsername,
      aliases: [],
    });
  }

  // Adventure Log: optional player-folder flattening + single-digit pad.
  if (sub === 'Adventure Log') {
    const flattenPlayer = adventureLogFlatten.get(root.slug);
    let leaf = subSegs.slice(1).join('/');
    if (subSegs.length >= 3) {
      const player = subSegs[1]!;
      const inner = subSegs.slice(2).join('/');
      if (flattenPlayer != null && player === flattenPlayer) {
        // Winner — strip the player folder entirely.
        leaf = inner;
      } else {
        // Either no clear winner (multiple populated, all flatten
        // with prefix) or this is a non-winning player's stray file
        // alongside the winner — prefix to keep the path canonical
        // and avoid collisions.
        leaf = `${player} - ${inner}`;
      }
    }
    const padded = padSingleDigitEpisode(leaf);
    const aliases = padded.aliasOf ? [padded.aliasOf] : [];
    return finishCharOrPlain({
      f,
      filename,
      kind: 'session',
      campaignSlug: root.slug,
      targetPath: `Campaigns/${root.slug}/${map.folder}/${padded.leaf}`,
      defaultPlayer: input.defaultPlayerUsername,
      aliases,
    });
  }

  const leaf = subSegs.slice(1).join('/');
  const padded = padSingleDigitEpisode(leaf);
  const aliases = padded.aliasOf ? [padded.aliasOf] : [];
  return finishCharOrPlain({
    f,
    filename,
    kind: map.kind,
    campaignSlug: root.slug,
    targetPath: `Campaigns/${root.slug}/${map.folder}/${padded.leaf}`,
    defaultPlayer: input.defaultPlayerUsername,
    aliases,
  });
}

function planOneShotFile(
  f: PlanInputFile,
  filename: string,
  segs: string[],
  input: PlanInput,
): PlannedFile {
  const root = segs[0]!; // e.g. "One-Shots"
  // Each one-shot becomes its own campaign keyed by the file or
  // subfolder name. `One-Shots/The Dancing Demon.md` →
  // `Campaigns/the-dancing-demon/index.md` (with alias).
  // `One-Shots/Party/X.md` doesn't have a clear one-shot identity
  // on its own; we try to find a sibling root file and use its slug.
  const stem = filename.replace(/\.md$/i, '');
  if (segs.length === 2) {
    const slug = nameToSlug(`${root}-${stem}`);
    return finishCharOrPlain({
      f,
      filename,
      kind: 'session',
      campaignSlug: slug,
      targetPath: `Campaigns/${slug}/index.md`,
      defaultPlayer: input.defaultPlayerUsername,
      aliases: [stem],
    });
  }
  // Deeper: assume the second segment is a thematic grouping like
  // "Party" → Characters subfolder.
  const groupSeg = segs[1]!;
  const slug = nameToSlug(`one-shot-${root}`);
  if (groupSeg.toLowerCase() === 'party') {
    return finishCharOrPlain({
      f,
      filename,
      kind: 'character',
      campaignSlug: slug,
      targetPath: `Campaigns/${slug}/Characters/${filename}`,
      defaultPlayer: input.defaultPlayerUsername,
      aliases: [],
    });
  }
  // Otherwise just drop into the one-shot's namespace at the top.
  return finishCharOrPlain({
    f,
    filename,
    kind: 'note',
    campaignSlug: slug,
    targetPath: `Campaigns/${slug}/${segs.slice(1).join('/')}`,
    defaultPlayer: input.defaultPlayerUsername,
    aliases: [],
  });
}

function planFromAi(
  f: PlanInputFile,
  filename: string,
  ai: AiClassification,
  input: PlanInput,
): PlannedFile {
  const folder = canonicalFolder({
    kind: ai.kind,
    campaignSlug: ai.campaignSlug,
  });
  const targetPath = `${folder}/${filename}`;
  return finishCharOrPlain({
    f,
    filename,
    kind: ai.kind,
    campaignSlug: ai.campaignSlug,
    targetPath,
    defaultPlayer: input.defaultPlayerUsername,
    aliases: [],
    seedSheet: ai.sheet,
  });
}

function finishCharOrPlain(opts: {
  f: PlanInputFile;
  filename: string;
  kind: EntityKind;
  campaignSlug: string | undefined;
  targetPath: string;
  defaultPlayer: string | undefined;
  aliases: string[];
  seedSheet?: Record<string, unknown> | undefined;
}): PlannedFile {
  if (opts.kind === 'character') {
    const parsed = parseCharacter(opts.f.content, {
      defaultPlayer: opts.defaultPlayer ?? '',
    });
    if (opts.campaignSlug && parsed.frontmatter.campaigns == null) {
      parsed.frontmatter.campaigns = [opts.campaignSlug];
    }
    if (opts.seedSheet) {
      // AI-suggested sheet fields fill blanks the body parse missed.
      const existing =
        (parsed.frontmatter.sheet as Record<string, unknown> | undefined) ?? {};
      const merged: Record<string, unknown> = { ...opts.seedSheet, ...existing };
      parsed.frontmatter.sheet = merged;
    }
    return {
      sourcePath: opts.f.sourcePath,
      targetPath: opts.targetPath,
      kind: opts.kind,
      ...(opts.campaignSlug !== undefined ? { campaignSlug: opts.campaignSlug } : {}),
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      aliases: opts.aliases,
    };
  }
  const ensured = ensureBaseFrontmatter(
    opts.f.content,
    opts.kind,
    opts.defaultPlayer,
    opts.campaignSlug,
  );
  if (opts.seedSheet) {
    const existing =
      (ensured.frontmatter.sheet as Record<string, unknown> | undefined) ?? {};
    ensured.frontmatter.sheet = { ...opts.seedSheet, ...existing };
  }
  return {
    sourcePath: opts.f.sourcePath,
    targetPath: opts.targetPath,
    kind: opts.kind,
    ...(opts.campaignSlug !== undefined ? { campaignSlug: opts.campaignSlug } : {}),
    frontmatter: ensured.frontmatter,
    body: ensured.body,
    aliases: opts.aliases,
  };
}
