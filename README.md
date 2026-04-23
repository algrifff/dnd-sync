# Compendium

Self-hosted real-time vault for tabletop RPG campaigns. Obsidian is the UI. A Next.js 15 + SQLite server handles sync, search, AI-assisted import, and a web dashboard. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design decisions and roadmap.

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

# 6. In a second terminal — build the Obsidian plugin with watch
cd plugin
bun run dev
```

The web dashboard is at `http://localhost:3000`.  
Point Obsidian's Compendium plugin to `http://localhost:3000` with the admin token.

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

# Run the plugin in watch mode (separate terminal)
cd plugin
bun run dev
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

# Development — Obsidian plugin with watch
cd ../plugin
bun run dev

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

# Auth — Bearer tokens used by the Obsidian plugin
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
- In production (Railway/Docker) set these as environment variables — never commit `.env.local`.

---

## Workspace Layout

```
.
├── mise.toml               # Tool versions (Bun 1.1)
├── package.json            # Workspace root — defines three workspaces
├── bun.lockb               # Bun lockfile (commit this)
├── tsconfig.base.json      # Shared TypeScript config (strict, ES2022)
├── eslint.config.mjs
├── .prettierrc
│
├── shared/                 # @compendium/shared
│   └── src/
│       ├── protocol.ts     # Zod schemas for all API messages
│       └── constants.ts
│
├── server/                 # @compendium/server — Next.js 15 + WebSocket
│   ├── server.ts           # Custom entry point (Next.js + ws on same port)
│   ├── .env.example        # Environment variable template
│   ├── Dockerfile          # Multi-stage build for production
│   └── src/
│       ├── app/            # Next.js App Router (pages + 50+ API routes)
│       ├── lib/            # Business logic (~8 400 LOC)
│       │   ├── db.ts       # SQLite singleton (better-sqlite3, WAL mode)
│       │   ├── migrations.ts
│       │   ├── auth.ts     # Bearer token + session auth
│       │   └── ai/         # AI orchestrator, tools, per-kind skills
│       ├── ws/             # WebSocket route handler (Yjs sync)
│       └── collab/         # Hocuspocus server (web-app editing)
│
└── plugin/                 # @compendium/plugin — Obsidian plugin
    ├── manifest.json
    └── src/
        ├── main.ts         # Plugin lifecycle
        ├── sync/           # Yjs WebSocket provider + binary sync
        └── ui/             # Status bar indicator
```

The `shared` package is consumed as TypeScript source — no separate build step needed.

---

## Development Workflow

### Useful scripts (run from monorepo root)

| Command | What it does |
|---------|-------------|
| `bun run typecheck` | Type-check all three workspaces |
| `bun run lint` | ESLint across all packages |
| `bun run format` | Prettier formatting |

### Useful scripts (run from `server/`)

| Command | What it does |
|---------|-------------|
| `bun run server.ts` | Dev server with HMR on port 3000 |
| `bun run build` | Next.js production build |
| `bun run start` | Start compiled Next.js output |

### Useful scripts (run from `plugin/`)

| Command | What it does |
|---------|-------------|
| `bun run dev` | esbuild watch — outputs `main.js` |
| `bun run build` | Production esbuild bundle |

### Adding a database migration

1. Open `server/src/lib/migrations.ts`.
2. Append a new entry to the `MIGRATIONS` array (version = array index).
3. The migration runs automatically on next server start — no manual apply step.

---

## Database

- **Engine:** SQLite via `better-sqlite3` (native, in-process, no separate server)
- **File location:** `DATA_DIR/vault.db` (default `./.data/vault.db`)
- **Mode:** WAL (write-ahead logging) for concurrent reads
- **Migrations:** 18 migrations, auto-applied on boot

Key tables: `notes`, `users`, `groups`, `group_members`, `characters`, `session_notes`, `import_jobs`, `assets`, `notes_fts` (FTS5 full-text search).

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
1. **deps** (oven/bun:1.1.45) — install deps, compile native modules (argon2, better-sqlite3)
2. **build** (node:22-slim) — esbuild plugin, Next.js production build
3. **runtime** (node:22-slim) — minimal runtime image, runs `server.ts` via tsx

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 15 (App Router), React 19 |
| Runtime (dev) | Bun 1.1 |
| Runtime (prod) | Node.js 22 |
| Database | SQLite via better-sqlite3 (WAL mode) |
| Real-time sync | Yjs + WebSocket (Obsidian ↔ server) |
| Collaborative editing | Hocuspocus (web app rich editor) |
| AI | Vercel AI SDK v6, `@ai-sdk/openai` |
| Editor (web) | Tiptap + ProseMirror |
| Editor (plugin) | CodeMirror 6 + y-codemirror.next |
| Graph | Sigma.js (WebGL) + Graphology |
| Auth | Argon2 (passwords), custom Bearer tokens, HTTP-only session cookies |
| Styling | Tailwind CSS 4, Lucide React |
| Language | TypeScript 5.6 (strict) |
| Package manager | Bun (workspace protocol) |
| Tool manager | Mise |

---

## Authentication

### Obsidian plugin (Bearer token)

The plugin sends `Authorization: Bearer <token>` (or `?token=<token>`) on every request.

- `ADMIN_TOKEN` — full read/write access
- `PLAYER_TOKEN` — read-only access

Tokens are compared with a timing-safe function. They are auto-generated on first boot and stored in the `config` SQLite table.

### Web dashboard (session-based)

- Sign-in creates an HTTP-only session cookie + CSRF token.
- Users belong to one or more **Groups** (worlds) with a role: `admin`, `editor`, or `viewer`.
- Sessions are stored in the `sessions` table with expiry, user-agent, and IP tracking.
- An `audit_log` table records admin actions.

---

## API Overview

All routes live under `/api/`. The full set is ~50 endpoints; key groups:

| Group | Example routes |
|-------|---------------|
| Health | `GET /api/health` |
| Auth | `POST /api/sessions/create`, `GET /api/profile` |
| Notes | `GET /api/notes/[...path]`, `POST /api/notes/create`, `DELETE /api/notes/[...path]` |
| Search | `GET /api/search?q=...` (FTS5) |
| Characters | `GET /api/characters`, `POST /api/characters/create` |
| Sessions | `POST /api/sessions/create` |
| Worlds/Groups | `GET /api/worlds`, `POST /api/worlds`, `POST /api/worlds/[id]/invite` |
| Assets | `POST /api/assets/upload`, `GET /api/assets/[id]` |
| Import (AI) | `POST /api/import`, `POST /api/import/[id]/analyse`, `POST /api/import/[id]/apply` |
| Graph | `GET /api/graph`, `GET /api/graph/neighborhood/[...path]` |
| Tree | `GET /api/tree`, `POST /api/folders/create` |
| AI Chat | `POST /api/chat` (streaming, Vercel AI SDK) |
| Plugin | `GET /api/plugin/bundle`, `GET /api/plugin/version` |
| Admin | `POST /api/admin/vault/upload` |
