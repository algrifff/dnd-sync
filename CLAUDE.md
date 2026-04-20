# CLAUDE.md

## Project

Self-hosted real-time D&D vault. Next.js 15 + SQLite server handles sync, search, AI-import, and a web dashboard. An Obsidian plugin connects via WebSocket + Yjs for real-time note sync.

## Monorepo layout

```
server/     # Next.js 15 App Router + custom WebSocket server
plugin/     # Obsidian plugin (esbuild, TypeScript)
shared/     # @compendium/shared — Zod schemas + constants (no build step)
scripts/    # one-off utilities
```

## Commands

| Context | Command |
|---------|---------|
| Install deps | `bun install` (from root) |
| Dev server | `cd server && bun run server.ts` |
| Plugin watch | `cd plugin && bun run dev` |
| Type-check all | `bun run typecheck` (from root) |
| Lint | `bun run lint` |
| Tests | `bun test` |
| Production build | `cd server && bun run build` |

## Runtime split

- **Dev / tests**: Bun — uses `bun:sqlite` (see `server/src/lib/db.ts`)
- **Production**: Node 22 — uses `better-sqlite3` (multi-stage Dockerfile)
- The DB adapter switches at runtime via `typeof Bun !== "undefined"` guard

## Key files

- `server/src/lib/db.ts` — SQLite singleton, dual-runtime adapter
- `server/src/lib/migrations.ts` — append-only migration array (auto-runs on boot)
- `server/src/lib/auth.ts` — Bearer token + session auth
- `server/src/lib/ai/` — AI orchestrator, tools, per-kind import skills
- `server/server.ts` — custom entry point (Next.js + WebSocket on same port)
- `server/next.config.ts` — serverExternalPackages for Yjs/Tiptap/graph libs

## Deployment

Railway: build context is repo root, `railway.toml` at root, Dockerfile at `server/Dockerfile`.
Set env vars: `ADMIN_TOKEN`, `PLAYER_TOKEN`, `DATA_DIR=/data` + a mounted volume at `/data`.

## Conventions

- All API routes live under `server/src/app/api/`
- Error shape: `{ code, message, details }`
- No comments unless the WHY is non-obvious
- TypeScript strict mode throughout
- Migrations: append to `MIGRATIONS` array in `migrations.ts`, never edit existing entries

## Skills (invoke with `/skill:<name>`)

| Skill | Purpose |
|-------|---------|
| `code-review` | Structured review — correctness, perf, type safety |
| `security-audit` | OWASP Top 10 scan, auth/input validation focus |
| `refactor-plan` | Strategic refactoring with risk assessment |
| `rigor-audit` | Combined quality + security check |

Full docs: [`.claude/skills/README.md`](.claude/skills/README.md)

## Path-specific rules (auto-loaded by Claude Code)

| Rule file | Applies to |
|-----------|------------|
| [`.claude/rules/frontend.md`](.claude/rules/frontend.md) | `**/*.tsx`, `**/*.jsx`, `**/components/**` |
| [`.claude/rules/backend.md`](.claude/rules/backend.md) | `**/api/**`, `**/server/**` |
| [`.claude/rules/database.md`](.claude/rules/database.md) | `**/migrations*`, `**/*.sql` |
| [`.claude/rules/security.md`](.claude/rules/security.md) | `**/auth/**`, `**/security/**` |
| [`.claude/rules/testing.md`](.claude/rules/testing.md) | `**/*.test.*`, `**/*.spec.*` |

Language guides (TypeScript/Next.js most relevant): [`.claude/languages/`](.claude/languages/)
