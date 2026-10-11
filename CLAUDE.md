# CLAUDE.md

## What we're building

**Compendium** — a self-hosted TTRPG note-taking web app for players and GMs. Think Obsidian, but purpose-built for tabletop campaigns: real-time collaborative notes, character sheets, session logs, knowledge graph, and AI-assisted import of existing vaults.

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
| Dev server | `bun run dev` (gated, see memory rules below) |
| Type-check all | `bun run typecheck` (from root) |
| Lint | `bun run lint` |
| Tests | `bun run test` (gated; `test:changed` for just your diff) |
| Production build | `cd server && bun run build` |

## Running many agents in parallel — memory rules

The machine must stay under ~70 GB RAM total (WSL is capped in `~/.wslconfig`).
Every heavy command goes through `scripts/gate.ts`, which waits for a free slot
and for RAM headroom before it starts. The gate only limits commands launched
through it, so use the root scripts, never the raw tools:

- `bun run dev` — dev server, gated (max 3 at once). Sets `PORT` to 3100+slot, so parallel servers never collide. Don't start one unless the task needs a running app.
- `bun run test` / `bun run typecheck` / `bun run lint` — gated. Plain `bun test` is also safe: root `bunfig.toml` ignores `.claude/**`.
- `bun run test:changed` — only test files affected by your diff against `main`.

**A worktree is checked once, not continuously.** While working, run only the
test files you touched (`bun test path/to/file.test.ts`) or `test:changed`.
Run the full `test` + `typecheck` + `lint` once, right before opening the PR,
and don't re-run them on a worktree that hasn't changed since.

**Tear the worktree down when its PR is open**: stop any dev server, then
`git worktree remove <path>` (the branch and PR survive). Each worktree holds
~1 GB of `node_modules` and up to 1 GB of `.next`.

Tuning: `GATE_CEILING_GB` (default 70), `GATE_MAX_CHECK` (6), `GATE_MAX_DEV` (3).
Bun is pinned to 1.4 in `mise.toml`; 1.1 leaked badly on Windows and spiked to
~4.4 GB compiling a single Next route (1.4 stays near 1.3 GB). Install it
globally (`npm i -g bun@1.4.3`) — don't rely on `npx bun`, which resolves the old pin.

## Runtime split — critical

- **Dev / tests**: Bun → uses `bun:sqlite` (built-in, no native modules)
- **Production**: Node 22 → uses `better-sqlite3` (V8 ABI-specific .node binary)
- `server/src/lib/db.ts` switches at runtime: `typeof Bun !== "undefined"`
- The Dockerfile rebuilds `better-sqlite3` against Node 22's ABI in a separate stage — don't skip this step when changing the Dockerfile

## Data model (50 migrations, versions 1–52 — append only, never edit existing)

Numbering isn't contiguous — a couple of version numbers (21, 22) were
never shipped, so "latest version" and "migration count" are two
different numbers. Don't assume `version N` implies `N` migrations exist.

Key tables:

| Table | Purpose |
|-------|---------|
| `notes` | All content — path, ProseMirror JSON, Yjs state, frontmatter, `dm_only` + `gm_only` visibility flags |
| `users` | Web app accounts — email, password_hash (Argon2), avatar |
| `groups` | Worlds/campaigns — the multi-tenancy container |
| `group_members` | User ↔ group with role: `admin`, `editor`, `viewer` |
| `sessions` | HTTP-only session cookies + CSRF tokens |
| `characters` | Derived index from note frontmatter — re-derived on every save |
| `session_notes` | Session status (open → closed) and the pending Wrap-up proposal (`wrap_up_json`) |
| `character_suggestions` | Wrap-up Suggestions (story + inventory) held for a Character's Player until they accept or dismiss — never applied directly |
| `import_jobs` | AI import pipeline state — `uploaded` → `orchestrating_assets` → `orchestrating_campaign` → `orchestrating_entities` → `orchestrating_quality` → `applied` on the live Smart Import path (can pause at `waiting_for_answer`); `parsing` → `analysing` → `ready` is the legacy manual-review path, still valid statuses but not driven by the current UI |
| `assets` | Binary files (images etc.) deduplicated by content hash |
| `note_links` | Graph edges between notes (backlinks) |
| `note_relations` | Typed Relationships (v52): `from_path relation to_path` from the fixed list in `shared/src/schemas/relation.ts`, with the Session that established it. Authored, never derived; only `lib/relations.ts` reads or writes it, and every rename/move/delete carries its rows |
| `notes_fts` | FTS5 full-text search index, auto-synced by triggers on `notes` (including path moves). `path` and `group_id` are indexed (v48), so build every MATCH with `worldFtsMatch()` from `lib/search.ts`, never write to it directly |
| `group_invite_tokens` | Shareable world join links |
| `audit_log` | Admin action history |
| `oauth_clients` | MCP connector clients (v50): `kind='dcr'` rows from `POST /api/oauth/register`, `kind='cimd'` rows caching a fetched Client ID Metadata Document whose URL is the `client_id` |
| `oauth_codes` | Single-use, 5-minute authorization codes, stored as SHA-256 hashes with the PKCE challenge and the `resource` |
| `oauth_grants` | One consent: user U lets client C read world G. Deleting it (settings UI, RFC 7009 revoke, lost membership, prune) cascades every token |
| `oauth_tokens` | Access (1 h) and refresh (30 d, rotated on use) tokens as SHA-256 hashes, `ON DELETE CASCADE` from their grant |

All queries include `group_id` — no table-level tenant isolation, just strict query filtering.

## Auth — three separate layers

**Super-admin token** (`/admin/*` only)
- `POST /api/admin/login` timing-safe compares the submitted token against the `ADMIN_TOKEN` env var (rate-limited) and sets the `__sa` cookie; `lib/superadmin.ts#isSuperAdmin` checks that cookie
- Env var only: the `admin_token` / `player_token` rows that `ensureConfig()` seeds into the `config` table are not read by any auth path
- `ADMIN_TOKEN` is not a password for the regular `/login` form (that master-password path was removed)
- No `?token=` API auth remains. The only `Authorization: Bearer` surface is `/api/mcp`, below

**Session-based** (web dashboard)
- HTTP-only cookie + CSRF token validated on every mutation
- Roles within a group: `admin`, `editor`, `viewer`
- Admin/editor = GM privileges; viewer = player

**MCP connector bearer tokens** (`POST /api/mcp` only, see "MCP connector" below)
- OAuth 2.1 access tokens issued by Compendium's own authorization server (`lib/oauth.ts`) after the user consents on `/oauth/authorize` with a normal session
- A token is bound to (user, world, resource); `authenticateAccessToken()` re-reads `group_members` on every request, so losing membership cuts access at once and drops the grant
- Never cookies, never CSRF on this route; a missing or dead token gets `401` + `WWW-Authenticate: Bearer resource_metadata=…, scope="notes:read"`

**Middleware** (`server/src/middleware.ts`): redirects unauthenticated to `/login?next=<path>`; also applies the security-header pack to every response. Public paths (no redirect): `/`, `/login`, `/signup`, `/admin/login`, `/api/*`, `/.well-known/*`, `/_next/*`, plus static assets. `/oauth/authorize` is deliberately not public: the redirect to `/login?next=` carries its whole query, so the consent page resumes after sign-in. `/admin/*` (except `/admin/login`) is a separate super-admin gate on its own `__sa` cookie, not the regular session.

## Real-time sync

**Web editing**
- Hocuspocus server at `/collab` — Yjs CRDTs over WebSocket
- Tiptap + ProseMirror on the frontend; `Collaboration` extension binds to Y.Doc
- Cursor awareness via `CollaborationCaret`

**Yjs persistence**: `yjs_state` column stores raw `Y.encodeStateAsUpdate()` blob — not plain text. Loss of the DB = loss of all edit history.

## AI features

There is no in-app AI chat. It was removed so players can reach Claude
through an MCP connector instead (built separately). `OPENAI_API_KEY`
still powers the import pipeline and PDF character-sheet import below.

**AI tools** (`server/src/lib/ai/tools.ts#createTools`) are currently
unreferenced outside `tools.test.ts`. They are kept for the MCP
connector to adopt. `getToolsForRole` filters them per role: `dm` gets
all 13, `player` loses the 4 GM-only ones below, and `viewer`
additionally loses every mutating tool, leaving just `campaign_list` /
`campaign_browse` / `entity_search` / `note_read`.
- `campaign_list` — list registered campaigns (slug + name); `entity_create` only accepts these slugs
- `campaign_browse` — list notes inside a campaign
- `entity_search` — search before creating (prevent duplicates)
- `entity_create` — create notes under existing campaigns only (characters, items, locations, lore)
- `entity_edit_sheet` — update structured frontmatter fields (stats, HP, level)
- `entity_edit_content` — append prose to note body
- `note_read` — read full content + frontmatter of any note
- `backlink_create` — add knowledge graph edges
- `inventory_add` — add items to character sheet (GM only)
- `entity_move`, `entity_change_kind`, `note_write_section`, `session_finalize` (GM only)

**Wrap-up** — the app does not generate it. A Player's own Claude reads `GET /api/sessions/wrap-up/context` (log + visible candidate Notes, flagged `recorded` when their History already links the Session) and submits `POST /api/sessions/wrap-up` (strict Zod `WrapUpSubmission`; a mention of a Note the caller cannot see is a 404). The closer reviews the pending proposal in the End of Session dialog; `POST /api/sessions/wrap-up/apply` adds History entries, creates new Notes, links the log, records the ticked Relationships and closes the Session. A proposal may carry `relations` (`{ from, relation, to, note? }`, each end a `mention` of the same submission by name or an `existing` Note path, `relation` from the shared `RELATION_TYPES`); an unresolvable one is `400 invalid_relation`, an existing end the caller cannot see is a 404, and apply (`acceptedRelations`) records one only when both ends landed, otherwise it comes back in `relationsSkipped`. Logic lives in `server/src/lib/wrap-up.ts`.

**Import pipeline** — AI-assisted batch import of Markdown vaults ("Smart Import")
1. Upload ZIP → `import-parse.ts` (structural parse), job status `uploaded`
2. `import-orchestrate.ts` runs the pipeline the UI actually drives (`ImportLauncher` calls `POST /api/import/[id]/orchestrate`): assets → campaign → entities → quality (`orchestrating_*` statuses), pausing to ask the DM a question via an in-process chat channel (`waiting_for_answer`, answered through `POST /api/import/[id]/answer`) when something's genuinely ambiguous
3. Job lands as `applied`

A separate manual-review path still exists in the codebase
(`import-analyse.ts` → `plan_json` → `import-apply.ts` commits, behind
`POST /api/import/[id]/analyse` / `/apply`). Nothing in the current UI
calls `/analyse` — the vault settings page only drives `/orchestrate`.
`/apply` is still called by the "Apply" button in
`app/settings/import/[id]/ImportJobPanel.tsx`, reachable from the
vault page's job list via `/settings/import/<id>`.

## MCP connector (Claude reads a world)

Players add Compendium to claude.ai / Desktop / mobile / Claude Code as
a custom connector (remote MCP server), so their own Claude subscription
does the reasoning. Compendium is both the OAuth 2.1 authorization
server and the resource server. Reading never changes anything; the one
write is a Wrap-up *proposal* that a Player reviews in the app.

Flow (MCP authorization spec 2025-11-25): `POST /api/mcp` without a
token → `401` with `resource_metadata` → `GET /.well-known/oauth-protected-resource/api/mcp`
→ `GET /.well-known/oauth-authorization-server` → client identity by
Client ID Metadata Document (`client_id` is an HTTPS URL we fetch and
cache, `lib/oauth.ts#resolveClient`) or Dynamic Client Registration
(`POST /api/oauth/register`) → `GET /oauth/authorize` (session, world
picker, `ConsentForm`) → `POST /api/oauth/authorize` (session + CSRF)
mints a code and returns the redirect → `POST /api/oauth/token`
(form-encoded, PKCE S256 required, `resource` checked, rate-limited by
`oauthTokenLimiter`) → bearer token → MCP JSON-RPC. `POST /api/oauth/revoke`
is RFC 7009; `DELETE /api/oauth/grants/:id` backs the "Connected apps"
section on `/settings/profile`.

Every URL in the metadata derives from `lib/public-url.ts`
(`PUBLIC_APP_URL`, else forwarded host headers), so the `resource` a
token is bound to is always the one `/api/mcp` checks against.

Tools (`lib/mcp/tools.ts`, a registry the server adapter and tests
share): `list_campaigns`, `browse_notes` (folder + kind, cursor
paginated), `search_notes`, `read_note` (frontmatter, Markdown body,
links both ways), `note_neighbors` (1–2 hops). Every tool applies
`visibilityFor(role)` with the role read on this request: a Secret or
Private note is "not found" and never appears in a list, link, backlink
or neighbourhood. Output is plain text capped at 24k characters.

Wrap-up tools (ADR 0001): `wrap_up_context` returns a Session log plus a
page of candidate Notes; `submit_wrap_up` stores a proposal via
`lib/wrap-up.ts#submitWrapUp` (the same call as `POST /api/sessions/wrap-up`).
It writes no Note: a Player reviews and applies it in `WrapUpDialog`.
Scopes: grants carry `notes:read` and `wrapup:submit` (`lib/oauth.ts#SCOPES`);
the consent request's `scope` is honoured through `grantedScope`, a request
naming none gets both, and `runTool` refuses a tool whose scope the grant
lacks. The grant's scopes travel to tools as `McpContext.scopes`. The
MCP server (`lib/mcp/server.ts`) is stateless Streamable HTTP with JSON
responses; `GET`/`DELETE /api/mcp` are 405. The SDK bundles zod 4 while
the app is on zod 3, hence the one cast at `registerTool`.

Verify live with `cd server && bun run scripts/mcp-smoke.ts [--base URL] [--user NAME] [--keep]`
(mints a session straight into the server's SQLite, then drives the
whole flow over HTTP) and the MCP Inspector:
`npx @modelcontextprotocol/inspector --cli --transport http --server-url <origin>/api/mcp --method tools/list --header "Authorization: Bearer <token>"`.

## Key files

| File | What it does |
|------|-------------|
| `server/src/lib/db.ts` | SQLite singleton, dual-runtime adapter |
| `server/src/lib/migrations.ts` | Append-only migration array — **never edit existing entries** |
| `server/src/lib/superadmin.ts` | `ADMIN_TOKEN` check for the `/admin/*` `__sa` cookie |
| `server/src/lib/session.ts` | Session CRUD, CSRF, expiry cleanup |
| `server/src/lib/notes.ts` | Note CRUD, backlink derivation, FTS sync |
| `server/src/lib/relations.ts` | Relationships: `addRelation` (plus its manual link), visibility-gated `listRelations`, and the repoint/delete helpers every move and delete path calls |
| `server/src/lib/ai/tools.ts` | AI tool definitions, unreferenced until the MCP connector adopts them |
| `server/src/lib/wrap-up.ts` | Wrap-up: proposal shape, submit validation, candidate context, idempotent apply |
| `server/src/lib/note-edits.ts` | Lossless PM-JSON edits: `addHistoryEntry`, `linkMention`, `applyNoteEdit` |
| `server/src/lib/import-orchestrate.ts` | "Smart Import" — the multi-phase pipeline the vault UI actually drives (assets → campaign → entities → quality) |
| `server/src/lib/assets.ts` | Content-addressed asset storage — hash/mime dedup, `deleteAsset()` reference-checked delete |
| `server/src/lib/oauth.ts` | OAuth 2.1 authorization server for the MCP connector — clients (DCR + CIMD), hashed codes/tokens, PKCE, refresh rotation, bearer validation, revocation, prune |
| `server/src/lib/oauth-authorize.ts` | Validates an authorization request; shared by the consent page and `POST /api/oauth/authorize` |
| `server/src/lib/public-url.ts` | The one source of the public origin: issuer, `resource`, metadata and endpoint URLs |
| `server/src/lib/mcp/tools.ts` | The MCP tools (five read-only, two for Wrap-up), visibility-gated, as a registry |
| `server/src/lib/mcp/server.ts` | Per-request stateless Streamable HTTP MCP server over that registry |
| `server/src/app/api/mcp/route.ts` | Bearer gate + 401 challenge in front of the MCP server |
| `server/scripts/mcp-smoke.ts` | Live end-to-end check of the connector over HTTP |
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

~31 test files, most (not all) under `server/src/lib/` — a few live
alongside the code they cover instead, e.g.
`server/src/collab/derive.test.ts` and
`server/src/app/notes/sheet-header/util.test.ts`. Representative
examples:
- `session.test.ts`, `csrf.test.ts` — auth layer
- `notes.test.ts`, `users.test.ts`, `groups.test.ts` — core lib
- `md-to-pm.test.ts` — Markdown → ProseMirror conversion
- `ratelimit.test.ts` — auth throttling
- `migrations.test.ts` — schema migration invariants
- `ai/tools.test.ts` — AI tool behaviour

Pattern: AAA (Arrange → Act → Assert). Real in-memory SQLite — no DB mocking. No e2e tests yet.

## Non-obvious gotchas

**Characters table is a derived index** — rebuilt from note frontmatter on every save. Never write to it directly; always update the source note.

**`dm_only` and `gm_only` are enforced at the API layer, not the DB
layer** — `loadNote()` returns the raw row and filters nothing; every
read path must gate explicitly. Derive the predicate with
`visibilityFor(session.role)` from `lib/notes.ts`. A hidden note 404s
(never 403, never a withheld-body payload) — indistinguishable from a
note that doesn't exist. This used to be documented as "handled inside
`loadNote()`" — that was false and caused a real security hole (a
viewer could read GM-hidden notes); every call site has to check for
itself. Reference implementations: `collab/server.ts` (single-note
gates) and `api/ui/search/route.ts` (list surfaces).

`dm_only` and `gm_only` are two independent visibility namespaces on
the same `notes` row, with different audiences:
- **`dm_only`** hides a note from `viewer`s only — `admin` and `editor`
  (both GM-equivalent roles) can see it. `visibilityFor()`:
  `hideDmOnly: role === 'viewer'`.
- **`gm_only`** hides a note from everyone except `admin` — even
  `editor`, despite editors otherwise having GM privileges, cannot see
  a `gm_only` note. It's the world-owner-only namespace (e.g. GM-only
  uploaded assets, admin scratch notes). `visibilityFor()`:
  `hideGmOnly: role !== 'admin'`.

**Admin password only shown once** — logged to stdout on first boot in a styled banner. Never recoverable after that (Argon2 hash only).

**Import job temp files** — `raw_zip_path` points to a file under `DATA_DIR`. Deleted on apply/cancel. Orphaned zips accumulate if the server crashes mid-import.

**Asset deduplication is per-group, not per-blob** — `assets` has
`UNIQUE(group_id, hash)`, so two uploads of the same bytes *within one
group* reuse the same `asset_id` row. Across different groups the same
bytes get separate `asset_id` rows (each group needs its own row to
delete/permission independently) but still share one file on disk at
`/data/assets/<hash>.<ext>` — `deleteAsset()` in `lib/assets.ts` only
unlinks that file once no `assets` row anywhere still points at it.

**`yjs_state` is a raw binary blob** — `Y.encodeStateAsUpdate()` format. The DB is the only backup of real-time edit history.

**Sheet headers are inline-editable, CharacterSheet is the side panel** — the header strip above the TipTap body lets players edit name / HP / portrait / class / etc. directly. It calls `usePatchSheet`, which debounces 400ms and PATCHes a **partial** `{ sheet: { ...fields } }` to `/api/notes/sheet`. The route shallow-merges into existing `frontmatter.sheet` before validation. Nested fields (`hit_points`, `armor_class`, `speed`, `ability_scores`) are **replaced wholesale** — always send the full nested object.

**Legacy flat sheet keys still exist** — `hp_current`, `ac`, `str`/`dex`/…. `CharacterHeader` writes BOTH the new nested shape and the legacy flat keys in one patch so the old `CharacterSheet` side-panel template keeps rendering. Do the same on any new character-touching write path during the transition.

**Kind mapping lives in one place** — `shared/src/schemas/kind.ts`. `NOTE_KINDS` is the canonical list (`character | person | creature | item | location | quest | lore | session | note`) and `KIND_ALIASES` collapses legacy aliases: `pc` → `character`, `npc|ally|villain` → `person`, `monster` → `creature`. Use `canonicalKind()` on validated input and `parseKind()` on untrusted strings. The AI tools and `canonicalFolder()` (`lib/ai/paths.ts`) call it directly; the UI's `sheet-header/util.ts#normalizeKind` is `parseKind()` narrowed to `SHEETED_KINDS`, so quest/lore/session/plain notes return `null` and the SheetHeader renders nothing. Never add a second switch; change the shared table.

**Per-world accent colour flows via CSS variable** — `groups.header_color` → page.tsx reads via `getWorldHeader()` → passed to `SheetHeader` → set as `--world-accent` on the wrapper div. Inline editors read it through `var(--world-accent, #8A7E6B)` — **do not prop-drill**. Also note: a scoped `.sheet-header *:focus-visible { outline: none }` rule in `globals.css` opts the subtree out of the app-wide candlelight focus ring. If you add another global focus style, scope it out too.

## Deployment

Railway: `railway.toml` at repo root, Dockerfile at `server/Dockerfile`. Build context is repo root.

Required env vars: `ADMIN_TOKEN` (the `/admin` super-admin login is disabled without it), `DATA_DIR=/data` + a volume mounted at `/data`. `PLAYER_TOKEN` is no longer read by any auth path; setting it is harmless.

Optional: `OPENAI_API_KEY` (enables Smart Import and PDF character import), `PUBLIC_APP_URL` (the public `https://` origin; set it on Railway so OAuth metadata and the MCP `resource` do not depend on forwarded headers).

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

## Pull requests — open them automatically

The user reviews PRs; they don't want to be asked to create them. When a
piece of work is finished and verified (typecheck/tests pass), ship it as
a PR without asking:

1. Branch off `main` (`<type>/<short-slug>`, e.g. `fix/search-snippets`) — never commit to `main` directly.
2. Stage **only the files belonging to this change** — the working tree often holds unrelated in-progress edits; leave them alone.
3. Commit (conventional style, e.g. `fix(ux): ...`), push with `-u`, and `gh pr create` with a summary + how it was verified.
4. Report the PR URL. Never merge — merging is the user's call.

One PR per coherent change. If follow-up fixes land on the same work, push to the existing branch instead of opening a new PR.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `algrifff/dnd-sync` (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
