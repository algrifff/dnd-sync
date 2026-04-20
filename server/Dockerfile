# Build context is the `compendium-ai/` folder (set via railway.toml).
#
# Three-stage split:
#
#   1. deps   — Bun installs packages (understands bun.lockb + workspace:*).
#               Native modules (better-sqlite3, argon2) are compiled here
#               against Bun's embedded Node ABI — NOT the same as Node 22.
#
#   2. build  — Node 22 rebuilds better-sqlite3 against its own ABI, then
#               runs the Next.js production build. better-sqlite3 uses V8
#               API (not N-API), so the ABI is version-specific and must
#               match the runtime exactly.
#
#   3. runtime — Slim Node 22 image; receives the rebuilt node_modules and
#                the Next.js build output.

# --- Stage 1: install on Bun + build tools for native module fallback ---
FROM oven/bun:1.3.11 AS deps
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lockb tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
RUN bun install --frozen-lockfile


# --- Stage 2: Next build on Node --------------------------------------
FROM node:22-trixie-slim AS build
WORKDIR /app

# Build tools needed to recompile better-sqlite3 against Node 22's ABI.
# The binary from the Bun deps stage was linked against Bun's embedded
# Node (v23 ABI) and cannot be dlopen'd by Node 22.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules       ./node_modules
COPY --from=deps /app/package.json       ./package.json
COPY --from=deps /app/bun.lockb          ./bun.lockb
COPY --from=deps /app/tsconfig.base.json ./tsconfig.base.json
COPY shared ./shared
COPY server ./server

# Recompile better-sqlite3 for Node 22 (V8 ABI 127).
RUN npm rebuild better-sqlite3

WORKDIR /app/server
ENV NODE_ENV=production
RUN npm run build


# --- Stage 3: runtime on Node -----------------------------------------
FROM node:22-trixie-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV DATA_DIR=/data

RUN mkdir -p /data

COPY --from=build /app/node_modules             ./node_modules
COPY --from=build /app/package.json             ./package.json
COPY --from=build /app/tsconfig.base.json       ./tsconfig.base.json
COPY --from=build /app/shared                   ./shared
COPY --from=build /app/server                   ./server

WORKDIR /app/server
EXPOSE 3000
# tsx's ESM loader transforms TypeScript on import so server.ts runs
# directly under Node without a separate tsc emit step.
CMD ["node", "--import", "tsx/esm", "server.ts"]
