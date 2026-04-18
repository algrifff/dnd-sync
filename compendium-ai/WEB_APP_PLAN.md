# Compendium Web App — Pivot Plan

**Target:** replace the Obsidian plugin with a self-hosted web app. Google-Docs-style live block editing, visible remote text cursors and mouse pointers, Notion-flavoured UX, D&D-parchment visual identity.
**Date:** 2026-04-18
**Planner:** Claude (AI)
**Estimated effort:** 9–11 dev days across eight phases
**Success metric:** five friends open the same note; every keystroke, text cursor, and mouse pointer propagates in <150 ms; mind-map graph renders smoothly at 1500-note scale; admin seeds the vault by uploading a ZIP.

---

## Current state assessment

**Code health score: C** — the Yjs + WebSocket plumbing works but tries to bridge Obsidian's file-backed editor with a CRDT, producing three-way state (disk file ↔ ytext ↔ Obsidian editor buffer) and five distinct race windows. Live sync keeps breaking because we can't observe what happens inside Obsidian's plugin lifecycle.

| Metric | Current | Target | Status |
|---|---|---|---|
| Sources of truth per note | 3 | 1 (ProseMirror JSON backed by ytext) | ❌ |
| Live-sync reliability | Flaky cursors + edits | Always propagates | ❌ |
| Conflict pathways | 4 | 1 (pure CRDT merge) | ❌ |
| Time-to-recover from corruption | Manual script + server wipe | Impossible by design | ❌ |
| Editor UX | Obsidian source-mode | Notion-style block editor | ❌ |
| Graph performance headroom | Canvas, caps ~1k nodes | WebGL, 50k+ nodes | ❌ |

---

## Why the rebuild succeeds this time

- The editor, the state, and the network all live in the browser with no disk file in between. There is exactly one copy of any note's content: the ytext inside hocuspocus-persisted Yjs state.
- Tiptap + `@tiptap/extension-collaboration` is the most widely shipped collaborative-editor combo in production. Yjs was designed for this exact pairing.
- Hocuspocus, not our own `ws/setup.ts`, handles the server lifecycle. Every subtle race we hit (GC timing, double-broadcast, auth-on-upgrade) is solved upstream by a maintained library.

---

## Refactoring strategy

**Approach:** new product surface (web app), reusing the Yjs CRDT core, replacing CodeMirror with Tiptap, replacing our custom y-websocket server with hocuspocus, shedding the Obsidian plugin entirely.

**Patterns applied:** Single Source of Truth (ProseMirror JSON via Yjs), Thin Client (all rendering from ytext state), Content-Addressed Storage (dedup on binary sha256 hash), Tenant-Scoped Schema (group_id on every scoped table from day 1 even with only one group).

---

## Scope and explicit non-goals for v1

**In scope:**
- Multi-user live editing of markdown notes with text cursors + mouse pointers
- Folder tree, backlinks, tags, Notion-style slash menu and drag handles
- Images, videos, PDFs embedded via content-addressed asset storage
- Mind-map graph view (full + mini)
- Admin ZIP upload to seed / re-seed the vault
- Cmd-K global search over note content + titles + tags
- Admin-managed user accounts

**Explicit non-goals (documented here so we don't silently scope-creep):**
- Note transclusions rendered inline (`![[OtherNote]]` embedding another note's body) — render as a link-card with the target's title + first paragraph preview; true transclusion may come later
- In-editor note **rename** — admin re-upload handles renames for v1
- `.canvas` files — ingested as link-cards pointing at the raw JSON download; no canvas renderer
- Obsidian block references (`[[Note^block-id]]`) — resolve to note path, ignore the `^block-id` anchor
- Password self-service reset — admin resets via the dashboard
- 2FA / SSO — trusted-group v1
- Real-time comments on blocks — revisit in a future phase
- Per-block permissions — everyone in the group sees everything
- Version history / time travel — Yjs snapshots exist but we don't surface a UI
- Multi-tenant UI (groups switcher, invites) — schema supports it, UI deferred

Calling these out prevents a reviewer from treating absence as a bug.

---

## Tech stack (pinned)

| Layer | Choice | Why |
|---|---|---|
| App framework | Next.js 15 App Router | Existing server |
| Runtime / PM | Bun 1.1 | Existing; native SQLite |
| DB | SQLite via `better-sqlite3` on Railway `/data` | Simple, fast at our scale |
| Binary storage | Railway `/data/assets/<hash>.<ext>`, streamed with Range support | Zero new infra; swap to R2 when > 80 % full |
| Auth | ~80-line cookie session + **bcrypt cost 12**, Next.js Server Actions for state-changing forms (built-in origin check = CSRF) | Fewer deps; trusted-group use case |
| CRDT | Yjs + **hocuspocus** + `@hocuspocus/extension-database` + `@hocuspocus/extension-logger` | MIT; built-in auth hooks, debounced persistence, doc GC; replaces ~250 lines of custom WS code |
| Editor | **Tiptap** + StarterKit + Image + Link + Table + TaskList + Highlight + CodeBlockLowlight + Placeholder + Mention + Collaboration + CollaborationCursor + **custom** WikiLink + Embed + Callout + TagMention + DragHandle + SlashMenu | **All extensions above are MIT.** See licensing note below. |
| MD bridge | `remark-parse` + `remark-gfm` + custom walker → ProseMirror JSON; `prosemirror-markdown` with custom node serialisers for export | Vault ingest/export; round-trip fidelity test in Phase 2 |
| Read-mode render | Same `NoteSurface` with `editable: false` + Collaboration loaded (receives live updates) but no CollaborationCursor | Single component; readers see live edits but no cursors |
| Graph | **Sigma.js v3** + `graphology` + `graphology-layout-forceatlas2` in a web worker | WebGL; 50k+ nodes at 60 fps |
| Search | SQLite FTS5 on derived `content_text` (plaintext extracted from `content_json`) | Existing FTS infra reused |
| Validation | Zod | Every API boundary (rule: `.claude/languages/typescript/security.md`) |
| Styling | Tailwind CSS v4 + custom D&D tokens | Already configured |
| Display font | Fraunces (H1 only) + Inter | Leather-book feel where it belongs |
| Icons | `lucide-react` | Calm, line-based |

### Licensing note (audit confirmed)

Every dependency listed is MIT-licensed and **free to self-host forever**. Tiptap Pro exists as a separate subscription for extensions we explicitly do **not** use:

| Tiptap Pro feature | Status in this plan |
|---|---|
| Drag Handle | **We build our own** — spec in Phase 4 (~150 LOC ProseMirror plugin) |
| Unique ID | We generate our own with `nanoid` |
| Comments | Out of scope v1 |
| Document AI | Out of scope v1 |
| Collaboration History (branching) | Out of scope (basic Yjs undo is free and sufficient) |
| Table of Contents | DIY from outline — trivial |
| Export / Import | DIY — we already control ingest + export |

If any extension we currently list ever moves to Pro tier, drop it and re-implement from the DragHandle template.

**Alternative if licensing ever gets messier:** `BlockNote` (MPL-2.0, no paid tier, drag handle + slash menu bundled free) is the fallback editor. Migration cost would be ~2 days. Staying with Tiptap for the ecosystem and our custom-extension flexibility.

**Not adopting (revisit later):**
- R2 or any object store — Railway volume is enough at current scale
- Postgres — SQLite handles our write volume; multi-tenant schema already isolates
- WebAssembly CRDT (Automerge/Loro) — no measurable gain at 40 ms RTT
- `markdown-rs` for ingest — swap in only if ZIP import exceeds 30 s

---

## Visual identity — "Round table, neatly typeset"

Base discipline = Notion (`.claude/design/CLAUDE.md`). Overlay = D&D warmth + Milanote generosity.

### Core palette

| Token | Hex | Role |
|---|---|---|
| `--parchment` | `#F4EDE0` | Reading canvas |
| `--parchment-sunk` | `#EAE1CF` | Sidebars, sunken panels |
| `--vellum` | `#FBF5E8` | Cards, hover lift |
| `--ink` | `#2A241E` | Body copy, titles |
| `--ink-soft` | `#5A4F42` | Secondary text |
| `--rule` | `#D4C7AE` | Dividers, borders |
| `--candlelight` | `#D4A85A` | Primary accent (links, selection) |
| `--moss` | `#7B8A5F` | Location category, calm status |
| `--wine` | `#8B4A52` | Villain category, destructive actions |
| `--sage` | `#6B7F8E` | Ally / official category |
| `--embers` | `#B5572A` | Session / event category |
| `--shadow` | `#1E1A15` | Deep contrast |

Each user gets a stable accent from `[#D4A85A, #7B8A5F, #8B4A52, #6B7F8E, #B5572A, #6A5D8B]` assigned at account creation for cursor + pointer.

### Texture

`public/textures/paper.svg` — subtle-grain SVG, 6 % opacity, `background-blend-mode: multiply`. No skeuomorphism; just enough tooth to feel tactile.

### Shape + motion

Milanote generosity: 12 px radii, soft borders, no drop shadows except floating menus. Cards lift 2 % on hover. Buttons scale 1.02 on hover. Slash-menu and wikilink suggestions rise with `translateY(-2px)` + opacity 150 ms.

### Type

Inherit Notion's scale. Body bumped to 17 px / line-height 1.7. Fraunces (display serif) on H1 of each page only.

### Dark mode

Deferred to Phase 8 polish; ship light first.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Browser                                                             │
│   Next.js 15 pages + React                                           │
│     /login  /admin  /notes/[...path]  /graph  /tags                  │
│   Components                                                         │
│     FileTree · NoteSurface (Tiptap editable | read-only)             │
│     SlashMenu · WikiLinkSuggest · EmbedPicker · DragHandle           │
│     GraphCanvas (Sigma) · MiniGraph                                  │
│     PointerOverlay · PresencePanel · CmdK · ErrorBoundary            │
└───────────────┬──────────────────────────────────────────────────────┘
       REST     │      WebSocket (hocuspocus)
┌───────────────▼──────────────────────────────────────────────────────┐
│  Bun / Node (server.ts — same process)                               │
│   Next.js 15 route handlers                                          │
│     /api/auth/{login,logout}                                         │
│     /api/admin/{users,vault/upload,stats,audit}                      │
│     /api/notes/[...path]            (JSON + metadata)                │
│     /api/notes/[...path]/preview    (hover popover data)             │
│     /api/notes/[...path]/create     (new note)                       │
│     /api/tree                       /api/backlinks/[...path]         │
│     /api/graph                      /api/graph/neighborhood/[path]   │
│     /api/search                     /api/tags                        │
│     /api/assets/[id]                (streaming; Range; variants)     │
│     /api/assets/upload              (rate-limited 20/min/user)       │
│   Hocuspocus WS server mounted at ws://host/collab                   │
│     onAuthenticate: session cookie → user + group                    │
│     extension-database → SQLite persistence                          │
│     extension-logger → structured logs                               │
│   SQLite (/data/compendium.db)                                       │
│     users · sessions · groups · group_members                        │
│     notes(group_id, path, content_json, yjs_state, content_text, …)  │
│     assets(group_id, id, hash, mime, size, …)                        │
│     aliases · note_links · tags · notes_fts · audit_log              │
│   Filesystem (/data/assets/<hash>.<ext>) — content-addressed         │
│   Backups (/data/backups/<YYYY-MM-DD>.db) — nightly cron             │
└──────────────────────────────────────────────────────────────────────┘
                        Railway (Docker, /data volume)
```

**Simplifications vs. the plugin world:**
- No vault on disk; `notes.yjs_state` is the only copy of content
- One WebSocket per active note — usually 1–2, never 200
- Auth cookie travels automatically on WS upgrade (same-origin); no URL tokens
- Every scoped table has `group_id` (constant `'default'` for v1) so future multi-tenancy is schema-compatible

---

## Phases

Execute in order. Each ends with `bun run typecheck`, `bun test`, success criteria verified, one commit: `web: phase N — <summary>`.

### Phase 1 — Auth, sessions, tenant-aware schema + security baseline (1–1.5 days)

**1.1 Migration v6 — users, sessions, groups, audit log**

```sql
CREATE TABLE groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
INSERT INTO groups (id, name, created_at) VALUES ('default', 'Compendium', unixepoch()*1000);

CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email          TEXT COLLATE NOCASE,
  password_hash  TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  accent_color   TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER
);

CREATE TABLE group_members (
  group_id  TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  role      TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
) WITHOUT ROWID;

CREATE TABLE sessions (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current_group_id TEXT NOT NULL REFERENCES groups(id),
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL,
  user_agent       TEXT,
  ip               TEXT
);
CREATE INDEX sessions_user    ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);

CREATE TABLE audit_log (
  id        TEXT PRIMARY KEY,
  group_id  TEXT NOT NULL REFERENCES groups(id),
  actor_id  TEXT REFERENCES users(id),
  action    TEXT NOT NULL,                 -- 'user.create', 'user.revoke', 'vault.upload', 'asset.upload', 'note.destroy'
  target    TEXT,                           -- free-form: username, path, asset id
  details_json TEXT,                        -- JSON blob with non-PII context
  at        INTEGER NOT NULL
);
CREATE INDEX audit_log_group_at ON audit_log(group_id, at DESC);
```

**1.2 Session module** — `server/src/lib/session.ts`

- `hashPassword(plain) → Promise<string>` (bcrypt cost 12)
- `verifyPassword(plain, hash) → Promise<boolean>`
- `createSession(userId, groupId, ua, ip) → string` (32 random bytes, 30-day expiry, written to DB)
- `rotateSession(oldId, userId) → string` — called on every login; invalidates old, issues new, prevents session fixation
- `readSession(req) → Session | null` — parses `compendium.sid` cookie, joins `users`, refreshes `last_seen_at` best-effort
- `destroySession(id)` — deletes row + expires cookie
- `requireSession(req) → Session | Response`
- `requireAdmin(req) → Session | Response`
- Cookie flags: `HttpOnly`, `Secure` (prod only via NODE_ENV), `SameSite=Lax`, `Path=/`, `Max-Age=2592000`

**1.3 CSRF strategy**

- State-changing forms use **Next.js Server Actions** (login, logout, create user, etc.) — origin check built in
- File upload endpoints (`POST /api/admin/vault/upload`, `POST /api/assets/upload`) are **not** Server Actions — they use `multipart/form-data` → require a per-session CSRF token:
  - Session creation issues a `csrfToken` (32 random bytes) alongside the session ID, stored in a non-HttpOnly cookie `compendium.csrf`
  - Upload endpoints require header `X-CSRF-Token` matching the cookie — double-submit pattern; protects against cross-origin POST

**1.4 Security headers (middleware)**

Every response sets:
```
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' ws: wss:; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), camera=(), microphone=()
```
Wrapped in a single `applySecurityHeaders(res)` helper so the policy is one place.

**1.5 Zod schemas** — `shared/src/protocol.ts`

```ts
export const LoginRequest = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});
export const CreateUserRequest = z.object({
  username: z.string().regex(/^[a-z0-9_-]{3,32}$/i),
  displayName: z.string().min(1).max(64),
  password: z.string().min(8).max(256),
  role: z.enum(['admin','editor','viewer']),
  email: z.string().email().optional(),
});
// ...ChangePassword, CreateGroup, InviteUser for completeness
```

**1.6 Login UI + middleware**

- `app/login/page.tsx` — single form; Server Action POST
- `middleware.ts` gates non-public routes; 302 `/login?next=<encoded>`; admin-only paths 403 for non-admins (don't leak existence via redirect)
- Login rate limit: 10 failed attempts / 5 min / IP (extend existing `ratelimit.ts`)

**1.7 Seed admin on first boot**

No users → create `admin` with role `admin`, membership in `default`, 24-char random password **printed to stdout once**. `audit_log` records the event.

**1.8 Env vars**

`.env.example` documents:
```
DATA_DIR=/data
NODE_ENV=production
SESSION_COOKIE_SECRET=<32+ byte random>
PORT=3000
ADMIN_EMAIL=<optional: for alerts>
```
Refuse to boot if `SESSION_COOKIE_SECRET` is unset or < 32 bytes in production.

**Success:**
- [ ] Fresh DB: boot prints `admin password: XXXXX` exactly once; `audit_log` has a `user.create` row
- [ ] `/` unauthenticated → 302 `/login?next=/`
- [ ] Correct login → cookie rotated, redirect to `next`
- [ ] Wrong password → generic "Unknown username or password" (never leaks which was wrong)
- [ ] 11 failed logins / 5 min from same IP → 429
- [ ] Every response carries the CSP + HSTS + security headers
- [ ] Multipart POST without CSRF token → 403
- [ ] Session rows correctly expire; cleaned up by boot-time job `DELETE FROM sessions WHERE expires_at < ?`

---

### Phase 2 — Ingestion → ProseMirror + Yjs seeding + fidelity test (1.5–2 days)

**2.1 Migration v7 — notes, assets, aliases, indexes**

```sql
CREATE TABLE notes (
  id               TEXT PRIMARY KEY,
  group_id         TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  path             TEXT NOT NULL,
  title            TEXT NOT NULL DEFAULT '',
  content_json     TEXT NOT NULL,
  content_text     TEXT NOT NULL DEFAULT '',       -- plaintext for FTS
  content_md       TEXT NOT NULL DEFAULT '',       -- derived export cache
  yjs_state        BLOB,
  frontmatter_json TEXT NOT NULL DEFAULT '{}',
  updated_at       INTEGER NOT NULL,
  updated_by       TEXT REFERENCES users(id),
  byte_size        INTEGER NOT NULL DEFAULT 0,
  UNIQUE (group_id, path)
);
CREATE INDEX notes_group_path   ON notes(group_id, path);
CREATE INDEX notes_updated_at   ON notes(group_id, updated_at DESC);

CREATE TABLE aliases (
  group_id TEXT NOT NULL,
  alias    TEXT NOT NULL COLLATE NOCASE,
  path     TEXT NOT NULL,
  PRIMARY KEY (group_id, alias)
) WITHOUT ROWID;
CREATE INDEX aliases_path ON aliases(group_id, path);

CREATE TABLE assets (
  id            TEXT PRIMARY KEY,
  group_id      TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  hash          TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  original_name TEXT NOT NULL,
  uploaded_by   TEXT REFERENCES users(id),
  uploaded_at   INTEGER NOT NULL,
  UNIQUE (group_id, hash)
);
CREATE INDEX assets_hash ON assets(group_id, hash);

CREATE TABLE note_links (
  group_id  TEXT NOT NULL,
  from_path TEXT NOT NULL,
  to_path   TEXT NOT NULL,          -- canonical path; '__orphan__:<label>' if unresolved
  PRIMARY KEY (group_id, from_path, to_path)
) WITHOUT ROWID;
CREATE INDEX note_links_to ON note_links(group_id, to_path);

CREATE TABLE tags (
  group_id TEXT NOT NULL,
  path     TEXT NOT NULL,
  tag      TEXT NOT NULL,
  PRIMARY KEY (group_id, path, tag)
) WITHOUT ROWID;
CREATE INDEX tags_tag ON tags(group_id, tag);

CREATE VIRTUAL TABLE notes_fts USING fts5(
  path UNINDEXED, title, content,
  tokenize = 'porter unicode61'
);
-- triggers mirror notes.(title, content_text) → notes_fts
```

**No backfill from text_docs / binary_files.** The user re-uploads a fresh ZIP after the Phase 2 deploy. Old tables stay idle until Phase 8 cleanup.

**2.2 Markdown → ProseMirror converter**

`server/src/lib/md-to-pm.ts` — pure, deterministic:

```ts
export type NoteIngest = {
  path: string;
  title: string;                      // H1 or filename fallback
  frontmatter: Record<string, unknown>;
  aliases: string[];                  // from frontmatter.aliases
  contentJson: ProseMirrorJSON;       // Tiptap-compatible
  contentMd: string;                  // re-serialised canonical markdown
  contentText: string;                // plaintext for FTS
  wikilinks: string[];                // resolved canonical paths (or '__orphan__:X')
  tags: string[];                     // frontmatter.tags + inline #tags
  embedAssets: { label: string }[];   // unresolved until asset pass joins
};
export function ingestMarkdown(
  path: string,
  raw: string,
  allPaths: ReadonlySet<string>,
  aliasMap: ReadonlyMap<string, string>,  // populated after first pass
  assetsByName: ReadonlyMap<string, string>, // label → asset id
): NoteIngest;
```

Pipeline:
1. `remark-parse` + `remark-gfm` + `remark-frontmatter` → MDAST + frontmatter
2. Walker transforms MDAST → ProseMirror JSON with:
   - Text segment regex for `[[target(\|label)?]]` → `wikilink` node with resolved target
   - Text regex for `![[asset(|label)?]]` → `embed` node referencing `assets[label]`
   - Obsidian callout blockquotes (`> [!note]`) → `callout` node with `kind`
   - Inline `#tag` (outside code/link contexts) → `tagMention` node
   - `rehype-sanitize` equivalent schema applied inside the walker — any raw HTML outside the whitelist becomes text
3. Wikilink resolution order: **exact path → alias table → exact basename → longest path suffix → orphan**
4. Re-serialise to `content_md` via `prosemirror-markdown` with custom node serialisers
5. Extract `content_text` by walking the PM doc collecting text nodes

**Aliases:** Two-pass ingest. First pass parses every note and collects `(path, aliases)` into a map. Second pass resolves wikilinks using that map.

**Block refs (`[[Note^anchor]]`):** target resolves to `Note` only; anchor stored on the wikilink attrs for later support, ignored at render.

**Transclusions (`![[OtherNote]]`):** rendered as a link-card block (`embedNote` node) showing the target's title + first paragraph; server resolves the preview at render time.

**Per-file cap:** reject any single note over 5 MB (raw markdown) — pathological input guard.

**2.3 Asset ingest pass**

Before the note pass, scan every ZIP entry:
- Binary extensions → compute sha256 streaming, if asset exists reuse, else write to `/data/assets/<hash>.<ext>` and insert row
- Build `assetsByName: Map<filename, assetId>` so the note pass can resolve `![[foo.png]]` → asset id

**2.4 Admin upload endpoint**

`app/api/admin/vault/upload/route.ts`:
- `POST` multipart, field `vault`, plus `X-CSRF-Token` header
- `requireAdmin(req)` + rate limit 5 uploads/hour
- `Content-Length` cap 500 MB
- Stream to `/data/tmp/upload-<uuid>.zip`
- `adm-zip` iterate, reject paths with `..`, null, drive-letters, and entries > 50 MB individually, total uncompressed > 1 GB
- Skip `.obsidian/**`, `.trash/**`, `.DS_Store`, `__MACOSX/**`, `*.canvas` (log warning for canvas files)
- MIME sniff every asset via magic-byte check (avoid trusting filename extension)
- Whole operation inside one `db.transaction()`
- After commit: call `collabServer.closeConnections(docName)` for every updated path so live clients reconnect to fresh state
- Write an `audit_log` row `vault.upload`
- Response: `{ notes, assets, links, tags, skipped: {paths:string[], reasons:string[]}, durationMs }`

**2.5 Confirmation UX on re-upload**

If `notes` non-empty, admin page requires:
- Checkbox "I understand this replaces every note and disconnects any live editors"
- Displays currently-connected editor count per doc (from hocuspocus stats)
- Button enabled only with checkbox checked AND ≥ 5 s after arming

**2.6 Ingest fidelity test (mandatory)**

`server/test/ingest-fidelity.test.ts` — runs `bun test`:
1. Take the user's actual vault ZIP (committed to `test/fixtures/vault.zip`)
2. For each note: `ingestMarkdown(md)` → `content_md` → `ingestMarkdown(content_md)` → compare
3. Assertion: `normalised(md) === normalised(content_md2)` (normalisation strips trailing whitespace, collapses consecutive blank lines)
4. Any drift fails the build — prevents Tiptap schema evolution from silently corrupting round-trips

**Success:**
- [ ] Current vault (~10 MB) ingests in < 20 s
- [ ] `COUNT(*) FROM notes` equals markdown count in ZIP
- [ ] Atoxis wikilinks count matches hand-check (≥ 6 outbound)
- [ ] Frontmatter aliases populate `aliases` table; `[[Villain]]` resolves via alias when configured
- [ ] Re-upload replaces cleanly; orphan paths dropped; stale `note_links` dropped
- [ ] Live client (Phase 4+) receives "Vault updated, reloading…" banner within 2 s
- [ ] `/data/assets/` content-hashed; re-uploading same image → one file on disk
- [ ] Round-trip fidelity test passes for every note in the fixture
- [ ] ZIP with a `../../etc/passwd` entry → rejected with explicit log line

---

### Phase 3 — Reader UI (read-only Tiptap + live update receive) (1 day)

Three-pane Milanote layout. Same Tiptap component we'll use for editing — just `editable: false` and no `CollaborationCursor`.

```
┌────────────────┬──────────────────────────────┬────────────────┐
│  Folder tree   │  Note surface (read-only)    │  Side rail     │
│                │                              │                │
│  Campaigns/    │  # Atoxis                    │  Backlinks     │
│   C1/          │  <video controls>…</video>   │   · Bailin     │
│   C2/          │                              │   · Vacant…    │
│   C3/          │  ## Overview                 │  Tags          │
│    NPCs/       │  A demon prince…             │   [villain]    │
│     Atoxis ◉   │                              │  Mini-graph    │
└────────────────┴──────────────────────────────┴────────────────┘
```

**3.1 Tree component** — `components/FileTree.tsx`
- Recursive folders, chevrons, active-path highlight with `--candlelight` at 15 %
- Expansion state per-user in `localStorage` keyed by groupId
- Keyboard nav: arrows, Enter, `/` focuses search

**3.2 Note surface** — `components/NoteSurface.tsx`
- Loads `notes.content_json` from `/api/notes/[...path]` server-side
- Mounts Tiptap with base extensions + `Collaboration` (receives live updates) but **not** `CollaborationCursor`; `editable: false`
- Wikilinks render `<a class="wikilink">` to `/notes/{resolved}`; on hover, 300 ms popover fetches `/api/notes/[...path]/preview` → `{title, excerpt}`; orphan wikilinks render in `--ink-soft` italic with title "Note does not exist"
- Embed block renders `<img>` / `<video controls>` / `<iframe>` / download-card based on `mime`
- Wrapped in `<NoteErrorBoundary>` — if Tiptap throws on a corrupt doc, user sees "This note failed to render" with "Report" button logging to server, not a blank page

**3.3 Note preview endpoint**

`GET /api/notes/[...path]/preview`:
- `requireSession(req)`
- Returns `{ title, excerpt: string /* first paragraph, max 200 chars */, tags }`
- Cached in-memory 60 s per path

**3.4 Side rail** — `components/NoteSidebar.tsx`
- **Backlinks** — `SELECT from_path FROM note_links WHERE group_id=? AND to_path=?`, grouped by folder
- **Tags** — pills in `--candlelight-soft`, click → `/tags/[tag]`
- **Outline** — H2/H3 extracted from `content_json`, click → scrolls
- **Mini-graph** slot (filled in Phase 6)

**3.5 Style pass**
- D&D palette + paper texture on `<main>`
- Content column max 720 px; body 17 px / 1.7; H1 Fraunces 40 px
- Embed blocks: `border: 1px solid var(--rule)`, 10 px radius, caption below in `--ink-soft`
- Wikilink: dotted underline `--candlelight`; orphan italic

**3.6 A11y baseline**
- Editor container has `role="document"` and `aria-label`
- Tree items `role="treeitem"` + `aria-expanded`
- Every embedded image/video has an alt/title from frontmatter or filename
- Focus ring visible on every interactive element
- Target Lighthouse A11y ≥ 95

**Success:**
- [ ] Clicking tree entry navigates without full reload
- [ ] `[[Lumen Flumen]]` resolves and navigates
- [ ] Orphan wikilink visible with italic styling
- [ ] Hover popover appears with 300 ms delay, dismissed on mouseleave
- [ ] Backlinks panel shows ≥ 6 for Atoxis
- [ ] Image + video embeds render (video seeks)
- [ ] Typing from another tab in Phase 4 surfaces in the reader in < 1 s (via Collaboration extension)
- [ ] Mobile (≤ 640 px): tree drawer + stacked sidebar
- [ ] Lighthouse A11y ≥ 95
- [ ] Corrupted doc `content_json` → error boundary renders safe message; console logs the error

---

### Phase 4 — Live collaborative editor + assets (2–2.5 days)

Same `NoteSurface` component; flip `editable: true`, add `CollaborationCursor`, custom extensions mount.

**4.1 Hocuspocus server**

`server/src/collab/server.ts`:

```ts
import { Server } from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import { Logger } from '@hocuspocus/extension-logger';
import { getDb } from '@/lib/db';
import { readSessionFromIncoming } from '@/lib/session';

export const collabServer = Server.configure({
  async onAuthenticate({ request }) {
    const session = await readSessionFromIncoming(request);
    if (!session) throw new Error('Unauthorized');
    return {
      userId: session.userId,
      displayName: session.displayName,
      accentColor: session.accentColor,
      groupId: session.currentGroupId,
    };
  },
  extensions: [
    new Logger({ onUpgrade: true, onLoadDocument: false, onStoreDocument: false }),
    new Database({
      fetch: async ({ documentName, context }) => {
        const row = getDb().query<{ yjs_state: Uint8Array | null }, [string, string]>(
          'SELECT yjs_state FROM notes WHERE group_id = ? AND path = ?',
        ).get(context.groupId, documentName);
        return row?.yjs_state ? new Uint8Array(row.yjs_state) : null;
      },
      store: async ({ documentName, state, context }) => {
        getDb().query(
          `UPDATE notes
              SET yjs_state = ?, updated_at = ?, updated_by = ?
              WHERE group_id = ? AND path = ?`,
        ).run(state, Date.now(), context.userId, context.groupId, documentName);
        queueDeriveCache(context.groupId, documentName);
      },
    }),
  ],
});
```

`queueDeriveCache` is a 500 ms debounced per-path task that:
1. Loads yjs_state, decodes to ProseMirror JSON
2. Updates `notes.content_json`, `content_md`, `content_text`, `title`
3. Rebuilds `note_links` + `tags` for that path
4. Triggers update on `notes_fts`

Mounted into `server.ts`:
```ts
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${hostname}`);
  if (url.pathname === '/collab') {
    collabServer.handleUpgrade(req, socket, head);
    return;
  }
  socket.destroy();
});
```

Legacy `ws/setup.ts` stays compiled but unreachable until Phase 8.

**4.2 Tiptap editor wiring**

`components/NoteSurface.tsx`:

```tsx
const ydoc = useMemo(() => new Y.Doc(), [path]);
const provider = useMemo(() => new HocuspocusProvider({
  url: wsUrl('/collab'),
  name: path,
  document: ydoc,
  onAuthenticationFailed: () => location.href = '/login',
}), [path]);

const editor = useEditor({
  editable: mode === 'edit',
  extensions: [
    StarterKit.configure({ history: false }),           // Yjs owns history
    Image, Link.configure({ openOnClick: false }),
    Table.configure({ resizable: true }), TableRow, TableCell, TableHeader,
    TaskList, TaskItem,
    Highlight,
    CodeBlockLowlight.configure({ lowlight }),
    Placeholder.configure({ placeholder: 'Press / for blocks…' }),
    Collaboration.configure({ document: ydoc, field: 'default' }),
    mode === 'edit' && CollaborationCursor.configure({
      provider,
      user: { name: user.displayName, color: user.accentColor },
    }),
    WikiLink, Embed, EmbedNote, Callout, TagMention,
    SlashCommand, DragHandle,
  ].filter(Boolean),
}, [path, mode, provider]);

useEffect(() => () => {
  editor?.destroy();
  provider.destroy();
  ydoc.destroy();
}, [provider, ydoc, editor]);
```

**4.3 Custom Tiptap extensions**

`components/editor/extensions/WikiLink.ts`:
- Inline node with attrs `{ target, label, anchor?, orphan }`
- Typing `[[` opens `@tiptap/suggestion` popup listing all notes + aliases (fetched once, cached client-side, invalidated on vault re-upload broadcast)
- Enter inserts `wikilink` node; rendered `<a class="wikilink" data-target="…" href="/notes/…">label</a>`
- Orphan state styled italic `--ink-soft`

`components/editor/extensions/Embed.ts`:
- Block node, attrs `{ assetId, mime, caption?, alignment? }`
- Renders image / video / pdf-iframe / file-card
- Inserted via slash menu → opens `<input type="file">` → upload via `/api/assets/upload` → node inserted with returned `assetId`
- Additionally: **clipboard paste handler** — pasting an image from OS clipboard uploads and inserts; progress overlay visible for files > 1 MB
- Additionally: **drag-drop handler** — drop file anywhere in editor → upload + insert at drop position

`components/editor/extensions/EmbedNote.ts`:
- Block node, attrs `{ target }` (note path)
- Renders link-card with title + excerpt fetched from `/api/notes/[path]/preview`
- Inserted by the ingest walker when it sees `![[OtherNote]]`
- Click opens the note

`components/editor/extensions/Callout.ts`:
- Block node, attrs `{ kind: 'note'|'tip'|'warning'|'danger' }`
- Coloured with category palette

`components/editor/extensions/TagMention.ts`:
- Inline node, `#` trigger, fuzzy-matches existing tags + allows new
- Rendered as pill

`components/editor/extensions/SlashCommand.ts`:
- Uses `@tiptap/suggestion` with `/` trigger
- Menu items: Heading 1/2/3, Bulleted list, Numbered list, Task list, Quote, Code, Divider, Image, Video, PDF, Callout (note/tip/warning/danger), Wiki-link, Table
- Keyboard-navigable; Enter inserts

`components/editor/extensions/DragHandle.ts` (our own — not Tiptap Pro):
- ProseMirror `Plugin` with a DOM element overlay
- On mouseover a block, position the handle at its left margin
- On mousedown, begin a ProseMirror drag operation using `view.dragging = { slice, move: true }`
- Drop uses native `drop` event → inserts at the resolved position
- ~150 LOC; reference in source comment: based on ProseMirror `prosemirror-dropcursor` patterns

**4.4 New note + delete flows**

`POST /api/notes/[...path]/create`:
- `requireSession(req)` + editor role
- Creates row with empty content_json (single empty paragraph), seeds an empty Yjs doc
- Returns 201 with path; client navigates
- Rejects if path already exists

`DELETE /api/notes/[...path]`:
- `requireSession(req)` + editor role
- Removes row, cascades note_links + tags, calls `collabServer.closeConnections(path)`
- audit_log entry

Note **rename is explicitly out-of-scope v1** — admin re-upload handles.

**4.5 Asset upload endpoint**

`POST /api/assets/upload`:
- `requireSession(req)` + `X-CSRF-Token` header
- Rate limit 20/min/user
- Multipart stream → `/data/tmp/upload-<uuid>` while computing sha256 and MIME-sniffing magic bytes
- On close: look up `(group_id, hash)` — if exists, delete temp + return existing row
- Else: verify MIME in allowlist (images, video, audio, pdf, zip for exports), rename temp to `/data/assets/<hash>.<ext>`, insert row, audit_log
- Cap 100 MB per file
- SVG → forced `Content-Disposition: attachment` at serve time unless sanitised via `svg-sanitizer`

**4.6 Asset streaming endpoint**

`GET /api/assets/[id]?w=<width>`:
- `requireSession(req)` + `SELECT ... WHERE group_id = ?`
- `Range: bytes=…` honoured — return 206 partial content with correct headers
- `?w=320|640|1280` returns pre-resized variant (populated in Phase 7)
- `Cache-Control: private, max-age=3600, immutable` (hash-based id = safe)

**4.7 Upload progress UX**

`XMLHttpRequest` (for `progress` event) wrapped in the upload helper — progress bar appears for any upload > 1 MB; shows bytes + percent; cancel button aborts the request.

**Success:**
- [ ] Two browser tabs, two users, same note: typing in one appears in the other within 150 ms
- [ ] Remote text cursors visible with correct name + accent colour
- [ ] Slash menu opens on `/` and inserts every listed block
- [ ] `[[atox` opens wikilink picker; Enter inserts a working link
- [ ] Pasted screenshot uploads and appears inline in both tabs
- [ ] 50 MB video drag-drop shows progress bar, uploads, plays + seeks in both tabs
- [ ] Drag handle reorders blocks without losing collab cursors
- [ ] Closing a tab mid-type: reopen shows every character
- [ ] Vault re-upload while editor open → "Vault updated, reloading…" banner → editor reloads fresh state
- [ ] Upload endpoint rejects calls without CSRF token
- [ ] 21 upload attempts in one minute → 429

---

### Phase 5 — Presence: mouse pointers + "Who's here" (1 day)

**5.1 Extended awareness**

```ts
type Awareness = {
  user:    { name: string; color: string; colorLight: string };
  cursor?: YTextCursor;                     // set by CollaborationCursor
  pointer?: { xRel: number; yRel: number }; // normalised to content scrollHeight/scrollWidth
  viewing?: string;                         // current note path
  scrollY?: number;                         // for out-of-viewport indicator
};
```

**5.2 Pointer overlay**

`components/PointerOverlay.tsx`:
- Subscribes to `provider.awareness.on('change', ...)`
- `onMouseMove` on content root, `requestAnimationFrame`-throttled to 60 Hz
- Computes **document-relative** `{xRel, yRel}` (normalised to content root's `scrollWidth × scrollHeight`, **not** viewport) — so pointing at "line 30 of the doc" stays there regardless of remote user's scroll
- Broadcasts; clears on `mouseleave`
- Remote pointers rendered absolutely within content root. If a remote pointer's Y is outside the current viewport, render a ghost indicator at the viewport edge: "↑ Alex — 320 px above" that scrolls into view on click

**5.3 Presence panel**

`components/PresencePanel.tsx` top-right:
- Row of avatars (initials + accent dot)
- Hover: "Alex is viewing *Atoxis*"
- Click: navigate to their current note

Driven by a single shared awareness connection on a reserved `/collab/.presence` doc (content-less, awareness-only). One persistent WebSocket for online presence separate from per-note WSes.

**5.4 Cursor-label styling**

Override `@tiptap/extension-collaboration-cursor` default CSS:
- Label pill uses user's `colorLight` background, `--ink` text
- Caret 2 px wide in user's accent colour
- Label visible while cursor is active; fades after 2 s of inactivity (keeps caret)
- Contrast ratio ≥ 4.5 : 1 on parchment

**Success:**
- [ ] Two tabs, two users: each sees the other's avatar in the top bar
- [ ] Both on same note: remote mouse moves smoothly at 60 Hz
- [ ] Remote pointer that scrolls their view does NOT move in mine — it stays at the document position they moved to
- [ ] Remote pointer outside my viewport → edge indicator; click scrolls into view
- [ ] Navigate to different note → their pointer disappears, presence panel still shows them
- [ ] Close tab → drops from presence within ~2 s

---

### Phase 6 — Mind-map graph (Sigma.js) (1.5 days)

**6.1 Graph endpoints**

`GET /api/graph?scope=all|folder:<path>|tag:<tag>`:
- Returns `{ nodes: [{id, title, tags, degree}], edges: [{source, target}] }`
- ETag = `SHA1(MAX(notes.updated_at))` — client re-validates with `If-None-Match`
- Typical response at 1500 notes: ~300 KB JSON

`GET /api/graph/neighborhood/[...path]?depth=1`:
- Returns the subgraph of `path` and its 1-hop neighbours
- Used by `MiniGraph` on note pages; much lighter than loading the full graph per note

**6.2 Full-screen graph page**

`app/graph/page.tsx` — client component, full viewport.

Stack:
- `graphology` in-memory graph
- `graphology-layout-forceatlas2/worker` — layout runs in a web worker so main thread stays 60 fps during drag
- `sigma` for WebGL render

Node style:
- Radius `3 + 1.5 * sqrt(degree)`
- Fill: priority-ordered tag category — villain → wine, location → moss, ally/official → sage, session → embers, else `--ink-soft`. Priority documented in `graphStyle.ts`.
- Label visibility: always on when zoom > 1.2; only for hover + 1-hop neighbours below

Edge style:
- 40 % opacity default; hover-node pops 1-hop to `--candlelight`, others fade to 10 %

Interactions:
- Click → `/notes/[path]`
- Shift-drag → pin node (persist pin in `localStorage` per group)
- Double-click → recentre + zoom
- Right-click → tag/folder filter popover

Controls panel (top-left card):
- Scope selector (all / campaign 1 / campaign 2 / campaign 3 / any folder)
- Tag multi-filter
- "Recentre" + zoom ± / fit

**6.3 Mini-graph on note pages**

`components/MiniGraph.tsx` — 280 × 280 Sigma canvas, seeded from `/api/graph/neighborhood/[path]`. Click a neighbour → navigate.

**Success:**
- [ ] Full graph of current 210-node vault loads in < 1 s, stays 55+ fps while panning
- [ ] Synthetic 1500-node fixture renders smoothly — measured frame time < 18 ms p95
- [ ] `tag:villain` filter reduces graph to that cluster; unfilter restores
- [ ] Mini-graph shows correct 1-hop neighbourhood; click navigates
- [ ] Pinned nodes persist across page reloads

---

### Phase 7 — Search, tags, landing page, image variants (1 day)

**7.1 Command palette**

`components/CmdK.tsx` — Cmd/Ctrl-K overlay, `@headlessui/react` Combobox.
- Query hits `/api/search?q=` → FTS5 `snippet()` per hit
- Groups: Notes → Tags → Folders → People (for future)
- Keyboard-navigable; Enter opens
- Search also matches frontmatter values (`status:dead` etc.) when query starts with `field:value` syntax

**7.2 Tag index**

`app/tags/page.tsx` — grid of every tag with count; click → `/tags/[tag]` list.

**7.3 Landing page**

`app/page.tsx`:
- Hero card: last-upload summary (timestamp, admin, counts)
- "Recently updated" top 12 by `notes.updated_at`
- Campaign shortcut cards (linked to the three campaign overview notes)
- "Jump to graph" CTA

**7.4 Image variants**

On asset upload and ingest, also generate 320 / 640 / 1280 px widths via `sharp`, stored as `<hash>-<w>.<ext>` beside the original. `<img srcset>` in Embed uses them; `/api/assets/[id]?w=640` returns the closest.

**Success:**
- [ ] Cmd-K → "bail" → Bailin top hit in < 150 ms
- [ ] `/tags` lists every tag with correct count
- [ ] `status:dead` in Cmd-K returns NPC notes with that frontmatter
- [ ] Typical note image under 200 KB on mobile

---

### Phase 8 — Retire the plugin + polish (0.5–1 day)

**8.1 Delete legacy**

- `rm -rf plugin/`
- Remove `@compendium/plugin` from workspaces
- Delete `/api/installer`, `/api/plugin/bundle`, `/api/plugin/version`, `/install/[os]` routes
- Delete `server/src/lib/installer/`
- Delete `server/src/ws/setup.ts`
- Archive `SYNC_FIX_PLAN.md` + `scripts/dedupe-vault.ts` → `docs/archive/`
- Migration v8 drops `text_docs` and `binary_files` tables

**8.2 Update docs**

- `ARCHITECTURE.md` — rewrite intro to link this plan; preserve pre-pivot architecture in an appendix
- `README.md` — new getting-started: install → seed admin → log in → upload ZIP → invite users → edit
- `docs/operations.md` — backup/restore, env vars, Railway volume monitoring

**8.3 Pack-vault helper**

`scripts/pack-vault.sh` — zips a local Obsidian vault (excludes `.obsidian/`, `.trash/`), prompts for admin password, POSTs to `/api/admin/vault/upload` with `X-CSRF-Token`. One command to re-seed.

Also `scripts/pack-vault.ps1` for Windows so the admin on that OS isn't blocked.

**8.4 Dark mode (optional polish)**

CSS variable swap on `html[data-theme="dark"]`. Parchment → charcoal; ink → parchment. Accents muted-yet-vibrant on dark.

**Success:**
- [ ] `bun install` at repo root drops the plugin workspace cleanly
- [ ] No references to `@compendium/plugin`, `obsidian`, `y-codemirror.next`, `y-websocket`, `ws/setup.ts` anywhere
- [ ] Railway deploy: login + upload + edit + cursor + pointer + graph all green on a live URL
- [ ] `scripts/pack-vault.sh` + `.ps1` both upload a fresh vault in < 30 s
- [ ] `text_docs` + `binary_files` dropped; `audit_log` preserves the history

---

## Operations & disaster recovery

**Backups:**
- Nightly cron inside the container: `sqlite3 /data/compendium.db ".backup /data/backups/$(date +%F).db"` — keeps 7 daily + 4 weekly
- `/data/assets/` sync'd to admin's local dev box weekly via `rsync` (manual for v1; automated job later)
- Admin dashboard surfaces "Last backup" time and volume usage %

**Restore:**
- Documented playbook: stop container → `cp /data/backups/<date>.db /data/compendium.db` → restart → last-N changes lost (limited by backup cadence)

**Observability:**
- Structured JSON logs via `extension-logger` + our own `log()` helper (request ID, user ID, path, duration)
- Admin dashboard shows: connected WS count, active docs, volume %, last ingest timings, top-10 noisiest paths by update rate
- Error reporting: log `err.stack` on route-handler throws; Sentry integration deferred

**Rate-limit matrix:**

| Endpoint | Limit | Key |
|---|---|---|
| `POST /api/auth/login` | 10 / 5 min | IP |
| `POST /api/assets/upload` | 20 / 1 min | session |
| `POST /api/admin/vault/upload` | 5 / 1 hour | session |
| `GET /api/*` | 300 / 1 min | session |

In-memory bucket (reuse `ratelimit.ts`), persists restart-less. Switch to Redis when horizontal.

---

## Risk matrix

| Risk | Prob | Impact | Mitigation |
|---|---|---|---|
| Tiptap MD round-trip loses nested Obsidian callouts or HTML | High | Content drift on re-import | Phase 2 round-trip fidelity test (build fails on regression) |
| Admin re-upload wipes in-progress edits | High | Minutes of typing lost | Confirmation checkbox + presently-editing list + 5 s arm delay + hocuspocus disconnect + client auto-reload banner |
| ZIP bomb or path traversal | Medium | Fill disk / escape | 50 MB/file, 1 GB uncompressed total, reject `..`/null/drive-letter, MIME-sniff magic bytes |
| Untrusted markdown/HTML XSS | High | Site compromise | `rehype-sanitize` in MD→PM walker; Tiptap schema rejects raw `<script>`; strict CSP; SVG served as attachment unless sanitised |
| Wikilink resolver picks wrong same-basename target | High | Broken links | Resolution order: exact path → alias → basename → suffix; ambiguity indicator on hover; log every ambiguous resolve |
| Session hijack over HTTP | Medium | Account takeover | `Secure` cookie in prod, HSTS, Rail way HTTPS enforced, session rotation on login |
| CSRF on upload endpoints | Medium | Malicious upload | Double-submit CSRF token for non-action POSTs; Server Actions for everything else |
| Railway 5 GB volume fills with video | Medium | Upload failures | Admin dashboard shows volume %; migrate to R2 at 80 %; swap is ~1 file |
| Sigma graph chokes beyond 1500 nodes | Low at target | Poor UX | Layout in web worker; LOD labels; headroom to 50k |
| Hocuspocus doc GC races with ingest | Low | Clients stuck on stale state | Ingest calls `collabServer.closeConnections` before commit |
| Tiptap extension moves to Pro tier | Low | License creep | DragHandle template already shows the DIY pattern; BlockNote is fallback editor (~2 d migration) |
| Large note (> 5 MB) chokes editor | Low | Slow typing | Ingest rejects > 5 MB; users split the note |
| WebSocket blocked by corporate proxy | Medium | Friend can't edit live | Documented workaround; long-polling fallback deferred |

---

## Rollback plan

1. All work on the `compendium-ai` branch; one commit per phase
2. Phases 1–7 are additive — `git revert <sha>` rolls back cleanly
3. Phase 8 deletes the plugin; only run after web app has been live for 3 days with real use
4. Before every Railway deploy that includes a migration: SSH into container, `sqlite3 /data/compendium.db ".backup /data/backups/pre-<sha>.db"`
5. Migrations forward-only; a failed migration rolls back inside its transaction; schema_version stays unincremented
6. If a phase's success criteria can't be met, do not merge — fix or descope, document in plan

---

## Coding standards (non-negotiable, consolidated)

From `.claude/rules/*` and `.claude/languages/{typescript,nextjs}/*`:

**TypeScript:**
- No `any`. `unknown` + narrow, or define a real type
- Explicit return types on every exported function
- `interface` for object shapes, `type` for unions

**Validation:**
- Zod at every API boundary, request and response
- Validate admin ZIP entries (path, size, MIME) before touching the DB

**Next.js 15:**
- `export const dynamic = 'force-dynamic'` on every route reading auth state
- `requireSession(req)` / `requireAdmin(req)` before any DB read on non-public routes
- Async dynamic params: `params: Promise<…>` + `await ctx.params`
- State-changing forms via Server Actions (origin-checked)

**Database:**
- Parameterised queries only
- One logical change per migration; additive `ALTER` with safe defaults; never edit a shipped migration
- Foreign keys on (`PRAGMA foreign_keys = ON`)
- Every scoped table has `group_id` from day 1

**Security:**
- bcrypt cost 12; Argon2id if we ever revisit
- HttpOnly + Secure + SameSite=Lax cookies
- Double-submit CSRF token for non-Action POSTs
- Rate-limit login (10/5min), upload (20/min), admin upload (5/hour), API (300/min)
- Never log passwords, session IDs, bcrypt hashes, auth cookies, asset bytes
- Strict CSP + HSTS + X-Frame-Options + nosniff + Referrer-Policy
- `rehype-sanitize`-equivalent schema in MD→PM walker
- SVG served as attachment unless sanitised via `svg-sanitizer`
- MIME-sniff every upload via magic bytes; reject content-type spoofing

**WebSocket:**
- Auth by session cookie only; never query-string tokens
- Per-note doc name; scoped to group via `context.groupId`
- `collabServer.closeConnections(path)` after destructive ingest

**Tests:**
- `bun test` on pure helpers: `ingestMarkdown`, wikilink resolver, alias expansion, bcrypt round-trip, ZIP entry validator, session rotation, magic-byte MIME sniffer
- Phase 2: MD round-trip fidelity test against the fixture ZIP
- Phase 4: Playwright E2E — login → upload → edit → second tab sees change (deferred if time)

---

## Verification commands

Per phase:
```bash
bun run typecheck
bun test
bun --filter '@compendium/server' run build
```

Post-phase 5 smoke:
```bash
# Terminal A: dev server
cd server && bun run server.ts

# Terminal B: sanity
curl -sI http://localhost:3000/api/health
curl -sI http://localhost:3000/                 # 302 → /login
curl -s -c c.txt -b c.txt -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<printed-at-boot>"}'
curl -s -b c.txt http://localhost:3000/api/tree | jq '. | length'
```

Browser smoke: two tabs, two accounts, same note → cursors + pointers + edits flow.

---

## Execution notes for the AI runner

1. Work phase-by-phase. Each phase ends with every success criterion verified, a short manual test, and a commit.
2. **Do not touch the plugin workspace until Phase 8** — it is the fallback while the web app bakes.
3. Keep the existing WS server (`server.ts` upgrade + `ws/setup.ts`) compiled and dormant through Phase 3; Phase 4 mounts hocuspocus at `/collab` in one atomic commit.
4. Run the ingest fidelity test (Phase 2, § 2.6) before merging Phase 2 — this catches Tiptap schema drift early.
5. If a rule in `.claude/rules/*` or `.claude/languages/*` conflicts with a concrete line in this plan, follow the rule and flag the conflict in the PR body.
6. Never log a password, session ID, cookie, CSRF token, or asset bytes.
7. At each Railway deploy, back up the SQLite DB first.

---

## Success criteria (overall)

- [ ] Five friends across three cities open the same note and see each other's text cursors, mouse pointers, and typing in real time.
- [ ] Notion-style slash menu, block drag handles (our own implementation), and wikilink popovers all work.
- [ ] Admin uploads a ZIP; within 30 s all clients reload with the fresh state; re-upload is confirmation-gated.
- [ ] Embedded images, videos, and PDFs play / preview; videos seek.
- [ ] Mind-map graph of 1500 synthetic nodes renders at 55+ fps; current 210-note vault instant.
- [ ] `notes.yjs_state` is the only source of truth for note content; `content_md` + `content_text` are caches.
- [ ] Every API boundary Zod-validated; every non-public route session-gated; every upload CSRF-gated.
- [ ] Every response carries the security header pack.
- [ ] `audit_log` records every admin action.
- [ ] Obsidian plugin workspace deleted; one `bun install` at repo root produces a lean tree.
- [ ] No Tiptap Pro extensions installed; `package.json` verified against the Pro list.
- [ ] Ingest fidelity test passes in CI.
- [ ] `WEB_APP_PLAN.md` retired to `docs/archive/` when every criterion above is green.
