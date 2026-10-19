// The one way to create a Note: canonical Kind, Sheet seeded from the
// template, the first free path, the insert, and the derived indexes.
//
// Callers differ only in what they know up front (a path, a body, who
// owns it); they all get the same Sheet shape for the same Kind.
//
// Character shape (what the readers consume): `kind: 'character'`,
// `template: 'character'`, `player` on frontmatter, and a Sheet holding
// BOTH the nested fields the SheetHeader and Zod shape read
// (`ability_scores`, `classes`) and the legacy flat keys (`str`, `class`,
// `level`, `hp_max` ...) the old side panel still reads. No `role`:
// `characters.ts#detectRole` treats a role-less Character as a PC, and the
// index only needs `fm.player` to link the owner. NPC / ally / villain
// canonicalise to `person` (shared kind table), which has its own header.

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
import { hiddenNotesSql, type Visibility } from '@/lib/notes';

/** Kinds that carry a template-seeded Sheet. */
const SHEETED: readonly NoteKind[] = ['character', 'person', 'creature', 'item', 'location', 'session'];

/** Plain `page`, `excalidraw`, or any canonical Kind / legacy alias. */
export type NewNoteKind = KindInput | 'page' | 'excalidraw';

const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;

/** Frontmatter for a brand-new Note of `kind`. Plain pages get `{}`. */
export function seedFrontmatter(opts: {
  kind: NewNoteKind;
  title: string;
  /** Owner's username; becomes `player` on a Character. */
  username?: string | undefined;
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
  if (canonical === 'person' && !(opts.sheet && 'disposition' in opts.sheet)) {
    const alias = String(opts.kind).toLowerCase();
    if (alias === 'ally') sheet.disposition = 'friendly';
    if (alias === 'villain') sheet.disposition = 'hostile';
  }

  const fm: Record<string, unknown> = { kind: canonical, template: canonical, sheet };
  if (canonical === 'character') {
    nestCharacterSheet(sheet);
    if (opts.username) fm.player = opts.username;
  }
  return fm;
}

/** Template defaults seed the legacy flat keys; the SheetHeader and Zod
 *  shape read nested objects. Add the nested form and keep the flat keys. */
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
  for (let n = firstN; n < firstN + 1000; n++) {
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
  username?: string | undefined;
  /** Sheet fields that win over template defaults. */
  sheet?: Record<string, unknown> | undefined;
  /** Extra top-level frontmatter (e.g. `campaigns`). */
  frontmatter?: Record<string, unknown> | undefined;
  /** Replace seeding with a frontmatter the caller built via
   *  `seedFrontmatter` and then adjusted (e.g. merged a parsed body). */
  seeded?: Record<string, unknown> | undefined;
  /** Markdown body. Omitted: an empty paragraph. */
  markdown?: string | undefined;
  dmOnly?: boolean | undefined;
  gmOnly?: boolean | undefined;
  /** A taken path: fail (default) or take the next free one. */
  onTaken?: 'fail' | 'next-free' | undefined;
  /** With `next-free`: a holder visible under this still fails, so the
   *  answer never reveals a hidden Note. */
  visibleTo?: Visibility | undefined;
  /** Suffix for `next-free` (default ` (n)`). */
  suffix?: ((n: number) => string) | undefined;
  /** With `next-free`: the title takes the suffix too. */
  suffixTitle?: boolean | undefined;
};

export type CreateNoteResult =
  | { status: 'created'; path: string; title: string; frontmatter: Record<string, unknown> }
  | { status: 'exists'; path: string };

/** Insert a Note, derive its indexes and refresh the parent folder index.
 *  A taken path is a result, not a throw; unexpected database errors throw. */
export async function createNote(groupId: string, opts: CreateNoteOpts): Promise<CreateNoteResult> {
  const db = getDb();
  const stem = opts.path.replace(/\.md$/i, '');
  const leaf = stem.split('/').pop() ?? stem;
  const dir = stem.slice(0, stem.length - leaf.length);
  const suffix = opts.suffix ?? PAREN_SUFFIX;

  let path = opts.path;
  let title = opts.title;
  let frontmatter: Record<string, unknown> = {};
  // Insert first and translate the conflict: a SELECT-then-INSERT leaves
  // a window where two concurrent creates both pass the check.
  for (let n = 2; ; n++) {
    frontmatter = opts.seeded
      ? { ...opts.seeded }
      : {
          ...seedFrontmatter({ kind: opts.kind, title, username: opts.username, sheet: opts.sheet }),
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
      if (opts.onTaken !== 'next-free' || n > 50) return { status: 'exists', path };
      if (opts.visibleTo) {
        const visible = db
          .query<{ n: number }, [string, string]>(
            `SELECT COUNT(*) AS n FROM notes n WHERE n.group_id = ? AND n.path = ?${hiddenNotesSql('n', opts.visibleTo)}`,
          )
          .get(groupId, path);
        if ((visible?.n ?? 0) > 0) return { status: 'exists', path };
      }
      path = `${dir}${leaf}${suffix(n)}.md`;
      if (opts.suffixTitle) title = `${opts.title}${suffix(n)}`;
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
