# Build context is the `compendium-ai/` folder (set via railway.toml).
#
# Previously this was Bun-install + Node-build + Bun-runtime. The
# Bun runtime worked for simple routes but blew up with opaque
# "SyntaxError: Unexpected token ','" on anything that pulled the
# heavy ingest/collab/Tiptap import chain at module load. Running
# Next 15's production server under Bun's Node-compat layer has
# sharp edges we can't paper over without giving up reliability.
#
# Node is Next's native target. Running the whole pipeline under
# Node eliminates the entire class of Bun↔Next boundary issues.
# We give up Bun.file (swapped to fs.createReadStream) and
# bun:sqlite (swapped to better-sqlite3) — both Node-native and
# equivalent in semantics for our use.
#
# Two stages:
#   1. build   — Node installs + builds plugin + builds Next
#   2. runtime — Node runs server.ts via tsx's ESM loader

# --- Stage 1: install + build on Node ----------------------------------
FROM node:20-slim AS build
WORKDIR /app

# Build tools for the native modules we depend on (better-sqlite3,
# argon2). Both ship prebuilt binaries for common platforms, but
# falling back to a local compile keeps the build deterministic even
# when the prebuild cache misses.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY plugin/package.json ./plugin/
RUN npm install --no-audit --no-fund

COPY shared ./shared
COPY plugin ./plugin
COPY server ./server

# Plugin bundle.
WORKDIR /app/plugin
RUN node esbuild.config.mjs --production

# Next production build.
WORKDIR /app/server
ENV NODE_ENV=production
RUN npm run build


# --- Stage 2: runtime on Node ------------------------------------------
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
# run under Node without a prior compile step. Avoids maintaining a
# separate tsc emit just for the custom server entry.
CMD ["node", "--import", "tsx/esm", "server.ts"]
