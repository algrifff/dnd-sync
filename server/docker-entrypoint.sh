#!/bin/sh
# Container entrypoint. With LITESTREAM_REPLICA_URL set, restore the DB
# from the replica if it is missing, then run the app under Litestream
# (which forwards SIGTERM to it and syncs once more on exit). Without it,
# run the app exactly as before.
set -eu

DB=/data/compendium.db
CONFIG=/app/server/litestream.yml

if [ ! -w /data ]; then
  echo "[entrypoint] /data is not writable by $(id -un) (uid $(id -u))." >&2
  echo "[entrypoint] Give the volume to that uid, or on Railway set RAILWAY_RUN_UID=0." >&2
  exit 1
fi

if [ -z "${LITESTREAM_REPLICA_URL:-}" ]; then
  echo "[entrypoint] backups: off (LITESTREAM_REPLICA_URL not set)"
  exec bun run server.ts
fi

echo "[entrypoint] backups: on (litestream replicating $DB)"
litestream restore -config "$CONFIG" -if-db-not-exists -if-replica-exists "$DB"
exec litestream replicate -config "$CONFIG" -exec "bun run server.ts"
