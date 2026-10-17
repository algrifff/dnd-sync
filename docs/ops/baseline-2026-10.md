# Production baseline, 2026-10-17

Taken before moving production from Node 22 + better-sqlite3 to Bun +
bun:sqlite, so the switch can be judged against it. Service
`soothing-mercy`, project `pleasing-eagerness`, environment `production`,
deploy `52b38a4` on Node 22.

| Measure | Value | Source |
|---|---|---|
| Memory, 7 days | current 361 MB, average 385 MB, peak 1.63 GB, limit 8 GB | `railway metrics -s soothing-mercy --since 7d --memory` |
| CPU, 7 days | current < 0.01 vCPU, peak 0.02 vCPU | same, `--cpu` |
| Deploys | last 20 (since 2026-10-11): none crashed or OOM-killed | `railway deployment list --service soothing-mercy` |
| Volume `/data` | 254.6 MB used of 5 GB | `railway volume list` |
| `compendium.db` | 29 MB (snapshot of 2026-10-11) | local snapshot |
| Assets | about 225 MB (volume minus DB) | derived |
| Volume backups | not visible from the CLI; check the dashboard | — |

The 7-day figure is one aggregate, so it can't say whether the 1.63 GB
peak was a short spike (a Smart Import or a boot) or a slow climb.

## Pass criteria for the Bun deploy

- Idle memory at or below about 400 MB after 48 hours, with no upward
  slope between restarts.
- No crashed or OOM-killed deploys.
- `/api/health` reports the new commit and the same `schemaVersion`.

## Noticed along the way

- The server logs `unhandledRejection: ReferenceError:
  WebGL2RenderingContext is not defined` repeatedly: a three.js module
  is being evaluated on the server. Unrelated to the runtime change.
- Railway reports `railway.toml` config-as-code as deprecated, with
  legacy files supported until 2026-12-01.
- An unattached volume `dnd-sync-volume` (169 MB, `/var/syncthing`) is
  left over from the old Syncthing setup.
