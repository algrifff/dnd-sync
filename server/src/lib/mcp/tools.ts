// Read-only MCP tools over one world. Every tool runs with a context of
// (groupId, role) taken from the bearer token, and every read applies
// visibilityFor(role): a note the caller may not see is reported as
// missing and never appears in a list, a link, a backlink or a graph.
//
// The tools are a registry (name → definition) so the MCP server and
// the tests drive the same table, and adding a tool is one entry.

import { z } from 'zod';
import { getDb } from '../db';
import { listCampaigns } from '../characters';
import { buildNeighborhood } from '../graph';
import { loadBacklinks, loadNote, loadOutgoingLinks, visibilityFor, type NoteRow } from '../notes';
import { searchWorld, type NoteSearchResult } from '../search';
import { SNIPPET_MARK_CLOSE, SNIPPET_MARK_OPEN } from '../search-snippet';
import type { UserRole } from '../session';

export type McpContext = { groupId: string; role: UserRole };

export type ToolResult = { text: string; isError?: boolean };

export type ToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> = {
  name: string;
  title: string;
  description: string;
  input: Shape;
  // Method syntax on purpose: TypeScript checks method parameters
  // bivariantly, which is what lets a ToolDef<{ path: ZodString }> sit
  // in the ToolDef<ZodRawShape> registry below. runTool re-validates
  // args against `input` before calling, so the loosening is safe.
  run(ctx: McpContext, args: z.infer<z.ZodObject<Shape>>): ToolResult;
};

/** Hard ceiling on any single tool result, in characters. Claude's
 *  context is the scarce resource here, not our DB. */
export const MAX_RESULT_CHARS = 24_000;
const MAX_BODY_CHARS = 20_000;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;
// searchWorld never returns more than 12 title + 8 body hits.
const MAX_SEARCH = 20;

function define<Shape extends z.ZodRawShape>(def: ToolDef<Shape>): ToolDef<Shape> {
  return def;
}

function notFound(path: string): ToolResult {
  return { text: `Note not found: ${path}`, isError: true };
}

/** Cut an oversized result at a line boundary, keeping a trailing
 *  `next_cursor:` line so the caller can still page on. */
export function bounded(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  const cursor = text.match(/\n\nnext_cursor: [^\n]*$/)?.[0] ?? '';
  const room = MAX_RESULT_CHARS - cursor.length;
  const cut = text.lastIndexOf('\n', room);
  return text.slice(0, cut > 0 ? cut : room) + '\n\n[truncated]' + cursor;
}

function visibilitySql(role: UserRole, col = ''): string {
  const vis = visibilityFor(role);
  return (vis.hideDmOnly ? ` AND ${col}dm_only = 0` : '') + (vis.hideGmOnly ? ` AND ${col}gm_only = 0` : '');
}

function canSee(row: Pick<NoteRow, 'dm_only' | 'gm_only'>, role: UserRole): boolean {
  const vis = visibilityFor(role);
  if (vis.hideDmOnly && row.dm_only) return false;
  if (vis.hideGmOnly && row.gm_only) return false;
  return true;
}

/** Load a note the caller is allowed to see. Accepts the path with or
 *  without the `.md` suffix and tolerates a leading slash. */
function loadVisible(ctx: McpContext, rawPath: string): NoteRow | null {
  const path = rawPath.replace(/^\/+/, '');
  const candidates = path.endsWith('.md') || path.endsWith('.canvas') ? [path] : [path, `${path}.md`];
  for (const p of candidates) {
    const row = loadNote(ctx.groupId, p);
    if (row) return canSee(row, ctx.role) ? row : null;
  }
  return null;
}

function kindOf(frontmatterJson: string): string | null {
  try {
    const fm = JSON.parse(frontmatterJson) as { kind?: unknown };
    return typeof fm.kind === 'string' ? fm.kind : null;
  } catch {
    return null;
  }
}

const listCampaignsTool = define({
  name: 'list_campaigns',
  title: 'List campaigns',
  description:
    'List the campaigns in this world: each has a slug, a display name and a folder path under Campaigns/. ' +
    'Use the folder path with browse_notes to see what a campaign contains. Call this first when you do not ' +
    'know which campaign the user means.',
  input: {},
  run(ctx) {
    const rows = listCampaigns(ctx.groupId);
    if (rows.length === 0) return { text: 'This world has no campaigns yet.' };
    const lines = rows.map((c) => `- ${c.name} (slug: ${c.slug}) — folder: ${c.folderPath}`);
    return { text: bounded(`${rows.length} campaign(s):\n${lines.join('\n')}`) };
  },
});

const browseNotesTool = define({
  name: 'browse_notes',
  title: 'Browse notes',
  description:
    'List notes in this world, optionally restricted to a folder (for example a campaign folder from ' +
    'list_campaigns, or a subfolder such as "Campaigns/dragon-heist/Characters") and/or a kind ' +
    '(character, person, creature, item, location, session, lore, note). Returns path, title and kind, ' +
    'sorted by path and paginated: pass the returned next_cursor to get the next page. ' +
    'Use read_note with a path to read a note.',
  input: {
    folder: z.string().max(512).optional().describe('Folder path prefix, without a trailing slash. Omit for the whole world.'),
    kind: z.string().max(32).optional().describe('Only notes whose frontmatter kind equals this value.'),
    limit: z.number().int().min(1).max(MAX_PAGE).optional().describe(`Page size, default ${DEFAULT_PAGE}.`),
    cursor: z.string().max(512).optional().describe('next_cursor from the previous page.'),
  },
  run(ctx, args) {
    const limit = args.limit ?? DEFAULT_PAGE;
    const folder = args.folder?.replace(/^\/+|\/+$/g, '');
    const params: (string | number)[] = [ctx.groupId];
    let where = `group_id = ?${visibilitySql(ctx.role)}`;
    if (folder) {
      where += ' AND path LIKE ? ESCAPE \'\\\'';
      params.push(`${folder.replace(/[\\%_]/g, '\\$&')}/%`);
    }
    if (args.kind) {
      where += " AND lower(CASE WHEN json_valid(frontmatter_json) THEN json_extract(frontmatter_json, '$.kind') END) = lower(?)";
      params.push(args.kind);
    }
    if (args.cursor) {
      where += ' AND path > ?';
      params.push(args.cursor);
    }
    params.push(limit + 1);
    const rows = getDb()
      .query<{ path: string; title: string; frontmatter_json: string }, (string | number)[]>(
        `SELECT path, title, frontmatter_json FROM notes WHERE ${where} ORDER BY path LIMIT ?`,
      )
      .all(...params);
    const page = rows.slice(0, limit);
    if (page.length === 0) return { text: 'No notes match.' };
    const lines = page.map((r) => {
      const kind = kindOf(r.frontmatter_json);
      return `- ${r.path} — ${r.title || r.path}${kind ? ` [${kind}]` : ''}`;
    });
    const more = rows.length > limit ? `\n\nnext_cursor: ${page[page.length - 1]!.path}` : '';
    return { text: bounded(lines.join('\n') + more) };
  },
});

const searchNotesTool = define({
  name: 'search_notes',
  title: 'Search notes',
  description:
    'Full-text search over note titles and bodies in this world. Words are matched as prefixes and ' +
    'all must appear. Returns path, title, kind and a short snippet with the matching words in **bold**. ' +
    'Follow up with read_note for the full text.',
  input: {
    query: z.string().min(1).max(200).describe('Words to look for.'),
    limit: z.number().int().min(1).max(MAX_SEARCH).optional().describe('Maximum hits, default 20.'),
  },
  run(ctx, args) {
    const limit = args.limit ?? 20;
    const base = { q: args.query, groupId: ctx.groupId, role: ctx.role };
    const hits = searchWorld({ ...base, gmMode: false }).filter(isNoteHit);
    if (ctx.role === 'admin') hits.push(...searchWorld({ ...base, gmMode: true }).filter(isNoteHit));
    const page = hits.slice(0, limit);
    if (page.length === 0) return { text: `No notes match "${args.query}".` };
    const lines = page.map((h) => {
      const snippet = h.snippet
        ? ` — ${h.snippet.replaceAll(SNIPPET_MARK_OPEN, '**').replaceAll(SNIPPET_MARK_CLOSE, '**').replace(/\s+/g, ' ')}`
        : '';
      return `- ${h.path} — ${h.title}${h.noteKind ? ` [${h.noteKind}]` : ''}${snippet}`;
    });
    return { text: bounded(`${page.length} hit(s) for "${args.query}":\n${lines.join('\n')}`) };
  },
});

function isNoteHit(r: { kind: string }): r is NoteSearchResult {
  return r.kind === 'note';
}

const readNoteTool = define({
  name: 'read_note',
  title: 'Read a note',
  description:
    'Read one note by path: title, kind, frontmatter (character sheets, item stats and other structured ' +
    'fields live here), the Markdown body, the notes it links to and the notes that link to it. Paths come ' +
    'from browse_notes, search_notes or note_neighbors. Long bodies are truncated.',
  input: {
    path: z.string().min(1).max(512).describe('Note path, e.g. "Campaigns/dragon-heist/Characters/Aldric.md".'),
  },
  run(ctx, args) {
    const note = loadVisible(ctx, args.path);
    if (!note) return notFound(args.path);
    const vis = visibilityFor(ctx.role);
    const out = loadOutgoingLinks(ctx.groupId, note.path, vis);
    const back = loadBacklinks(ctx.groupId, note.path, vis);

    let frontmatter = '{}';
    try {
      frontmatter = JSON.stringify(JSON.parse(note.frontmatter_json), null, 2);
    } catch {
      frontmatter = note.frontmatter_json;
    }
    const body =
      note.content_md.length > MAX_BODY_CHARS
        ? note.content_md.slice(0, MAX_BODY_CHARS) + '\n\n[body truncated]'
        : note.content_md;
    const kind = kindOf(note.frontmatter_json);

    const sections = [
      `# ${note.title || note.path}`,
      `path: ${note.path}`,
      `kind: ${kind ?? 'note'}`,
      `updated: ${new Date(note.updated_at).toISOString()}`,
      frontmatter !== '{}' ? `## Frontmatter\n\`\`\`json\n${frontmatter}\n\`\`\`` : '',
      `## Body\n${body.trim() || '(empty)'}`,
      `## Links to\n${out.length ? out.map((l) => `- ${l.to_path} — ${l.title}`).join('\n') : '(none)'}`,
      `## Linked from\n${back.length ? back.map((l) => `- ${l.from_path} — ${l.title}`).join('\n') : '(none)'}`,
    ].filter(Boolean);
    return { text: bounded(sections.join('\n\n')) };
  },
});

const noteNeighborsTool = define({
  name: 'note_neighbors',
  title: 'Note neighbourhood',
  description:
    'The knowledge-graph neighbourhood of one note: every note within 1 or 2 link hops (in either ' +
    'direction) and the links among them. Use it to find related characters, places and sessions ' +
    'before reading them.',
  input: {
    path: z.string().min(1).max(512).describe('Path of the note at the centre.'),
    depth: z.number().int().min(1).max(2).optional().describe('1 (default) or 2 hops.'),
  },
  run(ctx, args) {
    const note = loadVisible(ctx, args.path);
    if (!note) return notFound(args.path);
    const graph = buildNeighborhood(ctx.groupId, note.path, args.depth ?? 1, {
      mode: note.gm_only ? 'gm' : 'player',
      hideDmOnly: visibilityFor(ctx.role).hideDmOnly,
    });
    if (!graph) return notFound(args.path);
    const nodes = graph.nodes
      .filter((n) => n.id !== note.path)
      .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id))
      .map((n) => `- ${n.id} — ${n.title}${n.tags.length ? ` (tags: ${n.tags.join(', ')})` : ''}`);
    const edges = graph.edges.map((e) => `- ${e.source} -> ${e.target}`);
    const text = [
      `Neighbourhood of ${note.path} (${args.depth ?? 1} hop${(args.depth ?? 1) > 1 ? 's' : ''})`,
      `## Notes (${nodes.length})\n${nodes.join('\n') || '(no linked notes)'}`,
      `## Links (${edges.length})\n${edges.join('\n') || '(none)'}`,
    ].join('\n\n');
    return { text: bounded(text) };
  },
});

export const MCP_TOOLS = [
  listCampaignsTool,
  browseNotesTool,
  searchNotesTool,
  readNoteTool,
  noteNeighborsTool,
] as const satisfies readonly ToolDef[];

/** Validate `args` against the tool's schema and run it. Used by tests
 *  and by the MCP server adapter. */
export function runTool(name: string, ctx: McpContext, args: unknown): ToolResult {
  const tool = (MCP_TOOLS as readonly ToolDef[]).find((t) => t.name === name);
  if (!tool) return { text: `Unknown tool: ${name}`, isError: true };
  const parsed = z.object(tool.input).safeParse(args ?? {});
  if (!parsed.success) {
    return { text: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, isError: true };
  }
  return tool.run(ctx, parsed.data);
}
