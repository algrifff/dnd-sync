#!/usr/bin/env bun
// Bulk-import the Main-Notes vault into a fresh "Delara" world locally.
// Stops before any export/apply step — user runs the dev server, eyeballs
// the result, then signs off before we ship.
//
// Usage:
//   bun run scripts/main-notes-import/build-local.ts \
//     --source "/mnt/c/Users/alexg/Documents/dnd/Main-Notes" \
//     --user-id "<production uuid for algrifff>" \
//     [--username algrifff] \
//     [--world-name Delara] \
//     [--reset]
//
// `--reset` deletes ./.data/compendium.db before starting (after
// snapshotting it). Without it, a stub user is upserted and a new world
// is created alongside any existing data.
//
// What this writes:
//   * users (algrifff stub, only if missing)
//   * groups (the new Delara world)
//   * group_members (algrifff as admin)
//   * folder_markers (default skeleton seeded by createWorld)
//   * assets (per-campaign images deduped to a global pool)
//   * notes / note_links / tags (via writeNote → ingestMarkdown)
//   * campaigns (auto-registered by deriveAllIndexes)
//   * derived index tables (characters/items/locations/creatures/sessions)
//
// On completion the script prints:
//   * notes per campaign / world lore subfolder
//   * assets uploaded
//   * unresolved wikilinks (count + first 50 paths)
//   * the new groupId — needed by export-bundle.ts

import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';

import { getDb } from '../../server/src/lib/db';
import { writeNote } from '../../server/src/lib/import-apply';
import { createWorld } from '../../server/src/lib/groups';
import { ensureDefaultFolders } from '../../server/src/lib/tree';
import { nameToSlug } from '../../server/src/lib/ai/paths';
import { assetPath, sniffMime } from '../../server/src/lib/assets';
import * as YAML from 'yaml';
import { parseCharacter } from '../../server/src/lib/character-parser';

// ── CLI ────────────────────────────────────────────────────────────────

type Args = {
  source: string;
  userId: string;
  username: string;
  worldName: string;
  reset: boolean;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const source = get('--source');
  const userId = get('--user-id');
  if (!source) throw new Error('missing --source <path-to-Main-Notes>');
  if (!userId) throw new Error('missing --user-id <prod-uuid-for-algrifff>');
  return {
    source,
    userId,
    username: get('--username') ?? 'algrifff',
    worldName: get('--world-name') ?? 'Delara',
    reset: argv.includes('--reset'),
  };
}

// ── Campaign + world-lore mapping ──────────────────────────────────────

const CAMPAIGN_MAP: Record<string, { slug: string; name: string }> = {
  'Campaign 1 - The Hired Help': {
    slug: 'the-hired-help',
    name: 'The Hired Help',
  },
  'Campaign 2 - The Seven Deadly Sins': {
    slug: 'the-seven-deadly-sins',
    name: 'The Seven Deadly Sins',
  },
  'Campaign 3 - Vacant Thrones and Kindred Unknowns': {
    slug: 'vacant-thrones-and-kindred-unknowns',
    name: 'Vacant Thrones and Kindred Unknowns',
  },
};

// Per-campaign source subfolder → canonical subfolder + kind.
const SUBFOLDER_KIND: Record<string, { folder: string; kind: string }> = {
  Characters: { folder: 'Characters', kind: 'character' },
  People: { folder: 'People', kind: 'person' },
  Enemies: { folder: 'Enemies', kind: 'creature' },
  Loot: { folder: 'Loot', kind: 'item' },
  Places: { folder: 'Places', kind: 'location' },
  'Adventure Log': { folder: 'Adventure Log', kind: 'session' },
  Creatures: { folder: 'Creatures', kind: 'creature' },
  Quests: { folder: 'Quests', kind: 'quest' },
};

// World Lore classification by exact filename (case-insensitive).
// Anything not listed lands in `World Lore/` root.
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

// ── Filesystem helpers ─────────────────────────────────────────────────

function listFiles(root: string, ext: RegExp): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && ext.test(entry.name)) out.push(p);
    }
  };
  walk(root);
  return out;
}

// ── Plan: classify every source file into a target ────────────────────

type NotePlan = {
  sourcePath: string;
  targetPath: string; // vault-relative, e.g. Campaigns/the-hired-help/People/atoxis.md
  kind: string;
  campaignSlug?: string;
};

type AssetPlan = {
  sourcePath: string;
  // basename is what wikilinks like ![[mountain.png]] use to resolve.
  basename: string;
  // canonical destination "path" stored on the asset row
  destPath: string;
};

type AliasPlan = { path: string; alias: string };
const pendingAliases: AliasPlan[] = [];

function planAll(sourceRoot: string): {
  notes: NotePlan[];
  assets: AssetPlan[];
  aliases: AliasPlan[];
} {
  pendingAliases.length = 0;
  const notes: NotePlan[] = [];
  const assets: AssetPlan[] = [];

  // Campaigns 1/2/3
  for (const [folder, { slug }] of Object.entries(CAMPAIGN_MAP)) {
    const campRoot = join(sourceRoot, folder);
    if (!existsSync(campRoot)) continue;
    walkCampaign(campRoot, slug, notes, assets);

    // Index file at campaign root (e.g. "index -The Hired Help.md").
    // Store under the canonical `index.md` path AND register the
    // original filename as an alias so wikilinks like
    // `[[index -The Hired Help]]` still resolve.
    const rootEntries = readdirSync(campRoot, { withFileTypes: true });
    for (const e of rootEntries) {
      if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue;
      const aliasStem = e.name.replace(/\.md$/i, '');
      notes.push({
        sourcePath: join(campRoot, e.name),
        targetPath: `Campaigns/${slug}/index.md`,
        kind: 'session',
        campaignSlug: slug,
      });
      pendingAliases.push({
        path: `Campaigns/${slug}/index.md`,
        alias: aliasStem,
      });
    }
  }

  // One-Shots → its own campaign per the user's decision.
  const oneShotsRoot = join(sourceRoot, 'One-Shots');
  if (existsSync(oneShotsRoot)) {
    const slug = 'one-shot-the-dancing-demon';
    // The one-shot file at the root → index.md + alias.
    for (const e of readdirSync(oneShotsRoot, { withFileTypes: true })) {
      if (e.isFile() && e.name === 'The Dancing Demon.md') {
        notes.push({
          sourcePath: join(oneShotsRoot, e.name),
          targetPath: `Campaigns/${slug}/index.md`,
          kind: 'session',
          campaignSlug: slug,
        });
        pendingAliases.push({
          path: `Campaigns/${slug}/index.md`,
          alias: 'The Dancing Demon',
        });
      }
    }
    // Party characters. Preserve filename so wikilinks like
    // [[Bailin Silverchord]] resolve via basename match.
    const partyRoot = join(oneShotsRoot, 'Party');
    if (existsSync(partyRoot)) {
      for (const e of readdirSync(partyRoot, { withFileTypes: true })) {
        if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue;
        notes.push({
          sourcePath: join(partyRoot, e.name),
          targetPath: `Campaigns/${slug}/Characters/${e.name}`,
          kind: 'character',
          campaignSlug: slug,
        });
      }
    }
    // Assets under One-Shots.
    const oneShotAssets = join(oneShotsRoot, 'Assets');
    if (existsSync(oneShotAssets)) collectAssets(oneShotAssets, assets);
  }

  // World Lore (with custom subfolder classification). Preserve filename
  // so wikilinks like [[Pelor]] / [[Blackwater Festival]] resolve via
  // basename match.
  const worldLoreRoot = join(sourceRoot, 'World Lore');
  if (existsSync(worldLoreRoot)) {
    for (const f of listFiles(worldLoreRoot, /\.md$/i)) {
      const filename = f.split('/').pop() ?? '';
      const folder = classifyWorldLore(filename);
      notes.push({
        sourcePath: f,
        targetPath: `${folder}/${filename}`,
        kind: 'lore',
      });
    }
  }

  return { notes, assets, aliases: [...pendingAliases] };
}

function walkCampaign(
  campRoot: string,
  slug: string,
  notes: NotePlan[],
  assets: AssetPlan[],
): void {
  for (const sub of Object.keys(SUBFOLDER_KIND)) {
    const subRoot = join(campRoot, sub);
    if (!existsSync(subRoot)) continue;
    const { folder, kind } = SUBFOLDER_KIND[sub]!;
    for (const f of listFiles(subRoot, /\.md$/i)) {
      const rel = relative(subRoot, f).replace(/\\/g, '/');
      // Adventure Log/<player>/<file>.md — flatten to <file>.md.
      // Per-player folders are journalling artefacts; the system's
      // session view wants a single top-level list. Names are unique
      // in practice (real logs live in one player's folder; the others
      // are empty or stubs).
      let leaf =
        sub === 'Adventure Log'
          ? (rel.split('/').pop() ?? rel)
          : rel;

      // Adventure Log: zero-pad single-digit Session/Episode numbers so
      // path-sorted UI (Episode 1, 10, 11, …, 2, 3) becomes natural
      // (Episode 01, 02, …, 10, 11). Register the unpadded stem as an
      // alias so existing [[Episode 5]] wikilinks still resolve.
      if (sub === 'Adventure Log') {
        const m = leaf.match(/^(Session|Episode)\s+(\d+)(.*?)(\.md)$/i);
        if (m) {
          const [, word, num, rest, ext] = m;
          if (num!.length === 1) {
            const original = leaf.slice(0, -ext!.length);
            leaf = `${word} ${num!.padStart(2, '0')}${rest}${ext}`;
            pendingAliases.push({
              path: `Campaigns/${slug}/${folder}/${leaf}`,
              alias: original,
            });
          }
        }
      }

      notes.push({
        sourcePath: f,
        targetPath: `Campaigns/${slug}/${folder}/${leaf}`,
        kind,
        campaignSlug: slug,
      });
    }
  }
  // Assets — push to global pool.
  const assetRoot = join(campRoot, 'Assets');
  if (existsSync(assetRoot)) collectAssets(assetRoot, assets);
}

function collectAssets(root: string, out: AssetPlan[]): void {
  for (const f of listFiles(root, /\.(png|jpe?g)$/i)) {
    const basename = f.split('/').pop() ?? '';
    const rel = relative(root, f); // e.g. Portraits/x.png
    // Map to global Assets/<Category>/<basename>; categories preserved.
    out.push({
      sourcePath: f,
      basename,
      destPath: `Assets/${rel.replace(/\\/g, '/')}`,
    });
  }
}

// ── Stub user / world setup ────────────────────────────────────────────

function ensureStubUser(userId: string, username: string): void {
  const db = getDb();
  const existing = db
    .query<{ id: string }, [string]>('SELECT id FROM users WHERE id = ?')
    .get(userId);
  if (existing) return;

  // Throwaway password hash (Argon2-style placeholder; real prod algrifff
  // already exists with their real hash, so this row never reaches prod).
  const fakeHash = '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$' +
    'A'.repeat(43);
  const now = Date.now();
  db.query(
    `INSERT INTO users
       (id, username, email, password_hash, display_name, accent_color,
        theme, created_at, last_login_at, email_verified_at)
     VALUES (?, ?, NULL, ?, ?, ?, 'day', ?, NULL, NULL)`,
  ).run(userId, username, fakeHash, username, '#D4A85A', now);
}

function ensureStubSession(userId: string, groupId: string | null): string {
  const db = getDb();
  const sessionId = randomUUID();
  // sessions.current_group_id is NOT NULL with FK → groups.id.
  // We have no group yet at first; pass groupId = null on bootstrap and
  // update once the world exists. For createWorld we need a session row,
  // so create a minimal one that can be retargeted.
  const now = Date.now();
  // Sessions require a current_group_id with FK → groups.id, so we must
  // have a group to point at. If no groups exist yet, seed a bootstrap
  // group; createWorld() will then INSERT the real Delara world and
  // UPDATE this session to point at it.
  const target =
    groupId ??
    (() => {
      const any = db
        .query<{ id: string }, []>('SELECT id FROM groups LIMIT 1')
        .get();
      if (any) return any.id;
      db.query(
        `INSERT INTO groups (id, name, created_at) VALUES ('bootstrap', 'bootstrap', ?)`,
      ).run(now);
      return 'bootstrap';
    })();
  db.query(
    `INSERT INTO sessions
       (id, user_id, current_group_id, csrf_token,
        created_at, expires_at, last_seen_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(
    sessionId,
    userId,
    target,
    'stub-csrf',
    now,
    now + 86400000,
    now,
  );
  return sessionId;
}

// ── Asset insert ───────────────────────────────────────────────────────

type AssetIndex = Map<string, { id: string; mime: string }>;

function commitAssets(
  groupId: string,
  userId: string,
  plans: AssetPlan[],
): { uploaded: number; reused: number; index: AssetIndex } {
  const db = getDb();
  const index: AssetIndex = new Map();
  let uploaded = 0;
  let reused = 0;

  for (const plan of plans) {
    const data = readFileSync(plan.sourcePath);
    const mime = sniffMime(data, plan.basename);
    const hash = createHash('sha256').update(data).digest('hex');

    const existing = db
      .query<{ id: string; mime: string }, [string, string]>(
        'SELECT id, mime FROM assets WHERE group_id = ? AND hash = ?',
      )
      .get(groupId, hash);

    let assetId: string;
    if (existing) {
      assetId = existing.id;
      reused++;
    } else {
      const diskPath = assetPath(hash, mime);
      if (!existsSync(diskPath)) writeFileSync(diskPath, data);
      assetId = randomUUID();
      const now = Date.now();
      db.query(
        `INSERT INTO assets
           (id, group_id, hash, mime, size, original_name, original_path,
            uploaded_by, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        assetId,
        groupId,
        hash,
        mime,
        data.byteLength,
        plan.basename,
        plan.destPath,
        userId,
        now,
      );
      uploaded++;
    }

    // Register every variant of the basename so resolveAsset finds it
    // by either ![[mountain.png]] or ![[Campaign 1/Assets/.../mountain.png]].
    index.set(plan.basename, { id: assetId, mime });
    index.set(plan.basename.toLowerCase(), { id: assetId, mime });
    index.set(plan.destPath, { id: assetId, mime });
    index.set(plan.destPath.toLowerCase(), { id: assetId, mime });
  }

  return { uploaded, reused, index };
}

// ── Note write loop ────────────────────────────────────────────────────

function ensureKindFrontmatter(
  raw: string,
  defaultKind: string,
  username: string,
  campaignSlug: string | undefined,
): { frontmatter: Record<string, unknown>; markdown: string } {
  // Very small frontmatter parser: grab the YAML block if present, else
  // start empty. We only mutate kind / template / player / campaigns.
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
        // Leave as plain body if YAML is broken — body still imports.
      }
      body = raw.slice(end + 4).replace(/^\s*\n/, '');
    }
  }

  if (typeof fm.kind !== 'string') fm.kind = defaultKind;
  // Templates are character/person/creature/item/location/session.
  const templated = ['character', 'person', 'creature', 'item', 'location', 'session'];
  if (templated.includes(String(fm.kind)) && typeof fm.template !== 'string') {
    fm.template = fm.kind;
  }
  if (fm.kind === 'character' && fm.player == null) {
    fm.player = username;
  }
  if (campaignSlug && fm.campaigns == null) {
    fm.campaigns = [campaignSlug];
  }
  return { frontmatter: fm, markdown: body };
}

function setOrIgnoreFolderMarkers(groupId: string, paths: string[]): void {
  const db = getDb();
  const now = Date.now();
  const stmt = db.query(
    `INSERT OR IGNORE INTO folder_markers (group_id, path, created_at)
     VALUES (?, ?, ?)`,
  );
  for (const p of paths) stmt.run(groupId, p, now);
}

// ── Main ───────────────────────────────────────────────────────────────

function main(): void {
  const args = parseArgs();
  const dataDir = process.env.DATA_DIR ?? './.data';

  if (args.reset) {
    if (existsSync(`${dataDir}/compendium.db`)) {
      const ts = Date.now();
      copyFileSync(
        `${dataDir}/compendium.db`,
        `${dataDir}/compendium.db.bak.${ts}`,
      );
      rmSync(`${dataDir}/compendium.db`);
      console.log(
        `[main-notes] reset: snapshotted to compendium.db.bak.${ts} and removed`,
      );
    }
  } else if (existsSync(`${dataDir}/compendium.db`)) {
    const ts = Date.now();
    copyFileSync(
      `${dataDir}/compendium.db`,
      `${dataDir}/compendium.db.bak.${ts}`,
    );
    console.log(
      `[main-notes] snapshot saved to compendium.db.bak.${ts}`,
    );
  } else {
    mkdirSync(dataDir, { recursive: true });
  }

  // Touch DB → triggers migrations.
  getDb();

  // 1. Stub user.
  ensureStubUser(args.userId, args.username);
  console.log(`[main-notes] stub user OK (id=${args.userId}, username=${args.username})`);

  // 2. Stub session (placeholder group_id; createWorld will retarget).
  const sessionId = ensureStubSession(args.userId, null);

  // 3. Create the world.
  const groupId = createWorld({
    name: args.worldName,
    creatorUserId: args.userId,
    sessionId,
  });
  console.log(`[main-notes] created world "${args.worldName}" → groupId=${groupId}`);

  // ensureDefaultFolders is already invoked by createWorld; it's a no-op
  // if folder_markers exist. We also seed our extra World Lore subfolders
  // so they appear in the tree even before notes land in them.
  ensureDefaultFolders(groupId);
  setOrIgnoreFolderMarkers(groupId, [
    'World Lore/Gods',
    'World Lore/Orders',
    'World Lore/Races',
    'World Lore/Houses',
    'World Lore/Parties',
    'World Lore/Places',
    'World Lore/Events',
  ]);

  // 4. Plan everything.
  const { notes, assets, aliases } = planAll(args.source);
  console.log(
    `[main-notes] plan: ${notes.length} notes, ${assets.length} assets, ${aliases.length} aliases`,
  );

  // 5. Commit assets first so wikilinks rewrite to /api/assets/<id>.
  const { uploaded, reused } = commitAssets(groupId, args.userId, assets);
  console.log(
    `[main-notes] assets: ${uploaded} uploaded, ${reused} reused`,
  );

  // 6a. Build aliasMap (lowercase alias → canonical path) for the
  // md-to-pm wikilink resolver step 2. This bridges cases like
  // `[[The Dancing Demon]]` → `Campaigns/.../index.md` where basename
  // match alone (which sees `index`) can't reach the right note.
  const aliasMap = new Map<string, string>();
  for (const a of aliases) aliasMap.set(a.alias.toLowerCase(), a.path);

  // 6. First pass — write every note.
  let firstPassErrors = 0;
  for (const n of notes) {
    try {
      const raw = readFileSync(n.sourcePath, 'utf8');
      let frontmatter: Record<string, unknown>;
      let markdown: string;
      if (n.kind === 'character') {
        // Characters get a structured-sheet parse from body tables so
        // HP / AC / abilities / class / portrait flow into the
        // CharacterSheet UI and party sidebar.
        const parsed = parseCharacter(raw, { defaultPlayer: args.username });
        frontmatter = parsed.frontmatter;
        markdown = parsed.body;
        if (n.campaignSlug && frontmatter.campaigns == null) {
          frontmatter.campaigns = [n.campaignSlug];
        }
      } else {
        const r = ensureKindFrontmatter(raw, n.kind, args.username, n.campaignSlug);
        frontmatter = r.frontmatter;
        markdown = r.markdown;
      }
      writeNote({
        groupId,
        userId: args.userId,
        path: n.targetPath,
        markdown,
        frontmatter,
        isUpdate: false,
        aliasMap,
      });
    } catch (err) {
      firstPassErrors++;
      console.error(
        `[main-notes] first-pass failed: ${n.sourcePath} → ${n.targetPath}:`,
        (err as Error).message,
      );
    }
  }
  console.log(
    `[main-notes] first pass done (${notes.length - firstPassErrors}/${notes.length} succeeded)`,
  );

  // 7. Second pass — re-run writeNote so cross-campaign wikilinks resolve.
  // writeNote reads vaultPaths fresh from the DB on each call; orphans
  // from pass 1 become real edges now.
  let secondPassErrors = 0;
  const db = getDb();
  const noteRows = db
    .query<
      { id: string; path: string; content_md: string; frontmatter_json: string },
      [string]
    >(
      `SELECT id, path, content_md, frontmatter_json
         FROM notes WHERE group_id = ?`,
    )
    .all(groupId);
  for (const row of noteRows) {
    try {
      const fm = JSON.parse(row.frontmatter_json) as Record<string, unknown>;
      writeNote({
        groupId,
        userId: args.userId,
        path: row.path,
        markdown: row.content_md,
        frontmatter: fm,
        isUpdate: true,
        noteId: row.id,
        aliasMap,
      });
    } catch (err) {
      secondPassErrors++;
      console.error(
        `[main-notes] second-pass failed: ${row.path}:`,
        (err as Error).message,
      );
    }
  }
  console.log(
    `[main-notes] second pass done (${noteRows.length - secondPassErrors}/${noteRows.length} succeeded)`,
  );

  // 8. Set friendly campaign names.
  for (const { slug, name } of Object.values(CAMPAIGN_MAP)) {
    db.query(
      'UPDATE campaigns SET name = ? WHERE group_id = ? AND slug = ?',
    ).run(name, groupId, slug);
  }
  db.query(
    'UPDATE campaigns SET name = ? WHERE group_id = ? AND slug = ?',
  ).run('One-Shot: The Dancing Demon', groupId, 'one-shot-the-dancing-demon');

  // 9. Summary.
  const orphans = db
    .query<{ to_path: string }, [string]>(
      `SELECT DISTINCT to_path FROM note_links
        WHERE group_id = ? AND to_path LIKE '__orphan__:%'
        ORDER BY to_path`,
    )
    .all(groupId);
  const byCampaign = db
    .query<{ campaign: string; n: number }, [string]>(
      `SELECT
         CASE
           WHEN path LIKE 'Campaigns/%' THEN substr(path, 11, instr(substr(path, 11), '/') - 1)
           WHEN path LIKE 'World Lore/%' THEN 'World Lore'
           ELSE 'other'
         END AS campaign,
         COUNT(*) AS n
       FROM notes WHERE group_id = ?
       GROUP BY campaign ORDER BY n DESC`,
    )
    .all(groupId);

  console.log('\n=== Import summary ===');
  console.log(`  groupId: ${groupId}`);
  console.log(`  user_id: ${args.userId}  username: ${args.username}`);
  console.log('  notes per campaign:');
  for (const row of byCampaign) {
    console.log(`    ${row.campaign.padEnd(40)} ${row.n}`);
  }
  console.log(
    `  unresolved wikilinks: ${orphans.length} unique target(s)` +
      (orphans.length > 0 ? ' — first 50:' : ''),
  );
  for (const o of orphans.slice(0, 50)) {
    console.log(`    ${o.to_path}`);
  }

  console.log('\n=== Next step (manual review) ===');
  console.log(
    `  cd server && bun run server.ts\n` +
      `  Log in as ${args.username} (whatever creds your local DB has)\n` +
      `  Open the world "${args.worldName}" and spot-check.\n` +
      `  When happy: run scripts/main-notes-import/export-bundle.ts --group-id ${groupId} --out bundle.json`,
  );
}

main();
