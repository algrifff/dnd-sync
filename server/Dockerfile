# Build context is the repo root (see railway.toml — dockerfilePath
# points here, at server/Dockerfile, but the context itself is the
# default: repo root). That's why the COPY instructions below reference
# shared/ and server/ as top-level folders instead of relative to this
# file's own directory.
#
# Single stage on Bun: dev, tests and production all use the same
# runtime and bun:sqlite, so there is no native SQLite module to rebuild.
FROM oven/bun:1.4.3
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV DATA_DIR=/data

# poppler-utils provides `pdftotext`, used by the PDF character-sheet
# importer in src/lib/pdfImport/extractText.ts.
RUN apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /data

COPY package.json bun.lockb tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
RUN bun install --frozen-lockfile

COPY shared ./shared
COPY server ./server

WORKDIR /app/server
RUN bun run build

# Litestream (continuous SQLite backup) is opt-in: see docker-entrypoint.sh.
COPY --from=litestream/litestream:0.5.17 /usr/local/bin/litestream /usr/local/bin/litestream
RUN chmod +x /app/server/docker-entrypoint.sh

# Run as the image's unprivileged `bun` user. It owns /data (DB, assets) and
# .next (Next's runtime cache). A volume mounted over /data keeps the volume's
# own owner; docker-entrypoint.sh stops with a clear error if bun can't write it.
RUN chown -R bun:bun /data /app/server/.next
USER bun

EXPOSE 3000
CMD ["/app/server/docker-entrypoint.sh"]
