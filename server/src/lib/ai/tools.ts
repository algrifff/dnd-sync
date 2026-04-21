// AI tool definitions for the chat agent.
//
// Tools are created via a factory that closes over the caller's context
// (groupId, userId, role) so each execute() has the right scope without
// module-level mutable state.
//
// Each tool defines its Zod schema as a named const so z.infer<> can
// type the execute callback explicitly — required for strict mode.

import { tool } from 'ai';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import * as Y from 'yjs';
import { getDb } from '@/lib/db';
import { getPmSchema } from '@/lib/pm-schema';
import { loadNote } from '@/lib/notes';
import { canonicalFolder, nameToSlug, type EntityKind } from '@/lib/ai/paths';
import { getTemplate, type TemplateKind } from '@/lib/templates';
import { deriveAllIndexes } from '@/lib/derive-indexes';
import { validateSheet } from '@/lib/validateSheet';

// ── Context ────────────────────────────────────────────────────────────

export type ToolContext = {
  groupId: string;
  userId: string;
  role: 'dm' | 'player';
  campaignSlug?: string | undefined;
};

// ── Factory ────────────────────────────────────────────────────────────

export function createTools(ctx: ToolContext) {
  return {
    entity_search:       entitySearch(ctx),
    entity_create:       entityCreate(ctx),
    entity_edit_sheet:   entityEditSheet(ctx),
    entity_edit_content: entityEditContent(ctx),
    entity_move:         entityMove(ctx),
    backlink_create:     backlinkCreate(ctx),
    inventory_add:       inventoryAdd(ctx),
    session_close:       sessionClose(ctx),
    session_apply:       sessionApply(ctx),
  };
}

export function getToolsForRole(ctx: ToolContext) {
  const all = createTools(ctx);
  if (ctx.role === 'dm') return all;
  const { session_close: _sc, session_apply: _sa, entity_move: _em, ...playerTools } = all;
  return playerTools;
}

// ── Schemas ────────────────────────────────────────────────────────────

const SearchSchema = z.object({
  query: z.string().describe('Name or keywords to search'),
  limit: z.number().int().positive().max(20).optional().default(10),
});

const CreateSchema = z.object({
  kind: z.enum([
    'character', 'person', 'creature',
    'item', 'location', 'session', 'lore', 'note',
    // legacy aliases — mapped to canonical kinds in normalizeKind()
    'pc', 'npc', 'ally', 'villain', 'monster',
  ]),
  name: z.string().min(1).max(200),
  campaignSlug: z.string().optional().describe('Campaign slug — omit for world-level entities'),
  sheet: z.record(z.unknown()).optional().describe('Frontmatter sheet fields to pre-fill'),
  dmOnly: z.boolean().optional().default(false),
});

const EditSheetSchema = z.object({
  path: z.string().min(1).max(512).describe('Full note path'),
  updates: z.record(
    z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
  ).describe('Field key→value pairs to merge into the sheet'),
});

const EditContentSchema = z.object({
  path:    z.string().min(1).max(512),
  content: z.string().describe('Plain text or simple markdown to append'),
  heading: z.string().optional().describe('Section heading to prepend'),
});

const MoveSchema = z.object({
  from: z.string().min(1).max(512),
  to:   z.string().min(1).max(512),
});

const BacklinkSchema = z.object({
  fromPath: z.string().min(1).max(512),
  toPath:   z.string().min(1).max(512),
  label:    z.string().optional().describe('Display label for the link'),
});

const InventorySchema = z.object({
  characterPath: z.string().min(1).max(512),
  itemPath:      z.string().optional().describe('Path to an existing Item entity note'),
  freeformName:  z.string().optional().describe('Plain text name for mundane/consumable items'),
  quantity:      z.number().int().positive().optional().default(1),
});

const SessionCloseSchema = z.object({
  sessionPath: z.string().min(1).max(512),
});

const SessionApplySchema = z.object({
  sessionPath: z.string().min(1).max(512),
  approvedChanges: z.array(z.object({
    id:       z.string(),
    approved: z.boolean(),
  })).describe('Per-change approval decisions from the review panel'),
});

// ── entity_search ─────────────────────────────────────────────────────

function toFtsQuery(raw: string): string {
  return raw.trim().replace(/['"*]/g, '').split(/\s+/).filter(Boolean).join(' ');
}

function entitySearch(ctx: ToolContext) {
  return tool({
    description:
      'Search for existing entities by name or keywords. Always call this before entity_create to prevent duplicates.',
    inputSchema: SearchSchema,
    execute: async ({ query, limit }: z.infer<typeof SearchSchema>) => {
      const fts = toFtsQuery(query);
      if (!fts) return { ok: true as const, results: [] };

      type FtsRow = { path: string; title: string; snippet: string };
      const rows = getDb()
        .query<FtsRow, [string, string, number]>(
          `SELECT n.path, n.title,
                  snippet(notes_fts, 2, '', '', '…', 20) AS snippet
             FROM notes_fts
             JOIN notes n ON n.path = notes_fts.path AND n.group_id = ?
             WHERE notes_fts MATCH ?
             ORDER BY notes_fts.rank
             LIMIT ?`,
        )
        .all(ctx.groupId, fts, limit ?? 10);

      return { ok: true as const, results: rows };
    },
  });
}

// ── entity_create ─────────────────────────────────────────────────────

function entityCreate(ctx: ToolContext) {
  return tool({
    description:
      'Create a new structured entity. Path is auto-assigned — never guess a path.',
    inputSchema: CreateSchema,
    execute: async ({ kind, name, campaignSlug, sheet, dmOnly }: z.infer<typeof CreateSchema>) => {
      const slug = campaignSlug ?? ctx.campaignSlug;
      const folder = canonicalFolder({ kind: kind as EntityKind, campaignSlug: slug });
      const path = `${folder}/${nameToSlug(name)}.md`;

      const db = getDb();
      const existing = db
        .query<{ n: number }, [string, string]>(
          'SELECT COUNT(*) AS n FROM notes WHERE group_id = ? AND path = ?',
        )
        .get(ctx.groupId, path);
      if ((existing?.n ?? 0) > 0) {
        return { ok: false as const, error: `Already exists at ${path}` };
      }

      const frontmatter = buildFrontmatter(kind as EntityKind, name, sheet ?? {}, ctx.userId);
      const fmKind = typeof frontmatter.kind === 'string' ? frontmatter.kind : undefined;
      const vr = validateSheet(fmKind, frontmatter.sheet);
      if (!vr.ok) {
        return {
          ok: false as const,
          error: `invalid_sheet for kind ${fmKind}`,
          issues: vr.issues,
        };
      }
      if (frontmatter.sheet && typeof frontmatter.sheet === 'object') {
        frontmatter.sheet = vr.data as Record<string, unknown>;
      }
      const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] };
      const ydoc = prosemirrorJSONToYDoc(getPmSchema(), emptyDoc, 'default');
      ydoc.getText('title').insert(0, name);
      const state = Y.encodeStateAsUpdate(ydoc);

      db.query(
        `INSERT INTO notes
           (id, group_id, path, title, content_json, content_text, content_md,
            yjs_state, frontmatter_json, byte_size, updated_at, updated_by,
            created_at, created_by, dm_only)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(), ctx.groupId, path, name,
        JSON.stringify(emptyDoc), '', '', state,
        JSON.stringify(frontmatter), 0,
        Date.now(), ctx.userId, Date.now(), ctx.userId,
        dmOnly ? 1 : 0,
      );

      try {
        deriveAllIndexes({
          groupId: ctx.groupId, notePath: path,
          frontmatterJson: JSON.stringify(frontmatter),
        });
      } catch (err) {
        console.error('[ai/tools] derive failed after entity_create:', err);
      }

      return { ok: true as const, path };
    },
  });
}

// ── entity_edit_sheet ─────────────────────────────────────────────────

function entityEditSheet(ctx: ToolContext) {
  return tool({
    description: 'Update structured frontmatter fields on an existing entity.',
    inputSchema: EditSheetSchema,
    execute: async ({ path, updates }: z.infer<typeof EditSheetSchema>) => {
      const note = loadNote(ctx.groupId, path);
      if (!note) return { ok: false as const, error: `Not found: ${path}` };

      let fm: Record<string, unknown>;
      try { fm = JSON.parse(note.frontmatter_json) as Record<string, unknown>; }
      catch { fm = {}; }

      const sheet =
        fm.sheet && typeof fm.sheet === 'object'
          ? { ...(fm.sheet as Record<string, unknown>) }
          : {};

      for (const [k, v] of Object.entries(updates)) {
        if (v === null) delete sheet[k];
        else sheet[k] = v;
      }

      const fmKind = typeof fm.kind === 'string' ? fm.kind : undefined;
      const vr = validateSheet(fmKind, sheet);
      if (!vr.ok) {
        return {
          ok: false as const,
          error: `invalid_sheet for kind ${fmKind}`,
          issues: vr.issues,
        };
      }
      const nextSheet = vr.data as Record<string, unknown>;
      const nextFm = { ...fm, sheet: nextSheet };
      getDb()
        .query(`UPDATE notes SET frontmatter_json=?, updated_at=?, updated_by=? WHERE group_id=? AND path=?`)
        .run(JSON.stringify(nextFm), Date.now(), ctx.userId, ctx.groupId, path);

      try {
        deriveAllIndexes({
          groupId: ctx.groupId, notePath: path,
          frontmatterJson: JSON.stringify(nextFm),
        });
      } catch (err) {
        console.error('[ai/tools] derive failed after entity_edit_sheet:', err);
      }

      return { ok: true as const, sheet: nextSheet };
    },
  });
}

// ── entity_edit_content ───────────────────────────────────────────────

function entityEditContent(ctx: ToolContext) {
  return tool({
    description: 'Append prose content to a note body. Never overwrites existing content.',
    inputSchema: EditContentSchema,
    execute: async ({ path, content, heading }: z.infer<typeof EditContentSchema>) => {
      const note = loadNote(ctx.groupId, path);
      if (!note) return { ok: false as const, error: `Not found: ${path}` };

      let doc: PmDoc;
      try { doc = JSON.parse(note.content_json) as PmDoc; }
      catch { doc = { type: 'doc', content: [] }; }

      const newNodes: PmNode[] = [];
      if (heading) {
        newNodes.push({
          type: 'heading', attrs: { level: 3 },
          content: [{ type: 'text', text: heading }],
        });
      }
      for (const para of content.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
        newNodes.push({ type: 'paragraph', content: [{ type: 'text', text: para }] });
      }

      const nextDoc: PmDoc = { ...doc, content: [...(doc.content ?? []), ...newNodes] };
      const headingMd = heading ? `### ${heading}\n\n` : '';
      const nextMd = (note.content_md ?? '').trimEnd() +
        (note.content_md?.trim() ? '\n\n' : '') + headingMd + content.trim();

      getDb()
        .query(
          `UPDATE notes SET content_json=?, content_text=?, content_md=?,
                            yjs_state=NULL, updated_at=?, updated_by=?
           WHERE group_id=? AND path=?`,
        )
        .run(
          JSON.stringify(nextDoc), extractText(nextDoc), nextMd,
          Date.now(), ctx.userId, ctx.groupId, path,
        );

      return { ok: true as const };
    },
  });
}

// ── entity_move ───────────────────────────────────────────────────────

function entityMove(ctx: ToolContext) {
  return tool({
    description: 'Move or rename a note to a new path.',
    inputSchema: MoveSchema,
    execute: async ({ from, to }: z.infer<typeof MoveSchema>) => {
      if (from === to) return { ok: true as const };
      const db = getDb();
      if (!loadNote(ctx.groupId, from)) return { ok: false as const, error: `Not found: ${from}` };
      const conflict = db
        .query<{ n: number }, [string, string]>('SELECT COUNT(*) AS n FROM notes WHERE group_id=? AND path=?')
        .get(ctx.groupId, to);
      if ((conflict?.n ?? 0) > 0) return { ok: false as const, error: `Path exists: ${to}` };

      db.transaction(() => {
        db.query(`UPDATE notes SET path=?, updated_at=?, updated_by=? WHERE group_id=? AND path=?`)
          .run(to, Date.now(), ctx.userId, ctx.groupId, from);
        for (const tbl of ['note_links', 'tags', 'aliases', 'characters', 'character_campaigns', 'session_notes']) {
          const col = tbl === 'note_links' ? 'from_path' : tbl === 'characters' || tbl === 'character_campaigns' || tbl === 'session_notes' ? 'note_path' : 'path';
          db.query(`UPDATE ${tbl} SET ${col}=? WHERE group_id=? AND ${col}=?`).run(to, ctx.groupId, from);
        }
        db.query(`UPDATE note_links SET to_path=? WHERE group_id=? AND to_path=?`).run(to, ctx.groupId, from);
      })();

      return { ok: true as const };
    },
  });
}

// ── backlink_create ───────────────────────────────────────────────────

function backlinkCreate(ctx: ToolContext) {
  return tool({
    description: 'Ensure a [[wikilink]] exists from one note to another.',
    inputSchema: BacklinkSchema,
    execute: async ({ fromPath, toPath, label }: z.infer<typeof BacklinkSchema>) => {
      const note = loadNote(ctx.groupId, fromPath);
      if (!note) return { ok: false as const, error: `Not found: ${fromPath}` };

      const targetBase = toPath.replace(/\.md$/i, '').split('/').pop() ?? toPath;
      if (note.content_md.includes(`[[${targetBase}`)) return { ok: true as const };

      const linkText = label ? `[[${targetBase}|${label}]]` : `[[${targetBase}]]`;
      const nextMd = (note.content_md ?? '').trimEnd() +
        (note.content_md?.trim() ? '\n\n' : '') + linkText;

      let doc: PmDoc;
      try { doc = JSON.parse(note.content_json) as PmDoc; }
      catch { doc = { type: 'doc', content: [] }; }

      const wikilinkNode: PmNode = {
        type: 'paragraph',
        content: [{ type: 'wikilink', attrs: { target: targetBase, label: label ?? null, orphan: false } }],
      };
      const nextDoc: PmDoc = { ...doc, content: [...(doc.content ?? []), wikilinkNode] };

      getDb().transaction(() => {
        getDb()
          .query(
            `UPDATE notes SET content_md=?, content_json=?, content_text=?,
                              yjs_state=NULL, updated_at=?, updated_by=?
             WHERE group_id=? AND path=?`,
          )
          .run(nextMd, JSON.stringify(nextDoc), extractText(nextDoc),
               Date.now(), ctx.userId, ctx.groupId, fromPath);
        getDb()
          .query(`INSERT OR IGNORE INTO note_links (group_id, from_path, to_path) VALUES (?,?,?)`)
          .run(ctx.groupId, fromPath, toPath);
      })();

      return { ok: true as const };
    },
  });
}

// ── inventory_add ─────────────────────────────────────────────────────

function inventoryAdd(ctx: ToolContext) {
  return tool({
    description: "Add an item to a character's inventory.",
    inputSchema: InventorySchema,
    execute: async ({ characterPath, itemPath, freeformName, quantity }: z.infer<typeof InventorySchema>) => {
      if (!itemPath && !freeformName) {
        return { ok: false as const, error: 'Provide either itemPath or freeformName' };
      }
      const note = loadNote(ctx.groupId, characterPath);
      if (!note) return { ok: false as const, error: `Not found: ${characterPath}` };

      let fm: Record<string, unknown>;
      try { fm = JSON.parse(note.frontmatter_json) as Record<string, unknown>; }
      catch { fm = {}; }

      const sheet =
        fm.sheet && typeof fm.sheet === 'object'
          ? { ...(fm.sheet as Record<string, unknown>) }
          : {};
      const items: string[] = Array.isArray(sheet.items) ? [...(sheet.items as string[])] : [];
      const qSuffix = (quantity ?? 1) > 1 ? ` ×${quantity}` : '';
      items.push(
        itemPath
          ? `[[${itemPath.replace(/\.md$/i, '').split('/').pop()}]]${qSuffix}`
          : `${freeformName}${qSuffix}`,
      );
      const nextFm = { ...fm, sheet: { ...sheet, items } };

      getDb()
        .query(`UPDATE notes SET frontmatter_json=?, updated_at=?, updated_by=? WHERE group_id=? AND path=?`)
        .run(JSON.stringify(nextFm), Date.now(), ctx.userId, ctx.groupId, characterPath);

      try {
        deriveAllIndexes({
          groupId: ctx.groupId, notePath: characterPath,
          frontmatterJson: JSON.stringify(nextFm),
        });
      } catch (err) {
        console.error('[ai/tools] derive failed after inventory_add:', err);
      }

      return { ok: true as const };
    },
  });
}

// ── session_close ─────────────────────────────────────────────────────

function sessionClose(ctx: ToolContext) {
  return tool({
    description:
      'Analyse a session and produce proposed changes for DM review. Does NOT commit — always requires session_apply.',
    inputSchema: SessionCloseSchema,
    execute: async ({ sessionPath }: z.infer<typeof SessionCloseSchema>) => {
      if (ctx.role !== 'dm') return { ok: false as const, error: 'DM only' };

      const note = loadNote(ctx.groupId, sessionPath);
      if (!note) return { ok: false as const, error: `Not found: ${sessionPath}` };

      const row = getDb()
        .query<{ status: string }, [string, string]>(
          `SELECT status FROM session_notes WHERE group_id=? AND note_path=?`,
        )
        .get(ctx.groupId, sessionPath);

      if (row?.status === 'closed') {
        return { ok: false as const, error: 'Session already closed.' };
      }

      const proposal: SessionProposal = {
        sessionPath, extractedAt: Date.now(),
        characterUpdates: [], inventoryChanges: [], newBacklinks: [],
        note: 'Review proposed changes and call session_apply to commit.',
      };

      getDb()
        .query(`UPDATE session_notes SET status='review', dm_review_json=? WHERE group_id=? AND note_path=?`)
        .run(JSON.stringify(proposal), ctx.groupId, sessionPath);

      return { ok: true as const, proposal };
    },
  });
}

// ── session_apply ─────────────────────────────────────────────────────

function sessionApply(ctx: ToolContext) {
  return tool({
    description: 'Commit DM-approved session changes after review.',
    inputSchema: SessionApplySchema,
    execute: async ({ sessionPath, approvedChanges }: z.infer<typeof SessionApplySchema>) => {
      if (ctx.role !== 'dm') return { ok: false as const, error: 'DM only' };

      const db = getDb();
      const row = db
        .query<{ status: string; dm_review_json: string | null }, [string, string]>(
          `SELECT status, dm_review_json FROM session_notes WHERE group_id=? AND note_path=?`,
        )
        .get(ctx.groupId, sessionPath);

      if (!row) return { ok: false as const, error: `Not found: ${sessionPath}` };
      if (row.status !== 'review') return { ok: false as const, error: 'Must be in review status' };

      const approved = new Set(approvedChanges.filter((c) => c.approved).map((c) => c.id));
      let applied = 0;
      let proposal: SessionProposal | null = null;
      try { proposal = JSON.parse(row.dm_review_json ?? '{}') as SessionProposal; }
      catch { /* empty proposal */ }

      db.transaction(() => {
        if (proposal) {
          for (const cu of proposal.characterUpdates) {
            if (!approved.has(cu.id)) continue;
            const n = loadNote(ctx.groupId, cu.path);
            if (!n) continue;
            let fm: Record<string, unknown>;
            try { fm = JSON.parse(n.frontmatter_json) as Record<string, unknown>; }
            catch { continue; }
            const s = fm.sheet && typeof fm.sheet === 'object' ? { ...(fm.sheet as Record<string, unknown>) } : {};
            s[cu.field] = cu.to;
            db.query(`UPDATE notes SET frontmatter_json=?, updated_at=?, updated_by=? WHERE group_id=? AND path=?`)
              .run(JSON.stringify({ ...fm, sheet: s }), Date.now(), ctx.userId, ctx.groupId, cu.path);
            applied++;
          }
          for (const bl of proposal.newBacklinks) {
            if (!approved.has(bl.id)) continue;
            db.query(`INSERT OR IGNORE INTO note_links (group_id, from_path, to_path) VALUES (?,?,?)`)
              .run(ctx.groupId, bl.from, bl.to);
            applied++;
          }
        }
        db.query(`UPDATE session_notes SET status='closed', closed_at=?, closed_by=? WHERE group_id=? AND note_path=?`)
          .run(Date.now(), ctx.userId, ctx.groupId, sessionPath);
      })();

      return { ok: true as const, applied };
    },
  });
}

// ── ProseMirror helpers ────────────────────────────────────────────────

type PmNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PmNode[];
  text?: string;
};

type PmDoc = { type: 'doc'; content: PmNode[] };

function extractText(doc: PmDoc): string {
  const parts: string[] = [];
  function walk(node: PmNode): void {
    if (node.text) parts.push(node.text);
    for (const child of node.content ?? []) walk(child);
  }
  for (const child of doc.content) walk(child);
  return parts.join(' ').trim();
}

// ── Types ─────────────────────────────────────────────────────────────

type SessionProposal = {
  sessionPath: string;
  extractedAt: number;
  note: string;
  characterUpdates: Array<{ id: string; path: string; field: string; from: unknown; to: unknown }>;
  inventoryChanges: Array<{ id: string; characterPath: string; action: 'add' | 'remove'; item: string }>;
  newBacklinks: Array<{ id: string; from: string; to: string }>;
};

// ── Frontmatter builder ────────────────────────────────────────────────

function normalizeKind(kind: EntityKind): EntityKind {
  // Collapse legacy aliases onto the canonical set. Old tool calls
  // from saved transcripts still use pc/npc/ally/villain/monster; new
  // calls use character/person/creature.
  if (kind === 'pc') return 'character';
  if (kind === 'npc' || kind === 'ally') return 'person';
  if (kind === 'villain') return 'creature';
  if (kind === 'monster') return 'creature';
  return kind;
}

function buildFrontmatter(
  kind: EntityKind,
  name: string,
  extraSheet: Record<string, unknown>,
  username: string,
): Record<string, unknown> {
  const canonical = normalizeKind(kind);
  const templated: EntityKind[] = [
    'character', 'person', 'creature', 'item', 'location', 'session',
  ];
  if (!templated.includes(canonical)) return {};

  const template = getTemplate(canonical as TemplateKind);
  const sheet: Record<string, unknown> = { name, ...extraSheet };
  if (template) {
    for (const section of template.schema.sections) {
      for (const field of section.fields) {
        if (field.id !== 'name' && !(field.id in sheet) && field.default !== undefined) {
          sheet[field.id] = field.default;
        }
      }
    }
  }

  const fm: Record<string, unknown> = { kind: canonical, template: canonical, sheet };
  if (canonical === 'character') fm.player = username;
  return fm;
}
