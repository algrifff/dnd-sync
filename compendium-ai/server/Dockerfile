# Build context is the `compendium-ai/` folder (set via railway.toml).
#
# One considered split, not a back-and-forth:
#
#   * Install with Bun — honours bun.lockb, resolves the `workspace:*`
#     protocol natively, fast. Requires python3+make+g++ in the image
#     because a missing prebuild for argon2 / better-sqlite3 falls back
#     to node-gyp compile, which node:22-slim has but oven/bun doesn't
#     out of the box.
#   * Build + runtime on Node — Next 15's production SSR runs under
#     Bun's Node-compat layer with opaque "SyntaxError: Unexpected
#     token ','" failures on any route that evaluates a heavy import
#     chain. The app code is already Bun-free after the
#     bun:sqlite / Bun.password / Bun.file swaps, so Node runtime is
#     the right endpoint.
#
# Native modules compiled during the install stage target Node-API,
# which is ABI-stable across Node majors, so they load cleanly under
# node:22-slim at runtime without a rebuild step.

# --- Stage 1: install on Bun + build tools for native module fallback ---
FROM oven/bun:1.1.45 AS deps
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lockb tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY plugin/package.json ./plugin/
RUN bun install --frozen-lockfile


# --- Stage 2: Next build on Node --------------------------------------
FROM node:22-slim AS build
WORKDIR /app

COPY --from=deps /app/node_modules       ./node_modules
COPY --from=deps /app/package.json       ./package.json
COPY --from=deps /app/bun.lockb          ./bun.lockb
COPY --from=deps /app/tsconfig.base.json ./tsconfig.base.json
COPY shared ./shared
COPY plugin ./plugin
COPY server ./server

WORKDIR /app/plugin
RUN node esbuild.config.mjs --production

WORKDIR /app/server
ENV NODE_ENV=production
RUN npm run build


# --- Stage 3: runtime on Node -----------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV DATA_DIR=/data
ENV PLUGIN_BUNDLE_DIR=/app/plugin-bundle

RUN mkdir -p /data /app/plugin-bundle

COPY --from=build /app/node_modules             ./node_modules
COPY --from=build /app/package.json             ./package.json
COPY --from=build /app/tsconfig.base.json       ./tsconfig.base.json
COPY --from=build /app/shared                   ./shared
COPY --from=build /app/server                   ./server
COPY --from=build /app/plugin/main.js           ./plugin-bundle/main.js
COPY --from=build /app/plugin/manifest.json     ./plugin-bundle/manifest.json

WORKDIR /app/server
EXPOSE 3000
# tsx's ESM loader transforms TypeScript on import so server.ts runs
# directly under Node without a separate tsc emit step.
CMD ["node", "--import", "tsx/esm", "server.ts"]
