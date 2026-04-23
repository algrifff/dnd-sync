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
import { loadNote, isAllowedPath } from '@/lib/notes';
import { captureServer } from '@/lib/analytics/capture';
import { EVENTS } from '@/lib/analytics/events';
import { getCampaignBySlug, listCampaigns } from '@/lib/characters';
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
    campaign_list:       campaignList(ctx),
    entity_search:       entitySearch(ctx),
    entity_create:       entityCreate(ctx),
    entity_edit_sheet:   entityEditSheet(ctx),
    entity_edit_content: entityEditContent(ctx),
    note_read:           noteRead(ctx),
    note_write_section:  noteWriteSection(ctx),
    entity_move:         entityMove(ctx),
    backlink_create:     backlinkCreate(ctx),
    inventory_add:       inventoryAdd(ctx),
    session_close:       sessionClose(ctx),
    session_apply:       sessionApply(ctx),
  };
}

export function getToolsForRole(ctx: ToolContext) {
  const all = createTools(ctx);
  const filtered = ctx.role === 'dm'
    ? all
    : (() => {
        const { session_close: _sc, session_apply: _sa, entity_move: _em, note_write_section: _nws, ...playerTools } = all;
        return playerTools;
      })();
  return wrapToolsWithTelemetry(ctx, filtered);
}

/** Wrap each tool's `execute` to fire a `chat_tool_called` event. Keeps
 *  tool bodies clean while giving PostHog a per-step record. The
 *  wrapper preserves the original return value verbatim — it only
 *  observes. */
function wrapToolsWithTelemetry<T extends Record<string, unknown>>(
  ctx: ToolContext,
  tools: T,
): T {
  const wrapped = {} as Record<string, unknown>;
  for (const [name, original] of Object.entries(tools)) {
    if (
      !original ||
      typeof original !== 'object' ||
      typeof (original as { execute?: unknown }).execute !== 'function'
    ) {
      wrapped[name] = original;
      continue;
    }
    const originalExecute = (original as { execute: (args: unknown, opts: unknown) => unknown })
      .execute.bind(original);
    wrapped[name] = {
      ...original,
      execute: async (args: unknown, opts: unknown): Promise<unknown> => {
        const startedAt = Date.now();
        let ok = true;
        let errorMessage: string | undefined;
        try {
          const result = await originalExecute(args, opts);
          if (result && typeof result === 'object' && 'ok' in result && (result as { ok: unknown }).ok === false) {
            ok = false;
            const errField = (result as { error?: unknown }).error;
            errorMessage = typeof errField === 'string' ? errField : 'tool_returned_error';
          }
          return result;
        } catch (err) {
          ok = false;
          errorMessage = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
          throw err;
        } finally {
          void captureServer({
            userId: ctx.userId,
            groupId: ctx.groupId,
            event: EVENTS.CHAT_TOOL_CALLED,
            properties: {
              tool_name: name,
              role: ctx.role,
              duration_ms: Date.now() - startedAt,
              ok,
              ...(errorMessage ? { error: errorMessage } : {}),
            },
          });
        }
      },
    };
  }
  return wrapped as T;
}

// ── Schemas ────────────────────────────────────────────────────────────

const CampaignListSchema = z.object({});

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
  campaignSlug: z
    .string()
    .optional()
    .describe(
      'Registered campaign slug (see campaign_list). Required for campaign-scoped kinds. Omit only for lore or for notes under World Lore.',
    ),
  sheet: z.record(z.unknown()).optional().describe('Frontmatter sheet fields to pre-fill'),
  dmOnly: z.boolean().optional().default(false),
});

const EditSheetSchema = z.object({
  path: z.string().min(1).max(512).describe('Full note path'),
  updates: z
    .record(z.unknown())
    .describe(
      'Field key→value pairs to merge into the sheet. Values may be strings, numbers, booleans, arrays, nested objects, or null to delete a field.',
    ),
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

const NoteReadSchema = z.object({
  path: z.string().min(1).max(512).describe('Full note path to read'),
});

const NoteWriteSectionSchema = z.object({
  path: z.string().min(1).max(512).describe('Full note path'),
  section: z.string().optional().describe(
    'Heading text of the section to replace (e.g. "Combat Notes"). ' +
    'If omitted the note must be empty — otherwise the tool refuses to avoid losing existing content.',
  ),
  content: z.string().describe('Markdown content for this section (without the heading line)'),
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

// ── campaign_list ────────────────────────────────────────────────────

function campaignList(ctx: ToolContext) {
  return tool({
    description:
      'List campaigns registered for this world. Call before entity_create when no campaign is selected — entity_create only accepts slugs from this list and cannot create new campaign folders.',
    inputSchema: CampaignListSchema,
    execute: async (_input: z.infer<typeof CampaignListSchema>) => {
      const campaigns = listCampaigns(ctx.groupId);
      return {
        ok: true as const,
        campaigns: campaigns.map((c) => ({
          slug: c.slug,
          name: c.name,
          folderPath: c.folderPath,
        })),
        hint:
          campaigns.length === 0
            ? 'No campaigns yet — an admin must create a campaign folder from the file tree before the AI can add campaign notes.'
            : undefined,
      };
    },
  });
}

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
        .query<FtsRow, [string, string, string, number]>(
          // group_id moved into notes_fts in migration #33 — scope
          // MATCH per world directly so the FTS rank is correct and
          // we don't leak hits across tenants.
          `SELECT n.path, n.title,
                  snippet(notes_fts, 2, '', '', '…', 20) AS snippet
             FROM notes_fts
             JOIN notes n
               ON n.group_id = notes_fts.group_id AND n.path = notes_fts.path
             WHERE notes_fts MATCH ?
               AND notes_fts.group_id = ?
             ORDER BY notes_fts.rank
             LIMIT ?`,
        )
        .all(fts, ctx.groupId, ctx.groupId, limit ?? 10);

      return { ok: true as const, results: rows };
    },
  });
}

// ── entity_create ─────────────────────────────────────────────────────

function entityCreate(ctx: ToolContext) {
  return tool({
    description:
      'Create a new structured entity. Path is auto-assigned from kind + a registered campaign (see campaign_list). Cannot create new campaigns — slug must already exist.',
    inputSchema: CreateSchema,
    execute: async ({ kind, name, campaignSlug, sheet, dmOnly }: z.infer<typeof CreateSchema>) => {
      const slugParam = (campaignSlug?.trim() ?? ctx.campaignSlug?.trim()) || undefined;
      const k = kind as EntityKind;
      const canonical = normalizeKind(k);

      let campaignRoot: string | undefined;

      if (canonical === 'lore' || kind === 'lore') {
        /* world-level only */
      } else if (canonical === 'note' || kind === 'note') {
        if (slugParam) {
          const row = getCampaignBySlug(ctx.groupId, slugParam);
          if (!row) {
            return {
              ok: false as const,
              error: 'unknown_campaign',
              message:
                `No registered campaign for slug "${slugParam}". Call campaign_list — only existing campaigns may receive notes.`,
            };
          }
          campaignRoot = row.folderPath;
        }
      } else {
        if (!slugParam) {
          return {
            ok: false as const,
            error: 'campaign_required',
            message:
              'This kind must be created under a registered campaign. Pass campaignSlug or set the active campaign in the app, or call campaign_list and ask the user which slug to use.',
          };
        }
        const row = getCampaignBySlug(ctx.groupId, slugParam);
        if (!row) {
          return {
            ok: false as const,
            error: 'unknown_campaign',
            message:
              `No registered campaign for slug "${slugParam}". Call campaign_list and use an existing slug — new campaign folders cannot be created via this tool.`,
          };
        }
        campaignRoot = row.folderPath;
      }

      const folder = canonicalFolder({
        kind: k,
        campaignSlug: slugParam,
        campaignRoot,
      });
      const path = `${folder}/${nameToSlug(name)}.md`;

      // Defence in depth: canonicalFolder should already emit
      // structured paths, but refuse to write anything that would
      // violate the top-level or hidden-segment invariants.
      const allowed = isAllowedPath(path);
      if (!allowed.ok) {
        return { ok: false as const, error: 'invalid_path', message: allowed.reason };
      }

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

      void captureServer({
        userId: ctx.userId,
        groupId: ctx.groupId,
        event: EVENTS.NOTE_CREATED,
        properties: {
          kind: canonical ?? kind,
          path_depth: path.split('/').length,
          top_level: path.split('/')[0],
          via: 'ai',
          campaign_slug: slugParam ?? null,
        },
      });

      return { ok: true as const, path };
    },
  });
}

// ── entity_edit_sheet ─────────────────────────────────────────────────

function entityEditSheet(ctx: ToolContext) {
  return tool({
    description:
      'Update structured frontmatter fields on an existing entity. ' +
      'For character sheets you may pass either nested objects ' +
      '(ability_scores:{str,dex,con,int,wis,cha}, hit_points:{max,current,temporary}, ' +
      'armor_class:{value}, speed:{walk}, classes:[{ref:{name},level}]) ' +
      'OR flat legacy keys (str/dex/…, hp_max/hp_current, ac, speed as number, class+level) — ' +
      'both are accepted and automatically coerced.',
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

      // Coerce flat template-style keys → nested Zod-compatible shape before merging
      const fmKind = typeof fm.kind === 'string' ? fm.kind : undefined;
      const coerced = normaliseSheetUpdates(fmKind, updates as Record<string, unknown>, sheet);

      for (const [k, v] of Object.entries(coerced)) {
        if (v === null) delete sheet[k];
        else sheet[k] = v;
      }

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
      if (from === to) return { ok: true as const, path: from };
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

      return { ok: true as const, path: to };
    },
  });
}

// ── backlink_create ───────────────────────────────────────────────────

function backlinkCreate(ctx: ToolContext) {
  return tool({
    description: 'Ensure a [[wikilink]] exists from one note to another.',
    inputSchema: BacklinkSchema,
    execute: async ({ fromPath, toPath, label }: z.infer<typeof BacklinkSchema>) => {
      if (fromPath === toPath) {
        return { ok: false as const, error: 'Self-links are not allowed' };
      }
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

// ── note_read ─────────────────────────────────────────────────────────

function noteRead(ctx: ToolContext) {
  return tool({
    description:
      'Read the full content and frontmatter of a note. Use this to inspect a note before editing it, or to read session notes before extracting entities.',
    inputSchema: NoteReadSchema,
    execute: async ({ path }: z.infer<typeof NoteReadSchema>) => {
      const note = loadNote(ctx.groupId, path);
      if (!note) return { ok: false as const, error: `Not found: ${path}` };

      if (note.dm_only === 1 && ctx.role !== 'dm') {
        return { ok: false as const, error: 'Access denied: GM-only note' };
      }

      let frontmatter: Record<string, unknown> = {};
      try { frontmatter = JSON.parse(note.frontmatter_json) as Record<string, unknown>; }
      catch { /* ignore */ }

      return {
        ok: true as const,
        path,
        title: note.title,
        content: note.content_md,
        frontmatter,
      };
    },
  });
}

// ── note_write_section ───────────────────────────────────────────────

function noteWriteSection(ctx: ToolContext) {
  return tool({
    description:
      'Write or replace a named section in a note. GM only. ' +
      'Always call note_read first to see what already exists. ' +
      'If `section` is provided, only that heading block is replaced — all other content is preserved. ' +
      'If `section` is omitted the note must be empty; otherwise the tool refuses to protect existing content.',
    inputSchema: NoteWriteSectionSchema,
    execute: async ({ path, section, content }: z.infer<typeof NoteWriteSectionSchema>) => {
      if (ctx.role !== 'dm') return { ok: false as const, error: 'GM only' };

      const note = loadNote(ctx.groupId, path);
      if (!note) return { ok: false as const, error: `Not found: ${path}` };

      const existingMd = (note.content_md ?? '').trim();

      // No section target — only allow on empty notes
      if (!section) {
        if (existingMd) {
          return {
            ok: false as const,
            error:
              'Note already has content. Call note_read first, then specify a `section` heading ' +
              'to replace only that part. Use entity_edit_content to append.',
          };
        }
        return writeFullContent(ctx, path, content);
      }

      // Section-targeted write — splice the section in/out of existing markdown
      const spliced = spliceSection(existingMd, section, content);
      if (!spliced.ok) return { ok: false as const, error: spliced.error };
      return writeFullContent(ctx, path, spliced.md);
    },
  });
}

function spliceSection(
  existing: string,
  heading: string,
  newContent: string,
): { ok: true; md: string } | { ok: false; error: string } {
  const headingRe = new RegExp(
    `^(#{1,6})\\s+${escapeRegex(heading)}\\s*$`,
    'im',
  );
  const match = headingRe.exec(existing);

  if (!match) {
    return {
      ok: false,
      error:
        `Section "${heading}" not found in this note. ` +
        `Call note_read to see the actual headings, then target one of those. ` +
        `Use entity_edit_content to append new content without creating a section.`,
    };
  }

  const level = match[1]!.length;
  const start = match.index!;
  const afterHeading = existing.slice(start + match[0].length);
  const nextRe = new RegExp(`^#{1,${level}}\\s`, 'm');
  const nextMatch = nextRe.exec(afterHeading);

  const before = existing.slice(0, start);
  const after  = nextMatch ? afterHeading.slice(nextMatch.index) : '';
  const hashes = '#'.repeat(level);
  const spliced = `${before.trimEnd()}\n\n${hashes} ${heading}\n\n${newContent.trim()}`;
  return { ok: true, md: after ? `${spliced}\n\n${after.trimStart()}` : spliced };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function writeFullContent(
  ctx: ToolContext,
  path: string,
  md: string,
): { ok: true } {
  const newNodes: PmNode[] = [];
  for (const para of md.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
    if (/^#{1,6}\s/.test(para)) {
      const m = /^(#{1,6})\s+(.*)$/.exec(para);
      if (m) {
        newNodes.push({ type: 'heading', attrs: { level: m[1]!.length }, content: [{ type: 'text', text: m[2] ?? '' }] });
        continue;
      }
    }
    newNodes.push({ type: 'paragraph', content: [{ type: 'text', text: para }] });
  }

  const nextDoc: PmDoc = { type: 'doc', content: newNodes.length ? newNodes : [{ type: 'paragraph' }] };

  getDb()
    .query(
      `UPDATE notes SET content_json=?, content_text=?, content_md=?,
                        yjs_state=NULL, updated_at=?, updated_by=?
       WHERE group_id=? AND path=?`,
    )
    .run(JSON.stringify(nextDoc), extractText(nextDoc), md.trim(), Date.now(), ctx.userId, ctx.groupId, path);

  return { ok: true as const };
}

// ── session_close ─────────────────────────────────────────────────────

function sessionClose(ctx: ToolContext) {
  return tool({
    description:
      'Analyse a session and produce proposed changes for GM review. Does NOT commit — always requires session_apply.',
    inputSchema: SessionCloseSchema,
    execute: async ({ sessionPath }: z.infer<typeof SessionCloseSchema>) => {
      if (ctx.role !== 'dm') return { ok: false as const, error: 'GM only' };

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
    description: 'Commit GM-approved session changes after review.',
    inputSchema: SessionApplySchema,
    execute: async ({ sessionPath, approvedChanges }: z.infer<typeof SessionApplySchema>) => {
      if (ctx.role !== 'dm') return { ok: false as const, error: 'GM only' };

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
            if (bl.from === bl.to) continue; // no self-loops
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

// ── Sheet update normaliser ────────────────────────────────────────────
//
// Accepts flat template-style keys (str/dex/…, hp_max, ac, level, class)
// OR the correct nested Zod shape — merges both gracefully so the AI
// never needs to know which convention the model picked.

function normaliseSheetUpdates(
  kind: string | undefined,
  updates: Record<string, unknown>,
  existingSheet: Record<string, unknown>,
): Record<string, unknown> {
  const r = { ...updates };

  // ── 1. Flat ability scores → ability_scores block ─────────────────
  const ABILS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
  const flatAbils: Record<string, number> = {};
  let hasFlatAbils = false;
  for (const k of ABILS) {
    if (typeof r[k] === 'number') {
      flatAbils[k] = r[k] as number;
      delete r[k];
      hasFlatAbils = true;
    }
  }
  if (hasFlatAbils) {
    const existing = obj(existingSheet.ability_scores);
    const inbound  = obj(r.ability_scores);
    r.ability_scores = {
      str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10,
      ...existing, ...inbound, ...flatAbils,
    };
  }

  // ── 2. Flat HP keys → hit_points block ───────────────────────────
  if (typeof r.hp_max === 'number' || typeof r.hp_current === 'number' || typeof r.hp_temporary === 'number') {
    const existing = obj(existingSheet.hit_points);
    const inbound  = obj(r.hit_points);
    r.hit_points = {
      max: existing.max ?? 0,
      current: existing.current ?? 0,
      temporary: existing.temporary ?? 0,
      ...inbound,
      ...(typeof r.hp_max       === 'number' ? { max:       r.hp_max }       : {}),
      ...(typeof r.hp_current   === 'number' ? { current:   r.hp_current }   : {}),
      ...(typeof r.hp_temporary === 'number' ? { temporary: r.hp_temporary } : {}),
    };
    delete r.hp_max; delete r.hp_current; delete r.hp_temporary;
  }

  // ── 3. Flat ac → armor_class block ───────────────────────────────
  if (typeof r.ac === 'number') {
    const existing = obj(existingSheet.armor_class);
    const inbound  = obj(r.armor_class);
    r.armor_class = Object.assign({ value: 10 }, existing, inbound, { value: r.ac });
    delete r.ac;
  }

  // ── 4. Flat speed number → Speed object ──────────────────────────
  if (typeof r.speed === 'number') {
    r.speed = { walk: r.speed as number };
  }

  // ── 5. Character-only: flat class + level → classes array ─────────
  if (kind === 'character') {
    const flatClass =
      typeof r.class === 'string' && r.class.trim() ? r.class.trim() : null;
    const flatLevel =
      typeof r.level === 'number' && Number.isFinite(r.level as number)
        ? Math.trunc(r.level as number)
        : null;

    if (flatClass !== null || flatLevel !== null) {
      const existing = Array.isArray(existingSheet.classes)
        ? (existingSheet.classes as Array<Record<string, unknown>>)
        : [];
      const first = existing[0] as Record<string, unknown> | undefined;
      const existingRef = first?.ref && typeof first.ref === 'object'
        ? (first.ref as Record<string, unknown>)
        : null;

      const nextRef   = flatClass !== null ? { name: flatClass } : (existingRef ?? { name: 'Adventurer' });
      const nextLevel = flatLevel ?? (typeof first?.level === 'number' ? first.level : 1);
      r.classes = [{ ref: nextRef, level: nextLevel }, ...existing.slice(1)];
      if (flatClass  !== null) delete r.class;
      if (flatLevel  !== null) delete r.level;
    }

    // ── 6. classes items without ref wrapper → fix { name, level } ──
    if (Array.isArray(r.classes)) {
      r.classes = (r.classes as Array<unknown>).map((item) => {
        if (!item || typeof item !== 'object') return item;
        const c = item as Record<string, unknown>;
        if (c.ref && typeof c.ref === 'object') return c;
        if (typeof c.name === 'string') {
          const { name, level, ...rest } = c;
          return { ref: { name }, level: level ?? 1, ...rest };
        }
        return c;
      });
    }
  }

  return r;
}

/** Safely cast a value to a plain object (returns {} for non-objects). */
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
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

  if (canonical === 'character') {
    hydrateCharacterSheetFromTemplateDefaults(sheet);
  }

  const fm: Record<string, unknown> = { kind: canonical, template: canonical, sheet };
  if (canonical === 'character') fm.player = username;
  return fm;
}

/** Template defaults still seed legacy flat keys (`str`, `level`, `class`,
 *  `hp_max`). The sheet header + Zod shape expect nested objects — bridge
 *  them here so AI-created PCs render immediately. */
function hydrateCharacterSheetFromTemplateDefaults(sheet: Record<string, unknown>): void {
  const ab = sheet.ability_scores;
  const hasAbilityBlock =
    ab &&
    typeof ab === 'object' &&
    (['str', 'dex', 'con', 'int', 'wis', 'cha'] as const).some(
      (k) => typeof (ab as Record<string, unknown>)[k] === 'number',
    );
  if (!hasAbilityBlock) {
    const keys = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
    const scores: Partial<Record<(typeof keys)[number], number>> = {};
    let any = false;
    for (const k of keys) {
      const v = sheet[k];
      if (typeof v === 'number' && Number.isFinite(v)) {
        scores[k] = v;
        any = true;
      }
    }
    if (any) {
      sheet.ability_scores = {
        str: scores.str ?? 10,
        dex: scores.dex ?? 10,
        con: scores.con ?? 10,
        int: scores.int ?? 10,
        wis: scores.wis ?? 10,
        cha: scores.cha ?? 10,
      };
    }
  }

  const hasClasses = Array.isArray(sheet.classes) && sheet.classes.length > 0;
  if (!hasClasses) {
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
    hp &&
    typeof hp === 'object' &&
    typeof (hp as Record<string, unknown>).max === 'number';
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
    ac &&
    typeof ac === 'object' &&
    typeof (ac as Record<string, unknown>).value === 'number';
  if (!hasAcBlock && typeof sheet.ac === 'number' && Number.isFinite(sheet.ac)) {
    sheet.armor_class = { value: sheet.ac };
  }

  if (typeof sheet.speed === 'number' && Number.isFinite(sheet.speed)) {
    sheet.speed = { walk: sheet.speed };
  }
}
