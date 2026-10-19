// Create one Note from the app: canonical Kind, Sheet seeded from the
// template, the insert, and the derived indexes. Used by
// `POST /api/notes/create`, `POST /api/sessions/create`, Wrap-up apply
// (`lib/wrap-up.ts`) and the `entity_create` AI tool. Other paths still
// write Notes themselves: Smart Import and the manual import apply,
// folder indexes (`index-notes.ts`), ingest, and the duplicate, promote
// and campaign-join routes.
//
// Callers differ only in what they know up front (a path, a body, who
// owns it); they all get the same Sheet shape for the same Kind.
//
// Character shape (what the readers consume): `kind: 'character'`,
// `template: 'character'`, `player` on frontmatter, and a Sheet holding
// BOTH the nested fields the SheetHeader and Zod shape read
// (`ability_scores`, `classes`) and the legacy flat keys (`str`, `class`,
// `level`, `hp_max` ...) the old side panel still reads.
//
// A legacy alias (`pc` / `npc` / `ally` / `villain`) also keeps `role:
// <alias>`: the note page and the sheet route read `role` to decide that a
// Character's `player` owns it, and a Person keeps which stance it was
// made as. NPC / ally / villain canonicalise to `person` (shared kind
// table), which has its own header and no `characters` row.

import { randomUUID } from 'node:crypto';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import * as Y from 'yjs';
import { parseKind, type KindInput, type NoteKind } from '@compendium/shared';
import { getDb, isUniqueConstraintError } from '@/lib/db';
import { getPmSchema } from '@/lib/pm-schema';
import { getTemplate, type TemplateKind } from '@/lib/templates';
import { deriveAllIndexes } from '@/lib/derive-indexes';
import { deriveFolderIndex, parentFolderUnderCampaign } from '@/lib/campaign-index';
import { writeNote } from '@/lib/import-apply';

/** Kinds that carry a template-seeded Sheet. */
const SHEETED: readonly NoteKind[] = ['character', 'person', 'creature', 'item', 'location', 'session'];

/** Plain `page`, `excalidraw`, or any canonical Kind / legacy alias. */
export type NewNoteKind = KindInput | 'page' | 'excalidraw';

/** Legacy aliases that carried a `role` before the shared kind table. */
const ROLE_ALIASES: readonly string[] = ['pc', 'npc', 'ally', 'villain'];

const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;

/** How far `next-free` looks for a free ` (n)` / `-n` path. */
export const NEXT_FREE_LIMIT = 1000;

/** Frontmatter for a brand-new Note of `kind`. Plain pages get `{}`. */
export function seedFrontmatter(opts: {
  kind: NewNoteKind;
  title: string;
  /** Written as `player` on a Character; ignored for other Kinds. */
  player?: string | undefined;
  /** Caller-chosen Sheet fields; they win over template defaults. */
  sheet?: Record<string, unknown> | undefined;
}): Record<string, unknown> {
  const { title } = opts;
  if (opts.kind === 'page') return {};
  if (opts.kind === 'excalidraw') return { kind: 'excalidraw', sheet: { name: title } };

  const canonical = parseKind(opts.kind);
  if (!canonical) return {};
  if (canonical === 'quest' || canonical === 'lore') return { kind: canonical };
  if (!SHEETED.includes(canonical)) return {};

  // Session Sheets have no `name` field; every other Kind does.
  const sheet: Record<string, unknown> = canonical === 'session' ? {} : { name: title };
  Object.assign(sheet, opts.sheet);
  const template = getTemplate(canonical as TemplateKind);
  for (const section of template?.schema.sections ?? []) {
    for (const field of section.fields) {
      if (field.id !== 'name' && !(field.id in sheet) && field.default !== undefined) {
        sheet[field.id] = field.default;
      }
    }
  }
  // Legacy aliases carried a stance that the Person template models.
  const alias = String(opts.kind).toLowerCase();
  if (canonical === 'person' && !(opts.sheet && 'disposition' in opts.sheet)) {
    if (alias === 'ally') sheet.disposition = 'friendly';
    if (alias === 'villain') sheet.disposition = 'hostile';
  }

  const fm: Record<string, unknown> = { kind: canonical, template: canonical, sheet };
  if (ROLE_ALIASES.includes(alias)) fm.role = alias;
  if (canonical === 'character') {
    nestCharacterSheet(sheet);
    if (opts.player) fm.player = opts.player;
  }
  return fm;
}

/** Template defaults seed the legacy flat keys; the SheetHeader and Zod
 *  shape read nested objects. Add the nested form and keep the flat keys
 *  (except a numeric `speed`, which becomes `{ walk }`). */
function nestCharacterSheet(sheet: Record<string, unknown>): void {
  const ab = sheet.ability_scores;
  const hasBlock =
    !!ab &&
    typeof ab === 'object' &&
    ABILITY_KEYS.some((k) => typeof (ab as Record<string, unknown>)[k] === 'number');
  if (!hasBlock) {
    const scores: Record<string, number> = {};
    let any = false;
    for (const k of ABILITY_KEYS) {
      const v = sheet[k];
      if (typeof v === 'number' && Number.isFinite(v)) {
        scores[k] = v;
        any = true;
      }
    }
    if (any) {
      sheet.ability_scores = Object.fromEntries(ABILITY_KEYS.map((k) => [k, scores[k] ?? 10]));
    }
  }

  if (!(Array.isArray(sheet.classes) && sheet.classes.length > 0)) {
    const className =
      typeof sheet.class === 'string' && sheet.class.trim() ? sheet.class.trim() : null;
    let level: number | null = null;
    if (typeof sheet.level === 'number' && sheet.level > 0) level = Math.trunc(sheet.level);
    else if (typeof sheet.level === 'string') {
      const n = Number(sheet.level);
      if (Number.isFinite(n) && n > 0) level = Math.trunc(n);
    }
    if (className || level !== null) {
      sheet.classes = [{ ref: { name: className ?? 'Adventurer' }, level: level ?? 1 }];
    }
  }

  const hp = sheet.hit_points;
  const hasHpBlock =
    !!hp && typeof hp === 'object' && typeof (hp as Record<string, unknown>).max === 'number';
  if (!hasHpBlock) {
    const max = typeof sheet.hp_max === 'number' ? sheet.hp_max : null;
    const cur = typeof sheet.hp_current === 'number' ? sheet.hp_current : null;
    if (max !== null || cur !== null) {
      sheet.hit_points = {
        max: max ?? cur ?? 0,
        current: cur ?? max ?? 0,
        temporary:
          typeof sheet.hp_temporary === 'number' && Number.isFinite(sheet.hp_temporary)
            ? sheet.hp_temporary
            : 0,
      };
    }
  }

  const ac = sheet.armor_class;
  const hasAcBlock =
    !!ac && typeof ac === 'object' && typeof (ac as Record<string, unknown>).value === 'number';
  if (!hasAcBlock && typeof sheet.ac === 'number' && Number.isFinite(sheet.ac)) {
    sheet.armor_class = { value: sheet.ac };
  }

  if (typeof sheet.speed === 'number' && Number.isFinite(sheet.speed)) {
    sheet.speed = { walk: sheet.speed };
  }
}

/** Default suffix: `a/b.md` -> `a/b (2).md`. */
export const PAREN_SUFFIX = (n: number): string => ` (${n})`;

/** The first path nothing in the group holds. Candidates are
 *  `<stem><suffix(n)>.md` for n = firstN, firstN + 1, ...; `path` itself
 *  is never returned. */
export function nextFreePath(
  groupId: string,
  path: string,
  suffix: (n: number) => string = PAREN_SUFFIX,
  firstN = 2,
): string {
  const stem = path.replace(/\.md$/i, '');
  const q = getDb().query<{ n: number }, [string, string]>(
    'SELECT COUNT(*) AS n FROM notes WHERE group_id = ? AND path = ?',
  );
  for (let n = firstN; n < firstN + NEXT_FREE_LIMIT; n++) {
    const candidate = `${stem}${suffix(n)}.md`;
    if ((q.get(groupId, candidate)?.n ?? 0) === 0) return candidate;
  }
  throw new Error(`No free path near ${path}`);
}

export type CreateNoteOpts = {
  userId: string;
  /** Full path including `.md`. */
  path: string;
  kind: NewNoteKind;
  title: string;
  /** Written as `player` on a Character. */
  player?: string | undefined;
  /** Sheet fields that win over template defaults. */
  sheet?: Record<string, unknown> | undefined;
  /** Extra top-level frontmatter (e.g. `campaigns`); wins over the seed. */
  frontmatter?: Record<string, unknown> | undefined;
  /** Markdown body. Omitted: an empty paragraph. */
  markdown?: string | undefined;
  dmOnly?: boolean | undefined;
  gmOnly?: boolean | undefined;
  /** Called when `taken` is already held, with n = 2, 3, ...: the next
   *  path and title to try, or null to answer `exists`. Omitted: `exists`
   *  at once. Retrying the insert, rather than looking for a free path
   *  first, keeps two concurrent creates from both passing the check. */
  onTaken?: ((taken: string, n: number) => { path: string; title: string } | null) | undefined;
};

export type CreateNoteResult =
  | { status: 'created'; path: string; title: string; frontmatter: Record<string, unknown> }
  | { status: 'exists'; path: string };

/** Insert a Note, derive its indexes and refresh the parent folder index.
 *  A taken path is a result, not a throw; unexpected database errors throw. */
export async function createNote(groupId: string, opts: CreateNoteOpts): Promise<CreateNoteResult> {
  const db = getDb();
  let path = opts.path;
  let title = opts.title;
  let frontmatter: Record<string, unknown> = {};
  // Insert first and translate the conflict: a SELECT-then-INSERT leaves
  // a window where two concurrent creates both pass the check.
  for (let n = 2; ; n++) {
    frontmatter = {
      ...seedFrontmatter({ kind: opts.kind, title, player: opts.player, sheet: opts.sheet }),
      ...opts.frontmatter,
    };
    // Every derive recomputes the dm_only column from this flag.
    if (opts.dmOnly) frontmatter.dm_only = true;
    try {
      if (opts.markdown !== undefined) {
        writeNote({ groupId, userId: opts.userId, path, title, markdown: opts.markdown, frontmatter, isUpdate: false });
        if (opts.dmOnly || opts.gmOnly) {
          db.query('UPDATE notes SET dm_only = ?, gm_only = ? WHERE group_id = ? AND path = ?').run(
            opts.dmOnly ? 1 : 0,
            opts.gmOnly ? 1 : 0,
            groupId,
            path,
          );
        }
      } else {
        insertBlank(groupId, opts, path, title, frontmatter);
      }
      break;
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      const next = n > NEXT_FREE_LIMIT ? null : (opts.onTaken?.(path, n) ?? null);
      if (!next) return { status: 'exists', path };
      ({ path, title } = next);
    }
  }

  try {
    deriveAllIndexes({ groupId, notePath: path, frontmatterJson: JSON.stringify(frontmatter) });
  } catch (err) {
    console.error('[create-note] derive failed:', err);
  }
  const parent = parentFolderUnderCampaign(path);
  if (parent) {
    await deriveFolderIndex(groupId, parent, { userId: opts.userId }).catch((err) => {
      console.error('[create-note] folder index refresh failed:', err);
    });
  }
  return { status: 'created', path, title, frontmatter };
}

function insertBlank(
  groupId: string,
  opts: CreateNoteOpts,
  path: string,
  title: string,
  frontmatter: Record<string, unknown>,
): void {
  const doc = { type: 'doc', content: [{ type: 'paragraph' }] };
  const ydoc = prosemirrorJSONToYDoc(getPmSchema(), doc, 'default');
  ydoc.getText('title').insert(0, title);
  const now = Date.now();
  getDb()
    .query(
      `INSERT INTO notes (id, group_id, path, title, content_json, content_text,
                          content_md, yjs_state, frontmatter_json, byte_size,
                          updated_at, updated_by, created_at, created_by, dm_only, gm_only)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(), groupId, path, title, JSON.stringify(doc), '', '',
      Y.encodeStateAsUpdate(ydoc), JSON.stringify(frontmatter), 0,
      now, opts.userId, now, opts.userId, opts.dmOnly ? 1 : 0, opts.gmOnly ? 1 : 0,
    );
}
