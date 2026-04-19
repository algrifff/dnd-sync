# Build context is the `compendium-ai/` folder (set via railway.toml).
#
# Previously this was Bun-install + Node-build + Bun-runtime. The Bun
# runtime worked for simple routes but blew up with opaque
# "SyntaxError: Unexpected token ','" on any route that loaded the
# heavy ingest/collab/Tiptap import chain — an unserialisable failure
# inside Bun's native request handling that we couldn't catch.
#
# Node is Next's native target. Run everything on Node; keep Bun only
# for the install step because the workspace manifests use the
# `workspace:*` protocol that bun.lockb tracks natively (npm 10 chokes
# on it). Bun install produces a plain node_modules layout Node reads
# directly.

# --- Stage 1: install with Bun (resolves workspace:* + honours lockfile) ---
FROM oven/bun:1.1.45 AS deps
WORKDIR /app
COPY package.json bun.lockb tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY plugin/package.json ./plugin/
RUN bun install --frozen-lockfile


# --- Stage 2: build on Node ------------------------------------------
FROM node:20-slim AS build
WORKDIR /app

# Build tools so Node's `npm rebuild` can fall back to a local compile
# if better-sqlite3 / argon2 prebuilds don't match the Node ABI.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules      ./node_modules
COPY --from=deps /app/package.json      ./package.json
COPY --from=deps /app/bun.lockb         ./bun.lockb
COPY --from=deps /app/tsconfig.base.json ./tsconfig.base.json
COPY shared ./shared
COPY plugin ./plugin
COPY server ./server

# Rebuild the native modules against Node's ABI. Most of the time the
# prebuilt binary Bun install downloaded already matches (N-API is
# ABI-stable), but this is the cheap safety net that catches the rare
# miss rather than finding out at request time.
RUN npm rebuild better-sqlite3 argon2

# Plugin bundle.
WORKDIR /app/plugin
RUN node esbuild.config.mjs --production

# Next production build.
WORKDIR /app/server
ENV NODE_ENV=production
RUN npm run build


# --- Stage 3: runtime on Node ----------------------------------------
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV DATA_DIR=/data
ENV PLUGIN_BUNDLE_DIR=/app/plugin-bundle

RUN mkdir -p /data /app/plugin-bundle

COPY --from=build /app/node_modules                 ./node_modules
COPY --from=build /app/package.json                 ./package.json
COPY --from=build /app/tsconfig.base.json           ./tsconfig.base.json
COPY --from=build /app/shared                       ./shared
COPY --from=build /app/server                       ./server
COPY --from=build /app/plugin/main.js               ./plugin-bundle/main.js
COPY --from=build /app/plugin/manifest.json         ./plugin-bundle/manifest.json

WORKDIR /app/server
EXPOSE 3000
# tsx's ESM loader transforms TypeScript on import so server.ts can
# run under Node without a prior compile step.
CMD ["node", "--import", "tsx/esm", "server.ts"]
