# Build context is the `compendium-ai/` folder (set via railway.toml).
#
# Three stages, each using the tool that's native to its phase:
#   1. deps    — Bun installs from bun.lockb (fast, honours the lockfile)
#   2. build   — Node compiles Next (Next is Node-first; running next
#                build under Bun's node-compat layer caused worker-IPC
#                failures on Railway that don't repro locally)
#   3. runtime — Bun serves (we use Bun.file + bun:sqlite natively,
#                so the serving image has to be Bun)
# The build output from stage 2 is platform-agnostic JS; Bun runs it
# identically whether Node or Bun compiled it.

# --- Stage 1: install dependencies with Bun -----------------------------
FROM oven/bun:1.1.45 AS deps
WORKDIR /app
COPY package.json bun.lockb tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY plugin/package.json ./plugin/
RUN bun install --frozen-lockfile


# --- Stage 2: build with Node -------------------------------------------
FROM node:20-slim AS build
WORKDIR /app

# Bun-installed node_modules uses the standard npm layout; Node reads
# it without modification. Workspace packages come through as symlinks
# which Node resolves natively.
COPY --from=deps /app/node_modules      ./node_modules
COPY --from=deps /app/package.json      ./package.json
COPY --from=deps /app/bun.lockb         ./bun.lockb
COPY --from=deps /app/tsconfig.base.json ./tsconfig.base.json
COPY shared ./shared
COPY plugin ./plugin
COPY server ./server

# Plugin bundle. Invoke esbuild.config.mjs directly under Node so the
# plugin's package-script (which calls "bun run ...") is bypassed.
WORKDIR /app/plugin
RUN node esbuild.config.mjs --production

# Next production build.
WORKDIR /app/server
ENV NODE_ENV=production
RUN npm run build


# --- Stage 3: runtime on Bun --------------------------------------------
FROM oven/bun:1.1.45 AS runtime
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
CMD ["bun", "run", "server.ts"]
