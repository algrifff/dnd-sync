# Build context is the `compendium-ai/` folder (set via railway.toml).

FROM oven/bun:1.1 AS build
WORKDIR /app

# Workspace manifests first, so `bun install` caches when source changes.
COPY package.json bun.lockb tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY plugin/package.json ./plugin/
RUN bun install --frozen-lockfile

# Source
COPY shared ./shared
COPY server ./server

WORKDIR /app/server
ENV NODE_ENV=production
RUN bun run build

FROM oven/bun:1.1 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV DATA_DIR=/data

RUN mkdir -p /data

COPY --from=build /app/node_modules      ./node_modules
COPY --from=build /app/package.json      ./package.json
COPY --from=build /app/tsconfig.base.json ./tsconfig.base.json
COPY --from=build /app/shared            ./shared
COPY --from=build /app/server            ./server

WORKDIR /app/server
EXPOSE 3000
CMD ["bun", "run", "server.ts"]
