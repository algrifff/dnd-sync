# Compendium

Self-hosted TTRPG note-taking web app for players and GMs — real-time collaborative notes, character sheets, session logs, knowledge graph, and an AI assistant that understands the campaign. Single Next.js 15 process backed by SQLite. See [ARCHITECTURE.md](./ARCHITECTURE.md) for how the system fits together.

## Key features

- Real-time collaborative notes (Yjs + Hocuspocus, ProseMirror state)
- Character sheets with inline-editable headers (per-kind: character / person / creature / item / location)
- AI chat with agentic tool calls (Vercel AI SDK v6, ~10 tools, per-kind skill injection)
- AI-assisted Markdown vault import (upload → analyse → review → apply)
- 3D knowledge graph (Sigma.js + Graphology) with hierarchical layout
- Auto-managed campaign index (per-world TOC, bidirectional backlinks)
- Per-world collaborative drawings (Excalidraw)

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Running with Mise](#running-with-mise)
- [Running with Bun directly](#running-with-bun-directly)
- [Environment Variables](#environment-variables)
- [Workspace Layout](#workspace-layout)
- [Development Workflow](#development-workflow)
- [Database](#database)
- [Deployment](#deployment)
- [Tech Stack](#tech-stack)
- [Authentication](#authentication)
- [API Overview](#api-overview)

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| [mise](https://mise.jdx.dev) | latest | `curl https://mise.run \| sh` |
| [Bun](https://bun.sh) | 1.1 | managed by mise |
| [Node.js](https://nodejs.org) | 22 | used for production build only |

Mise manages the Bun version automatically. If you skip mise you need Bun 1.1 installed manually.

---

## Quick Start

```bash
# 1. Clone and enter the repo root

# 2. Install tool versions pinned in mise.toml (Bun 1.1)
mise install

# 3. Install all workspace dependencies
bun install

# 4. Copy and configure environment variables
cp server/.env.example server/.env.local
# Edit server/.env.local — set ADMIN_TOKEN and PLAYER_TOKEN at minimum

# 5. Start the development server (Next.js + WebSocket on the same port)
cd server
bun run server.ts
```

Open the web dashboard at `http://localhost:3000`. On first boot the server creates the SQLite database, runs migrations, and prints a one-time admin password to stdout — copy it immediately.

---

## Running with Mise

Mise reads `mise.toml` and activates the correct Bun version for this project.

```bash
# First-time: install mise itself
curl https://mise.run | sh
# Follow the prompt to add mise to your shell (adds to ~/.zshrc or ~/.bashrc)

# Then activate tool versions for this project
mise install        # installs Bun 1.1 as pinned in mise.toml

# Verify
bun --version       # should print 1.1.x

# Install monorepo deps
bun install

# Run the server
cd server
bun run server.ts
```

Mise also lets you pin Node for CI if needed — add `node = "22"` to `mise.toml`.

---

## Running with Bun directly

If you already have Bun 1.1 and don't want mise:

```bash
# Install all workspace deps
bun install

# Development — server (port 3000 by default)
cd server
bun run server.ts

# Type-check all workspaces from monorepo root
cd ..
bun run typecheck

# Lint
bun run lint

# Format
bun run format
```

### Production build (Next.js)

```bash
cd server

# Build Next.js app
bun run build

# Start in production mode
NODE_ENV=production bun run server.ts
```

---

## Environment Variables

Copy `server/.env.example` to `server/.env.local` for local development.

```env
# Network
PORT=3000
HOSTNAME=0.0.0.0

# Data directory — SQLite DB and uploaded assets are stored here
DATA_DIR=./.data

# Auth — Bearer tokens for legacy API access and admin scripts
# Generate with: openssl rand -hex 32
ADMIN_TOKEN=replace-with-a-long-random-string
PLAYER_TOKEN=replace-with-a-long-random-string

# AI features (optional — enables /api/chat and the import-analyse pipeline)
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
```

**Notes:**
- `ADMIN_TOKEN` and `PLAYER_TOKEN` are required. The server will refuse to start without them.
- On first boot the server auto-creates the SQLite database, runs all migrations, seeds default templates, and creates a default admin user.
- AI keys are optional. Without them the chat and AI-import features are disabled; everything else works normally.
- The default AI provider is OpenAI (`gpt-4o-mini`). Anthropic is supported but optional.
- In production (Railway/Docker) set these as environment variables — never commit `.env.local`.

---

## Workspace Layout

Bun workspaces: `shared` and `server`. The `scripts/` folder holds one-off utilities and is not a workspace.

```
.
├── mise.toml               # Tool versions (Bun 1.1)
├── package.json            # Workspace root — workspaces: ["shared", "server"]
├── bun.lockb               # Bun lockfile (commit this)
├── tsconfig.base.json      # Shared TypeScript config (strict, ES2022)
├── eslint.config.mjs
├── railway.toml            # Points at server/Dockerfile
│
├── shared/                 # @compendium/shared — Zod schemas + constants
│   └── src/                # Consumed as TS source, no build step
│       ├── protocol.ts     # Zod schemas for API messages
│       ├── schemas/
│       └── constants.ts
│
├── server/                 # @compendium/server — Next.js 15 + Hocuspocus
│   ├── server.ts           # Custom entry — Next.js + WebSocket on one port
│   ├── .env.example
│   ├── Dockerfile          # Three-stage build (deps → build → runtime)
│   └── src/
│       ├── app/            # App Router pages + ~70 API route handlers
│       ├── lib/            # Business logic (notes, auth, ai, import, …)
│       │   ├── db.ts       # SQLite singleton — bun:sqlite or better-sqlite3
│       │   ├── migrations.ts
│       │   ├── auth.ts     # Bearer token + session auth
│       │   ├── notes.ts    # Note CRUD, backlink derivation, FTS sync
│       │   ├── campaign-index.ts
│       │   ├── graph.ts
│       │   ├── import-*.ts # Parse / analyse / apply pipeline
│       │   └── ai/         # Orchestrator, tools, per-kind skill prompts
│       ├── collab/         # Hocuspocus server (web rich-text collab)
│       └── middleware.ts
│
└── scripts/                # One-off utilities (not a workspace)
    ├── dedupe-vault.ts
    ├── migrate-character-sheets.ts
    └── reset-db.ts
```

---

## Development Workflow

### Useful scripts (run from monorepo root)

| Command | What it does |
|---------|-------------|
| `bun run typecheck` | Type-check all workspaces |
| `bun run lint` | ESLint across all packages |
| `bun run format` | Prettier formatting |

### Useful scripts (run from `server/`)

| Command | What it does |
|---------|-------------|
| `bun run server.ts` | Dev server with HMR on port 3000 |
| `bun run build` | Next.js production build |
| `bun run start` | Start compiled Next.js output |
| `bun test` | Run unit tests (`bun:test`, real in-memory SQLite) |

### Adding a database migration

1. Open `server/src/lib/migrations.ts`.
2. Append a new entry to the `MIGRATIONS` array (version = array index).
3. The migration runs automatically on next server start — no manual apply step.

---

## Database

- **Engine:** SQLite — `bun:sqlite` under Bun (dev / tests), `better-sqlite3` under Node 22 (production). Both expose the same interface; switch happens in `server/src/lib/db.ts`.
- **File location:** `DATA_DIR/compendium.db` (default `./.data/compendium.db`)
- **Mode:** WAL (write-ahead logging) for concurrent reads
- **Migrations:** append-only array in `server/src/lib/migrations.ts`, currently at schema version 46. Auto-applied on boot.

Key tables: `notes`, `users`, `groups`, `group_members`, `characters`, `session_notes`, `import_jobs`, `assets`, `note_links`, `notes_fts` (FTS5), `audit_log`, `group_invite_tokens`.

---

## Deployment

### Railway (recommended)

1. Connect your repo in Railway. The service source root is the repo root.
2. Railway picks up `railway.toml` at root — it uses `server/Dockerfile`.
3. Add a **Volume** mounted at `/data`.
4. Set environment variables:
   - `ADMIN_TOKEN` — generate with `openssl rand -hex 32`
   - `PLAYER_TOKEN` — generate with `openssl rand -hex 32`
   - `OPENAI_API_KEY` — optional, for AI features
   - `DATA_DIR=/data`
5. Deploy. Health check at `GET /api/health`.

### Docker (self-hosted)

```bash
# Build the image (from repo root)
docker build -f server/Dockerfile -t compendium .

# Run with a named volume for persistence
docker run -d \
  -p 3000:3000 \
  -v compendium-data:/data \
  -e ADMIN_TOKEN=<your-token> \
  -e PLAYER_TOKEN=<your-token> \
  -e DATA_DIR=/data \
  compendium
```

The Dockerfile is a three-stage build:
1. **deps** (`oven/bun:1.1`) — install workspace deps, compile native modules (argon2, better-sqlite3)
2. **build** (`node:22-slim`) — Next.js production build, **rebuild `better-sqlite3` against Node 22**
3. **runtime** (`node:22-slim`) — minimal image, runs `server.ts` via `tsx`

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 15 (App Router), React 19 |
| Runtime (dev / tests) | Bun 1.1 |
| Runtime (prod) | Node.js 22 |
| Database | SQLite — `bun:sqlite` (dev) / `better-sqlite3` (prod), WAL mode |
| Collaborative editing | Hocuspocus + Yjs |
| Editor | Tiptap + ProseMirror |
| Knowledge graph | Sigma.js (WebGL) + Graphology |
| Drawings | Excalidraw |
| AI | Vercel AI SDK v6, `@ai-sdk/openai` (default `gpt-4o-mini`) |
| Auth | Argon2 (passwords), custom Bearer tokens, HTTP-only session cookies |
| Styling | Tailwind CSS 4, Lucide React |
| Language | TypeScript 5.6 (strict) |
| Package manager | Bun (workspace protocol) |
| Tool manager | Mise |

---

## Authentication

Two independent layers.

### Web dashboard (session-based)

- Sign-in creates an HTTP-only session cookie + CSRF token. CSRF is validated on every mutation.
- Users belong to one or more **Groups** (worlds) with a role: `admin`, `editor`, or `viewer`.
- `viewer` is a player; `admin` / `editor` are GMs. `dm_only` notes are filtered at the API layer for viewers.
- Sessions are stored in the `sessions` table with expiry, user-agent, and IP tracking.
- An `audit_log` table records admin actions.

### Bearer token (legacy / admin scripts)

- `Authorization: Bearer <token>` or `?token=<token>` query parameter.
- Two roles: `admin` (full access, AI chat) and `player` (read-write notes).
- Tokens come from `ADMIN_TOKEN` / `PLAYER_TOKEN` env vars or the `config` SQLite table. Compared with a timing-safe function.

---

## API Overview

All routes live under `/api/`. ~70 endpoints; grouped:

| Group | Example routes |
|-------|---------------|
| Health | `GET /api/health` |
| Auth / profile | `POST /api/sessions/create`, `POST /api/sessions/end`, `GET /api/profile`, `POST /api/profile/password`, `POST /api/profile/avatar` |
| Notes | `GET /api/notes/[...path]`, `POST /api/notes/create`, `DELETE /api/notes/[...path]`, `POST /api/notes/move`, `POST /api/notes/duplicate`, `POST /api/notes/visibility`, `POST /api/notes/sheet`, `POST /api/notes/excalidraw-scene` |
| Search | `GET /api/search?q=...` (FTS5), `GET /api/ui/search` |
| Worlds (groups) | `GET /api/worlds`, `POST /api/worlds`, `GET /api/worlds/active`, `PATCH /api/worlds/[id]`, `POST /api/worlds/[id]/invite`, `POST /api/worlds/[id]/transfer`, `GET /api/worlds/[id]/members`, `GET /api/worlds/[id]/personalities` |
| Campaigns | `POST /api/campaigns/reorder`, `DELETE /api/campaigns/delete`, `POST /api/worlds/[id]/campaigns/[slug]/join` |
| Folders | `POST /api/folders/create`, `POST /api/folders/move`, `DELETE /api/folders/delete` |
| Tree | `GET /api/tree` |
| Characters | `GET /api/characters`, `POST /api/characters/create`, `GET /api/me/characters`, `POST /api/me/characters/import-pdf` |
| Inventory | `GET /api/inventory`, `POST /api/inventory` |
| Sessions (game) | `POST /api/sessions/mark-closed` |
| Tags | `GET /api/tags`, `GET /api/note-tags`, `GET /api/asset-tags` |
| Assets | `POST /api/assets/upload`, `GET /api/assets/[id]`, `GET /api/assets/list`, `GET /api/assets/by-path` |
| Backlinks | `GET /api/backlinks/[...path]`, `POST /api/notes/backlink` |
| Graph | `GET /api/graph`, `GET /api/graph/neighborhood/[...path]` |
| Import (AI) | `POST /api/import`, `POST /api/import/[id]/analyse`, `POST /api/import/[id]/apply`, `POST /api/import/[id]/orchestrate` |
| AI Chat | `POST /api/chat` (streaming, Vercel AI SDK), `POST /api/chat/upload` |
| UI state | `POST /api/ui/gm-mode` |
| Admin | `POST /api/admin/login`, `POST /api/admin/vault/upload` |
| Stats | `GET /api/stats` |
