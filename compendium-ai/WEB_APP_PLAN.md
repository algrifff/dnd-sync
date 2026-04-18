# Compendium Web App — Pivot Plan

**Target:** replace the Obsidian plugin with a self-hosted web app that friends log into.
**Date:** 2026-04-18
**Estimated effort:** 5–6 dev days across six phases
**Success metric:** admin uploads their vault folder; friends log in from anywhere and see the same folder tree, the same notes, the same wiki-link graph, with zero sync plumbing.

---

## Why the pivot

The Yjs/WebSocket live-sync stack was always over-engineered for the use case — five friends browsing a D&D compendium. The plugin has repeatedly broken in ways that corrupt content (compounding merge, stale baselines, race with yCollab) and debugging takes days. A read-only web viewer with admin-upload replaces **every** failure mode above with a single operation: the admin re-uploads when they've edited. Friends get a reliable view of the latest state.

The mind-map graph (Obsidian's killer feature for this use case) is not an Obsidian exclusive — it's just a force-directed render of wiki-link edges. We can build that on the same data in a few hundred lines.

---

## Tech stack (pinned)

| Layer | Choice | Notes |
|---|---|---|
| App | Next.js 15 App Router | Existing server is already this; extending it |
| Auth | iron-session + bcrypt | Cookie session, 48-char random password suggestions, admin-creates-accounts model |
| DB | SQLite via `better-sqlite3` | Existing; extend schema |
| Markdown | `react-markdown` + `remark-gfm` + `remark-wiki-link` | Standard pipeline; wikilink plugin turns `[[X]]` into hrefs |
| Graph | `react-force-graph-2d` | D3 force-directed, 2D canvas, handles 500+ nodes |
| Upload | `multer`-style Next.js route, `adm-zip` for ZIP extraction | Admin-only endpoint |
| Styling | Tailwind CSS v4 | Already configured; we add custom D&D-tone tokens |
| Icons | `lucide-react` | Simple, matches calm aesthetic |

---

## Visual identity — "Round table, but neatly typeset"

Base discipline = Notion (`.claude/design/CLAUDE.md`). Overlay = D&D warmth and texture.

### Core palette

| Token | Hex | Role |
|---|---|---|
| `--parchment` | `#F4EDE0` | Main canvas, reading surface |
| `--parchment-sunk` | `#EAE1CF` | Sidebars, sunken panels |
| `--vellum` | `#FBF5E8` | Cards, hover-lift surfaces |
| `--ink` | `#2A241E` | Body copy, titles |
| `--ink-soft` | `#5A4F42` | Secondary text |
| `--rule` | `#D4C7AE` | Dividers, borders |
| `--candlelight` | `#D4A85A` | Primary accent (links, selection), aged gold |
| `--moss` | `#7B8A5F` | Location / environment category |
| `--wine` | `#8B4A52` | Villain / danger category |
| `--sage` | `#6B7F8E` | Ally / official category |
| `--embers` | `#B5572A` | Session / event category |
| `--shadow` | `#1E1A15` | Deep contrast, headers on textured hero |

Dark mode comes later — ship light first.

### Texture

A subtle noise SVG (`public/textures/paper.svg`) applied as `background-blend-mode: multiply` with 6% opacity on the canvas. No hard paper lines, no scrolls — just enough grain that the screen doesn't feel like a spreadsheet.

### Type

Keep Notion's type scale. Swap the sans for **Fraunces** display serif on page titles only (H1 only) for a leather-book feel; Inter for everything else.

### Shape language

Milanote-flavoured: generous padding, 12 px radii, soft borders, no drop shadows except on floating menus. Buttons and cards grow ~2% on hover (`transform: scale(1.02)`), never wiggle.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Next.js 15 App (same server process as today)          │
│                                                         │
│  Pages (App Router)                                     │
│    /login                     → friend + admin login    │
│    /admin                     → admin dashboard + upload│
│    /                          → vault home / graph      │
│    /graph                     → full-screen mind map    │
│    /notes/[...path]           → note reader             │
│                                                         │
│  Route handlers                                         │
│    POST /api/auth/login       → session cookie          │
│    POST /api/auth/logout                                │
│    POST /api/admin/users      → create friend account   │
│    POST /api/admin/vault/upload  → ZIP ingest           │
│    GET  /api/notes/[...path]  → raw markdown + meta     │
│    GET  /api/graph            → nodes + edges JSON      │
│    GET  /api/tree             → folder tree JSON        │
│    GET  /api/search?q=…       → FTS results             │
│    GET  /api/assets/[...path] → binary pass-through     │
│                                                         │
│  SQLite (same `compendium.db`)                          │
│    users          (id, username, password_hash, role)   │
│    sessions       (id, user_id, expires_at)             │
│    text_docs      (path, text_content, frontmatter,     │
│                     updated_at)  [existing, refactor]   │
│    binary_files   (path, data, mime, …)   [existing]    │
│    note_links     (from_path, to_path)  [derived on     │
│                     ingest; powers graph + backlinks]   │
│    tags           (path, tag)                           │
│    text_docs_fts  [existing FTS5]                       │
└─────────────────────────────────────────────────────────┘
```

The WS server, `/sync/`, `y-*`, rate limiter, friend tokens stay for now but are unused by the web path. Deleted at end of Phase 6.

---

## Phases

Execute in order. Do not start phase N+1 before phase N typechecks and the listed success criteria pass.

### Phase 1 — Auth + sessions (0.5–1 day)

**1.1 Schema: users + sessions**

`server/src/lib/migrations.ts` — migration v6:

```sql
CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE,
  email          TEXT,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('admin','friend')),
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER
);
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
```

**1.2 Seed admin**

On first boot with no users, auto-create `admin` with a random 24-char password logged to stdout once (matches the existing admin-token pattern).

**1.3 Auth lib**

`server/src/lib/auth-web.ts` — `hashPassword`, `verifyPassword` (bcrypt at cost 12), `issueSession(userId)`, `readSession(req)`. Cookie is HttpOnly, Secure in prod, `SameSite=Lax`, 30-day expiry.

**1.4 Login page + logout**

`app/login/page.tsx` — single form (username + password). POST to `/api/auth/login`. On success, redirect to `/`. Simple, no frameworks beyond react-hook-form if needed.

**1.5 Middleware gate**

Every non-`/login`, non-`/api/auth/*` route checks for a valid session; otherwise redirects to `/login`. Admin-only routes additionally check `role==='admin'`.

**Success:**
- [ ] Visit `/` unauthenticated → redirected to `/login`.
- [ ] Log in with seeded admin → land on `/`.
- [ ] Wrong password → error message, no redirect.
- [ ] Logout clears cookie and sends back to `/login`.

---

### Phase 2 — Admin vault ingestion (1 day)

**2.1 Upload endpoint**

`POST /api/admin/vault/upload` — accepts a ZIP file (multipart). Admin-only. Replace-mode only for v1 (full overwrite — no partial updates). Safer than incremental and matches the "admin uploads" mental model.

Steps server-side:
1. Stream ZIP to a temp file under `/data/tmp/`.
2. `adm-zip` → iterate entries.
3. Validate paths (no `..`, no absolute, size caps).
4. For each `.md`/`.canvas` entry: insert into `text_docs`, parse frontmatter, parse `[[wikilinks]]`, insert into `note_links` + `tags`.
5. For each binary (extensions from the existing `BINARY_EXTENSIONS` minus `.obsidian/**`): insert into `binary_files`.
6. Everything inside a single SQLite transaction so an aborted upload doesn't leave a half-state. On success, drop the old rows (or move to a `_previous` sidebar table for rollback — stretch goal).
7. Delete temp file.

**2.2 Markdown parser + link extractor**

`server/src/lib/markdown.ts`:

```ts
export type ParsedNote = {
  path: string;
  title: string;              // H1 or filename fallback
  frontmatter: Record<string, unknown>;
  body: string;               // markdown minus frontmatter
  wikilinks: string[];        // resolved to canonical paths
  tags: string[];             // frontmatter tags + inline #tags
  h1: string | null;
};

export function parseNote(path: string, raw: string): ParsedNote;
```

Wikilink resolution rule: try (in order)
1. Exact match by `path` (case-insensitive on Windows casing).
2. Exact match by filename sans extension (`[[Bailin]]` → `Bailin.md` anywhere).
3. Fuzzy — longest path suffix match.

Store unresolved `[[X]]` as orphan edges (graph renders them as ghost nodes).

**2.3 Admin dashboard — upload UI**

`app/admin/page.tsx` extends the existing page:
- "Upload vault" section: drag-drop ZIP, progress bar, result summary ("204 notes, 2834 links, 156 assets ingested").
- Last-ingested timestamp + who uploaded.
- "Users" section: add friend (username + password autogen), revoke.

**Success:**
- [ ] ZIP of current vault uploads in <30 s.
- [ ] `text_docs` row count matches note count.
- [ ] `note_links` populated; `SELECT COUNT(*) FROM note_links` is reasonable.
- [ ] Re-uploading a slightly-edited ZIP replaces cleanly — old notes removed, new ones added, no orphans.

---

### Phase 3 — Reader UI (1–1.5 days)

Three-pane layout. Resizable.

```
┌─────────────────┬────────────────────────────────┬────────────────┐
│  Folder tree    │  Note content                  │  Backlinks     │
│  (sidebar)      │  (center)                      │  (outline)     │
│                 │                                │                │
│  Campaigns/     │  # Atoxis                      │  Mentioned in: │
│    C1/          │                                │  • Bailin.md   │
│    C2/          │  ![[token_atoxis.png]]         │  • Vacant T…   │
│    C3/          │                                │                │
│      NPCs/      │  ## Overview                   │  Tags:         │
│        ...      │  A demon prince.               │  [villain]     │
│                 │                                │  [demon]       │
└─────────────────┴────────────────────────────────┴────────────────┘
```

**3.1 Tree component**

`components/FileTree.tsx`. Recursive folders, chevrons (quiet like Notion), active-path highlight using `--candlelight` at 15 % opacity. Folders remember open/closed per-user in `localStorage`.

**3.2 Note page**

`app/notes/[...path]/page.tsx` server-renders the note. Markdown pipeline:
- `remark-gfm` (tables, strikethrough)
- `remark-wiki-link` configured with a `pageResolver` returning our API path
- `remark-frontmatter` to strip YAML
- `rehype-raw` (allow inline HTML — Obsidian notes use it occasionally)
- Custom renderer for `![[Asset/...]]` embeds → `<img>` pointing at `/api/assets/...`

Wiki-links render as links with a subtle dotted underline; hover shows a 300 ms preview popover with the target note's H1 + first paragraph (like Obsidian).

**3.3 Backlinks + outline panel**

Right sidebar lists:
- **Backlinks** — notes whose `note_links.to_path = current_path`. Click to navigate.
- **Tags** — frontmatter tags as pills in `--candlelight-soft`.
- **Outline** — H2/H3 headings of the current note, click to scroll.

**3.4 Styling pass**

Apply the D&D palette + Fraunces on H1 only + Inter everywhere else. Paper texture on the main canvas. Ensure density is Milanote-comfortable, not Notion-cramped: body size 17 px, generous line-height 1.7, content max-width 720 px.

**Success:**
- [ ] Clicking a folder tree entry loads the note without a full page reload (client navigation).
- [ ] `[[Atoxis]]` in Bailin's note is a working link.
- [ ] Backlinks panel correctly lists all notes mentioning the current one.
- [ ] Image embeds render.
- [ ] Mobile (≤640 px) shows a drawer-collapsed tree + single-pane note.

---

### Phase 4 — Mind map graph (1 day)

**4.1 Graph data endpoint**

`GET /api/graph?scope=...` returns `{ nodes: [{id, title, tags, weight}], edges: [{from, to}] }`. `scope=all` returns the whole vault; `scope=campaign:C3` filters. Size in URL, cacheable (ETag on last-upload timestamp).

**4.2 Graph page**

`app/graph/page.tsx` full-screen canvas using `react-force-graph-2d`.

Node styling:
- Size from `log(weight)` where weight = `in-degree + out-degree`.
- Colour from primary tag category: villain → `--wine`, location → `--moss`, ally/official → `--sage`, session → `--embers`, others → `--ink-soft`.
- Label always visible at zoom ≥ 1.0; only hovered+adjacent at lower zooms.

Edge styling:
- Default: `--rule` at 40 % opacity.
- On hover a node: direct edges go `--candlelight`, 2-hop neighbourhood stays `--rule`, further fades to 10 %.

Interactions:
- Click node → navigate to `/notes/[path]`.
- Double-click → center and zoom.
- Drag → pin (Obsidian parity).
- Right-click → filter submenu (by tag, by folder).

Controls panel (top-left):
- Zoom buttons.
- Filter by tag (multi-select).
- Scope selector (whole vault / campaign 1 / campaign 2 / campaign 3).
- "Reset layout".

**4.3 Mini-graph on note pages**

On the right sidebar, below backlinks: a 280 × 280 mini force graph of the current node + 1 hop. Same rendering, smaller. Click a neighbour → navigate.

**Success:**
- [ ] Full graph of your current vault loads in <2 s and stays 55+ fps while being dragged.
- [ ] Clicking Atoxis recentre → visible cluster of connected NPCs + locations.
- [ ] Filtering to `tag:villain` reduces the graph to that cluster.
- [ ] Mini-graph on Atoxis's page shows Lumen, Zordaar, Pride, Claye, Cardinal Henry, Caelin, The Comet.

---

### Phase 5 — Search + polish (0.5–1 day)

**5.1 Global search**

Cmd/Ctrl-K anywhere opens a command palette (headless UI `Combobox`).
- Query hits `/api/search?q=` → FTS5 `snippet()` per hit.
- Results grouped: Notes → Tags → Folders.
- Keyboard-navigable, Enter opens the result.

**5.2 Tag index page**

`/tags` — grid of every tag + count. Click → list of notes with that tag.

**5.3 Recently updated**

Landing page `/` shows: last upload summary at top, then "Recently updated" (top 12 `text_docs` by `updated_at`), a small "Campaigns" section linking to the three campaign overview notes, and a "Jump to graph" CTA.

**5.4 Asset optimisation**

`sharp`-resize images on ingest into three widths (320/640/1280) stored in `binary_files` with a `variant` column. `<img srcset>` uses them. Improves mobile perf significantly for token portraits.

**5.5 Dark mode** (optional, ship if time)

CSS variable swap on `html[data-theme="dark"]`. Ink ↔ parchment flip. Accent colours shifted to be vibrant-yet-muted on dark.

**Success:**
- [ ] Cmd-K → type "bailin" → top hit in <150 ms.
- [ ] `/tags` lists every tag correctly.
- [ ] Mobile image loads under 200 KB for a typical NPC page.

---

### Phase 6 — Delete the plugin; docs (0.5 day)

**6.1 Delete legacy**

- `rm -rf plugin/`
- Delete `server/src/ws/`, `server/server.ts` WS upgrade handler (replace with Next.js default listen).
- Delete `yjs`, `y-protocols`, `y-websocket`, `ws` from `server/package.json`.
- Delete `SYNC_FIX_PLAN.md`.
- Update `ARCHITECTURE.md` — mark the Yjs/plugin sections as superseded; link to this plan.
- Delete `shared/src/protocol.ts` pieces that referenced WS.

**6.2 Update `README.md`**

New getting-started: install, migrate, seed admin, upload ZIP, invite friends.

**6.3 Install the admin workflow**

Add a `scripts/pack-vault.sh` that zips the admin's local Obsidian vault (excluding `.obsidian/`, `.trash/`) and POSTs it to `/api/admin/vault/upload` with the admin's session cookie. One-command updates.

**Success:**
- [ ] `bun install` at repo root removes 20 MB of WS deps.
- [ ] Deploy to Railway → dashboard + login + vault upload all work.
- [ ] `scripts/pack-vault.sh` uploads in <30 s from a fresh clone of the vault.

---

## Risk matrix

| Risk | Prob | Impact | Mitigation |
|---|---|---|---|
| Upload endpoint OOMs on large vaults | Medium | Upload fails | Stream ZIP to disk; iterate entries one at a time; reject > 500 MB upfront |
| Wikilink resolution picks wrong target when two notes share a filename | High | Broken links | Prefer shortest path; log ambiguous resolutions; show disambiguation UI on hover |
| Force graph chokes at 1000+ nodes | Low (we're at ~210) | Poor UX | Switch to `react-force-graph-3d` or canvas-based sigma if we hit that scale |
| Password leaks via logs | Low | Security | Audit every log site; bcrypt before storage; never echo password in responses |
| Session hijack on HTTP | Medium | Account takeover | Enforce `Secure` cookie in prod, HSTS header on Railway |
| Admin ZIP contains malicious SVG / HTML | Medium | XSS | `rehype-sanitize` in the markdown pipeline; SVGs served as `Content-Disposition: attachment` by default |

---

## Coding standards (reminder)

From `.claude/rules/*` and `.claude/languages/{typescript,nextjs}/*`:

- No `any`; explicit return types on exported functions.
- Zod-validate every POST body and query string.
- Parameterised SQL only.
- `requireSession(req)` before DB access on any non-public route.
- `dynamic = 'force-dynamic'` on any route that reads auth state.
- Never log a password, session cookie, or token.
- Tests: `bun test` on pure helpers (wikilink resolution, markdown parser, auth hash round-trip).

---

## Execution notes for the AI runner

1. Work phase-by-phase. Each phase ends with its success criteria verified and a commit: `web: phase N — <short summary>`.
2. If a verify step fails, stop and surface it. Don't paper over.
3. Keep the Obsidian plugin untouched until Phase 6. It's the fallback while the web app bakes.
4. After Phase 2, before Phase 3, run an upload smoke with the actual vault so parser edge cases (old `.canvas` files, weird frontmatter, broken links) are caught early.
5. Follow the design palette above; feel free to nudge hex values but keep the warm-paper / muted-pastel direction. Do not introduce saturated SaaS colours.

---

## Out of scope for v1 (capture as follow-ups)

- Live collaborative editing (the whole reason we pivoted — never again for this use case unless we can't avoid it).
- Real-time comments / annotations by friends.
- Multi-vault support.
- AI assistant integration (Phase 3 of ARCHITECTURE.md — revisit post-v1).
- Mobile app (PWA is sufficient).
- Full-text history / version diff.
