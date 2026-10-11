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
import { getDb } from '@/lib/db';
import { worldFtsMatch } from '@/lib/search';
import { loadNote, isAllowedPath } from '@/lib/notes';
import { captureServer } from '@/lib/analytics/capture';
import { EVENTS } from '@/lib/analytics/events';
import { getCampaignBySlug, listCampaigns } from '@/lib/characters';
import { canonicalFolder, nameToSlug } from '@/lib/ai/paths';
import { canonicalKind, KIND_INPUTS, NOTE_KINDS, type NoteKind } from '@compendium/shared';
import { getTemplate, type TemplateKind } from '@/lib/templates';
import { deriveAllIndexes } from '@/lib/derive-indexes';
import {
  deriveFolderIndex,
  deriveFolderIndexesFor,
  parentFolderUnderCampaign,
} from '@/lib/campaign-index';
import { validateSheet } from '@/lib/validateSheet';
import { signalSheetChanged } from '@/collab/server';
import { parseCharacter } from '@/lib/character-parser';
import { writeNote } from '@/lib/import-apply';
import { applyNoteEdit, type PmDoc } from '@/lib/note-edits';
import { repointSuggestionPaths } from '@/lib/suggestion-paths';
import { repointRelations } from '@/lib/relations';
import type { PmNode } from '@/lib/md-to-pm';

// ── Context ────────────────────────────────────────────────────────────

export type ToolContext = {
  groupId: string;
  userId: string;
  role: 'dm' | 'player' | 'viewer';
  // The REAL session role, uncollapsed. `role` above folds both
  // 'admin' and 'editor' into 'dm' for the many places that only care
  // about GM-vs-player — but `gm_only` visibility is stricter than
  // that fold: only 'admin' may see gm_only content (mirrors
  // collab/server.ts#isNoteGmOnly and lib/notes.ts#visibilityFor).
  // Every tool that reads or writes a note by path must gate on THIS
  // field for gm_only, not on `role`.
  sessionRole: 'admin' | 'editor' | 'viewer';
  campaignSlug?: string | undefined;
  // Whether this chat turn is running in the GM namespace (mirrors the
  // UI's GM-mode toggle — see lib/gm-mode.ts#isGmModeOn). Selects which
  // gm_only partition entity_search reads from; it does not grant
  // access to the other partition.
  gmNamespace: boolean;
};

/** True when a gm_only note must be hidden from this caller. Mirrors
 *  `collab/server.ts#isNoteGmOnly`'s consumer exactly: gm_only content
 *  is visible ONLY to session role 'admin' — an 'editor' (whose
 *  collapsed `ctx.role` reads 'dm' for every other purpose) must not
 *  see it. Callers should treat a `true` result the same way they treat
 *  a missing note (return the tool's normal not-found error), never a
 *  distinct "access denied" — a hidden note must be indistinguishable
 *  from one that doesn't exist, matching every direct read path. */
function isGmOnlyHiddenFrom(ctx: ToolContext, note: { gm_only: number }): boolean {
  return note.gm_only === 1 && ctx.sessionRole !== 'admin';
}

// ── Factory ────────────────────────────────────────────────────────────

export function createTools(ctx: ToolContext) {
  return {
    campaign_list:       campaignList(ctx),
    campaign_browse:     campaignBrowse(ctx),
    entity_search:       entitySearch(ctx),
    entity_create:       entityCreate(ctx),
    entity_edit_sheet:   entityEditSheet(ctx),
    entity_edit_content: entityEditContent(ctx),
    note_read:           noteRead(ctx),
    note_write_section:  noteWriteSection(ctx),
    entity_move:         entityMove(ctx),
    entity_change_kind:  entityChangeKind(ctx),
    backlink_create:     backlinkCreate(ctx),
    inventory_add:       inventoryAdd(ctx),
    session_finalize:    sessionFinalize(ctx),
  };
}

export function getToolsForRole(ctx: ToolContext) {
  const all = createTools(ctx);
  let filtered: Partial<typeof all>;
  if (ctx.role === 'dm') {
    filtered = all;
  } else if (ctx.role === 'player') {
    const { session_finalize: _sf, entity_move: _em, entity_change_kind: _eck, note_write_section: _nws, ...playerTools } = all;
    filtered = playerTools;
  } else {
    // viewer: read-only surface — no mutating tools at all.
    const {
      session_finalize: _sf,
      entity_move: _em,
      entity_change_kind: _eck,
      note_write_section: _nws,
      entity_create: _ec,
      entity_edit_sheet: _ees,
      entity_edit_content: _eec,
      backlink_create: _bc,
      inventory_add: _ia,
      ...readOnlyTools
    } = all;
    filtered = readOnlyTools;
  }
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

const CampaignBrowseSchema = z.object({
  campaignSlug: z.string().optional().describe(
    'Registered campaign slug. Defaults to the active campaign. Required if none is active.',
  ),
  kind: z.enum(NOTE_KINDS).optional().describe('Filter by canonical kind.'),
  subfolder: z.string().optional().describe(
    'Relative subfolder inside the campaign (e.g. "Sessions", "Characters"). Case-insensitive.',
  ),
  limit: z.number().int().positive().max(100).optional().default(50),
});

const SearchSchema = z.object({
  query: z.string().describe('Name or keywords to search'),
  limit: z.number().int().positive().max(20).optional().default(10),
});

const CreateSchema = z.object({
  kind: z.enum(KIND_INPUTS),
  name: z.string().min(1).max(200),
  campaignSlug: z
    .string()
    .optional()
    .describe(
      'Registered campaign slug (see campaign_list). Required for campaign-scoped kinds. Omit only for lore or for notes under World Lore.',
    ),
  sheet: z.record(z.unknown()).optional().describe('Frontmatter sheet fields to pre-fill'),
  body: z
    .string()
    .optional()
    .describe(
      'Optional initial markdown body for the note. For kind=character the body is auto-parsed for HP/AC/abilities/class/race tables and merged into the sheet (caller-supplied `sheet` fields win). Wikilinks, tags, and image embeds in the body are processed normally.',
    ),
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

const ChangeKindSchema = z.object({
  path: z.string().min(1).max(512).describe('Full path of the existing note'),
  newKind: z.enum(KIND_INPUTS).describe('Target entity kind. Legacy aliases (pc/npc/ally/villain/monster) are normalised.'),
  campaignSlug: z.string().optional().describe(
    'Move to a different campaign at the same time. Omit to keep the note in its current campaign (or world-level).',
  ),
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

const SessionFinalizeSchema = z.object({
  sessionPath: z.string().min(1).max(512),
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

// ── campaign_browse ──────────────────────────────────────────────────

function campaignBrowse(ctx: ToolContext) {
  return tool({
    description:
      'Enumerate notes under a campaign so you can pick what to read. ' +
      'Use this when the user asks for a recap, summary, connections, or any question ' +
      'that requires looking across many notes — not just one. Returns path, title, kind, ' +
      'a short excerpt, and updatedAt, ordered most-recent first. Follow up with note_read ' +
      'on the rows that look relevant. Filter by `kind` (e.g. "session" for recaps, ' +
      '"character"/"person" for who-is-who) or `subfolder` to narrow the result.',
    inputSchema: CampaignBrowseSchema,
    execute: async ({ campaignSlug, kind, subfolder, limit }: z.infer<typeof CampaignBrowseSchema>) => {
      const slugParam = (campaignSlug?.trim() ?? ctx.campaignSlug?.trim()) || undefined;
      if (!slugParam) {
        return {
          ok: false as const,
          error: 'campaign_required',
          message: 'Pass campaignSlug or set an active campaign. Call campaign_list to see options.',
        };
      }
      const camp = getCampaignBySlug(ctx.groupId, slugParam);
      if (!camp) {
        return {
          ok: false as const,
          error: 'unknown_campaign',
          message: `No registered campaign for slug "${slugParam}". Call campaign_list.`,
        };
      }

      const base = subfolder?.trim()
        ? `${camp.folderPath}/${subfolder.trim().replace(/^\/+|\/+$/g, '')}/`
        : `${camp.folderPath}/`;

      type Row = {
        path: string;
        title: string;
        frontmatter_json: string;
        content_text: string;
        updated_at: number;
        dm_only: number;
        gm_only: number;
      };
      const rows = getDb()
        .query<Row, [string, string, number]>(
          `SELECT path, title, frontmatter_json, content_text, updated_at, dm_only, gm_only
             FROM notes
            WHERE group_id = ? AND path LIKE ? || '%'
            ORDER BY updated_at DESC
            LIMIT ?`,
        )
        .all(ctx.groupId, base, Math.min(limit ?? 50, 100) * 2);

      const kindFilter = kind ?? null;

      const results = rows
        .filter((r) => ctx.role === 'dm' || r.dm_only === 0)
        .filter((r) => !isGmOnlyHiddenFrom(ctx, r))
        .map((r) => {
          let fmKind: string | undefined;
          try {
            const fm = JSON.parse(r.frontmatter_json) as { kind?: unknown };
            if (typeof fm.kind === 'string') fmKind = fm.kind;
          } catch { /* ignore */ }
          const text = (r.content_text ?? '').replace(/\s+/g, ' ').trim();
          return {
            path: r.path,
            title: r.title,
            kind: fmKind,
            excerpt: text.slice(0, 240),
            updatedAt: r.updated_at,
          };
        })
        .filter((r) => !kindFilter || r.kind === kindFilter)
        .slice(0, limit ?? 50);

      return {
        ok: true as const,
        campaign: { slug: camp.slug, name: camp.name, folderPath: camp.folderPath },
        count: results.length,
        results,
      };
    },
  });
}

// ── entity_search ─────────────────────────────────────────────────────

function entitySearch(ctx: ToolContext) {
  return tool({
    description:
      'Search for existing entities by name or keywords. Always call this before entity_create to prevent duplicates.',
    inputSchema: SearchSchema,
    execute: async ({ query, limit }: z.infer<typeof SearchSchema>) => {
      const match = worldFtsMatch(ctx.groupId, query);
      if (!match) return { ok: true as const, results: [] };

      type FtsRow = { path: string; title: string; snippet: string };
      const rows = getDb()
        .query<FtsRow, [string, string, number, number, number]>(
          // Visibility: dm_only rows are withheld from non-GM callers
          // (ctx.role === 'dm' ⟺ session role admin|editor). gm_only is
          // namespace *selection*, not an extra filter — mirrors
          // api/ui/search/route.ts: ctx.gmNamespace (set from
          // isGmModeOn(), which itself requires role === 'admin') picks
          // which partition (player vs GM) this search reads from, so
          // an admin in GM mode can find the gm_only notes they just
          // created. This only controls what entity_search can find —
          // it is not the authorization gate for gm_only content. That
          // gate now lives on every read/write tool via
          // `isGmOnlyHiddenFrom(ctx, note)` (see note_read,
          // entity_edit_sheet, entity_edit_content, note_write_section,
          // backlink_create, inventory_add, entity_move,
          // entity_change_kind, campaign_browse) — so a gm_only path
          // leaked to the model by any other means (e.g. a stale
          // transcript, a backlink target) is still refused there.
          `SELECT n.path, n.title,
                  snippet(notes_fts, 2, '', '', '…', 20) AS snippet
             FROM notes_fts
             JOIN notes n
               ON n.group_id = notes_fts.group_id AND n.path = notes_fts.path
             WHERE notes_fts MATCH ?
               AND notes_fts.group_id = ?
               AND (n.dm_only = 0 OR ? = 1)
               AND n.gm_only = ?
             ORDER BY notes_fts.rank
             LIMIT ?`,
        )
        .all(match, ctx.groupId, ctx.role === 'dm' ? 1 : 0, ctx.gmNamespace ? 1 : 0, limit ?? 10);

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
    execute: async ({ kind, name, campaignSlug, sheet, body, dmOnly }: z.infer<typeof CreateSchema>) => {
      const slugParam = (campaignSlug?.trim() ?? ctx.campaignSlug?.trim()) || undefined;
      const canonical = canonicalKind(kind);

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
        kind: canonical,
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

      // Build the seed frontmatter from the AI's structured input.
      const frontmatter = buildFrontmatter(canonical, name, sheet ?? {}, ctx.userId);

      // For characters with a body, run the structured-sheet extractor
      // over the prose so HP/AC/abilities/class/race in markdown tables
      // flow into `frontmatter.sheet` automatically. Caller-supplied
      // sheet fields win on conflict (the AI made a deliberate choice).
      let bodyToWrite = '';
      if (typeof body === 'string' && body.trim().length > 0) {
        if (canonical === 'character' || kind === 'character' || kind === 'pc') {
          const parsed = parseCharacter(body, {
            defaultPlayer:
              typeof frontmatter.player === 'string' ? frontmatter.player : ctx.userId,
          });
          const parsedSheet =
            (parsed.frontmatter.sheet as Record<string, unknown> | undefined) ?? {};
          const aiSheet =
            (frontmatter.sheet as Record<string, unknown> | undefined) ?? {};
          // Parsed-from-body fills blanks; AI explicitly-set fields win.
          frontmatter.sheet = { ...parsedSheet, ...aiSheet };
          // Surface portrait at the top level so transfer-character / derive
          // pick it up (they read fm.portrait, not fm.sheet.portrait).
          if (parsed.frontmatter.portrait && frontmatter.portrait == null) {
            frontmatter.portrait = parsed.frontmatter.portrait;
          }
          bodyToWrite = parsed.body;
        } else {
          bodyToWrite = body;
        }
      }

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

      // Persist via writeNote so md-to-pm, FTS triggers, note_links,
      // tags, derived indexes, and Yjs state all stay in lock-step
      // with every other write path. dm_only is set in a follow-up
      // UPDATE since writeNote doesn't take it.
      try {
        writeNote({
          groupId: ctx.groupId,
          userId: ctx.userId,
          path,
          markdown: bodyToWrite,
          frontmatter,
          isUpdate: false,
        });
      } catch (err) {
        return {
          ok: false as const,
          error: 'write_failed',
          message: (err as Error).message,
        };
      }
      if (dmOnly) {
        db.query(
          'UPDATE notes SET dm_only = 1 WHERE group_id = ? AND path = ?',
        ).run(ctx.groupId, path);
      }

      const parent = parentFolderUnderCampaign(path);
      if (parent) {
        void deriveFolderIndex(ctx.groupId, parent, {
          userId: ctx.userId,
        }).catch((err) => {
          console.error('[ai/tools] folder index refresh failed:', err);
        });
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
      if (isGmOnlyHiddenFrom(ctx, note)) {
        return { ok: false as const, error: `Not found: ${path}` };
      }

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

      // Frontmatter isn't in the Y.Doc, so an open sheet header sees
      // nothing without this ping. Deliberately NOT a connection
      // close — this write cannot conflict with the live body doc, and
      // evicting would throw the player out of the editor mid-session.
      signalSheetChanged(ctx.groupId, path);

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
      const exists = loadNote(ctx.groupId, path);
      if (!exists) return { ok: false as const, error: `Not found: ${path}` };
      // Gate BEFORE the destructive drain below — a caller who cannot
      // even see this note must not be able to trigger an eviction of
      // its live editors as a side effect of a rejected request.
      if (isGmOnlyHiddenFrom(ctx, exists)) {
        return { ok: false as const, error: `Not found: ${path}` };
      }

      // applyNoteEdit drains live editors first and hands the edit the
      // post-drain body, so a flush that lands during the drain is
      // built on rather than clobbered (D4).
      const result = await applyNoteEdit({
        groupId: ctx.groupId,
        path,
        userId: ctx.userId,
        edit: (doc) => {
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
          return { status: 'changed', doc: { ...doc, content: [...(doc.content ?? []), ...newNodes] } };
        },
      });
      if (result.status === 'not_found') return { ok: false as const, error: `Not found: ${path}` };
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
      // GM only — mirrors note_write_section / session_finalize.
      // Guarding here (not just by omission from getToolsForRole)
      // matters because any caller that hand-picks from createTools()
      // rather than calling getToolsForRole() gets a real check instead
      // of relying on the filter.
      if (ctx.role !== 'dm') return { ok: false as const, error: 'GM only' };

      if (from === to) return { ok: true as const, path: from };
      const db = getDb();
      const fromNote = loadNote(ctx.groupId, from);
      if (!fromNote) return { ok: false as const, error: `Not found: ${from}` };
      if (isGmOnlyHiddenFrom(ctx, fromNote)) {
        return { ok: false as const, error: `Not found: ${from}` };
      }
      const conflict = db
        .query<{ n: number }, [string, string]>('SELECT COUNT(*) AS n FROM notes WHERE group_id=? AND path=?')
        .get(ctx.groupId, to);
      if ((conflict?.n ?? 0) > 0) return { ok: false as const, error: `Path exists: ${to}` };

      db.transaction(() => {
        // Derived-index tables hold FKs on notes(group_id, path) with no
        // ON UPDATE CASCADE; check them at COMMIT, after the rewrites below.
        db.exec('PRAGMA defer_foreign_keys = 1');
        db.query(`UPDATE notes SET path=?, updated_at=?, updated_by=? WHERE group_id=? AND path=?`)
          .run(to, Date.now(), ctx.userId, ctx.groupId, from);
        for (const tbl of ['note_links', 'tags', 'aliases', 'characters', 'character_campaigns', 'session_notes']) {
          const col = tbl === 'note_links' ? 'from_path' : tbl === 'characters' || tbl === 'character_campaigns' || tbl === 'session_notes' ? 'note_path' : 'path';
          db.query(`UPDATE ${tbl} SET ${col}=? WHERE group_id=? AND ${col}=?`).run(to, ctx.groupId, from);
        }
        db.query(`UPDATE note_links SET to_path=? WHERE group_id=? AND to_path=?`).run(to, ctx.groupId, from);
        repointSuggestionPaths(ctx.groupId, from, to);
        repointRelations(ctx.groupId, from, to);
      })();

      void deriveFolderIndexesFor(ctx.groupId, [from, to], {
        userId: ctx.userId,
      }).catch((err) => {
        console.error('[ai/tools] folder index refresh failed:', err);
      });

      return { ok: true as const, path: to };
    },
  });
}

// ── entity_change_kind ────────────────────────────────────────────────

function entityChangeKind(ctx: ToolContext) {
  return tool({
    description:
      'Change the entity type of an existing note (e.g. person → creature, npc → character). ' +
      'Updates frontmatter.kind AND moves the file to the canonical folder for the new kind ' +
      '(People → Creatures, etc.). All backlinks, character refs, and session refs are preserved. ' +
      'Pass campaignSlug to move it into a different campaign at the same time.',
    inputSchema: ChangeKindSchema,
    execute: async ({ path, newKind, campaignSlug: overrideSlug }: z.infer<typeof ChangeKindSchema>) => {
      // GM only — see entity_move for why this must be an inline check
      // rather than relying solely on getToolsForRole's filtering.
      if (ctx.role !== 'dm') return { ok: false as const, error: 'GM only' };

      const db = getDb();
      const note = loadNote(ctx.groupId, path);
      if (!note) return { ok: false as const, error: `Not found: ${path}` };
      if (isGmOnlyHiddenFrom(ctx, note)) {
        return { ok: false as const, error: `Not found: ${path}` };
      }

      const canonical = canonicalKind(newKind);

      // Determine target campaign: explicit override, then current campaign
      // by matching the note path against any registered campaign's
      // folder_path, then ctx.campaignSlug, then world-level.
      const campaigns = listCampaigns(ctx.groupId);
      const matched = campaigns
        .filter((c) => path.startsWith(c.folderPath + '/'))
        .sort((a, b) => b.folderPath.length - a.folderPath.length)[0];
      const targetSlug = overrideSlug ?? matched?.slug ?? ctx.campaignSlug;

      let campaignRoot: string | undefined;
      if (targetSlug) {
        const camp = getCampaignBySlug(ctx.groupId, targetSlug);
        if (!camp) {
          return {
            ok: false as const,
            error: 'unknown_campaign',
            message: `No registered campaign for slug "${targetSlug}". Call campaign_list.`,
          };
        }
        campaignRoot = camp.folderPath;
      }

      // Compute new path. Reuse the existing leaf slug so links to the
      // file by name still resolve.
      const leaf = path.split('/').pop()?.replace(/\.md$/i, '') ?? note.title;
      const folder = canonicalFolder({
        kind: canonical,
        ...(targetSlug    !== undefined ? { campaignSlug: targetSlug } : {}),
        ...(campaignRoot  !== undefined ? { campaignRoot }              : {}),
      });
      const newPath = `${folder}/${nameToSlug(leaf)}.md`;

      // Update kind in frontmatter (write either way — kind changed even
      // if path is unchanged).
      let fm: Record<string, unknown>;
      try { fm = JSON.parse(note.frontmatter_json) as Record<string, unknown>; }
      catch { fm = {}; }
      const nextFm = { ...fm, kind: canonical, template: canonical };

      if (newPath !== path) {
        const conflict = db
          .query<{ n: number }, [string, string]>('SELECT COUNT(*) AS n FROM notes WHERE group_id=? AND path=?')
          .get(ctx.groupId, newPath);
        if ((conflict?.n ?? 0) > 0) {
          return { ok: false as const, error: `Path exists: ${newPath}` };
        }
      }

      db.transaction(() => {
        if (newPath !== path) {
          db.exec('PRAGMA defer_foreign_keys = 1');
          db.query(`UPDATE notes SET path=?, frontmatter_json=?, updated_at=?, updated_by=? WHERE group_id=? AND path=?`)
            .run(newPath, JSON.stringify(nextFm), Date.now(), ctx.userId, ctx.groupId, path);
          for (const tbl of ['note_links', 'tags', 'aliases', 'characters', 'character_campaigns', 'session_notes']) {
            const col = tbl === 'note_links' ? 'from_path'
              : tbl === 'characters' || tbl === 'character_campaigns' || tbl === 'session_notes' ? 'note_path'
              : 'path';
            db.query(`UPDATE ${tbl} SET ${col}=? WHERE group_id=? AND ${col}=?`).run(newPath, ctx.groupId, path);
          }
          db.query(`UPDATE note_links SET to_path=? WHERE group_id=? AND to_path=?`).run(newPath, ctx.groupId, path);
          repointSuggestionPaths(ctx.groupId, path, newPath);
          repointRelations(ctx.groupId, path, newPath);
        } else {
          db.query(`UPDATE notes SET frontmatter_json=?, updated_at=?, updated_by=? WHERE group_id=? AND path=?`)
            .run(JSON.stringify(nextFm), Date.now(), ctx.userId, ctx.groupId, path);
        }
      })();

      try {
        deriveAllIndexes({
          groupId: ctx.groupId, notePath: newPath,
          frontmatterJson: JSON.stringify(nextFm),
        });
      } catch (err) {
        console.error('[ai/tools] derive failed after entity_change_kind:', err);
      }

      void deriveFolderIndexesFor(ctx.groupId, [path, newPath], {
        userId: ctx.userId,
      }).catch((err) => {
        console.error('[ai/tools] folder index refresh failed:', err);
      });

      return { ok: true as const, path: newPath, kind: canonical };
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
      const note0 = loadNote(ctx.groupId, fromPath);
      if (!note0) return { ok: false as const, error: `Not found: ${fromPath}` };
      // Gate BEFORE the pre-drain check / destructive drain below —
      // see entity_edit_content for why this must come first.
      if (isGmOnlyHiddenFrom(ctx, note0)) {
        return { ok: false as const, error: `Not found: ${fromPath}` };
      }

      // Cheap pre-drain check: if the link is already there, skip the
      // drain entirely rather than kicking editors for a no-op write.
      if (hasWikilinkTo(note0.content_json, toPath)) return { ok: true as const };

      // Re-checked post-drain: the flush that just landed may already
      // hold this link, and an unchanged edit evicts nobody (N7).
      const result = await applyNoteEdit({
        groupId: ctx.groupId,
        path: fromPath,
        userId: ctx.userId,
        edit: (doc, note) => {
          if (hasWikilinkTo(note.content_json, toPath)) return { status: 'unchanged' };
          const wikilinkNode: PmNode = {
            type: 'paragraph',
            content: [{ type: 'wikilink', attrs: { target: toPath, label: label ?? '', anchor: null, orphan: false } }],
          };
          return { status: 'changed', doc: { ...doc, content: [...(doc.content ?? []), wikilinkNode] } };
        },
      });
      if (result.status === 'not_found') return { ok: false as const, error: `Not found: ${fromPath}` };
      return { ok: true as const };
    },
  });
}

/** derive.ts persists a wikilink node's `target` verbatim as `to_path`,
 *  so "already linked" means a node targeting exactly that path. */
function hasWikilinkTo(contentJson: string, target: string): boolean {
  let doc: PmNode;
  try { doc = JSON.parse(contentJson) as PmNode; }
  catch { return false; }
  const walk = (n: PmNode): boolean =>
    (n.type === 'wikilink' && n.attrs?.target === target) || (n.content ?? []).some(walk);
  return walk(doc);
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
      if (isGmOnlyHiddenFrom(ctx, note)) {
        return { ok: false as const, error: `Not found: ${characterPath}` };
      }

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

      // See entity_edit_sheet — frontmatter-only write, no Y.Doc
      // conflict possible, so ping rather than evict.
      signalSheetChanged(ctx.groupId, characterPath);

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
      // Both visibility gates return the plain not-found shape so a
      // hidden note is indistinguishable from a missing one. gm_only is
      // stricter than dm_only: an 'editor' has ctx.role === 'dm' but
      // must not see it — see isGmOnlyHiddenFrom.
      if (!note || (note.dm_only === 1 && ctx.role !== 'dm') || isGmOnlyHiddenFrom(ctx, note)) {
        return { ok: false as const, error: `Not found: ${path}` };
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

      const exists = loadNote(ctx.groupId, path);
      if (!exists) return { ok: false as const, error: `Not found: ${path}` };
      // Gate BEFORE the destructive drain below — see
      // entity_edit_content for why this must come first.
      if (isGmOnlyHiddenFrom(ctx, exists)) {
        return { ok: false as const, error: `Not found: ${path}` };
      }

      // The splice runs against the post-drain body applyNoteEdit
      // hands over, never a pre-drain copy (D4).
      const result = await applyNoteEdit({
        groupId: ctx.groupId,
        path,
        userId: ctx.userId,
        edit: (_doc, note) => {
          const existingMd = (note.content_md ?? '').trim();
          if (!section) {
            if (existingMd) {
              return {
                status: 'rejected',
                reason:
                  'Note already has content. Call note_read first, then specify a `section` heading ' +
                  'to replace only that part. Use entity_edit_content to append.',
              };
            }
            return { status: 'changed', doc: markdownToDoc(content) };
          }
          const spliced = spliceSection(existingMd, section, content);
          if (!spliced.ok) return { status: 'rejected', reason: spliced.error };
          return { status: 'changed', doc: markdownToDoc(spliced.md) };
        },
      });
      if (result.status === 'not_found') return { ok: false as const, error: `Not found: ${path}` };
      if (result.status === 'rejected') return { ok: false as const, error: result.reason };
      return { ok: true as const };
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

/** Headings and plain paragraphs only; anything richer stays as
 *  paragraph text. */
function markdownToDoc(md: string): PmDoc {
  const newNodes: PmNode[] = [];
  for (const para of md.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
    const m = /^(#{1,6})\s+(.*)$/.exec(para);
    if (m) {
      newNodes.push({ type: 'heading', attrs: { level: m[1]!.length }, content: [{ type: 'text', text: m[2] ?? '' }] });
      continue;
    }
    newNodes.push({ type: 'paragraph', content: [{ type: 'text', text: para }] });
  }
  return { type: 'doc', content: newNodes.length ? newNodes : [{ type: 'paragraph' }] };
}

// ── session_finalize ──────────────────────────────────────────────────
// Terminal step after the model has distributed info (entity_create /
// entity_edit_sheet / inventory_add / backlink_create). Idempotent —
// calling it on an already-closed session is a no-op, not an error,
// so the End-of-Session button's pre-flight mark-closed doesn't trip
// the agent mid-chain.

function sessionFinalize(ctx: ToolContext) {
  return tool({
    description:
      'Mark a session note as closed after all distribution work is done. ' +
      'Call this LAST, only after creating/updating every extracted entity and adding backlinks. ' +
      'Idempotent — safe to call on already-closed sessions.',
    inputSchema: SessionFinalizeSchema,
    execute: async ({ sessionPath }: z.infer<typeof SessionFinalizeSchema>) => {
      if (ctx.role !== 'dm') return { ok: false as const, error: 'GM only' };

      const note = loadNote(ctx.groupId, sessionPath);
      if (!note) return { ok: false as const, error: `Not found: ${sessionPath}` };

      const now = Date.now();
      getDb()
        .query(
          `INSERT INTO session_notes (group_id, note_path, updated_at, status, closed_at, closed_by)
           VALUES (?, ?, ?, 'closed', ?, ?)
           ON CONFLICT (group_id, note_path)
           DO UPDATE SET status='closed', closed_at=excluded.closed_at, closed_by=excluded.closed_by`,
        )
        .run(ctx.groupId, sessionPath, now, now, ctx.userId);

      return { ok: true as const, sessionPath };
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

// ── Frontmatter builder ────────────────────────────────────────────────

function buildFrontmatter(
  canonical: NoteKind,
  name: string,
  extraSheet: Record<string, unknown>,
  username: string,
): Record<string, unknown> {
  const templated: NoteKind[] = [
    'character', 'person', 'creature', 'item', 'location', 'session',
  ];
  if (canonical === 'quest') return { kind: 'quest' };
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
