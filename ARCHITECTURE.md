# Compendium — Architecture & Implementation Plan

Living north-star document. Update this as decisions evolve. Phase 1 is file-level sync using Yjs as the transport so Phase 2 is a plugin-only upgrade. Phase 3 is the AI layer.

## North star

**Compendium** — a self-hosted real-time vault for tabletop RPG campaigns. Obsidian remains the UI. A tiny Next.js + SQLite server handles sync, search, and AI. Character-level editing and AI assistance are flip-a-switch upgrades on the same codebase.

## Architecture

```
Obsidian (vault folder + CodeMirror editor)
    │
    │  @compendium/plugin  (TypeScript, esbuild)
    │    - Phase 1: file watcher  ──► Yjs doc  ──► WebSocket
    │    - Phase 2: CodeMirror   ◄─► Yjs doc (y-codemirror.next)
    │
    ▼ ws://…/sync?path=…  (Yjs updates, awareness, binary framed)
    ▼ POST /api/files/*   (binary uploads)
    ▼ POST /api/chat      (agentic LLM — Phase 3)
    │
┌─────────────────────────────────────────────────────────────┐
│  @compendium/server  (Next.js 15 App Router + custom WS)    │
│                                                             │
│  WebSocket server (y-websocket + custom SQLite persistence) │
│  Route handlers:  /api/health  /api/search  /api/files/*    │
│                   /api/chat  (Vercel AI SDK, Phase 3)       │
│                                                             │
│  SQLite (better-sqlite3, WAL mode)                          │
│    text_docs(path, yjs_state, text_content, updated_at)     │
│    binary_files(path, data, mime, size, updated_at)         │
│    documents_fts USING fts5(path, content)  [auto-synced]   │
└─────────────────────────────────────────────────────────────┘
             Railway (Docker, volume at /data)
```

## Repo layout

Bun workspaces inside the `compendium-ai/` subfolder of this repo.

```
compendium-sync/                     ← existing repo
├── compendium-ai/                   ← NEW: the whole Node project
│   ├── package.json                 ← workspace root
│   ├── pnpm-workspace.yaml
│   ├── .editorconfig
│   ├── .prettierrc
│   ├── tsconfig.base.json
│   ├── eslint.config.mjs
│   ├── ARCHITECTURE.md              ← this file
│   ├── README.md                    ← Compendium-AI specific docs
│   ├── shared/                      ← @compendium/shared
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── protocol.ts          ← Zod schemas for all API messages
│   │       └── constants.ts
│   ├── server/                      ← @compendium/server (Next.js)
│   │   ├── package.json
│   │   ├── next.config.ts
│   │   ├── tailwind.config.ts       ← preconfigured, unused in Phase 1
│   │   ├── server.ts                ← custom entry (Next + WS)
│   │   ├── Dockerfile
│   │   ├── railway.toml
│   │   └── src/
│   │       ├── app/
│   │       │   └── api/
│   │       │       ├── health/route.ts
│   │       │       ├── search/route.ts
│   │       │       ├── files/[...path]/route.ts
│   │       │       └── chat/route.ts       ← Phase 3
│   │       ├── lib/
│   │       │   ├── db.ts            ← SQLite singleton
│   │       │   ├── migrations.ts
│   │       │   ├── yjs-persistence.ts
│   │       │   ├── auth.ts
│   │       │   └── search.ts
│   │       └── ws/
│   │           └── setup.ts         ← wires y-websocket to auth + persistence
│   ├── plugin/                      ← @compendium/plugin (Obsidian)
│   │   ├── package.json
│   │   ├── manifest.json
│   │   ├── esbuild.config.mjs
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── main.ts              ← Plugin lifecycle
│   │       ├── settings.ts          ← Settings tab (URL, token)
│   │       ├── sync/
│   │       │   ├── provider.ts      ← WebsocketProvider wrapper
│   │       │   ├── docRegistry.ts   ← path → Yjs doc map
│   │       │   ├── fileMirror.ts    ← vault events ↔ Yjs
│   │       │   └── binarySync.ts    ← REST upload/download
│   │       ├── ui/
│   │       │   └── statusBar.ts     ← 🔄/⚠ indicator
│   │       └── editor/              ← Phase 2
│   │           └── cmBinding.ts     ← y-codemirror.next integration
│   └── installer/                   ← builds friend-facing installers
│       └── build-release.ts
└── (existing sync scripts untouched)
```

Separating `shared / server / plugin` lets the plugin import the exact Zod schemas the server validates against — typo in protocol message is a compile error.

## Tech stack (pinned)

| Layer             | Choice                                | Notes                                              |
|-------------------|---------------------------------------|----------------------------------------------------|
| Version manager   | mise                                  | `.mise.toml` pins Bun (and anything else)          |
| Runtime + package manager | Bun 1.1                      | Native TS, workspaces, single tool for install/run |
| Server framework  | Next.js 15 (App Router)               | Route handlers for REST; custom `server.ts` for WS |
| Language          | TypeScript 5.x, strict                | `strict`, `noUncheckedIndexedAccess`               |
| Styling           | Tailwind CSS v4                       | Preconfigured, dormant in Phase 1                  |
| Validation        | Zod 3.x                               | All API boundaries                                 |
| CRDT              | Yjs + `y-websocket` + `y-protocols`   | Server and plugin must match versions              |
| WebSocket         | `ws`                                  | Next.js server exposes raw upgrade handler         |
| DB                | `better-sqlite3`                      | Synchronous, WAL mode (kept runtime-agnostic)      |
| Migrations        | Hand-rolled `runMigrations()`         | ~30 lines, no ORM                                  |
| AI (Phase 3)      | `ai` v4 + `@ai-sdk/anthropic`         | `streamText` with `tool()` helpers                 |
| Plugin bundler    | esbuild                               | Same as `obsidian-sample-plugin`                   |
| Lint / format     | ESLint flat config + Prettier         | Minimal rules                                      |

## Milestones

### Milestone 1 — Foundation

**Step 1.1 — Monorepo scaffold**
- `cd compendium-ai`
- `mise.toml` pins `bun = "1.1"`
- Root `package.json` with `workspaces: ["shared", "server", "plugin"]`
- Root `tsconfig.base.json` with strict settings (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- `.editorconfig`, `.prettierrc`, `.gitignore`, `eslint.config.mjs`
- **Done when:** `mise install && bun install` succeeds with zero deps

**Step 1.2 — `@compendium/shared`**
- `shared/src/protocol.ts` with Zod schemas for `AuthToken`, `SearchResult`, `FileMetadata`, `ChatMessage`. Export types via `z.infer`.
- `shared/src/constants.ts` with `WS_PATH = '/sync'`, `MARKDOWN_EXTENSIONS`, `BINARY_EXTENSIONS`.
- Consumed as TS source — no build step. `exports: { ".": "./src/index.ts" }`.
- **Done when:** `bun --filter '@compendium/shared' typecheck` passes

### Milestone 2 — Server core

**Step 2.1 — Next.js skeleton + custom server**
- Install `next react react-dom tailwindcss` + dev deps
- `server.ts` at package root: `createServer` wraps Next + exposes `/sync` upgrade hook (no-op handler yet)
- `/api/health/route.ts` returns `{ ok: true, commit: process.env.RAILWAY_GIT_COMMIT_SHA }`
- `Dockerfile` (multi-stage: deps → build → run; runs `node server.js`)
- `railway.toml` with volume hint for `/data`
- **Done when:** `docker build && docker run -p 3000:3000 -e DATA_DIR=/tmp …` serves `/api/health`

**Step 2.2 — SQLite + migrations**
- `lib/db.ts` — `better-sqlite3` singleton at `${DATA_DIR}/compendium.db`, WAL mode, `foreign_keys = ON`
- `lib/migrations.ts` — array of SQL strings per version, tracked in `schema_version`, runs on server boot
- Schema v1:
  ```sql
  CREATE TABLE text_docs (
    path TEXT PRIMARY KEY,
    yjs_state BLOB NOT NULL,
    text_content TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    updated_by TEXT
  ) WITHOUT ROWID;

  CREATE TABLE binary_files (
    path TEXT PRIMARY KEY,
    data BLOB NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT
  ) WITHOUT ROWID;

  CREATE VIRTUAL TABLE text_docs_fts USING fts5(
    path, content, tokenize='porter unicode61'
  );
  ```
- Triggers to keep `text_docs_fts` in sync with `text_docs.text_content`
- **Done when:** Server starts, DB file exists with all tables, `schema_version = 1`

**Step 2.3 — Yjs over WebSocket, persisted to SQLite**
- Add `yjs y-protocols ws`
- `lib/yjs-persistence.ts`:
  ```ts
  interface YjsPersistence {
    bindState(docName: string, ydoc: Y.Doc): Promise<void>;
    writeState(docName: string, ydoc: Y.Doc): Promise<void>;
  }
  ```
  - `bindState`: load `yjs_state`, `Y.applyUpdate(ydoc, state)`, subscribe `ydoc.on('update', debounced_persist)`
  - `debounced_persist`: 300ms debounce, encode state, also extract `.getText('content').toString()`, upsert both columns (FTS auto-updates via trigger)
- `ws/setup.ts` — on WS connection to `/sync?path=…`, instantiate `Y.Doc`, run y-protocol message loop, call `bindState`
- Wire in `server.ts`
- **Done when:** Two websocat sessions on same path see each other's Yjs updates; restart preserves state

### Milestone 3 — Server features

**Step 3.1 — Auth middleware**
- `lib/auth.ts` — `requireToken(req)` checks `Authorization: Bearer <token>`, compared against `ADMIN_TOKEN` or `PLAYER_TOKEN` env var
- Player token is read-write. Admin can hit `/api/chat` with unbounded cost.
- Applied to WS upgrade (pre-handshake 401) and all `/api/*` except `/api/health`
- **Done when:** Curl without token → 401; with player token → 200

**Step 3.2 — Binary files + search**
- `/api/files/[...path]/route.ts` — `GET` reads blob, `PUT` writes blob from raw body + content-type, `DELETE` removes. Streaming for large files.
- `/api/search/route.ts` — `GET ?q=term&limit=20` runs
  ```sql
  SELECT path, snippet(text_docs_fts, 1, '<mark>', '</mark>', '…', 20)
  FROM text_docs_fts WHERE text_docs_fts MATCH ?
  ```
- **Done when:** Upload an image, `curl` it back; create a doc via WS, `curl /api/search?q=…` returns it

### Milestone 4 — Obsidian plugin Phase 1

**Step 4.1 — Plugin skeleton**
- Fork `obsidian-sample-plugin` structure into `plugin/`
- `manifest.json`, `esbuild.config.mjs`, `main.ts` with empty Plugin class
- Settings tab with `serverUrl`, `authToken` (validated on save with `@compendium/shared` Zod schemas)
- **Done when:** Plugin loads in Obsidian, settings persist

**Step 4.2 — Doc registry + WS provider**
- `sync/docRegistry.ts` — `Map<string, Y.Doc>` keyed by vault-relative path. `get(path)` creates doc + `WebsocketProvider` on demand.
- Provider connects to `ws://.../sync?path=${encodePath(path)}` with auth via query param (WS can't send headers; server accepts `?token=` too)
- Connection events → status bar updates
- **Done when:** Opening the plugin connects; closing Obsidian cleans up providers

**Step 4.3 — File ↔ Yjs mirroring**
- `sync/fileMirror.ts`:
  - On startup: enumerate markdown files; for each, `getDoc(path)` and if local file is newer than last-known server state, apply file content to doc
  - On vault `modify` event: read file, diff against doc's current text, replace via `ytext.delete(0, len); ytext.insert(0, content)` (coarse Phase 1 approach)
  - On Yjs `update` from server: write `ytext.toString()` back to file with `ignoreNextFileChange` flag to avoid feedback loop
- Binary files: `sync/binarySync.ts` — on vault event for binary extensions, PUT via REST. Initial pull on startup by listing server files.
- **Done when:** Edit a markdown file on Machine A, see it on Machine B within 1s

**Step 4.4 — Status bar + polish**
- `ui/statusBar.ts`: states `connected | connecting | disconnected | error`, plus file-count indicator
- Exponential backoff on reconnect; user-visible errors via `Notice`
- **Done when:** Disconnect network → status disconnected; restore → reconnects

### Milestone 5 — Distribution

**Step 5.1 — Installer + release workflow**
- `installer/build-release.ts` reads `.env`, produces:
  - `dist/compendium-mac.sh`
  - `dist/compendium-linux.sh`
  - `dist/compendium-windows.ps1` (+ `.bat` wrapper)
- Each installer: installs Obsidian if missing, creates vault folder, drops plugin files in, writes `data.json` with baked `serverUrl` + player token, opens Obsidian
- GitHub Action: on release tag, build plugin + run installer build, attach files to release
- **Done when:** Fresh machine runs one-liner, ends with working live sync, zero prompts

### Milestone 6 — Phase 2: character-level sync

**Step 6.1 — CodeMirror binding**
- Add `y-codemirror.next`
- `editor/cmBinding.ts` — on file open, get the CodeMirror 6 `EditorView` from the active `MarkdownView`, bind its state to the `yText` via `yCollab` extension. On close, unbind.
- Awareness protocol → visible cursors with user colors
- **Done when:** Two machines open the same note, cursors visible, typing streams per-character

### Milestone 7 — Phase 3: AI assistant

**Step 7.1 — Server `/api/chat` with tool calls**
- Add `ai @ai-sdk/anthropic`
- `/api/chat/route.ts`:
  ```ts
  streamText({
    model: anthropic('claude-sonnet-4-6'),
    messages,
    tools: {
      searchNotes: tool({ parameters: z.object({ q: z.string() }), execute: ... }),
      readNote:    tool({ parameters: z.object({ path: z.string() }), execute: ... }),
      writeNote:   tool({ parameters: z.object({ path: z.string(), content: z.string() }), execute: ... }),
    },
    maxSteps: 10,
  })
  ```
- Tools call directly into `lib/db.ts` (search) and the Yjs layer (read/write) so AI edits propagate live for everyone
- Stream SSE back to the plugin
- **Done when:** `curl -N` a chat request, stream comes back, vault changes propagate live

**Step 7.2 — Plugin AI chat pane**
- Right-sidebar view, `ai-sdk-react`'s `useChat` client
- Message history stored as Yjs doc under `.compendium/chat/<sessionId>.json` — syncs across devices automatically
- **Done when:** Type "find all NPCs in the Mountain Monastery", assistant streams back a summary citing notes by name

## Ground rules for "clean"

- **No utility abstractions until there are 3 use cases.** E.g. no `BaseRoute` class for one route.
- **All API boundaries validated by Zod** from `@compendium/shared`. Server and plugin import the same schema.
- **Every file has a top comment** stating its purpose in one line. No comments inside functions unless something non-obvious.
- **No dead code, no feature flags for hypotheticals, no backwards-compat shims.**
- **Tests:** vitest for `lib/` pure functions and migration behaviour. Don't test framework code.
- **CI:** one GitHub Action — `pnpm lint && pnpm -r typecheck && pnpm -r build`. No e2e in Phase 1.

## Open decisions (resolve before Milestone 2)

1. **Single player token vs per-friend tokens?** Single is simpler; per-friend gives accountability. Current lean: single for Phase 1.
2. **Chat history — shared Yjs doc or local-only?** Shared is slick but all friends see each other's chats. Local-only is private per device.
3. **Cost control on `/api/chat`?** Monthly token cap. Claude Haiku is cheap, but a runaway loop could still bill.

## Execution order right after thumbs-up

1. Commit this plan (done when this file is in git)
2. Execute Milestone 1 (~15 min): repo scaffold + `@compendium/shared`. `pnpm -r build` passes on a clean monorepo with strict TS
3. Pause, verify, start Milestone 2
