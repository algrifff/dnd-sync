# CLAUDE.md

## What we're building

**Compendium** — a self-hosted TTRPG note-taking web app for players and GMs. Think Obsidian, but purpose-built for tabletop campaigns: real-time collaborative notes, character sheets, session logs, knowledge graph, and an AI assistant that understands the game context.

Players connect via a web dashboard. Notes sync live across all clients via Yjs CRDTs over WebSocket. Multiple groups (worlds/campaigns) are supported; users can belong to several.

## Monorepo layout

```
server/     # Next.js 15 App Router + custom WebSocket server (the main app)
shared/     # @compendium/shared — Zod schemas + protocol constants (no build step)
scripts/    # one-off utilities (e.g. vault deduplication)
```

## Commands

| Context | Command |
|---------|---------|
| Install deps | `bun install` (from root) |
| Dev server | `cd server && bun run server.ts` |
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
| `session_notes` | Campaign session logs with GM review workflow (open → closed) |
| `import_jobs` | AI import pipeline state (uploaded → parsing → analysing → ready → applied) |
| `assets` | Binary files (images etc.) deduplicated by content hash |
| `note_links` | Graph edges between notes (backlinks) |
| `notes_fts` | FTS5 full-text search index (auto-synced via triggers) |
| `group_invite_tokens` | Shareable world join links |
| `audit_log` | Admin action history |

All queries include `group_id` — no table-level tenant isolation, just strict query filtering.

## Auth — two separate layers

**Bearer token** (legacy API / admin scripts)
- `Authorization: Bearer <token>` or `?token=`
- `admin` or `player` role; timing-safe comparison
- Tokens come from env vars or `config` table

**Session-based** (web dashboard)
- HTTP-only cookie + CSRF token validated on every mutation
- Roles within a group: `admin`, `editor`, `viewer`
- Admin/editor = GM privileges in AI; viewer = player

**Middleware** (`server/src/middleware.ts`): redirects unauthenticated to `/login`; public paths: `/login`, `/api/*`, `/_next/*`

## Real-time sync

**Web editing**
- Hocuspocus server at `/collab` — Yjs CRDTs over WebSocket
- Tiptap + ProseMirror on the frontend; `Collaboration` extension binds to Y.Doc
- Cursor awareness via `CollaborationCaret`

**Yjs persistence**: `yjs_state` column stores raw `Y.encodeStateAsUpdate()` blob — not plain text. Loss of the DB = loss of all edit history.

## AI features

**Chat** (`POST /api/chat`)
- Vercel AI SDK v6, OpenAI (configurable, default gpt-4o-mini), streaming
- Up to 8 agentic tool-call steps per turn
- Context injected: groupId, campaignSlug, activeCharacterName, openSessionPath, role

**Tools available to the AI**
- `campaign_list` — list registered campaigns (slug + name); `entity_create` only accepts these slugs
- `entity_search` — search before creating (prevent duplicates)
- `entity_create` — create notes under existing campaigns only (characters, items, locations, lore)
- `entity_edit_sheet` — update structured frontmatter fields (stats, HP, level)
- `entity_edit_content` — append prose to note body
- `backlink_create` — add knowledge graph edges
- `inventory_add` — add items to character sheet (GM only)
- `entity_move`, `session_close`, `session_apply` (GM only)

**Import pipeline** — AI-assisted batch import of Markdown vaults
1. Upload ZIP → `import-parse.ts` (structural parse)
2. `import-analyse.ts` → classify + extract entities → `plan_json`
3. User reviews plan → `import-apply.ts` commits to DB

**Skill injection** — per-kind markdown prompts (`character.md`, `creature.md`, `session.md`, `item.md`, `location.md`, `lore.md`, `note.md`) are loaded dynamically based on keyword detection in the user's message.

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
| `server/src/collab/server.ts` | Hocuspocus server for web editing |
| `server/server.ts` | Entry point — Next.js + WebSocket on the same port |
| `server/next.config.ts` | `serverExternalPackages` for Yjs/Tiptap/graph libs — touch carefully |
| `server/src/app/notes/sheet-header/SheetHeader.tsx` | Per-kind header dispatcher (character / person / creature / item / location) |
| `server/src/app/notes/sheet-header/usePatchSheet.ts` | Debounced shallow-merge PATCH hook + Hocuspocus awareness mirror |
| `server/src/app/notes/sheet-header/util.ts` | `normalizeKind`, `titleSizeClass`, ability/HP/AC readers, rarity/disposition palette |
| `server/src/app/api/notes/sheet/route.ts` | PATCH endpoint: shallow-merge sheet patch → `validateSheet()` → write |

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

Test files (all in `server/src/lib/`):
- `auth.test.ts`, `session.test.ts`, `csrf.test.ts` — auth layer
- `notes.test.ts`, `users.test.ts` — core lib
- `md-to-pm.test.ts` — Markdown → ProseMirror conversion
- `ratelimit.test.ts` — auth throttling

Pattern: AAA (Arrange → Act → Assert). Real in-memory SQLite — no DB mocking. No e2e tests yet.

## Non-obvious gotchas

**Characters table is a derived index** — rebuilt from note frontmatter on every save. Never write to it directly; always update the source note.

**`dm_only` is enforced at the API layer** — viewers get the note path/title but body is withheld. Not a DB-level permission.

**Admin password only shown once** — logged to stdout on first boot in a styled banner. Never recoverable after that (Argon2 hash only).

**Import job temp files** — `raw_zip_path` points to a file under `DATA_DIR`. Deleted on apply/cancel. Orphaned zips accumulate if the server crashes mid-import.

**Asset deduplication** — same binary content = same `asset_id`. Two users uploading the same image store one blob.

**`yjs_state` is a raw binary blob** — `Y.encodeStateAsUpdate()` format. The DB is the only backup of real-time edit history.

**Sheet headers are inline-editable, CharacterSheet is the side panel** — the header strip above the TipTap body lets players edit name / HP / portrait / class / etc. directly. It calls `usePatchSheet`, which debounces 400ms and PATCHes a **partial** `{ sheet: { ...fields } }` to `/api/notes/sheet`. The route shallow-merges into existing `frontmatter.sheet` before validation. Nested fields (`hit_points`, `armor_class`, `speed`, `ability_scores`) are **replaced wholesale** — always send the full nested object.

**Legacy flat sheet keys still exist** — `hp_current`, `ac`, `str`/`dex`/…. `CharacterHeader` writes BOTH the new nested shape and the legacy flat keys in one patch so the old `CharacterSheet` side-panel template keeps rendering. Do the same on any new character-touching write path during the transition.

**Kind normaliser lives in two places, must stay in sync** — `server/src/lib/ai/tools.ts` (server/AI) and `server/src/app/notes/sheet-header/util.ts#normalizeKind` (UI). Legacy aliases: `pc|ally` → `character`, `npc|villain` → `person`, `monster` → `creature`. Unknown kinds return `null` and the SheetHeader renders nothing — this is what keeps lore/session/plain notes unaffected.

**Per-world accent colour flows via CSS variable** — `groups.header_color` → page.tsx reads via `getWorldHeader()` → passed to `SheetHeader` → set as `--world-accent` on the wrapper div. Inline editors read it through `var(--world-accent, #8A7E6B)` — **do not prop-drill**. Also note: a scoped `.sheet-header *:focus-visible { outline: none }` rule in `globals.css` opts the subtree out of the app-wide candlelight focus ring. If you add another global focus style, scope it out too.

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
| `sheet-header` | Add / review a per-kind note header (character / person / creature / item / location) |

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
