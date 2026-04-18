# Compendium Web App — Pivot Plan

**Target:** replace the Obsidian plugin with a self-hosted web app. Google-Docs-style live block editing, visible remote text cursors and mouse pointers, Notion-flavoured UX, D&D-parchment visual identity.
**Date:** 2026-04-18
**Planner:** Claude (AI)
**Estimated effort:** 8–10 dev days across eight phases
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
- Tiptap + `@tiptap/extension-collaboration` is the most widely shipped collaborative-editor combo in production today. Yjs was designed for this exact pairing.
- Hocuspocus, not our own ws/setup.ts, handles the server lifecycle. Every subtle race we hit (GC timing, double-broadcast, auth-on-upgrade) is solved upstream.

---

## Refactoring strategy

**Approach:** new product surface (web app), reusing the Yjs CRDT core, replacing CodeMirror with Tiptap, replacing our custom y-websocket server with hocuspocus, shedding the Obsidian plugin entirely.

**Pattern applied:** Single Source of Truth (ProseMirror JSON via Yjs), Thin Client (all rendering from ytext state), Content-Addressed Storage (dedup on binary hash).

---

## Tech stack (pinned)

| Layer | Choice | Why |
|---|---|---|
| App framework | Next.js 15 App Router | Existing server |
| Runtime / PM | Bun 1.1 | Existing, native SQLite |
| DB | SQLite via `better-sqlite3` on Railway `/data` volume | Simple, fast at our scale |
| Binary storage | Railway volume `/data/assets/<hash>.<ext>`, streamed with Range support | Zero new infra; swap to R2 when >5 GB |
| Auth | 60-line cookie session + bcrypt cost 12 | Fewer deps; trusted-group use case |
| CRDT | Yjs + **hocuspocus** + `@hocuspocus/extension-database` | Built-in auth hooks, debounced persistence, doc GC; replaces ~250 lines of custom WS server code |
| Editor | **Tiptap** + StarterKit + Collaboration + CollaborationCursor + custom WikiLink + custom Embed + SlashCommand | Notion-style block editor with native Yjs collab |
| Markdown bridge | `remark-parse` + custom walker → ProseMirror JSON; `prosemirror-markdown` for export | Vault ingest/export; never lossy for content we care about |
| Read-mode render | Same Tiptap component with `editable: false` | No separate renderer to maintain |
| Graph | **Sigma.js v3** + `graphology` + `graphology-layout-forceatlas2` | WebGL; handles 50k+ nodes at 60 fps |
| Search | SQLite FTS5 on derived `content_md` | Existing FTS infra reused |
| Validation | Zod | Every API boundary (rule: `.claude/languages/typescript/security.md`) |
| Styling | Tailwind CSS v4 | Already configured |
| Display font | Fraunces (H1 only) + Inter | Leather-book feel only where it belongs |
| Icons | `lucide-react` | Calm, line-based |

**Not adopting:**
- R2 or any object store — Railway volume is sufficient for the target scale; we'll revisit at 5 GB.
- Postgres — SQLite handles our write volume; multi-tenancy is schema-only for now.
- WebAssembly CRDT (Automerge/Loro) — no measurable gain at 40-ms-RTT scale.
- `markdown-rs` for ingest — revisit only if the ZIP import bottleneck becomes visible.

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

Milanote generosity: 12 px radii, soft borders, no drop shadows except floating menus. Cards lift 2 % on hover. Buttons scale 1.02 on hover. Slash-menu and wikilink suggestions rise with `translateY(-2px)` + opacity.

### Type

Inherit Notion's scale. Body bumped to 17 px / line-height 1.7. Fraunces (display serif) only on H1 of each page.

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
│     SlashMenu · WikiLinkSuggest · EmbedPicker                        │
│     GraphCanvas (Sigma) · MiniGraph                                  │
│     PointerOverlay · PresencePanel · CmdK                            │
└───────────────┬──────────────────────────────────────────────────────┘
       REST     │      WebSocket (hocuspocus)
┌───────────────▼──────────────────────────────────────────────────────┐
│  Node / Bun (server.ts, same process)                                │
│   Next.js 15 route handlers                                          │
│     /api/auth/{login,logout}                                         │
│     /api/admin/{users,vault/upload}                                  │
│     /api/notes/[...path]      (JSON + metadata)                      │
│     /api/tree                  /api/backlinks/[...path]              │
│     /api/graph                 /api/search  /api/tags                │
│     /api/assets/[id]           (streaming with Range support)        │
│     /api/assets/upload         (signed by session)                   │
│   Hocuspocus WS server mounted at ws://host/collab                   │
│     auth: session cookie → user                                      │
│     extension-database → SQLite persistence                          │
│     extension-logger → structured logs                               │
│   SQLite (/data/compendium.db)                                       │
│     users · sessions · groups · group_members                        │
│     notes(group_id, path, content_json, yjs_state, content_md, …)    │
│     assets(group_id, id, hash, mime, size, …)                        │
│     note_links · tags · notes_fts                                    │
│   Filesystem (/data/assets/<hash>.<ext>) — content-addressed         │
└──────────────────────────────────────────────────────────────────────┘
                        Railway (Docker, /data volume)
```

**Key simplifications vs. the plugin world:**
- No vault on disk; `notes.yjs_state` is the only copy of content
- One WebSocket per active note — usually 1–2, never 200
- Auth cookie travels automatically on WS upgrade; no URL tokens
- Every scoped table has `group_id` (constant `'default'` for v1) so future multi-tenancy is schema-compatible

---

## Phases

Execute in order. Each ends with `bun run typecheck`, success criteria verified, one commit: `web: phase N — <summary>`.

### Phase 1 — Auth, sessions, tenant-aware schema (1 day)

**1.1 Migration v6 — users, sessions, groups**

```sql
CREATE TABLE groups (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  created_at   INTEGER NOT NULL
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
  last_seen_at     INTEGER NOT NULL
);
CREATE INDEX sessions_user    ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);
```

**1.2 Auth module** — `server/src/lib/session.ts`

- `hashPassword(plain) → Promise<string>` (bcrypt cost 12)
- `verifyPassword(plain, hash) → Promise<boolean>`
- `createSession(userId, groupId) → string` (32 random bytes, 30-day expiry)
- `readSession(req) → Session | null`
- `requireSession(req) → Session | Response`
- `requireAdmin(req) → Session | Response`
- Cookie: `compendium.sid`, HttpOnly, `Secure` in prod, `SameSite=Lax`, `Path=/`

**1.3 Zod schemas** — `shared/src/protocol.ts`:

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
```

**1.4 Login page + middleware**

- `app/login/page.tsx` — single form; server action calls `/api/auth/login`
- `middleware.ts` — gate non-public routes; 302 to `/login?next=<encoded>`; admin-only paths 403 for non-admins
- Rate-limit `/api/auth/login` at 10 attempts / 5 min / IP (extend existing `ratelimit.ts`)

**1.5 Seed admin**

On first boot with no users: create `admin` with role `admin`, membership in `default`, 24-char random password printed to stdout once.

**Success:**
- [ ] Fresh DB → `admin password: XXXXX` printed once
- [ ] `/` unauthenticated → 302 `/login?next=/`
- [ ] Correct login → cookie + redirect
- [ ] Wrong password → generic "Unknown username or password"
- [ ] Logout clears cookie + deletes session row
- [ ] `/admin/*` 403 for friends
- [ ] 11 failed logins in 5 min from same IP → 429

---

### Phase 2 — Ingestion → ProseMirror + Yjs seeding (1.5 days)

**2.1 Migration v7 — notes, assets, indexes**

```sql
CREATE TABLE notes (
  id               TEXT PRIMARY KEY,
  group_id         TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  path             TEXT NOT NULL,
  title            TEXT NOT NULL DEFAULT '',
  content_json     TEXT NOT NULL,
  content_md       TEXT NOT NULL DEFAULT '',
  yjs_state        BLOB,
  frontmatter_json TEXT NOT NULL DEFAULT '{}',
  updated_at       INTEGER NOT NULL,
  updated_by       TEXT REFERENCES users(id),
  UNIQUE (group_id, path)
);
CREATE INDEX notes_group_path ON notes(group_id, path);

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

CREATE TABLE note_links (
  group_id  TEXT NOT NULL,
  from_path TEXT NOT NULL,
  to_path   TEXT NOT NULL,
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
-- triggers mirror notes.content_md → notes_fts (same pattern as text_docs_fts)
```

Retire `text_docs` + `binary_files` — migration v7 backfills them into `notes` + `assets` then drops them in migration v8 (after the web app is live).

**2.2 Markdown → ProseMirror converter**

`server/src/lib/md-to-pm.ts` — pure module:

```ts
export type NoteIngest = {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  contentJson: ProseMirrorJSON;  // Tiptap-compatible doc
  contentMd: string;             // normalised markdown, re-serialised
  wikilinks: string[];
  tags: string[];
};
export function ingestMarkdown(path: string, raw: string, allPaths: ReadonlySet<string>): NoteIngest;
```

Pipeline:
1. `remark-parse` + `remark-gfm` → MDAST
2. `remark-frontmatter` strip → frontmatter object
3. Walker transforms MDAST nodes to Tiptap-compatible ProseMirror JSON:
   - `heading` → `heading` with level
   - `paragraph` / `list` / `listItem` / `blockquote` / `code` / `inlineCode` / `table` → direct mapping
   - Text with `[[target|label]]` → `wikilink` node `{ attrs: { target, label } }`
   - Text with `![[asset]]` → `embed` node with mime derived from extension
   - Obsidian callouts (`> [!note]`) → `callout` node with type
   - Inline `#tag` → `tagMention` node
4. Re-serialise to `content_md` via `prosemirror-markdown` with custom nodes registered — ensures the round-trip produces stable output
5. Collect wikilinks (resolve against `allPaths`) + tags

Unit tests cover each node type + edge cases (wikilink with pipe, embed ambiguity, callout types).

**2.3 Admin upload endpoint**

`app/api/admin/vault/upload/route.ts`:
- `POST` multipart with `vault` field (ZIP)
- `requireAdmin(req)`, `dynamic = 'force-dynamic'`, `Content-Length` cap at 500 MB
- Stream to `/data/tmp/upload-<uuid>.zip`, then `adm-zip` iterate
- Skip `.obsidian/**`, `.trash/**`, `.DS_Store`, `__MACOSX/**`, files > 50 MB individually, paths containing `..`, null bytes, or Windows drive letters
- For each note: `ingestMarkdown` → upsert `notes` + populate `note_links` + `tags`. Build a fresh `Y.Doc`, seed the ProseMirror JSON via `y-prosemirror`'s `prosemirrorToYXmlFragment`, encode state as `Y.encodeStateAsUpdate` → store as `yjs_state`
- For each binary: compute sha256, if `assets` row with that hash exists, reuse; else write to `/data/assets/<hash>.<ext>` + insert row
- Whole operation inside one `db.transaction()`
- After commit: call `hocuspocus.closeConnections(docName)` for every updated path so live clients reconnect to fresh state
- Response: `{ notes, assets, links, tags, durationMs, skipped }`

**2.4 Confirmation UX on re-upload**

If `notes` non-empty, admin page requires checkbox: *"I understand this replaces every note and disconnects any live editors."* Plus a "presently editing" list with currently-open doc counts before the button enables.

**Success:**
- [ ] Current vault (~10 MB) ingests in < 20 s
- [ ] `COUNT(*) FROM notes` == markdown file count in ZIP
- [ ] Wikilink count matches hand-checked figure on Atoxis (≥ 6 outbound)
- [ ] Re-upload replaces cleanly; orphan paths dropped
- [ ] Live client (Phase 4) sees a "Vault updated, reconnecting…" banner within 2 s
- [ ] `/data/assets/` contains content-hashed files; re-uploading same image does not duplicate on disk

---

### Phase 3 — Reader UI (read-only Tiptap) (1 day)

Three-pane Milanote layout. Same Tiptap component we'll later use for editing, just mounted with `editable: false` and no collab extensions.

```
┌────────────────┬──────────────────────────────┬────────────────┐
│  Folder tree   │  Note surface (read-only)    │  Side rail     │
│                │                              │                │
│  Campaigns/    │  # Atoxis                    │  Backlinks     │
│   C1/          │  ![](/api/assets/<id>)       │   · Bailin     │
│   C2/          │                              │   · Vacant…    │
│   C3/          │  ## Overview                 │  Tags          │
│    NPCs/       │  A demon prince…             │   [villain]    │
│     Atoxis ◉   │                              │  Mini-graph    │
└────────────────┴──────────────────────────────┴────────────────┘
```

**3.1 Tree component** — `components/FileTree.tsx`
- Recursive folders, chevrons, active-path highlight with `--candlelight` at 15 %
- Expansion state per-user in `localStorage`
- Keyboard nav: arrows, Enter, `/` to focus search

**3.2 Note surface** — `components/NoteSurface.tsx`
- Loads `notes.content_json` from `/api/notes/[...path]` server-side
- Mounts Tiptap with extensions: StarterKit, Image, Link, Table, TaskList, Highlight, CodeBlockLowlight, WikiLink (custom), Embed (custom), Callout (custom), TagMention (custom)
- `editable: false` for this phase
- Wikilinks render `<a class="wikilink">` pointing to `/notes/{resolved-path}`
- Embed block renders `<img>` / `<video controls>` / `<iframe>` / download-card based on mime

**3.3 Side rail** — `components/NoteSidebar.tsx`
- **Backlinks** — `SELECT from_path FROM note_links WHERE group_id=? AND to_path=?`, grouped by folder
- **Tags** — pills in `--candlelight-soft`, click → `/tags/[tag]`
- **Outline** — H2/H3 extracted from `content_json`, click → scroll
- **Mini-graph** slot (filled in Phase 6)

**3.4 Style pass**
- Apply D&D palette + paper texture on `<main>`
- Content column max-width 720 px, body 17 px / 1.7, H1 Fraunces 40 px
- Embed blocks: `border: 1px solid var(--rule)`, 10 px radius, dark-label caption below
- Wikilink: dotted underline `--candlelight`; hover reveals 300 ms preview popover (first H1 + first paragraph of target)

**Success:**
- [ ] Clicking tree entry navigates without full reload
- [ ] Atoxis's `[[Lumen Flumen]]` wikilink resolves correctly
- [ ] Backlinks panel lists ≥ 6 for Atoxis
- [ ] Embedded image + one sample video play inline
- [ ] Mobile (≤ 640 px): tree drawer + stacked sidebar
- [ ] Lighthouse A11y ≥ 95 on a sample note

---

### Phase 4 — Live collaborative editor (2 days)

Same `NoteSurface` component; flip `editable: true` + mount collab extensions when the user toggles Edit.

**4.1 Hocuspocus server**

`server/src/collab/server.ts` replaces our handwritten `ws/setup.ts`:

```ts
import { Server } from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import { Logger } from '@hocuspocus/extension-logger';
import { getDb } from '@/lib/db';
import { readSession } from '@/lib/session';

export const collabServer = Server.configure({
  port: undefined,                 // we mount into the existing http server
  async onAuthenticate({ request }) {
    const session = await readSession(request);
    if (!session) throw new Error('Unauthorized');
    return {
      userId: session.userId,
      displayName: session.displayName,
      accentColor: session.accentColor,
      groupId: session.currentGroupId,
    };
  },
  extensions: [
    new Logger({ onLoadDocument: false, onStoreDocument: false, onUpgrade: true }),
    new Database({
      fetch: async ({ documentName }) => {
        const row = getDb().query<{ yjs_state: Uint8Array | null }, [string]>(
          'SELECT yjs_state FROM notes WHERE group_id = ? AND path = ?',
        ).get(defaultGroupId(), documentName);
        return row?.yjs_state ? new Uint8Array(row.yjs_state) : null;
      },
      store: async ({ documentName, state }) => {
        getDb().query(
          'UPDATE notes SET yjs_state = ?, updated_at = ? WHERE group_id = ? AND path = ?',
        ).run(state, Date.now(), defaultGroupId(), documentName);
        // also regenerate content_json + content_md off the ytext — debounced in an async task
        queueDeriveCache(documentName);
      },
    }),
  ],
});
```

Mount into `server.ts`:
```ts
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://_').pathname === '/collab') {
    collabServer.handleUpgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});
```

Derived cache (`content_json`, `content_md`, `content_text`, `note_links`, `tags`) is rebuilt off the main thread from the stored ytext — `queueDeriveCache` is a 500 ms debounced promise per docName.

**4.2 Tiptap editor wiring**

`components/NoteSurface.tsx`:

```tsx
const ydoc = useMemo(() => new Y.Doc(), [path]);
const provider = useMemo(() => new HocuspocusProvider({
  url: wsUrl('/collab'),
  name: path,
  document: ydoc,
}), [path]);

const editor = useEditor({
  editable: mode === 'edit',
  extensions: [
    StarterKit.configure({ history: false }),     // Yjs owns history
    Collaboration.configure({ document: ydoc }),
    mode === 'edit' && CollaborationCursor.configure({
      provider,
      user: { name: currentUser.displayName, color: currentUser.accentColor },
    }),
    WikiLink, Embed, Callout, TagMention,
    SlashCommand, DragHandle,
    Placeholder.configure({ placeholder: '+ / for blocks' }),
  ].filter(Boolean),
}, [path, mode, provider]);

useEffect(() => () => {
  provider.destroy();
  ydoc.destroy();
}, [provider, ydoc]);
```

- `HocuspocusProvider` sends the session cookie automatically on WS upgrade
- `UndoManager` handled by the CollaborationHistory extension (no custom code)
- Editor styles: paper background, D&D palette on cursors + selection, hover drag handles

**4.3 Custom Tiptap extensions**

`components/editor/extensions/WikiLink.ts`:
- Inline mark-like node with attrs `{ target: string, label: string }`
- Input rules: typing `[[` opens a `@tiptap/suggestion` popup listing all note paths (fetched once, cached client-side, invalidated on vault re-upload broadcast)
- Enter inserts `wikilink` node; rendered `<a class="wikilink" data-target="…" href="/notes/…">label</a>`

`components/editor/extensions/Embed.ts`:
- Block node with attrs `{ assetId: string, mime: string, caption?: string }`
- Renders image / video / iframe / file-card based on mime
- Inserted via slash menu ("Add image", "Add video", "Add PDF") → opens file picker → uploads via `/api/assets/upload` → inserts node with returned `assetId`

`components/editor/extensions/Callout.ts`:
- Block node, attrs `{ kind: 'note' | 'tip' | 'warning' | 'danger' }`
- Rendered with category colour from the palette

`components/editor/extensions/TagMention.ts`:
- Inline mark, `#` trigger, fuzzy match against known tags
- Rendered as pill

**4.4 Slash menu**

`SlashCommand` extension (from `@tiptap/extension-mention` reconfigured) — `/` trigger, shows insertable blocks: Heading 1/2/3, Bulleted list, Numbered list, Task list, Quote, Code, Divider, Image, Video, PDF, Callout, Wiki-link. Keyboard-navigable; Enter inserts.

**4.5 Asset upload endpoint**

`POST /api/assets/upload`:
- `requireSession(req)`
- Multipart or raw body with `Content-Type` header
- Stream to `/data/tmp/upload-<uuid>` while streaming sha256 hash
- On close: look up by `(group_id, hash)` in `assets` — if exists, delete temp + return existing row
- Else rename temp to `/data/assets/<hash>.<ext>` and insert row
- Return `{ id, mime, size, originalName }`
- Hard cap 100 MB per file via `Content-Length` pre-check; reject earlier for obviously oversized types

**4.6 Asset streaming endpoint**

`GET /api/assets/[id]`:
- `requireSession(req)` + `SELECT ... WHERE group_id = ?`
- `Range: bytes=…` honoured — use `fs.createReadStream(path, { start, end })` and return 206 partial content with correct headers
- `Cache-Control: private, max-age=3600`
- Optional query `?w=320|640|1280` → serve pre-resized image variant (Phase 7 feature, stub for now)

**Success:**
- [ ] Two browser tabs as different users, same note: typing in one appears in the other within 150 ms
- [ ] Remote text cursors visible with correct user name + accent colour
- [ ] Slash menu opens on `/` and can insert every listed block
- [ ] `[[atox` opens the wikilink picker; Enter inserts a working link
- [ ] Drag-drop an image file into the editor → uploads → shows in both tabs
- [ ] Video file embed plays, seeks with range requests
- [ ] Closing a tab mid-type: reopening shows every character (hocuspocus persistence)
- [ ] Vault re-upload while editor open → client receives disconnect + "Vault updated, reloading…" banner + auto-reloads editor with fresh state

---

### Phase 5 — Presence: mouse pointers + "Who's here" (0.5–1 day)

**5.1 Extended awareness shape**

Awareness on each provider carries:
```ts
type Awareness = {
  user:    { name: string; color: string; colorLight: string };
  cursor?: YTextCursor;                 // set by CollaborationCursor
  pointer?: { x: number; y: number };   // normalised 0..1 inside content root
  viewing?: string;                     // current note path
};
```

**5.2 PointerOverlay component**

`components/PointerOverlay.tsx`:
- `useEffect` subscribes to `provider.awareness.on('change', ...)`
- `onMouseMove` on the content root, `requestAnimationFrame`-throttled to ~60 Hz
- Compute normalised `{ x, y }` vs. the content `<article>` bounding rect
- Broadcast via `awareness.setLocalStateField('pointer', {x,y})`; clear on `mouseleave`
- Render one div per remote state whose `viewing === currentPath`:
  - SVG pointer icon in user accent
  - Name pill in `colorLight` with `--ink` text
  - CSS transition 80 ms, pointer-events: none

**5.3 Presence panel**

`components/PresencePanel.tsx` in the top bar:
- Row of avatars (initials + accent dot)
- Tooltip on hover: "Alex is viewing *Atoxis*"
- Click an avatar → navigate to where they are

Single shared awareness connection on a dedicated `/collab/.presence` doc (no content, awareness only). Stays open as long as the browser tab is open.

**5.4 Cursor-label styling**

Override `@tiptap/extension-collaboration-cursor` default CSS with D&D tokens — label pill uses user's `colorLight`, text `--ink`; contrast ratio ≥ 4.5:1 on parchment.

**Success:**
- [ ] Two tabs open: each sees the other's avatar in the top bar
- [ ] Both on same note: remote mouse pointer visible and smooth
- [ ] Switching to a different note: pointer disappears, presence panel updates
- [ ] Closing a tab: user drops from presence within ~2 s (awareness TTL)

---

### Phase 6 — Mind-map graph (Sigma.js) (1–1.5 days)

**6.1 Graph endpoint**

`GET /api/graph?scope=all|folder:<path>|tag:<tag>` returns
```ts
{ nodes: Array<{ id: string; title: string; tags: string[]; degree: number }>,
  edges: Array<{ source: string; target: string }> }
```
ETag keyed on `MAX(notes.updated_at)` so clients can `If-None-Match`.

**6.2 Full-screen graph page**

`app/graph/page.tsx` — client, full viewport.

Stack:
- `graphology` for the in-memory graph
- `graphology-layout-forceatlas2` running inside a web worker via `graphology-layout-forceatlas2/worker` — keeps the main thread 60 fps
- `sigma` for WebGL render

Styling:
- Node size `3 + 1.5 * sqrt(degree)`
- Node fill from first matched tag category (villain → wine, location → moss, etc.)
- Label visibility: always on at zoom > 1.2, only hovered-neighbourhood below that
- Edges: 40 % opacity; hover-node pops 1-hop to `--candlelight`, fades others to 10 %

Interactions:
- Click → `/notes/[path]`
- Shift-drag → pin position
- Double-click → recentre + zoom
- Right-click → tag/folder filter popover

Controls panel:
- Scope selector, tag multi-filter, "Recentre", zoom ± / fit

**6.3 Mini-graph on note pages**

`components/MiniGraph.tsx` — 280 × 280, same Sigma setup, seeded with 1-hop subgraph for the current path. Click a neighbour → navigate.

**Success:**
- [ ] Full graph of 210 notes loads in < 2 s, stays 55+ fps while panning
- [ ] Synthetic test with 1500 nodes still renders smoothly (confirm headroom)
- [ ] Filtering `tag:villain` reduces to that cluster; unfiltering restores
- [ ] Mini-graph shows correct 1-hop neighbourhood and click navigates

---

### Phase 7 — Search, tags, landing page (0.5–1 day)

**7.1 Command palette**

`components/CmdK.tsx` — Cmd/Ctrl-K overlay, `@headlessui/react` Combobox.
- Query hits `/api/search?q=` → FTS5 `snippet()`
- Groups: Notes → Tags → Folders
- Keyboard-navigable, Enter opens

**7.2 Tag index**

`app/tags/page.tsx` — grid of every tag with count; click → `/tags/[tag]` list.

**7.3 Landing page**

`app/page.tsx`:
- Hero card with last-upload summary (timestamp, admin, counts)
- "Recently updated" list (top 12 by `notes.updated_at`)
- Campaign shortcut cards
- "Jump to graph" CTA

**7.4 Image variants**

On ingest and `/api/assets/upload`, also generate 320 / 640 / 1280 px variants via `sharp`, store as `<hash>-<w>.<ext>` next to the original. `/api/assets/[id]?w=640` returns the closest. `<img srcset>` in the Embed renderer uses them.

**Success:**
- [ ] Cmd-K → "bail" → Bailin top hit in < 150 ms
- [ ] `/tags` lists every tag with correct count
- [ ] Typical note image under 200 KB on mobile

---

### Phase 8 — Retire the plugin + polish (0.5–1 day)

**8.1 Delete legacy**

- `rm -rf plugin/`
- Remove `@compendium/plugin` from root `package.json` workspaces
- Delete `/api/installer`, `/api/plugin/bundle`, `/api/plugin/version`, `/install/[os]` routes
- Delete `server/src/lib/installer/`
- Delete `server/src/ws/setup.ts` (replaced by hocuspocus)
- Delete `scripts/dedupe-vault.ts` + `SYNC_FIX_PLAN.md` → move both to `docs/archive/`

**8.2 Update docs**

- `ARCHITECTURE.md` — replace plugin sections with a "Web app" summary linking to this plan, preserve the pre-pivot architecture in an appendix
- `README.md` — new getting-started (install, seed admin, log in, upload ZIP, invite users)

**8.3 Pack-vault helper**

`scripts/pack-vault.sh` — zips the admin's Obsidian vault (excludes `.obsidian/`, `.trash/`), prompts for admin password, POSTs to `/api/admin/vault/upload`. One-command vault refresh.

**8.4 Dark mode (optional polish)**

CSS variable swap on `html[data-theme="dark"]`. Parchment → charcoal; ink → parchment. Accents muted-but-vibrant on dark.

**Success:**
- [ ] Fresh `bun install` at repo root drops the plugin workspace cleanly
- [ ] No references to `@compendium/plugin`, `obsidian`, `y-codemirror.next`, `y-websocket`, `ws/setup.ts` in the server workspace
- [ ] Railway deploy: login + upload + edit + cursor + pointer + graph all green on a live URL
- [ ] `scripts/pack-vault.sh` uploads in < 30 s from a clean vault checkout

---

## Risk matrix

| Risk | Prob | Impact | Mitigation |
|---|---|---|---|
| Tiptap markdown round-trip loses nested Obsidian callouts or HTML | High | Content drift on re-import | Write an ingest fidelity test that round-trips every existing note and diffs — fail the build on regression |
| Admin re-upload wipes in-progress edits | High | Minutes of typing lost | Confirmation checkbox + presently-editing list + broadcast banner + hocuspocus disconnect + client auto-reload |
| ZIP bomb or path traversal | Medium | Fill disk / escape sandbox | Per-file cap 50 MB, total uncompressed cap 1 GB, reject `..`, null, drive-letter paths |
| Untrusted markdown XSS through HTML nodes | High | Site compromise | `rehype-sanitize` in MD→PM walker; Tiptap schema doesn't allow raw `<script>`; CSP with `script-src 'self'` |
| Wikilink resolver picks wrong same-basename target | High | Broken links | Prefer exact path → shortest full path → fuzzy; show ambiguity indicator in editor on hover |
| Sigma graph chokes beyond 1500 nodes | Low at target | Poor UX | Level-of-detail + viewport culling; we have headroom to 50k |
| Railway 5 GB volume fills | Medium (with video) | Upload failures | Monitor via `/api/admin/stats`; migrate to R2 when >80 % full (swap is ~1 file change) |
| Session hijack over HTTP | Medium | Account takeover | `Secure` cookie enforced in prod, HSTS header, HTTPS-only deploy |
| Hocuspocus doc GC races with ingest | Low | Clients stuck on stale state | Ingest calls `hocuspocus.closeConnections(docName)` before commit; new connection reloads fresh |

---

## Rollback plan

1. All work on `compendium-ai` branch; one commit per phase
2. Phases 1–7 additive — `git revert <sha>` rolls back cleanly
3. Phase 8 deletes the plugin; only run after web app has been live for 3 days with real use
4. Before Phase 2 deploy: `cp /data/compendium.db /data/compendium.backup-pre-v7.db` on the Railway volume (ssh into the running container and use the built-in SQLite CLI)
5. Migrations are forward-only and additive; a failed migration rolls back inside its transaction

---

## Coding standards (non-negotiable)

Consolidated from `.claude/rules/*` and `.claude/languages/{typescript,nextjs}/*`:

- No `any`; explicit return types on exported functions; `interface` for objects, `type` for unions
- Zod validation at every API boundary, request and response
- `export const dynamic = 'force-dynamic'` on every route reading auth state
- `requireSession(req)` / `requireAdmin(req)` before any DB read on non-public routes
- Async dynamic params: `params: Promise<…>` + `await ctx.params`
- Parameterised queries only; one logical change per migration; additive `ALTER` with safe defaults
- bcrypt cost 12; HttpOnly + Secure + SameSite=Lax cookies; rate-limit `/api/auth/login` at 10/5min/IP
- Never log passwords, session IDs, bcrypt hashes, auth cookies
- `rehype-sanitize` between MD parse and PM conversion; Tiptap schema itself rejects `<script>`/`<iframe>` except whitelisted sources
- WebSocket auth by cookie only; never query-string tokens
- Content-addressed assets in `/data/assets/`; never execute uploaded content
- `bun test` on pure helpers (`ingestMarkdown`, wikilink resolver, bcrypt round-trip, ZIP entry validator)

---

## Verification commands

Per phase:
```bash
bun run typecheck
bun test                                    # from Phase 2 onward
bun --filter '@compendium/server' run build
```

End-to-end smoke (post-Phase 5):
```bash
# Terminal A: dev server
cd server && bun run server.ts

# Terminal B: two-tab test
curl -sI http://localhost:3000/api/health
# log in as admin, upload sample vault
# open http://localhost:3000/notes/Atoxis in two browser tabs as two users
# type in one → see chars + cursor + pointer on the other within ~150 ms
```

---

## Execution notes for the AI runner

1. Work phase-by-phase. Each phase ends with every success criterion verified, a short manual test, and a commit
2. Do **not** touch the plugin workspace until Phase 8 — it's the fallback while the web app bakes
3. Keep the existing WS server (`server.ts` upgrade + `ws/setup.ts`) compiled and dormant through Phase 3; Phase 4 swaps it for hocuspocus in one atomic commit
4. Run the ingest fidelity test (from the Tiptap risk row) before merging Phase 2 — this is the one that catches Tiptap schema drift early
5. If a rule in `.claude/rules/*` or `.claude/languages/*` conflicts with any line here, follow the rule and flag the conflict in the PR body
6. Never log a password, session ID, cookie, or user-generated content that may include a pasted credential

---

## Success criteria (overall)

- [ ] Five friends across three cities open the same note and see each other's text cursors, mouse pointers, and typing in real time
- [ ] Notion-style slash menu, block drag handles, and wikilink popover all work
- [ ] Admin uploads a ZIP; within 30 s all clients reload with the fresh state
- [ ] Embedded images, videos, and PDFs play/preview correctly; videos seek
- [ ] Mind-map graph of 1500 synthetic nodes renders at 55+ fps; current 210-note vault instant
- [ ] `notes.yjs_state` is the only source of truth; `content_md` is a cache, never read by the editor
- [ ] Obsidian plugin workspace deleted; one `bun install` at root produces a lean tree
- [ ] `WEB_APP_PLAN.md` retired to `docs/archive/` when every criterion above is green
