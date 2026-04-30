// Extract a structured D&D 5e character sheet from raw markdown content.
// Used by every flow that turns user-supplied prose into a character
// note: bulk import scripts, the in-app AI import pipeline, and the AI
// `entity_create` tool when given a body. The output `frontmatter.sheet`
// lights up the CharacterSheet UI, party sidebar, and SheetHeader
// inline editors.
//
// Source files are inconsistent: most have YAML frontmatter at the top
// (name/player/class/level/race/background/alignment), some have it
// buried mid-file after the appearance log, and stats live in body
// tables in two shapes:
//
//   Vertical "Field | Value":
//     | Player | Alucard8008 |
//     | Class  | Barbarian 17 |
//     | HP     | 206 |
//     | AC     | 16 |
//     | Speed  | 70ft walk / 100ft swim |
//
//   Horizontal "HP | AC | Initiative | Speed":
//     | HP   | AC | Initiative | Speed                 |
//     | 113  | 14 | +2         | 30ft walk / 15ft swim |
//
// Plus an Ability Scores table:
//     | STR    | DEX     | CON     | INT     | WIS     | CHA     |
//     | 19(+4) | 14(+2)  | 18(+4)  | 9(-1)   | 9(-1)   | 11(+0)  |
//
// We're "best effort": missing data is fine, the validator is forgiving.

import * as YAML from 'yaml';

export type ParsedCharacter = {
  /** Frontmatter to set on the note. Caller should merge with existing. */
  frontmatter: Record<string, unknown>;
  /** Body markdown to write (with embedded YAML blocks stripped if any). */
  body: string;
};

// ── Frontmatter discovery ──────────────────────────────────────────────

type FoundFm = { data: Record<string, unknown>; before: string; after: string };

function tryTopFrontmatter(raw: string): FoundFm | null {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) return null;
  const end = raw.indexOf('\n---', 4);
  if (end === -1) return null;
  const yamlText = raw.slice(raw.indexOf('\n') + 1, end).trim();
  let data: Record<string, unknown> = {};
  try {
    const parsed = YAML.parse(yamlText);
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  return { data, before: '', after: raw.slice(end + 4).replace(/^\s*\n/, '') };
}

/** Find the YAML frontmatter block embedded somewhere in the file.
 *  Source files often have multiple `---` lines (section separators
 *  AND frontmatter delimiters), so we collect every `---` line and
 *  try YAML-parsing the content between each adjacent pair. The first
 *  pair whose content parses to an object containing character-shaped
 *  keys wins. */
function tryEmbeddedFrontmatter(raw: string): FoundFm | null {
  const lines = raw.split('\n');
  const seps: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') seps.push(i);
  }
  if (seps.length < 2) return null;
  // Cumulative byte offsets so we can recover before/after slices.
  const offsets: number[] = [0];
  for (let i = 0; i < lines.length; i++) {
    offsets[i + 1] = offsets[i]! + lines[i]!.length + 1; // +1 for the '\n'
  }
  for (let i = 0; i < seps.length - 1; i++) {
    const startLine = seps[i]!;
    const endLine = seps[i + 1]!;
    if (endLine - startLine < 2) continue; // empty block
    const yamlText = lines.slice(startLine + 1, endLine).join('\n');
    let data: Record<string, unknown>;
    try {
      const parsed = YAML.parse(yamlText);
      if (!parsed || typeof parsed !== 'object') continue;
      data = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (
      typeof data.name === 'string' &&
      (data.class != null ||
        data.level != null ||
        data.race != null ||
        data.species != null ||
        data.player != null)
    ) {
      const startByte = offsets[startLine]!;
      const endByte = offsets[endLine + 1]!;
      return {
        data,
        before: raw.slice(0, startByte),
        after: raw.slice(endByte),
      };
    }
  }
  return null;
}

// ── Body stat parser ───────────────────────────────────────────────────

type Stats = {
  hp_max?: number;
  hp_current?: number;
  ac?: number;
  initiative_bonus?: number;
  speed?: Record<string, number>;
  proficiency_bonus?: number;
  level?: number;
  ability_scores?: Record<'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha', number>;
};

function stripMd(s: string): string {
  // Remove markdown emphasis markers and trim. Doesn't try to be a real
  // parser — just enough to recover the key text.
  return s.replace(/[*_`]+/g, '').trim();
}

function intFromCell(s: string): number | null {
  // "18 (+4)" → 18, "+2" → 2, "30ft" → 30, "1d8" → 1
  const m = s.match(/-?\d+/);
  return m ? Number(m[0]) : null;
}

function parseSpeed(cell: string): Record<string, number> {
  // "30ft walk / 15ft swim" or "70ft walk / 100ft swim" or "30ft" or "30 ft."
  const out: Record<string, number> = {};
  const parts = cell.split(/[/,]/);
  for (const p of parts) {
    const t = p.trim();
    const m = t.match(/(\d+)\s*ft\.?\s*(walk|swim|fly|climb|burrow)?/i);
    if (m) {
      const n = Number(m[1]);
      const mode = (m[2] ?? 'walk').toLowerCase();
      out[mode] = n;
    }
  }
  if (Object.keys(out).length === 0) {
    const n = intFromCell(cell);
    if (n != null) out.walk = n;
  }
  return out;
}

function parseStats(body: string): Stats {
  const out: Stats = {};

  // Iterate every markdown table.
  const tables = extractTables(body);
  for (const t of tables) {
    const headersLower = t.headers.map((h) => h.toLowerCase().trim());
    const isVertical =
      headersLower.length === 2 &&
      (headersLower[0] === 'field' || headersLower[0] === 'attribute' || headersLower[0] === '') &&
      (headersLower[1] === 'value' || headersLower[1] === '');

    if (isVertical) {
      for (const row of t.rows) {
        // Strip markdown bold/italic so `**Level**` and `*Level*` both
        // match the same key.
        const key = stripMd((row[0] ?? '').trim()).toLowerCase();
        const val = (row[1] ?? '').trim();
        applyKv(out, key, val);
      }
      continue;
    }

    // Horizontal: header row defines columns; each row has values.
    if (headersLower.includes('str') && headersLower.includes('dex')) {
      // Ability scores table.
      const valueRow = t.rows[0] ?? [];
      const idx = (k: string) => headersLower.findIndex((h) => h === k);
      const get = (k: string) => intFromCell(valueRow[idx(k)] ?? '');
      out.ability_scores = {
        str: get('str') ?? 10,
        dex: get('dex') ?? 10,
        con: get('con') ?? 10,
        int: get('int') ?? 10,
        wis: get('wis') ?? 10,
        cha: get('cha') ?? 10,
      };
      continue;
    }

    if (
      headersLower.includes('hp') ||
      headersLower.includes('ac') ||
      headersLower.includes('speed') ||
      headersLower.includes('initiative')
    ) {
      const row = t.rows[0] ?? [];
      const idx = (k: string) => headersLower.findIndex((h) => h === k);
      const get = (k: string) => row[idx(k)] ?? '';
      const hp = intFromCell(get('hp'));
      if (hp != null) {
        out.hp_max = hp;
        out.hp_current = hp;
      }
      const ac = intFromCell(get('ac'));
      if (ac != null) out.ac = ac;
      const init = intFromCell(get('initiative'));
      if (init != null) out.initiative_bonus = init;
      const speed = get('speed').trim();
      if (speed) out.speed = parseSpeed(speed);
      const pb = intFromCell(get('proficiency') ?? get('proficiency bonus'));
      if (pb != null) out.proficiency_bonus = pb;
    }
  }

  // Inline `**Initiative:** +5` / `**Proficiency Bonus:** +5` lines (Erianor).
  const inline = (re: RegExp): number | null => {
    const m = body.match(re);
    return m ? intFromCell(m[1]!) : null;
  };
  if (out.initiative_bonus == null) {
    const v = inline(/\*\*\s*Initiative\s*:?\s*\*\*\s*([+\-]?\d+)/i);
    if (v != null) out.initiative_bonus = v;
  }
  if (out.proficiency_bonus == null) {
    const v = inline(/\*\*\s*Proficiency Bonus\s*:?\s*\*\*\s*([+\-]?\d+)/i);
    if (v != null) out.proficiency_bonus = v;
  }

  return out;
}

function applyKv(out: Stats, key: string, val: string): void {
  if (key === 'hp' || key === 'hit points') {
    const n = intFromCell(val);
    if (n != null) {
      out.hp_max = n;
      out.hp_current = n;
    }
  } else if (key === 'ac' || key === 'armor class' || key === 'armour class') {
    const n = intFromCell(val);
    if (n != null) out.ac = n;
  } else if (key === 'initiative') {
    const n = intFromCell(val);
    if (n != null) out.initiative_bonus = n;
  } else if (key === 'speed') {
    out.speed = parseSpeed(val);
  } else if (key === 'proficiency' || key === 'proficiency bonus') {
    const n = intFromCell(val);
    if (n != null) out.proficiency_bonus = n;
  } else if (key === 'level') {
    const n = intFromCell(val);
    if (n != null) out.level = n;
  }
}

// Markdown table extractor: returns each `| ... |` table as headers + rows.
type Table = { headers: string[]; rows: string[][] };

function extractTables(body: string): Table[] {
  const lines = body.split(/\r?\n/);
  const tables: Table[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim().startsWith('|') || !line.trim().endsWith('|')) continue;
    // Header is line `i`; separator is `i+1` (with dashes).
    const sep = lines[i + 1]?.trim() ?? '';
    if (!/^\|[\s\-:|]+\|$/.test(sep)) continue;
    const headers = splitTableRow(line);
    const rows: string[][] = [];
    let j = i + 2;
    while (j < lines.length) {
      const r = lines[j]!.trim();
      if (!r.startsWith('|') || !r.endsWith('|')) break;
      rows.push(splitTableRow(r));
      j++;
    }
    tables.push({ headers, rows });
    i = j - 1;
  }
  return tables;
}

function splitTableRow(line: string): string[] {
  const t = line.trim();
  const inner = t.slice(1, -1); // strip leading/trailing |
  return inner.split('|').map((c) => c.trim());
}

// ── Class parsing ──────────────────────────────────────────────────────

type ParsedClass = { name: string; level: number; subclass?: string };

function parseClasses(
  classRaw: unknown,
  subclassRaw: unknown,
  totalLevel: number | null,
): ParsedClass[] {
  const className = typeof classRaw === 'string' ? classRaw.trim() : '';
  if (!className) return [];

  const subclassName = typeof subclassRaw === 'string' ? subclassRaw.trim() : '';

  // "Monk 14 / Barbarian 3" — multi-class with explicit per-class levels.
  // "Monk / Barbarian" — multi-class without; we don't know the split,
  // so attribute the full frontmatter level to the first class and 0
  // to the rest. The display in the sheet looks "Monk N" with the
  // others as multiclass tagalongs the user can fix in-app.
  if (className.includes('/')) {
    const parts = className.split('/').map((s) => s.trim());
    const subclasses = subclassName.split('/').map((s) => s.trim());
    const anyHasLevel = parts.some((p) => /\s+\d+$/.test(p));
    return parts.map((p, idx): ParsedClass => {
      const m = p.match(/^(.*?)\s+(\d+)$/);
      const name = (m ? m[1]! : p).trim();
      const lvl = m
        ? Number(m[2])
        : anyHasLevel
          ? 1
          : idx === 0
            ? (totalLevel ?? 1)
            : 0;
      const sub = subclasses[idx];
      return {
        name,
        level: lvl,
        ...(sub ? { subclass: sub } : {}),
      };
    }).filter((c) => c.level > 0);
  }

  // "Rogue 15" — single class with level baked in
  const m = className.match(/^(.*?)\s+(\d+)$/);
  if (m) {
    return [
      {
        name: m[1]!.trim(),
        level: Number(m[2]),
        ...(subclassName ? { subclass: subclassName } : {}),
      },
    ];
  }

  // Bare class name; use frontmatter level
  return [
    {
      name: className,
      level: totalLevel ?? 1,
      ...(subclassName ? { subclass: subclassName } : {}),
    },
  ];
}

// ── Portrait extraction ────────────────────────────────────────────────

function parsePortrait(body: string): string | null {
  // ![[Campaign 3/Assets/Portraits/jason_johnson_portrait.png]] or
  // ![[jason_johnson_portrait.png]]
  const m = body.match(/!\[\[([^\]|]+)\]\]/);
  if (!m) return null;
  const ref = m[1]!.trim();
  // We register the basename in the assets index, so the resolver
  // will find it. Return just the basename so deriveCharacter can
  // store a stable portrait reference (the body itself has the
  // full original path, which md-to-pm rewrites to /api/assets/...).
  const base = ref.split('/').pop() ?? ref;
  return base;
}

// ── Top-level entry ────────────────────────────────────────────────────

export function parseCharacter(raw: string, opts: { defaultPlayer: string }): ParsedCharacter {
  // 1. Locate the source-of-truth YAML. If top-of-file, easy. Otherwise
  // an embedded one mid-file. If neither, start empty.
  const top = tryTopFrontmatter(raw);
  let srcFm: Record<string, unknown> = {};
  let body: string;
  if (top) {
    srcFm = top.data;
    body = top.after;
  } else {
    const embedded = tryEmbeddedFrontmatter(raw);
    if (embedded) {
      srcFm = embedded.data;
      body = embedded.before + '\n\n' + embedded.after;
    } else {
      body = raw;
    }
  }

  // 2. Parse stats from body tables.
  const stats = parseStats(body);

  // 3. Build canonical sheet. Level can come from frontmatter or be
  // parsed out of the body's stats table (when no frontmatter).
  const level = numFm(srcFm.level) ?? stats.level ?? null;
  const classes = parseClasses(srcFm.class, srcFm.subclass, level);
  const totalLevel =
    classes.length > 0 ? classes.reduce((s, c) => s + c.level, 0) : (level ?? 1);

  const sheet: Record<string, unknown> = {
    name: strFm(srcFm.name) ?? '',
  };

  if (classes.length > 0) {
    sheet.classes = classes.map((c) => ({
      ref: { name: c.name },
      level: c.level,
      hit_dice_used: 0,
      ...(c.subclass ? { subclass: c.subclass } : {}),
    }));
  }
  // legacy flat mirrors used by the old CharacterSheet side-panel
  if (classes.length > 0) {
    sheet.class = classes.map((c) => `${c.name} ${c.level}`).join(' / ');
  } else if (typeof srcFm.class === 'string') {
    sheet.class = srcFm.class;
  }
  if (typeof srcFm.subclass === 'string') sheet.subclass = srcFm.subclass;

  const race = strFm(srcFm.race) ?? strFm(srcFm.species);
  if (race) sheet.race = race; // string form — schema coerces to { ref: { name } }
  const background = strFm(srcFm.background);
  if (background) sheet.background = background;
  const alignment = strFm(srcFm.alignment);
  if (alignment) sheet.alignment = alignment;

  if (stats.ability_scores) {
    sheet.ability_scores = stats.ability_scores;
    // legacy flat keys
    sheet.str = stats.ability_scores.str;
    sheet.dex = stats.ability_scores.dex;
    sheet.con = stats.ability_scores.con;
    sheet.int = stats.ability_scores.int;
    sheet.wis = stats.ability_scores.wis;
    sheet.cha = stats.ability_scores.cha;
  }
  if (stats.ac != null) {
    sheet.armor_class = { value: stats.ac };
    sheet.ac = stats.ac;
  }
  if (stats.hp_max != null) {
    sheet.hit_points = {
      max: stats.hp_max,
      current: stats.hp_current ?? stats.hp_max,
      temporary: 0,
    };
    sheet.hp_max = stats.hp_max;
    sheet.hp_current = stats.hp_current ?? stats.hp_max;
  }
  if (stats.speed) sheet.speed = stats.speed;
  if (stats.initiative_bonus != null) sheet.initiative_bonus = stats.initiative_bonus;
  if (stats.proficiency_bonus != null) sheet.proficiency_bonus = stats.proficiency_bonus;

  sheet.level = totalLevel;

  const portraitBase = parsePortrait(body);
  if (portraitBase) {
    // Stored as the original wikilink target; md-to-pm rewrites it.
    sheet.portrait = portraitBase;
  }

  // Also surface the portrait at the top level of frontmatter so the
  // assign-player / transfer-character flow picks it up — it reads
  // `fm.portrait`, not `fm.sheet.portrait`. Same for
  // deriveCharacterFromFrontmatter, which checks both but prefers top.

  // 4. Compose the new frontmatter (preserve any unknown source keys).
  const fm: Record<string, unknown> = { ...srcFm };
  fm.kind = 'character';
  fm.template = 'character';
  if (typeof fm.player !== 'string') fm.player = opts.defaultPlayer;
  fm.sheet = sheet;
  if (portraitBase) fm.portrait = portraitBase;
  // Drop the legacy top-level keys we already moved into sheet (so the
  // sheet object is the single source of truth).
  delete fm.class;
  delete fm.subclass;
  delete fm.race;
  delete fm.species;
  delete fm.background;
  delete fm.level;
  delete fm.alignment;

  return { frontmatter: fm, body };
}

// ── Helpers ────────────────────────────────────────────────────────────

function strFm(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function numFm(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}
