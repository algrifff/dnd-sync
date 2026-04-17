# Compendium

Self-hosted real-time vault for D&D. Obsidian is the UI. A Next.js + SQLite server handles sync, search, and AI. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full plan.

## Getting started

```bash
# First time only: install mise (https://mise.jdx.dev/getting-started.html)
curl https://mise.run | sh

# Install tool versions pinned in mise.toml (Bun 1.1)
mise install

# Install dependencies across all workspaces
bun install

# Typecheck everything
bun run typecheck
```

## Workspace layout

- `shared/` — `@compendium/shared`: protocol types (Zod) + constants. Consumed as TS source, no build.
- `server/` — `@compendium/server`: Next.js app + WebSocket + SQLite. Deploys to Railway.
- `plugin/` — `@compendium/plugin`: the Obsidian plugin.

## Status

**Milestone 1 — Foundation:** scaffold + shared types.
