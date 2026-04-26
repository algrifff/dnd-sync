# Compendium — Architecture

A snapshot of how the system is built **today**. For setup, env vars, and deployment instructions see [README.md](./README.md). For coding conventions and gotchas see [CLAUDE.md](./CLAUDE.md).

## What it is

**Compendium** is a self-hosted TTRPG note-taking web app for players and GMs. Multiple groups (worlds / campaigns) share the same instance. Notes, character sheets, and session logs sync live across browsers via Yjs CRDTs over WebSocket. An AI assistant has read/write access to the vault and understands the campaign context.

The whole thing runs as a single Next.js process backed by SQLite — no external database, queue, or cache.

## High-level architecture

```
┌────────────────────────────────────────────────────────────┐
│  Browser (Next.js client)                                  │
│    Tiptap + ProseMirror editor                             │
│    Sigma.js / Graphology 3D graph                          │
│    Excalidraw drawings                                     │
└────────────┬───────────────────┬───────────────────────────┘
             │ HTTPS (REST)      │ WSS  /collab?…
             │                   │
┌────────────▼───────────────────▼───────────────────────────┐
│  server.ts  (custom entry — Next.js + Hocuspocus on one    │
│              port, share the same HTTP upgrade handler)    │
│                                                            │
│   App Router            Hocuspocus           AI Chat        │
│   /api/* routes         server (Yjs)         /api/chat      │
│      │                     │                    │           │
│      ▼                     ▼                    ▼           │
│   ┌──────────────────────────────────────────────────────┐ │
│   │  lib/  — notes, auth, session, ai, import, graph,    │ │
│   │         campaign-index, characters, assets, audit    │ │
│   └────────────────────┬─────────────────────────────────┘ │
│                        │                                   │
│        ┌───────────────┼───────────────┐                   │
│        ▼               ▼               ▼                   │
│    SQLite          $DATA_DIR/        OpenAI                │
│    compendium.db   assets/           (or other AI          │
│    (WAL)           (binary blobs)     provider)            │
└────────────────────────────────────────────────────────────┘
```

## Repo layout

Bun workspaces at the repo root.

```
.
├── server/         # @compendium/server — Next.js 15 + Hocuspocus (the app)
│   ├── server.ts   # Custom entry — Next + WebSocket on the same port
│   ├── Dockerfile
│   └── src/
│       ├── app/        # App Router pages + ~70 API route handlers
│       ├── lib/        # All business logic (notes, auth, ai, import, …)
│       │   └── ai/     # Orchestrator, tools, per-kind skill prompts
│       ├── collab/     # Hocuspocus server (web rich-text collaboration)
│       └── middleware.ts
├── shared/         # @compendium/shared — Zod schemas + protocol constants
│   └── src/        # Consumed as TS source, no build step
├── scripts/        # One-off utilities (vault dedupe, sheet migration, etc.)
├── package.json    # Workspaces: ["shared", "server"]
└── railway.toml    # Points at server/Dockerfile
```

## Runtime split (important)

`server/src/lib/db.ts` switches its SQLite backend at runtime:

| Environment              | SQLite backend  | Why                                            |
|--------------------------|-----------------|------------------------------------------------|
| Bun (dev + tests)        | `bun:sqlite`    | Built in, no native compile step               |
| Node 22 (production)     | `better-sqlite3`| V8-ABI-specific `.node` binary, fast + stable  |

The Dockerfile is multi-stage so it can install everything with Bun and then **rebuild `better-sqlite3` against Node 22's ABI** before running. Don't skip that stage.

Both backends expose the same `Database` interface, so call sites are runtime-agnostic.

## Data model

Schema is defined in `server/src/lib/migrations.ts` as an append-only array. Currently at **schema version 46** — never edit existing entries, always append.

Key tables:

| Table                  | Purpose                                                              |
|------------------------|----------------------------------------------------------------------|
| `notes`                | All content — path, ProseMirror JSON, Yjs state, frontmatter         |
| `users`                | Web accounts — email, Argon2 hash, avatar                            |
| `groups`               | Worlds / campaigns — the multi-tenancy container                     |
| `group_members`        | User ↔ group with role: `admin` / `editor` / `viewer`                |
| `sessions`             | HTTP-only session cookies + CSRF tokens                              |
| `characters`           | **Derived index** — rebuilt from note frontmatter on every save      |
| `session_notes`        | Campaign session logs with GM review workflow                        |
| `import_jobs`          | AI import pipeline state (uploaded → parsing → analysing → applied)  |
| `assets`               | Binary files deduplicated by content hash                            |
| `note_links`           | Knowledge-graph edges (backlinks, with `is_index` flag for TOCs)     |
| `notes_fts`            | FTS5 full-text search index — auto-synced via triggers               |
| `group_invite_tokens`  | Shareable world-join links                                           |
| `audit_log`            | Admin action history                                                 |

All queries include `group_id` — no row-level security, just strict query filtering.

## Real-time sync

Web editing runs through a **Hocuspocus** server mounted at `/collab` on the same port as Next.js. Tiptap on the client uses the `Collaboration` extension, which binds the editor's ProseMirror state to a `Y.Doc`. Cursor presence is broadcast via `CollaborationCaret` (Yjs awareness).

Persistence: every connected document writes its `Y.encodeStateAsUpdate()` blob into `notes.yjs_state`. **The DB is the only backup of edit history** — losing it loses CRDT history.

Excalidraw drawings ride on the same channel as part of the per-note frontmatter / scene payload.

## Auth

Two independent layers:

**Session-based (web dashboard)**
- Sign-in creates an HTTP-only session cookie + CSRF token (validated on every mutation).
- Group roles: `admin`, `editor`, `viewer`. `viewer` is a player; `admin` / `editor` are GMs.
- `dm_only` notes are filtered at the API layer — viewers see the path/title but no body.
- `middleware.ts` redirects unauthenticated requests to `/login`.

**Bearer token (legacy / admin scripts)**
- `Authorization: Bearer <token>` or `?token=` query param.
- Two roles: `admin` and `player`. Compared with a timing-safe function.
- Tokens come from `ADMIN_TOKEN` / `PLAYER_TOKEN` env vars or the `config` SQLite table.

## AI features

`POST /api/chat` streams responses via the **Vercel AI SDK v6** (default `gpt-4o-mini` via `@ai-sdk/openai`). Up to 8 agentic tool-call steps per turn. Context injected per request: groupId, campaign slug, active character name, currently open session, role.

Tools the model can call (defined in `server/src/lib/ai/tools.ts`):

| Tool                  | Effect                                                          |
|-----------------------|-----------------------------------------------------------------|
| `campaign_list`       | List registered campaign slugs (constrains `entity_create`)     |
| `entity_search`       | Search before creating, to prevent duplicates                   |
| `entity_create`       | Create a note under an existing campaign                        |
| `entity_edit_sheet`   | Update structured frontmatter fields (HP, AC, level, …)         |
| `entity_edit_content` | Append prose to a note body                                     |
| `backlink_create`     | Add a knowledge-graph edge between two notes                    |
| `inventory_add`       | Add an item to a character sheet (GM only)                      |
| `entity_move`         | Relocate a note                                                 |
| `session_close`       | Close an open session note (GM only)                            |
| `session_apply`       | Apply session outcomes to canonical notes (GM only)             |

**Skill injection** — per-kind Markdown prompts in `server/src/lib/ai/skills/` (`character.md`, `creature.md`, `session.md`, `item.md`, `location.md`, `lore.md`, `note.md`) are loaded dynamically based on keywords in the user's message.

**Import pipeline** — batch import of an existing Markdown vault:

```
upload .zip → import-parse → import-analyse → user reviews plan → import-apply
   (raw)       (structural)   (LLM classify +    (UI)              (commit to DB)
                              entity extract)
```

## Tech stack

| Layer                   | Choice                                              |
|-------------------------|-----------------------------------------------------|
| Framework               | Next.js 15 (App Router), React 19                  |
| Runtime (dev / tests)   | Bun 1.1                                            |
| Runtime (production)    | Node.js 22                                         |
| Language                | TypeScript 5.6, strict + `noUncheckedIndexedAccess`|
| Database                | SQLite (WAL): `bun:sqlite` or `better-sqlite3`     |
| Validation              | Zod (all API boundaries)                            |
| Real-time editing       | Hocuspocus + Yjs + Tiptap + ProseMirror            |
| Knowledge graph         | Sigma.js (WebGL) + Graphology                       |
| Drawings                | Excalidraw                                          |
| AI                      | Vercel AI SDK v6 + `@ai-sdk/openai`                |
| Auth                    | Argon2 password hashes, custom session + Bearer     |
| Styling                 | Tailwind CSS 4, Lucide icons                        |
| Tooling                 | mise (Bun pin), ESLint, Prettier                    |

## Deployment

Railway: `railway.toml` at repo root → uses `server/Dockerfile`. Build context is the repo root.

The Dockerfile is a three-stage build:
1. **deps** (`oven/bun:1.1`) — install workspace deps, compile native modules.
2. **build** (`node:22-slim`) — Next.js production build, **rebuild `better-sqlite3` against Node 22**.
3. **runtime** (`node:22-slim`) — minimal image, runs `server.ts` via `tsx`.

Required env vars: `ADMIN_TOKEN`, `PLAYER_TOKEN`, `DATA_DIR=/data` (with a Railway volume mounted at `/data`).
Optional: `OPENAI_API_KEY` (enables AI chat + import), `ANTHROPIC_API_KEY`.

Health check: `GET /api/health`.
