# CLAUDE.md

## What we're building

**Compendium** — a self-hosted D&D note-taking web app for players and DMs. Think Obsidian, but purpose-built for tabletop campaigns: real-time collaborative notes, character sheets, session logs, knowledge graph, and an AI assistant that understands the game context.

Players connect via a web dashboard or an Obsidian plugin. Notes sync live across all clients via Yjs CRDTs over WebSocket. Multiple groups (worlds/campaigns) are supported; users can belong to several.

## Monorepo layout

```
server/     # Next.js 15 App Router + custom WebSocket server (the main app)
plugin/     # Obsidian plugin — syncs vault files to the server via Yjs + REST
shared/     # @compendium/shared — Zod schemas + protocol constants (no build step)
scripts/    # one-off utilities (e.g. vault deduplication)
```

## Commands

| Context | Command |
|---------|---------|
| Install deps | `bun install` (from root) |
| Dev server | `cd server && bun run server.ts` |
| Plugin watch | `cd plugin && bun run dev` |
| Type-check all | `bun run typecheck` (from root) |
| Lint | `bun run lint` |
| Tests | `bun test` |
| Production build | `cd server && bun run build` |

## Runtime split — critical

- **Dev / tests**: Bun → uses `bun:sqlite` (built-in, no native modules)
- **Production**: Node 22 → uses `better-sqlite3` (V8 ABI-specific .node binary)
- `server/src/lib/db.ts` switches at runtime: `typeof Bun !== "undefined"`
- The Dockerfile rebuilds `better-sqlite3` against Node 22's ABI in a separate stage — don't skip this step when changing the Dockerfile

## Data model (18 migrations — append only, never edit existing)

Key tables:

| Table | Purpose |
|-------|---------|
| `notes` | All content — path, ProseMirror JSON, Yjs state, frontmatter, dm_only flag |
| `users` | Web app accounts — email, password_hash (Argon2), avatar |
| `groups` | Worlds/campaigns — the multi-tenancy container |
| `group_members` | User ↔ group with role: `admin`, `editor`, `viewer` |
| `sessions` | HTTP-only session cookies + CSRF tokens |
| `characters` | Derived index from note frontmatter — re-derived on every save |
| `session_notes` | D&D session logs with DM review workflow (open → closed) |
| `import_jobs` | AI import pipeline state (uploaded → parsing → analysing → ready → applied) |
| `assets` | Binary files (images etc.) deduplicated by content hash |
| `note_links` | Graph edges between notes (backlinks) |
| `notes_fts` | FTS5 full-text search index (auto-synced via triggers) |
| `group_invite_tokens` | Shareable world join links |
| `audit_log` | Admin action history |

All queries include `group_id` — no table-level tenant isolation, just strict query filtering.

## Auth — two separate layers

**Bearer token** (Obsidian plugin + legacy API)
- `Authorization: Bearer <token>` or `?token=`
- `admin` or `player` role; timing-safe comparison
- Tokens come from env vars or `config` table; friend tokens from `friends` table

**Session-based** (web dashboard)
- HTTP-only cookie + CSRF token validated on every mutation
- Roles within a group: `admin`, `editor`, `viewer`
- Admin/editor = DM privileges in AI; viewer = player

**Middleware** (`server/src/middleware.ts`): redirects unauthenticated to `/login`; public paths: `/login`, `/api/*`, `/install/*`, `/_next/*`

## Real-time sync

**Obsidian plugin → server**
- Yjs WebSocket at `ws://host/sync/<path>` — binary y-protocols (sync + awareness)
- Awareness carries cursor positions and user metadata
- REST for binary files (images, PDFs): PUT/DELETE `/api/files/[...path]`
- `fileMirror.ts` watches vault events; diffs against Y.Doc and applies delta

**Web editing**
- Hocuspocus server at `/collab` — same Yjs CRDTs, different upgrade path
- Tiptap + ProseMirror on the frontend; `Collaboration` extension binds to Y.Doc
- Cursor awareness via `CollaborationCaret`

**Yjs persistence**: `yjs_state` column stores raw `Y.encodeStateAsUpdate()` blob — not plain text. Loss of the DB = loss of all edit history.

## AI features

**Chat** (`POST /api/chat`)
- Vercel AI SDK v6, OpenAI (configurable, default gpt-4o-mini), streaming
- Up to 8 agentic tool-call steps per turn
- Context injected: groupId, campaignSlug, activeCharacterName, openSessionPath, role

**Tools available to the AI**
- `entity_search` — search before creating (prevent duplicates)
- `entity_create` — create notes (characters, items, locations, lore)
- `entity_edit_sheet` — update structured frontmatter fields (stats, HP, level)
- `entity_edit_content` — append prose to note body
- `backlink_create` — add knowledge graph edges
- `inventory_add` — add items to character sheet (DM only)
- `entity_move`, `session_close`, `session_apply` (DM only)

**Import pipeline** — AI-assisted batch import of Markdown vaults
1. Upload ZIP → `import-parse.ts` (structural parse)
2. `import-analyse.ts` → classify + extract entities → `plan_json`
3. User reviews plan → `import-apply.ts` commits to DB

**Skill injection** — per-kind markdown prompts (`character.md`, `session.md`, `item.md`, `location.md`, `lore.md`, `note.md`) are loaded dynamically based on keyword detection in the user's message.

## Key files

| File | What it does |
|------|-------------|
| `server/src/lib/db.ts` | SQLite singleton, dual-runtime adapter |
| `server/src/lib/migrations.ts` | Append-only migration array — **never edit existing entries** |
| `server/src/lib/auth.ts` | Bearer token verification |
| `server/src/lib/session.ts` | Session CRUD, CSRF, expiry cleanup |
| `server/src/lib/notes.ts` | Note CRUD, backlink derivation, FTS sync |
| `server/src/lib/ai/orchestrator.ts` | Chat system prompt builder + skill injection |
| `server/src/lib/ai/tools.ts` | All AI tool definitions |
| `server/src/ws/setup.ts` | Yjs WebSocket handler (sync + awareness) |
| `server/src/collab/server.ts` | Hocuspocus server for web editing |
| `server/server.ts` | Entry point — Next.js + WebSocket on the same port |
| `server/next.config.ts` | `serverExternalPackages` for Yjs/Tiptap/graph libs — touch carefully |

## API route conventions

Every route follows this pattern:

```ts
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  const session = requireSession(req);           // 1. auth
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);         // 2. CSRF on mutations
  if (csrf) return csrf;
  const parsed = Body.parse(await req.json());   // 3. Zod parse (throws → catch → 400)
  // ... permission check, path sanitization, DB query, audit log
  return json({ ok: true, ... }, 201);
}
```

Error shape: `{ error: 'snake_case_code', reason?: string }` — never expose stack traces.

HTTP status usage: 400 bad input, 401 unauthenticated, 403 forbidden, 404 not found, 409 conflict, 503 unavailable.

## Testing

Bun's native test runner (`bun:test`). Run with `bun test` from root or any workspace.

Test files (all in `server/src/lib/` and `plugin/src/sync/`):
- `auth.test.ts`, `session.test.ts`, `csrf.test.ts` — auth layer
- `notes.test.ts`, `users.test.ts` — core lib
- `md-to-pm.test.ts` — Markdown → ProseMirror conversion
- `ratelimit.test.ts` — auth throttling
- `hash.test.ts`, `retry.test.ts` — plugin utilities

Pattern: AAA (Arrange → Act → Assert). Real in-memory SQLite — no DB mocking. No e2e tests yet.

## Non-obvious gotchas

**Characters table is a derived index** — rebuilt from note frontmatter on every save. Never write to it directly; always update the source note.

**`dm_only` is enforced at the API layer** — viewers get the note path/title but body is withheld. Not a DB-level permission.

**Admin password only shown once** — logged to stdout on first boot in a styled banner. Never recoverable after that (Argon2 hash only).

**Import job temp files** — `raw_zip_path` points to a file under `DATA_DIR`. Deleted on apply/cancel. Orphaned zips accumulate if the server crashes mid-import.

**Asset deduplication** — same binary content = same `asset_id`. Two users uploading the same image store one blob.

**`yjs_state` is a raw binary blob** — `Y.encodeStateAsUpdate()` format. The DB is the only backup of real-time edit history.

**Plugin URL normalisation** — `normalizeServerUrl()` auto-corrects trailing slashes and wrong schemes on save. If users report "can't connect" check the saved URL in plugin settings first.

## Deployment

Railway: `railway.toml` at repo root, Dockerfile at `server/Dockerfile`. Build context is repo root.

Required env vars: `ADMIN_TOKEN`, `PLAYER_TOKEN`, `DATA_DIR=/data` + a volume mounted at `/data`.

Optional: `OPENAI_API_KEY` (enables AI chat + import), `ANTHROPIC_API_KEY`.

## Skills (invoke with `/skill:<name>`)

| Skill | Purpose |
|-------|---------|
| `code-review` | Structured review — correctness, perf, type safety |
| `security-audit` | OWASP Top 10 scan, auth/input validation focus |
| `refactor-plan` | Strategic refactoring with risk assessment |
| `rigor-audit` | Combined quality + security check |

Full docs: [`.claude/skills/README.md`](.claude/skills/README.md)

## Path-specific rules (auto-loaded by Claude Code)

| Rule file | Applies to |
|-----------|------------|
| [`.claude/rules/frontend.md`](.claude/rules/frontend.md) | `**/*.tsx`, `**/*.jsx`, `**/components/**` |
| [`.claude/rules/backend.md`](.claude/rules/backend.md) | `**/api/**`, `**/server/**` |
| [`.claude/rules/database.md`](.claude/rules/database.md) | `**/migrations*`, `**/*.sql` |
| [`.claude/rules/security.md`](.claude/rules/security.md) | `**/auth/**`, `**/security/**` |
| [`.claude/rules/testing.md`](.claude/rules/testing.md) | `**/*.test.*`, `**/*.spec.*` |

Language guides (TypeScript + Next.js most relevant for this stack): [`.claude/languages/`](.claude/languages/)
