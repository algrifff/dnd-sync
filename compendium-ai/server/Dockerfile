# Build context is the `compendium-ai/` folder (set via railway.toml).

FROM oven/bun:1.1 AS build
WORKDIR /app

# Workspace manifests first so bun install caches when only source changes.
COPY package.json bun.lockb tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY plugin/package.json ./plugin/
RUN bun install --frozen-lockfile

# Source
COPY shared ./shared
COPY plugin ./plugin
COPY server ./server

# Build the Obsidian plugin so the server can ship it to friends on demand.
WORKDIR /app/plugin
RUN bun run build

# Build Next.js.
WORKDIR /app/server
ENV NODE_ENV=production
RUN bun run build

FROM oven/bun:1.1 AS runtime
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
