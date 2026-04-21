---
paths:
  - "**/api/**"
  - "**/server/**"
  - "**/routes/**"
---

# Backend Rules

## API Design
- Use the project error shape: `{ error: 'snake_case_code', reason?: string }`.
  Do NOT invent a `{ code, message, details }` shape — it is not wired up
  anywhere in this repo and middleware + tests assume the existing shape.
- Validate all inputs at the boundary with Zod. `Body.parse()` throws → let
  the route wrapper turn it into a 400.
- Return appropriate HTTP status codes: 400 bad input, 401 unauthenticated,
  403 forbidden, 404 not found, 409 conflict, 503 unavailable.
- Every mutation route calls `requireSession` then `verifyCsrf` before
  touching the DB. Bearer-token routes live under the admin/script surface
  only — never mix the two on one endpoint.

## Security
- Authn ≠ Authz: always re-check `group_id` + role after authenticating.
- Never log secrets or `csrfToken` values.
- Add timeouts for external calls (AI provider requests in particular).
- Rate-limit anything password-adjacent — see `ratelimit.ts` for the
  existing primitive.
- `dm_only` is enforced at the API layer, not the DB layer. Every note
  read path must either withhold the body for viewers or route through
  `loadNote()` which already does.

## Error Handling
- Catch errors at the route level; never let a stack trace reach the client.
- Log with `console.error('[route-name] ...', err)` — no correlation-ID
  framework is wired up, keep log lines short and greppable.
- User-facing `error` codes are snake_case and stable (treated as an API).
  Do not rename without a grep + client update.

## Performance
- Paginate list endpoints. Default limit 50, cursor via `before` id where
  ordering allows.
- Cache where appropriate but remember SQLite is in-process — prefer query
  tightening over adding a cache layer.
- All DB access goes through the singleton in `server/src/lib/db.ts`. Do not
  open a second handle.

## Sheet PATCH contract (`/api/notes/sheet`)

The sheet-header inline editors send **partial patches** — a sparse object
of only the fields that changed, not the whole sheet. When touching this
endpoint, preserve these invariants:

- Request body: `{ path: string, sheet: Partial<Sheet> }`. The `sheet` key
  is a shallow patch that is merged into the stored `frontmatter.sheet`
  before validation.
- Merge order: `{ ...existingSheet, ...patch }` (shallow). Nested fields
  like `hit_points` are replaced wholesale — the client is expected to
  send the full nested object (`{ current, max, temporary }`) when any
  sub-field changes. See `CharacterHeader.tsx` for the pattern.
- Validate after merge with `validateSheet()` (forgiving Zod). Reject with
  `{ error: 'invalid_sheet', reason }` on failure, not `invalid_body`.
- Return the merged + validated sheet as `{ ok: true, sheet }` so the
  client can reconcile optimistic state.
- Hocuspocus broadcasts the frontmatter delta automatically after the row
  is written — do not re-broadcast from the route handler.
- `sheet.name` is `.min(1).optional()` — accept omission, reject empty
  string. Clients are expected to trim-and-skip rather than sending `''`.

## Kind normalisation

The canonical frontmatter kinds are `character | person | creature | item |
location | session | lore | note`. Legacy aliases (`pc`, `npc`, `ally`,
`villain`, `monster`) must normalise through the mapping in
`server/src/lib/ai/tools.ts`. Any new route that branches on `fm.kind`
should call the shared normaliser — do not grow a third copy of the switch.
The sheet-header UI mirror is in
`server/src/app/notes/sheet-header/util.ts#normalizeKind`. If you add a
kind, update both sites in the same commit.
