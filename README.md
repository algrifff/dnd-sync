# Compendium

Self-hosted TTRPG note-taking web app for players and GMs — real-time collaborative notes, character sheets, session logs, knowledge graph, and AI-assisted vault import. Single Next.js 15 process backed by SQLite. See [ARCHITECTURE.md](./ARCHITECTURE.md) for how the system fits together.

## Key features

- Real-time collaborative notes (Yjs + Hocuspocus, ProseMirror state)
- Character sheets with inline-editable headers (per-kind: character / person / creature / item / location)
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
- [Connect Claude to Compendium](#connect-claude-to-compendium)
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

# AI import (optional — enables Smart Import and PDF character import)
# OPENAI_API_KEY=

# Public origin (optional, recommended in production). The MCP connector's
# OAuth metadata and token audience are built from it.
# PUBLIC_APP_URL=https://compendium.example
```

**Notes:**
- `ADMIN_TOKEN` and `PLAYER_TOKEN` are required. The server will refuse to start without them.
- On first boot the server auto-creates the SQLite database, runs all migrations, seeds default templates, and creates a default admin user.
- `OPENAI_API_KEY` is optional. Without it the AI import features are disabled; everything else works normally. There is no in-app AI chat; players use Claude through an MCP connector.
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
│       │   ├── db.ts       # SQLite singleton — bun:sqlite
│       │   ├── migrations.ts
│       │   ├── auth.ts     # Bearer token + session auth
│       │   ├── notes.ts    # Note CRUD, backlink derivation, FTS sync
│       │   ├── campaign-index.ts
│       │   ├── graph.ts
│       │   ├── import-*.ts # Parse / analyse / apply pipeline
│       │   └── ai/         # OpenAI client, import skills, tools (unreferenced until the MCP connector)
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
| `bun run test` | Run unit tests (`bun:test`, real in-memory SQLite), memory-gated; `test:changed` runs only tests affected by your diff |

### Adding a database migration

1. Open `server/src/lib/migrations.ts`.
2. Append a new entry to the `MIGRATIONS` array (version = array index).
3. The migration runs automatically on next server start — no manual apply step.

---

## Database

- **Engine:** SQLite — `bun:sqlite`, used in dev, tests and production alike (everything runs on Bun). Wrapped in `server/src/lib/db.ts`.
- **File location:** `DATA_DIR/compendium.db` (default `./.data/compendium.db`)
- **Mode:** WAL (write-ahead logging) for concurrent reads
- **Migrations:** append-only array in `server/src/lib/migrations.ts`, currently at schema version 48. Auto-applied on boot.

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
   - `OPENAI_API_KEY` — optional, for AI import
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

The Dockerfile is a single stage on `oven/bun:1.4.3`: install workspace deps, run the Next.js production build, then start `server.ts` with `bun run`.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 15 (App Router), React 19 |
| Runtime (dev / tests) | Bun 1.1 |
| Runtime (prod) | Node.js 22 |
| Database | SQLite — `bun:sqlite`, WAL mode |
| Collaborative editing | Hocuspocus + Yjs |
| Editor | Tiptap + ProseMirror |
| Knowledge graph | Sigma.js (WebGL) + Graphology |
| Drawings | Excalidraw |
| AI | OpenAI via `lib/ai/openai.ts` for import (model from `OPENAI_MODEL`, default `gpt-5-mini`) |
| Auth | Argon2 (passwords), custom Bearer tokens, HTTP-only session cookies |
| Styling | Tailwind CSS 4, Lucide React |
| Language | TypeScript 5.6 (strict) |
| Package manager | Bun (workspace protocol) |
| Tool manager | Mise |

---

## Connect Claude to Compendium

Claude (claude.ai, the desktop and mobile apps, Claude Code) can read your
world's notes through a custom connector, using your own Claude
subscription. It is limited to one world you pick and shows you exactly
what you can see in the app: Secret and Private notes stay hidden from
players. Claude cannot edit notes. The one thing it can do beyond reading
is propose a Session Wrap-up, which does nothing until you review and
apply it when you end the Session.

Your Compendium must be reachable over HTTPS from the internet (a Railway
deploy is), and your admin should have set `PUBLIC_APP_URL`.

**In claude.ai, Claude Desktop or the mobile app** (Free, Pro and Max plans
add connectors to their own account; on Team and Enterprise an Owner adds
it under Organization settings > Connectors first):

1. Open **Customize > Connectors** and click **Add custom connector**.
2. Enter the MCP server URL: `https://<your-compendium>/api/mcp`.
3. Leave the OAuth client setting on **Use Claude's published identity**
   (or **Register automatically**; both work, no client ID or secret needed)
   and click **Add**.
4. Click **Connect**. A Compendium tab opens: sign in if asked, pick the
   world to share, and click **Allow read access**.
5. Back in Claude, turn the connector on in a chat with the **+** menu and
   ask away ("Who is Volo?", "Summarise last session", "What do we know about
   the Xanathar?").

**In Claude Code:**

```bash
claude mcp add --transport http compendium https://<your-compendium>/api/mcp
```

Then run `/mcp` inside Claude Code to sign in; the same consent page
opens in your browser.

**To disconnect**, go to **Settings > Profile > Connected apps** in
Compendium and click **Disconnect** (removing the connector in Claude
also works, but only Compendium's side revokes the token immediately).

What Claude gets: `list_campaigns`, `browse_notes`, `search_notes`,
`read_note` and `note_neighbors`. Tokens last an hour and refresh for up
to 30 days; being removed from a world ends access at once.

---

## Authentication

Three independent layers.

### Web dashboard (session-based)

- Sign-in creates an HTTP-only session cookie + CSRF token. CSRF is validated on every mutation.
- Users belong to one or more **Groups** (worlds) with a role: `admin`, `editor`, or `viewer`.
- `viewer` is a player; `admin` / `editor` are GMs. `dm_only` notes are filtered at the API layer for viewers.
- Sessions are stored in the `sessions` table with expiry, user-agent, and IP tracking.
- An `audit_log` table records admin actions.

### Super-admin (`/admin/*`)

- `POST /api/admin/login` compares the submitted token with `ADMIN_TOKEN` (timing-safe, rate-limited) and sets the `__sa` cookie.

### MCP connector (OAuth 2.1 bearer tokens, `/api/mcp` only)

- Compendium is its own authorization server: discovery at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`, Dynamic Client Registration at `POST /api/oauth/register`, Client ID Metadata Documents accepted as `client_id`, consent at `/oauth/authorize`, token exchange and refresh at `POST /api/oauth/token` (PKCE S256 required), revocation at `POST /api/oauth/revoke`.
- Codes and tokens are stored hashed. Access tokens live one hour; refresh tokens rotate on every use and live 30 days. A token is bound to one user, one world and the `/api/mcp` resource, and the member's role is re-read on every request.

---

## API Overview

All routes live under `/api/`. ~70 endpoints; grouped:

| Group | Example routes |
|-------|---------------|
| Health | `GET /api/health` |
| Auth / profile | `POST /api/sessions/create`, `GET /api/profile`, `POST /api/profile/password`, `POST /api/profile/avatar` |
| Notes | `GET /api/notes/[...path]`, `POST /api/notes/create`, `DELETE /api/notes/[...path]`, `POST /api/notes/move`, `POST /api/notes/duplicate`, `POST /api/notes/visibility`, `POST /api/notes/sheet` |
| Search | `GET /api/ui/search` |
| Templates | `GET /api/templates`, `GET /api/templates/[kind]` |
| Worlds (groups) | `GET /api/worlds`, `POST /api/worlds`, `GET /api/worlds/active`, `PATCH /api/worlds/[id]`, `POST /api/worlds/[id]/invite`, `POST /api/worlds/[id]/transfer`, `GET /api/worlds/[id]/members` |
| Campaigns | `POST /api/campaigns/reorder`, `DELETE /api/campaigns/delete`, `POST /api/worlds/[id]/campaigns/[slug]/join` |
| Folders | `POST /api/folders/create`, `POST /api/folders/move`, `DELETE /api/folders/delete` |
| Tree | `GET /api/tree` |
| Characters | `GET /api/characters`, `GET /api/me/characters`, `POST /api/me/characters/import-pdf` |
| Sessions (game) | `POST /api/sessions/mark-closed`, `GET`/`POST /api/sessions/wrap-up`, `GET /api/sessions/wrap-up/context`, `POST /api/sessions/wrap-up/apply` |
| Tags | `GET /api/tags`, `GET /api/note-tags`, `GET /api/asset-tags` |
| Assets | `POST /api/assets/upload`, `GET /api/assets/[id]`, `GET /api/assets/list`, `GET /api/assets/by-path` |
| Backlinks | `POST /api/notes/backlink` |
| MCP connector | `POST /api/mcp`, `GET /.well-known/oauth-protected-resource`, `GET /.well-known/oauth-authorization-server`, `POST /api/oauth/register`, `POST /api/oauth/authorize`, `POST /api/oauth/token`, `POST /api/oauth/revoke`, `DELETE /api/oauth/grants/[id]` |
| Graph | `GET /api/graph`, `GET /api/graph/neighborhood/[...path]` |
| Import (AI) | `POST /api/import`, `POST /api/import/[id]/analyse`, `POST /api/import/[id]/apply`, `POST /api/import/[id]/orchestrate` |
| UI state | `POST /api/ui/gm-mode` |
| Admin | `POST /api/admin/login`, `POST /api/admin/vault/upload` |
