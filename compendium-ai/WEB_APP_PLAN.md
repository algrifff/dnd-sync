# Compendium Web App — Pivot Plan

**Target:** replace the Obsidian plugin with a self-hosted web app that friends log into, with Google-Docs-style live editing and visible remote mouse pointers.
**Date:** 2026-04-18
**Planner:** Claude (AI)
**Estimated effort:** 7–9 dev days across eight phases
**Success metric:** five friends open the same note in their browsers; every keystroke, text cursor, and mouse pointer shows up on the others' screens in <150 ms; admin re-seeds the vault by uploading a ZIP.

---

## Current state assessment

**Code health score: C** — the Yjs + WebSocket plumbing is conceptually sound but brittle because it tries to bridge Obsidian's vault with a CRDT. The split state (disk file ↔ ytext ↔ editor via yCollab ↔ server) gave us five distinct race windows, each one capable of corrupting content. Live sync keeps breaking because we can't observe what's happening inside Obsidian's editor lifecycle.

| Metric | Current | Target | Status |
|---|---|---|---|
| Sources of truth per note | 3 (disk, ytext, editor buffer) | 1 (ytext) | ❌ |
| Live-sync reliability | Flaky, cursors + edits disappearing | Edits + cursors + pointers always propagate | ❌ |
| Conflict pathways | 4 (offline merge, file-open race, cleanup drift, baseline staleness) | 1 (pure CRDT merge) | ❌ |
| Time-to-recover from corruption | Manual script + server wipe | Impossible by design | ❌ |
| Required admin tools for sync | 2 (plugin, server) | 1 (web app) | ❌ |

---

## Identified issues motivating the pivot

| Priority | Issue | Impact |
|---|---|---|
| P1 | Obsidian editor state + on-disk file + ytext triple-sync → content corruption | Data loss (Phase 3 compounding-merge incident) |
| P1 | yCollab binding runs inside Obsidian's plugin host — no observable lifecycle, races with auto-save | Live edits + cursors disappear without clear cause |
| P1 | Per-file WebSocket; 200+ simultaneous handshakes on startup saturate Railway | Cold-start thrash, false "disconnected" states |
| P2 | Friends must install a plugin bundle (OS installer, token paste, occasional manual update) | Bad UX for non-technical friends |
| P2 | No graph/mind-map view outside Obsidian itself | Admin loses the wiki-link overview when not on their main machine |

---

## Why the CRDT approach survives the pivot

The technical pattern (Yjs + y-websocket + y-codemirror.next) was **never** the problem — the problem was bolting it onto Obsidian's file-backed editor. In a plain web page we own the *entire* editor lifecycle:

- `ytext` is the only copy of the note.
- CodeMirror 6 binds to it directly via yCollab; no file auto-save firing in parallel.
- No "pull from disk on startup → overwrite ytext" reconcile step.
- No `.obsidian/` dotfolders, no file watchers, no vault event soup.

Yjs was designed for exactly this use case.

---

## Refactoring strategy

**Approach:** new product surface (web app), reusing the proven Yjs sync core on the server, shedding the Obsidian plugin entirely. The existing `@compendium/server` workspace is extended — no new project.

**Pattern applied:** Single Source of Truth per note (the server's persisted Yjs state), Observer pattern for presence (Awareness), and Thin Client (all rendering happens browser-side from ytext + awareness).

---

## Tech stack (pinned)

| Layer | Choice | Why |
|---|---|---|
| App framework | Next.js 15 App Router | Existing server already on it |
| Runtime / PM | Bun 1.1 | Existing |
| Auth | `iron-session` + bcrypt | HttpOnly cookies, no third-party auth service, fits trusted-group model |
| DB | SQLite via `better-sqlite3` | Existing; extend schema |
| CRDT | Yjs + `y-websocket` + `y-protocols` | Same libs the server already uses |
| Editor | CodeMirror 6 + `y-codemirror.next` | Direct browser use — no Obsidian shell |
| Live pointers | Custom awareness field + React overlay | No extra library |
| Markdown render | `react-markdown` + `remark-gfm` + `remark-wiki-link` + `rehype-sanitize` | Standard pipeline |
| Graph | `react-force-graph-2d` | D3 force-directed, handles 500+ nodes |
| Upload | Next route handler + `adm-zip` + streaming | Admin-only |
| Validation | Zod | Every API boundary (rule: `.claude/languages/typescript/security.md`) |
| Styling | Tailwind CSS v4 | Already configured |
| Icons | `lucide-react` | Calm, line-based |
| Display font | Fraunces (H1 only) + Inter | Leather-book feel where it matters |

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
| `--sage` | `#6B7F8E` | Ally/official category |
| `--embers` | `#B5572A` | Session / event category |
| `--shadow` | `#1E1A15` | Deep contrast |

Each live user also gets a picked-from-a-palette accent colour for cursor + pointer. Palette: `#D4A85A, #7B8A5F, #8B4A52, #6B7F8E, #B5572A, #6A5D8B` (last is a violet for variety). Assigned stable per-user on account creation.

### Texture

`public/textures/paper.svg` subtle-grain SVG, 6 % opacity, `background-blend-mode: multiply` on the canvas. No heavy skeuomorphism; just enough tooth that it doesn't feel like a spreadsheet.

### Shape language

Milanote-flavoured: 12 px radii, soft borders, no drop shadows except floating menus. Cards lift ~2 % on hover. Buttons scale to 1.02 on hover. Type sizes inherited from Notion's scale, but body bumped to 17 px / line-height 1.7 for comfortable reading.

### Dark mode

Deferred to Phase 8 polish. Ship light first.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Browser                                                             │
│    ┌────────────────────────────────────────────────────────────┐    │
│    │ Next.js 15 pages + React                                   │    │
│    │   /login /admin /notes/[...] /graph /tags                  │    │
│    │ Components:                                                │    │
│    │   FileTree · NoteReader · NoteEditor (CodeMirror+yCollab)  │    │
│    │   GraphCanvas · PointerOverlay · PresencePanel · CmdK      │    │
│    └────────────────────────────────────────────────────────────┘    │
│                 │ REST + WS                                          │
└─────────────────┼────────────────────────────────────────────────────┘
                  │
┌─────────────────▼────────────────────────────────────────────────────┐
│  Node.js (server.ts, same process)                                   │
│    Next.js App Router route handlers                                 │
│    ┌───────────────────────────────────────────────────────────────┐ │
│    │ /api/auth/{login,logout}   /api/admin/{users,vault/upload}    │ │
│    │ /api/notes/[...path]       /api/tree    /api/backlinks/…      │ │
│    │ /api/graph                 /api/search  /api/assets/[...path] │ │
│    └───────────────────────────────────────────────────────────────┘ │
│    WebSocket upgrade handler                                         │
│    ┌───────────────────────────────────────────────────────────────┐ │
│    │ ws://host/sync/<encoded-path>                                 │ │
│    │   auth: session cookie (no URL token)                         │ │
│    │   → ws/setup.ts → y-websocket sync + awareness                │ │
│    └───────────────────────────────────────────────────────────────┘ │
│    SQLite (compendium.db)                                            │
│      users · sessions · text_docs(path, yjs_state, text_cache)       │
│      note_links · tags · binary_files · text_docs_fts                │
└──────────────────────────────────────────────────────────────────────┘
                           Railway (Docker, /data volume)
```

**Key simplifications vs. the plugin world:**
- There is no vault on disk. `text_docs.yjs_state` is the only copy.
- One WebSocket per note the user is currently viewing — usually 1–2, never 200.
- Auth cookie travels automatically on WS upgrade; no query-string tokens.
- `text_cache` is a denormalised copy of `ytext.toString()` kept in sync on every persist, purely for FTS and graph ingest. Never read by the editor.

---

## Phases

Execute in order. Each ends with `bun run typecheck`, listed success criteria verified, one commit with message `web: phase N — <summary>`.

### Phase 1 — Auth, sessions, user model (0.5–1 day)

**1.1 Migration v6 — users + sessions**

`server/src/lib/migrations.ts`:
```sql
CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email          TEXT COLLATE NOCASE,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('admin','friend')),
  display_name   TEXT NOT NULL,
  accent_color   TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER
);
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);
```

One logical change per migration — `friends.last_seen_at` from v5 stays as-is; v6 adds `users`/`sessions`.

**1.2 Auth module**

`server/src/lib/auth-web.ts`:
- `hashPassword(plain: string): Promise<string>` — bcrypt cost 12.
- `verifyPassword(plain: string, hash: string): Promise<boolean>`.
- `createSession(userId: string): string` — 32-byte random, 30-day expiry, insert row.
- `readSession(req: NextRequest): Session | null` — reads HttpOnly cookie, joins `users`, refreshes `last_seen_at` best-effort.
- `requireSession(req) → Session | Response`, `requireAdmin(req) → Session | Response`.

Cookie: `compendium.sid`, HttpOnly, `Secure` in prod, `SameSite=Lax`, `Path=/`, 30-day Max-Age. Follows `.claude/rules/security.md` (constant-time comparison not needed — random token is indexed, not compared).

**1.3 Zod schemas**

`shared/src/protocol.ts` additions:
```ts
export const LoginRequest = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});
export const CreateUserRequest = z.object({
  username: z.string().regex(/^[a-z0-9_-]{3,32}$/i),
  displayName: z.string().min(1).max(64),
  password: z.string().min(8).max(256),
  role: z.enum(['admin','friend']),
  email: z.string().email().optional(),
});
```
Validated server-side in the route handlers.

**1.4 Login page + middleware**

- `app/login/page.tsx` — single form, client component, uses Server Action for the POST.
- `middleware.ts` — every request outside `/login`, `/api/auth/*`, `/api/health`, `/_next/*`, `/public/*` must have a valid session cookie; else 302 to `/login?next=<encoded>`.
- Admin-only pages (`/admin/**`) require `role==='admin'` — render 403 page, don't leak existence via redirect.

**1.5 Seed admin on first boot**

Extend `ensureConfig()` — if no users exist, create `admin` with a freshly-generated 24-char password; print password to stdout ONCE (same pattern as existing admin token). Log nothing after that.

**Success criteria:**
- [ ] Fresh DB: first `bun start` prints `admin password: XXXXX` exactly once.
- [ ] Visiting `/` unauthenticated → redirect to `/login?next=/`.
- [ ] Correct login → cookie set, redirect to `next`.
- [ ] Wrong password → "Unknown username or password" (same message — don't leak which is wrong).
- [ ] `POST /api/auth/logout` clears cookie + deletes the session row.
- [ ] `/admin/*` returns 403 for friends.

---

### Phase 2 — Ingestion pipeline (1 day)

**2.1 Schema extensions — migration v7**

```sql
CREATE TABLE note_links (
  from_path TEXT NOT NULL,
  to_path   TEXT NOT NULL,
  PRIMARY KEY (from_path, to_path)
) WITHOUT ROWID;
CREATE INDEX note_links_to ON note_links(to_path);

CREATE TABLE tags (
  path TEXT NOT NULL,
  tag  TEXT NOT NULL,
  PRIMARY KEY (path, tag)
) WITHOUT ROWID;
CREATE INDEX tags_tag ON tags(tag);

ALTER TABLE text_docs ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE text_docs ADD COLUMN frontmatter_json TEXT NOT NULL DEFAULT '{}';
```

`text_docs.text_content` already exists and serves as the FTS + ingest cache.

**2.2 Markdown parser**

`server/src/lib/markdown.ts` — pure, testable:
```ts
export type ParsedNote = {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
  wikilinks: string[];      // resolved paths (see resolver below)
  tags: string[];           // frontmatter tags + inline #tags
};
export function parseNote(path: string, raw: string, allPaths: ReadonlySet<string>): ParsedNote;
```

Wikilink resolver (in order):
1. Exact match by path (case-insensitive).
2. Exact match by `path.basename` (filename without extension).
3. Suffix match — longest wins; tie-breaker is shortest full path.
4. Unresolved → keep the raw `[[label]]` stored as edge with `to_path = '__orphan__:label'` so the graph can render a ghost node.

Unit tests cover each branch + edge cases (case-only difference, two notes with same basename, circular links).

**2.3 Admin upload endpoint**

`app/api/admin/vault/upload/route.ts`:
- `POST` multipart with ZIP field `vault`.
- Admin-only, `export const dynamic = 'force-dynamic'`, no caching.
- Stream to `/data/tmp/upload-<uuid>.zip` (reject > 500 MB up front via `Content-Length`).
- `adm-zip` iterate entries:
  - Skip `.obsidian/**`, `.trash/**`, `.DS_Store`, `__MACOSX/**`.
  - `.md`/`.canvas` → `parseNote` → insert/update `text_docs`, populate `note_links` + `tags`. For each ingested note, build a fresh `Y.Doc`, seed its content, `Y.encodeStateAsUpdate` → store as `yjs_state`.
  - Binary extensions → insert/update `binary_files`.
- Everything inside one `db.transaction()`.
- After commit, destroy any in-memory SharedDoc via `destroyDoc(path)` (from `ws/setup.ts`) so next reader rehydrates fresh state.
- Response: `{ notes: N, assets: M, links: K, tags: T, durationMs: D }`.

**2.4 Confirmation UX on re-upload**

If `text_docs` is non-empty, the admin page requires an explicit "I understand this replaces all notes, including any in-progress live edits" checkbox before the button enables. Prevents accidental clobber.

**Success:**
- [ ] ZIP of current vault (~10 MB) ingests in < 20 s.
- [ ] `SELECT COUNT(*) FROM text_docs` == markdown count in ZIP.
- [ ] `note_links` has reasonable count (spot-check: Atoxis has ≥6 outbound edges).
- [ ] Re-upload replaces cleanly; old paths dropped from `text_docs`.
- [ ] Running clients (Phase 5 onward) are disconnected on re-upload and reconnect with fresh state.

---

### Phase 3 — Reader UI (read mode) (1–1.5 days)

Three-pane layout with Milanote generosity.

```
┌────────────────┬──────────────────────────────┬────────────────┐
│  Folder tree   │  Note render                 │  Backlinks     │
│  (sidebar)     │  (main)                      │  + outline     │
│                │                              │  + mini-graph  │
│  Campaigns/    │  # Atoxis                    │                │
│   C1/          │                              │  Mentioned in  │
│   C2/          │  ![](token_atoxis.png)       │  ·  Bailin     │
│   C3/          │                              │  ·  Vacant…    │
│    NPCs/       │  ## Overview                 │                │
│     Atoxis ◉   │  A demon prince…             │  Tags          │
│     Bailin     │                              │  [villain]     │
└────────────────┴──────────────────────────────┴────────────────┘
```

**3.1 Tree component**

`components/FileTree.tsx`, client component. Recursive folders, chevrons, active-path highlight with `--candlelight` at 15 % opacity. Expansion state per-user in `localStorage`. Keyboard nav (arrow keys, Enter).

**3.2 Note page**

`app/notes/[...path]/page.tsx` — server component.
- Load note by path (404 if missing).
- Render markdown via `react-markdown` + plugins, with a **custom renderer** for wikilinks that points to `/notes/{resolved-path}` and applies a dotted underline.
- `rehype-sanitize` configured to allow `class` and a whitelist of HTML tags (Obsidian users sometimes embed `<div class="callout">`).
- `![[Assets/...]]` embeds → `<img src="/api/assets/{encoded}">`.
- The page also mounts a client-side `NoteFooter` and `PresencePanel` for Phase 5/6; wire up now with empty implementations.

**3.3 Backlinks + outline + mini-graph slots**

`components/NoteSidebar.tsx`:
- **Backlinks** — `SELECT from_path FROM note_links WHERE to_path = ?`, grouped by folder.
- **Outline** — H2/H3 of the current note.
- **Tags** — pills with `--candlelight-soft` background, clickable → `/tags/{tag}`.
- **Mini-graph** slot (rendered in Phase 6).

**3.4 Style pass**

Apply the D&D palette + texture. Content column max-width 720 px. H1 in Fraunces 40 px. Body Inter 17/1.7. Card hovers lift 2 %. Muted category dots next to tag pills using the palette mapping.

**Success:**
- [ ] Clicking a tree entry navigates without full reload (Next.js App Router client nav).
- [ ] `[[Atoxis]]` in Bailin's note → link to `/notes/Campaigns/Campaign%203/NPCs/Villains/Atoxis`.
- [ ] Backlinks panel shows ≥6 references for Atoxis.
- [ ] Embedded `![](...)` images render.
- [ ] Mobile: tree becomes a slide-out drawer, right sidebar stacks below content.
- [ ] Lighthouse A11y score ≥ 95 on a sample note.

---

### Phase 4 — Live collaborative editor (1.5 days)

The centrepiece. CodeMirror 6 + Yjs + y-websocket, directly in the browser.

**4.1 Server WS handler (auth by cookie)**

Replace the token-based upgrade check in `server.ts`:
- Parse `Cookie: compendium.sid=...` header.
- Validate against `sessions` table.
- On failure → `HTTP/1.1 401\r\n` and destroy.
- On success → stash `userId + username + accentColor + displayName` on the `req` via a symbol, `wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))`.

The existing `ws/setup.ts` stays mostly as-is. Simplifications:
- Remove `.preflight` branch (not needed without the settings-test button).
- `touchFriendLastSeen` becomes `touchUserLastLogin` against `users.last_login_at`.
- `destroyDoc` is called from the ingest route, already wired.

**4.2 Editor component**

`components/NoteEditor.tsx` (client):
```tsx
// Props: path, user (from session), onEditingChanged
// State: Y.Doc + WebsocketProvider, CodeMirror EditorView
// Mount:
//   - new Y.Doc()
//   - new WebsocketProvider(`ws://host/sync/${encodeURIComponent(path)}`, null, doc,
//       { params: { /* empty — cookie carries auth */ } })
//   - provider.awareness.setLocalStateField('user', {
//       name: user.displayName, color: user.accentColor, colorLight: soften(color),
//     })
//   - editorView = new EditorView({
//       doc: '', extensions: [markdownExtension(), yCollab(ytext, provider.awareness, { undoManager: new Y.UndoManager(ytext) })],
//       parent: ref.current })
// Unmount: editorView.destroy(); provider.destroy(); doc.destroy()
```

Extensions:
- `markdown()` for syntax highlighting.
- `yCollab(...)` for CRDT binding + remote cursors.
- `EditorView.theme(...)` applying the D&D palette — line height 1.7, accent `--candlelight`, selection tint matches user colour.
- `EditorState.tabSize.of(2)`, soft-wrap on.

**4.3 Read ↔ Edit toggle**

Each note page has a `Read / Edit` segmented toggle (top-right of content column). Default = Read.
- Read mode renders the markdown from `text_docs.text_content` (fast server render) plus a thin WebSocket that only subscribes to remote updates → re-runs a debounced fetch so the reader sees others' edits within ~500 ms.
- Edit mode mounts the full `NoteEditor`. Character-level live sync + remote cursors.
- Switching Edit → Read destroys the editor cleanly.

**4.4 Persistence and cache**

Extend `server/src/lib/yjs-persistence.ts`:
- On every persist (debounced 300 ms), also write `ytext.getText('content').toString()` into `text_docs.text_content`, and re-run the wikilink/tag extractor to update `note_links` + `tags`.
- FTS trigger already refreshes from `text_content`.
- Title updates too: scan for first `# ` line; fallback to basename.

**4.5 Wikilink autocomplete**

CodeMirror extension that on `[[` opens a small popup listing all paths with fuzzy match. Enter inserts `[[Resolved Title|Path]]`. Implemented with `@codemirror/autocomplete`. Data source = small `/api/tree?flat=1` fetch cached client-side.

**Success:**
- [ ] Two browsers, same note in Edit: typing in one appears in the other within 150 ms.
- [ ] Remote text cursors visible with user's name + colour.
- [ ] Closing the tab doesn't lose in-flight edits (persist flushes on WS close).
- [ ] Re-open after 5 minutes of edits → all changes there.
- [ ] Edit → Read toggle shows the edited content immediately.
- [ ] Typing `[[atox` in the editor opens autocomplete, Enter inserts a wikilink.

---

### Phase 5 — Presence: mouse pointers + "Who's here" (0.5–1 day)

**5.1 Mouse-pointer awareness channel**

Extend the awareness state shape:
```ts
type AwarenessState = {
  user: { name: string; color: string; colorLight: string };
  cursor?: YTextCursor;          // set by yCollab
  pointer?: { x: number; y: number; /* normalised 0..1 within content area */ };
  viewing?: string;              // current note path (same for read + edit)
};
```

**5.2 PointerOverlay component**

`components/PointerOverlay.tsx`:
- `useEffect` subscribes to `provider.awareness.on('change', ...)`.
- Track pointer on the content root via `onMouseMove`, throttle to 60 Hz with `requestAnimationFrame`, compute `{x,y}` as fraction of the content `<article>` bounding rect.
- Broadcast `awareness.setLocalStateField('pointer', {x, y})` — do NOT broadcast when mouse leaves the content area.
- Render one `<div>` per remote awareness state whose `viewing === currentPath`: fixed position, small SVG pointer icon in user's colour, label "Alex" in a pill beneath. CSS transition at 80 ms for smooth tracking.

**5.3 Presence panel**

`components/PresencePanel.tsx` shown at the top-right of every page: row of user avatars (initials + colour dot), current viewing note below on hover. Clicking an avatar navigates to their current note.

Driven by a single provider on a dedicated `/sync/.presence` room (no document content, just awareness). Each browser connects to this room once on login and keeps it open; it's how we learn who else is online even when we're on different notes.

**5.4 Cursor label polish**

Already rendered by yCollab but currently invisible on our parchment background. Override yCollab's CSS via the existing `cursorStyles` pattern but with D&D colours and better contrast (label pill uses the user's `colorLight`, text `--ink`).

**Success:**
- [ ] Two browsers open; presence panel on each shows the other's avatar.
- [ ] Both on same note: remote mouse moves visible within ~80 ms and track smoothly.
- [ ] Third tab opened on a different note: presence panel updates; no pointer rendered for that user.
- [ ] Closing a tab removes the user from the presence panel within ~2 s (awareness TTL).
- [ ] Cursor labels readable on parchment (contrast ratio ≥ 4.5:1).

---

### Phase 6 — Mind map graph (1 day)

**6.1 Graph data endpoint**

`GET /api/graph?scope=all|folder:<path>|tag:<tag>` returns
```ts
{ nodes: { id: string; title: string; tags: string[]; weight: number }[],
  edges: { from: string; to: string }[] }
```
Server-side query joins `text_docs` + `note_links` + `tags`. Cached behind an ETag keyed on `MAX(text_docs.updated_at)`.

**6.2 Full-screen graph page**

`app/graph/page.tsx` — client, full-viewport canvas. `react-force-graph-2d`.

Styling rules from the palette:
- Node fill: category colour from first matched tag (villain → `--wine`, location → `--moss`, ally → `--sage`, session → `--embers`, default → `--ink-soft`).
- Node radius: `3 + 1.5 * sqrt(in + out degree)`.
- Label: always-on at zoom ≥ 1; only hovered neighbours below 1.
- Edges: 40 % opacity default; hovering a node highlights 1-hop in `--candlelight`, dims others to 10 %.

Controls (top-left card):
- Scope selector.
- Tag multi-filter.
- "Recentre" button.
- Zoom in/out / fit.

Interactions: click → open note; shift-click → pin position; double-click → recentre on node.

**6.3 Mini-graph on note pages**

`components/MiniGraph.tsx` — 280 × 280, same library, scope = current note + 1 hop. Pre-computed server-side on request.

**Success:**
- [ ] Whole-vault graph loads in < 2 s and stays 55 fps while panning.
- [ ] Clicking Atoxis recentres visible cluster of connected NPCs + locations.
- [ ] Filter `tag:villain` reduces graph to that cluster; unfiltering restores.
- [ ] Mini-graph on a note shows correct 1-hop neighbourhood.

---

### Phase 7 — Search, tags, landing page (0.5–1 day)

**7.1 Command palette**

`components/CmdK.tsx` — Cmd-K / Ctrl-K overlay. Headless Combobox from `@headlessui/react`.
- Query hits `/api/search?q=` → FTS5 `snippet()` per hit.
- Groups: Notes (title + snippet) → Tags → Folders.
- Keyboard-only navigable; Enter opens.

**7.2 Tag index page**

`app/tags/page.tsx` — grid of every tag with usage count; click → `/tags/[tag]` listing notes.

**7.3 Landing page**

`app/page.tsx`:
- Last-upload summary (date, who, counts).
- "Recently updated" — top 12 notes by `updated_at` in `text_docs`.
- Campaign shortcuts — three cards linking to the campaign overview notes.
- "Jump to graph" CTA card.

**7.4 Asset image variants**

On ingest, generate 320/640/1280 widths via `sharp`; store with a `variant` column. `<img srcset>` in the markdown renderer. Image requests for `/api/assets/...?w=640` return the closest variant.

**Success:**
- [ ] Cmd-K → "bail" → Bailin as top hit in < 150 ms.
- [ ] `/tags` lists every tag with correct count.
- [ ] Typical note image under 200 KB on mobile.

---

### Phase 8 — Delete the Obsidian plugin; polish (0.5–1 day)

**8.1 Remove plugin workspace**

- `rm -rf plugin/`
- Delete `@compendium/plugin` from root `package.json` workspaces.
- Remove `/api/installer`, `/api/plugin/bundle`, `/api/plugin/version`, `/install/[os]` routes.
- Delete `server/src/lib/installer/` templates.
- Delete `scripts/dedupe-vault.ts` (no longer applicable).
- Archive `SYNC_FIX_PLAN.md` → `docs/archive/SYNC_FIX_PLAN.md`.

**8.2 Update ARCHITECTURE.md**

Replace the "Phase 1/2/3 plugin" sections with a summary that links to `WEB_APP_PLAN.md` as the active plan and preserves the historical pre-pivot architecture in an "Archive" appendix.

**8.3 Update README.md**

Getting-started:
```bash
mise install
bun install
cd server && bun run server.ts
# admin password printed once — save it.
# Visit http://localhost:3000 → log in.
# Admin page → Users → add friends.
# Admin page → Upload vault → drop a ZIP.
```

**8.4 Pack-vault helper**

`scripts/pack-vault.sh` — zips an Obsidian vault (excluding `.obsidian/`, `.trash/`), curls it with a prompted admin password. One command to re-seed.

**8.5 Dark mode (optional)**

CSS variable swap on `html[data-theme="dark"]`. Parchment inverts to near-charcoal (`#2A241E` canvas, `#F4EDE0` ink). Accents shift to vibrant-but-still-muted.

**Success:**
- [ ] Fresh `bun install` at root removes the plugin workspace cleanly.
- [ ] No dangling references to `@compendium/plugin`, `obsidian`, `y-codemirror.next` in the server workspace.
- [ ] Deploy to Railway: login + upload + edit + cursor + mouse + graph all green on a live URL.
- [ ] `scripts/pack-vault.sh` uploads the current vault in < 30 s.

---

## Risk matrix

| Risk | Prob | Impact | Mitigation |
|---|---|---|---|
| Admin re-upload wipes in-progress edits | High | Data loss (minutes of typing) | Confirmation checkbox on re-upload; print summary of connected users before the wipe; server `destroyDoc` kicks clients who show a "reload — vault was reseeded" banner |
| Session cookie hijack on HTTP | Medium | Account takeover | `Secure` cookie enforced in prod; HSTS header from Next.js; recommend deploying behind Railway TLS only |
| ZIP bomb or malicious path (`../`) | Medium | Fill disk / escape sandbox | Per-entry size cap (50 MB), total uncompressed cap (1 GB), reject any path containing `..`, `/`, `\`, or null |
| Untrusted markdown → XSS | High | Site compromise | `rehype-sanitize` with a schema; SVG uploads served as `Content-Disposition: attachment` by default; CSP header with `script-src 'self'` |
| Wikilink resolver picks wrong target for same-basename notes | High | Broken links | Show a subtle ambiguity indicator on hover; prefer exact path match; log every ambiguous resolve for admin review |
| Force graph chokes at 1k+ nodes | Low at current scale | Poor UX | Switch to canvas-based `sigma` if we hit that; current vault is ~210 notes |
| WebSocket behind corporate proxies | Medium | Friend can't connect | Document "try a personal hotspot"; consider long-polling fallback (`sockjs`) as a Phase 9 item |
| Yjs state corruption during concurrent ingest + edit | Low | Doc wipe | Ingest route takes a write lock; connected clients forced to reconnect after commit |

---

## Rollback plan

1. All work on the existing `compendium-ai` branch; each phase is its own commit.
2. Phases 1–7 are additive — `git revert <sha>` safely rolls back any phase.
3. Phase 8 deletes the plugin; only execute after the web app has been smoke-tested for at least 3 days with the full friend group.
4. Migration versions are forward-only; a failed migration rolls back inside its transaction.
5. Vault data lives in `text_docs.yjs_state`; before Phase 2 deploy, `sqlite3 compendium.db .dump > backup.sql` against the live Railway volume.

---

## Dependencies

- **Blocked by:** nothing.
- **Blocks:** Phase 3 of ARCHITECTURE.md (AI assistant). The chat tool calls will hit the same `text_docs` / `note_links` tables this plan builds.
- **Notify:** the five friend accounts before Phase 8 ships — they stop installing the plugin and start using the URL.

---

## Coding standards (non-negotiable)

Consolidated from `.claude/rules/*` and `.claude/languages/{typescript,nextjs}/*`:

**TypeScript**
- No `any`. Use `unknown` + narrow, or define a real type.
- Explicit return types on every exported function.
- `interface` for object shapes, `type` for unions.
- Validate external inputs with Zod at every API boundary.

**Next.js 15**
- `export const dynamic = 'force-dynamic'` on every route reading auth state.
- `requireSession(req)` or `requireAdmin(req)` before any DB read on a non-public route.
- Secrets stay server-side only. Never pass the session token, bcrypt hash, or admin password into a client component prop.
- Async dynamic params: `params: Promise<…>` + `await ctx.params` (Next 15 contract).

**Database**
- Parameterised queries only.
- One logical change per migration — append, never edit, never reorder.
- Additive `ALTER` with safe defaults so a half-migrated DB still reads.

**Security**
- bcrypt cost 12 for passwords.
- Cookie: HttpOnly, Secure in prod, SameSite=Lax.
- Rate-limit `/api/auth/login` at 10 attempts / 5 min / IP (in-memory bucket; reuse `ratelimit.ts`).
- Never log passwords, session IDs, bcrypt hashes, or cookies.
- `rehype-sanitize` between markdown parse and render.

**WebSocket**
- Auth by cookie only; never by URL token.
- Per-note room, keyed on canonical path.
- One `destroyDoc` call after each successful ingest.

**Testing**
- `bun test` on pure helpers: `parseNote`, wikilink resolver, bcrypt round-trip, ZIP entry validator, awareness encoder.
- Integration tests deferred — Phase 1's CI is `bun run typecheck && bun run build`.

---

## Verification commands

Per phase:
```bash
bun run typecheck
bun test                           # after Phase 2 + 4
bun --filter '@compendium/server' run build
```

End-to-end smoke (post-Phase 5):
```bash
# Terminal A
cd server && bun run server.ts

# Terminal B — curl sanity
curl -sI http://localhost:3000/api/health          # 200
curl -sI http://localhost:3000/                    # 302 → /login
curl -s -c cookies.txt -b cookies.txt -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<printed-at-boot>"}'
curl -s -b cookies.txt http://localhost:3000/api/tree | jq '. | length'
```

Browser smoke: two tabs (two user accounts), same note, cursors + pointers visible, edits flow.

---

## Execution notes for the AI runner

1. Work phase-by-phase. Each phase ends with every success criterion verified, a short manual test, and a commit.
2. Do **not** touch the plugin workspace until Phase 8 — it's the fallback while the web app bakes.
3. Keep the existing WS server running alongside the new cookie-based auth during phases 1–3; in Phase 4 flip the upgrade handler over and remove the `?token=` path.
4. If any phase's success criteria can't be met, stop and surface the block; do not hand-wave around it.
5. If a rule in `.claude/rules/*` or `.claude/languages/*` conflicts with a concrete line in this plan, follow the rule and flag the conflict in the PR body.
6. Never log a password, session ID, or awareness state containing a pointer coordinate that includes a PII-style cursor path.

---

## Success criteria (overall)

- [ ] Five friends across three cities can open the same note and see each other's cursors, mouse pointers, and typing in real time.
- [ ] Admin uploads a ZIP; within 30 s all clients are on the fresh state with a "Vault updated" banner.
- [ ] Mind-map graph of 210 notes renders at 55+ fps, clustered by tag.
- [ ] No single-source-of-truth contradictions; `text_docs.yjs_state` is the only copy of any note's content.
- [ ] Obsidian plugin is deleted; one `bun install` at repo root produces a lean workspace.
- [ ] Plan document (`WEB_APP_PLAN.md`) retired to `docs/archive/` once every success criterion is met.
