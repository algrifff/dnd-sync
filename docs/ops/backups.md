# Database backups (Litestream)

Production streams the SQLite database to a Cloudflare R2 bucket with
[Litestream](https://litestream.io) 0.5.17. It is opt-in: with the
variables below unset the container runs the app exactly as before.

## What is backed up

- **Backed up:** `/data/compendium.db` (notes, Yjs state, users, groups,
  everything in SQLite). Roughly seconds of lag; 72 h of history, a
  snapshot per day.
- **Not backed up:** `/data/assets` (uploaded images and files). Losing
  the volume loses them. Treat that as an open gap.

## Railway variables

Set on the service (names only):

- `LITESTREAM_REPLICA_URL` (for example `s3://<bucket>/compendium`). Setting it turns backups on.
- `LITESTREAM_S3_ENDPOINT` (`https://<account-id>.r2.cloudflarestorage.com`)
- `LITESTREAM_ACCESS_KEY_ID`
- `LITESTREAM_SECRET_ACCESS_KEY`

## Create the R2 bucket and token

1. Cloudflare dashboard, R2 Object Storage, Create bucket (any name, for example `compendium-backups`). Leave it private.
2. R2 overview, Manage API tokens, Create API token. Permission: Object Read & Write. Scope it to that one bucket.
3. Copy the Access Key ID and Secret Access Key (shown once) and the account endpoint (`https://<account-id>.r2.cloudflarestorage.com`).
4. Set the four variables on Railway and redeploy.

## Confirm it works

- Deploy log shows `[entrypoint] backups: on (litestream replicating /data/compendium.db)`, followed by Litestream log lines and no errors. `backups: off` means the URL variable is missing or empty.
- The bucket gains objects under the replica path (an `ltx/` folder) within a minute. They keep growing while the app is used.

On boot with an empty volume, the entrypoint restores the latest replica
before starting the app. If the replica is unreachable or credentials are
wrong, the container exits rather than starting with an empty database.

## Restore drill

On Linux, macOS or WSL with the `litestream` 0.5.17 binary installed:

```sh
export LITESTREAM_ACCESS_KEY_ID=... LITESTREAM_SECRET_ACCESS_KEY=...
litestream restore -o ./restored.db "s3://<bucket>/compendium?endpoint=https://<account-id>.r2.cloudflarestorage.com&region=auto"
bun -e 'import { Database } from "bun:sqlite"; const d = new Database("./restored.db", { readonly: true }); for (const t of ["notes", "users"]) console.log(t, d.query(`select count(*) c from ${t}`).get().c)'
```

Compare the counts with production. If the URL query parameters are
rejected, use a config file with the same keys as `server/litestream.yml`
and pass `-config`.

Last successful drill: _never_ (record the date here).
