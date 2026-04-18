# Sync Fix Plan — Compendium

**Target:** `plugin/`, `server/` — the live-collaboration pipeline
**Date:** 2026-04-18
**Estimated effort:** 3–4 dev days, split into six phases
**Companion task list:** `TaskList` in the Claude session spawned alongside this doc

---

## Problem statement

Users report the plugin says **"connected"** while no edits propagate and new users see an empty vault. Pairing (admin hands a friend a token) succeeds on the HTTP probe but fails silently at the WebSocket layer.

### Root causes (verified against code)

| # | Root cause | File:line |
|---|------------|-----------|
| R1 | Status bar shows 🟢 on `provider.status === 'connected'`, which is only the WS handshake. Initial Yjs sync (`provider.synced`) is never checked. | `plugin/src/sync/docRegistry.ts:44`, `plugin/src/ui/statusBar.ts:33` |
| R2 | `syncInventory` is one-shot with `console.error` on failure — no retry, no surfacing. Fresh user with a single blip → empty vault forever. | `plugin/src/sync/fileMirror.ts:80-89` |
| R3 | `BinarySync.reconcile` fails identically — one try, both directions dropped. | `plugin/src/sync/binarySync.ts:105-112` |
| R4 | DocRegistry has no `connecting` timeout. A stalled WS handshake sits yellow forever. | `plugin/src/sync/docRegistry.ts:41` |
| R5 | `reconcileAfterSync` treats the server as canonical and **overwrites local on divergence** — offline edits are silently lost. | `plugin/src/sync/fileMirror.ts:138-141` |
| R6 | Test-connection only checks HTTP `/api/inventory`. Reverse-proxies that drop `Upgrade: websocket` pass this test while WS fails. | `plugin/src/settings.ts:199-206` |
| R7 | Friend pairing returns a token with no end-to-end verification and no `last_seen_at`. Admin cannot tell whether a token ever worked. | `server/src/app/api/friends/route.ts:33`, `server/src/lib/friends.ts:71-83` |
| R8 | Server text deletes are never propagated — no `DELETE /api/docs/:path`. Rows orphan in SQLite; deletes on client A don't reach client B. | `plugin/src/sync/fileMirror.ts:205-207` |

### Desired behaviour

- 🟢 means *every tracked doc* is `status: connected` **and** `provider.synced === true` **and** no pending writes.
- 🔴/🟡 carry a hover tooltip with the precise failure (auth rejected, inventory stuck on retry 3/5, WS upgrade blocked, etc.).
- Inventory fetch retries with exponential backoff until it succeeds or the user dismisses it.
- At startup, if local and server disagree, we **merge via CRDT** rather than overwriting local.
- Admin dashboard shows per-friend "last seen" so pairing failures are visible without asking the friend.
- Deleting a file locally removes the server row.

---

## Current state assessment

**Code health score:** C (architecture sound, but sync layer is optimistic — one failure mode silences the rest)

| Metric | Current | Target | Status |
|--------|---------|--------|--------|
| Status-bar truth | WS-level only | Synced + pending | ❌ |
| Inventory retry | None | 5 × exp. backoff | ❌ |
| Startup divergence safety | Overwrites local | CRDT merge | ❌ |
| Friend pairing verifiability | Token-and-pray | `last_seen_at` surfaced | ❌ |
| Delete propagation | Client-only | Server DELETE endpoint | ❌ |
| Preflight on `Test connection` | HTTP-only | HTTP + WS + sync | ❌ |

---

## Phase plan (execute in order)

Each phase is one commit (or a tight cluster). Do not start phase N+1 before phase N typechecks with `bun run typecheck` and builds.

### Phase 0 — Truthful status *(half a day)*

Make the UI stop lying so subsequent phases have an honest signal. No behaviour changes to sync itself yet.

**0.1 — Track `provider.synced` in DocRegistry**

File: `plugin/src/sync/docRegistry.ts`

```ts
// Add to DocRecord:
type DocRecord = {
  path: string;
  doc: Y.Doc;
  provider: WebsocketProvider;
  status: ConnectionStatus;
  synced: boolean;           // NEW — true after sync step 2 received
  lastError: string | null;  // NEW — last user-facing error for this doc
};

// In get(), after the status listener:
provider.on('sync', (synced: boolean) => {
  record.synced = synced;
  this.emit();
});
// Capture auth / connection failures for tooltip surfacing
provider.on('connection-error', (err: Event) => {
  record.lastError = describeWsError(err);
  this.emit();
});
provider.on('connection-close', (event: CloseEvent) => {
  if (event.code === 1008 || event.code === 4401) {
    record.lastError = 'auth rejected';
  }
});
```

Update `aggregate()`: return `'connected'` only if every record has `status === 'connected' && synced`. Otherwise `'connecting'`.

Export a new `errors(): string[]` for the status bar tooltip.

**0.2 — Connecting timeout**

File: `plugin/src/sync/docRegistry.ts`, method `get()`

Start a 30-second timer on doc creation. If the record hasn't reached `status === 'connected'` by timeout, mark `status = 'disconnected'`, `lastError = 'handshake timeout'`, `emit()`. Clear the timer on first connected-event.

**0.3 — Status-bar tooltip carries last error**

File: `plugin/src/ui/statusBar.ts`

Extend `render(status, count, errors: string[])`. If `errors.length > 0`, set `this.el.title = errors.join('\n')` so hovering the indicator shows the reason. Keep the icon logic intact.

Wire the new `errors()` getter through `DocRegistry.onStatusChange` (extend the listener signature).

**Success criteria (Phase 0)**

- [ ] `bun run typecheck` passes.
- [ ] Disable the server → plugin shows 🔴 with tooltip "connection-error: ECONNREFUSED" within 30 s.
- [ ] Revoke the token, reconnect → tooltip reads "auth rejected" within 5 s.
- [ ] While inventory is still fetching the first time, status stays 🟡 (not 🟢).

---

### Phase 1 — Robust pull *(half a day)*

Make initial reconciliation actually happen even over flaky networks.

**1.1 — Extract a `retryWithBackoff` helper**

New file: `plugin/src/sync/retry.ts`

```ts
// Exponential backoff: 1s, 2s, 4s, 8s, 16s then give up.
export async function retryWithBackoff<T>(
  op: () => Promise<T>,
  opts: { attempts?: number; onAttempt?: (n: number, err: unknown) => void } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 5;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      opts.onAttempt?.(i + 1, err);
      if (i === attempts - 1) break;
      await sleep(1000 * 2 ** i);
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
```

**1.2 — Wrap `syncInventory`**

File: `plugin/src/sync/fileMirror.ts:80-89`

Replace `try/catch/console.error` with:

```ts
private async syncInventory(): Promise<void> {
  try {
    const inventory = await retryWithBackoff(() => fetchInventory(this.cfg), {
      onAttempt: (n, err) => {
        this.registry.setGlobalError(`inventory retry ${n}/5: ${short(err)}`);
      },
    });
    this.registry.clearGlobalError();
    for (const entry of inventory.textDocs) {
      if (!this.tracked.has(entry.path)) void this.track(entry.path);
    }
  } catch (err) {
    this.registry.setGlobalError(`inventory failed: ${short(err)}`);
    new Notice('Compendium: could not fetch server inventory. See status bar for detail.');
  }
}
```

Add `setGlobalError`/`clearGlobalError` to `DocRegistry` so non-doc errors land in the same tooltip path introduced in Phase 0.

**1.3 — Same treatment for `BinarySync.reconcile`**

File: `plugin/src/sync/binarySync.ts:105-112` — wrap the `fetchInventory` call identically. After success, still run both directions.

**Success criteria (Phase 1)**

- [ ] With the server paused mid-startup, status bar shows "inventory retry 2/5…" and recovers automatically when the server comes back.
- [ ] After 5 failed attempts, status is 🔴 with a descriptive tooltip; subsequent `Reconnect` button press restarts the retry loop.
- [ ] A newly-configured client on a slow network actually downloads all server-side markdown files.

---

### Phase 2 — Honest preflight *(half a day)*

Make **Test connection** prove the end-to-end pipeline works, not just HTTP.

**2.1 — Server: reserve `/sync/.preflight`**

File: `server/src/ws/setup.ts`, in `handleConnection`

After `extractDocName(req)`, short-circuit if `docName === '.preflight'`:

```ts
if (docName === '.preflight') {
  // Do a minimal Yjs handshake so the client can verify the full pipeline
  // without materialising a DB-backed doc.
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, new Y.Doc());
  ws.send(encoding.toUint8Array(encoder));
  ws.close(1000, 'preflight ok');
  return;
}
```

Auth is already enforced at the upgrade layer (`server/server.ts:52-58`). No DB write, no persistence, no broadcast.

**2.2 — Plugin: `preflight()` helper**

New file: `plugin/src/sync/preflight.ts`

```ts
export type PreflightResult =
  | { ok: true }
  | { ok: false; stage: 'health' | 'inventory' | 'ws'; reason: string };

export async function preflight(cfg: HttpConfig): Promise<PreflightResult> {
  // 1. Health (no auth required)
  const h = await requestUrl({ url: `${base(cfg)}/api/health`, throw: false });
  if (h.status !== 200) return { ok: false, stage: 'health', reason: `health ${h.status}` };

  // 2. Inventory (auth required) — confirms the token works over HTTP
  const inv = await requestUrl({
    url: `${base(cfg)}/api/inventory`,
    headers: { Authorization: `Bearer ${cfg.authToken}` },
    throw: false,
  });
  if (inv.status !== 200) return { ok: false, stage: 'inventory', reason: `inventory ${inv.status}` };

  // 3. WebSocket handshake to /sync/.preflight with 5s timeout
  return await wsProbe(cfg);
}
```

`wsProbe` opens a raw `new WebSocket(url + '/sync/.preflight?token=...')`, waits for:
- `open` within 3 s, else `{ ok: false, stage: 'ws', reason: 'handshake timeout' }`
- first binary message within 2 s, else `{ ok: false, stage: 'ws', reason: 'no sync response' }`
- close code 1000, else flag the code

Must use the global `WebSocket` constructor (same as y-websocket) — **not** Obsidian's `requestUrl`, which can't speak WS.

**2.3 — Rewrite `runConnectionTest`**

File: `plugin/src/settings.ts:191-218`

Replace the body with a call to `preflight()`, show Notices per stage:

```ts
const result = await preflight({ serverUrl, authToken });
if (result.ok) new Notice('Compendium: connection OK ✓ (HTTP + WS + sync)');
else new Notice(`Compendium: ${result.stage} check failed — ${result.reason}`);
```

**Success criteria (Phase 2)**

- [ ] `Test` with a valid URL/token over a proxy that blocks WS → user sees "ws check failed — handshake timeout".
- [ ] `Test` with a revoked token → "inventory check failed — 401".
- [ ] `Test` with a live server → green notice within 1 s.

---

### Phase 3 — Conflict-safe reconcile *(1 day)*

Offline edits must survive reconnection.

**3.1 — Persist a baseline hash per path**

File: `plugin/src/settings.ts`

Extend `CompendiumSettings`:

```ts
export type CompendiumSettings = {
  serverUrl: string;
  authToken: string;
  displayName: string;
  displayColor: string;
  /** Path → sha256 of the last content we observed as synced.
   *  Used to decide whether divergence at reconnect means "local changed
   *  offline" (push) or "we're stale" (pull). */
  baselines: Record<string, string>;
};
```

Default `{}`. Migrate existing settings in `loadSettings()` (add missing key, do not drop).

Add a tiny helper in a new `plugin/src/sync/hash.ts`:

```ts
export async function sha256(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
```

**3.2 — Rewrite `reconcileAfterSync`**

File: `plugin/src/sync/fileMirror.ts:126-151`

New logic (replace lines 126-151):

```
Let localText   = file on disk (or '' if missing)
Let serverText  = ytext.toString() after provider.synced
Let baseline    = settings.baselines[path] ?? null
Let localHash   = sha256(localText)
Let serverHash  = sha256(serverText)

if localHash === serverHash:
    // Already in sync. Update baseline just in case it's unset.
    setBaseline(path, localHash)
    return

if serverText === '' and baseline === null:
    // Server has no record at all. Push local up.
    ytext.insert(0, localText) inside doc.transact(_, LOCAL_ORIGIN)
    setBaseline(path, localHash)
    return

if baseline === serverHash and localHash !== serverHash:
    // We have offline local edits. Push them.
    ytext.delete(0, len); ytext.insert(0, localText) inside LOCAL_ORIGIN
    setBaseline(path, localHash)
    return

if baseline === localHash and serverHash !== localHash:
    // We are stale; server moved on. Pull.
    writeLocal(path, serverText)
    setBaseline(path, serverHash)
    return

// baseline === null || both diverged from baseline → real conflict.
// CRDT-safe merge: keep server state, append local as a clearly-marked block.
const merged =
    serverText +
    `\n\n<!-- compendium: offline edits from ${displayName} -->\n` +
    localText;
ytext.delete(0, len); ytext.insert(0, merged) inside LOCAL_ORIGIN
setBaseline(path, await sha256(merged))
```

Expose `setBaseline(path, hash)` that writes through to `plugin.saveSettings()`. Advance the baseline on every successful `writeLocal` and every successful local push, both in `onLocalModify` and in the observer.

**Test plan (manual, since no unit harness in Phase 1):**

- Two clients edit the same file while offline (stop the server). Reconnect. Verify both sets of edits are present — server's wins at the top, local's appears under the marker comment.
- One client offline, edits locally, server unchanged. Reconnect. Local wins.
- One client online, receives edits. Second client was offline with the baseline in place. Reconnect. Server wins, no conflict marker.

**Success criteria (Phase 3)**

- [ ] Disabling the server, editing file X on client A, re-enabling → X on server contains A's edits, `baselines[X]` advanced.
- [ ] Both clients edit X offline → reconnect shows both copies with a marker comment; no silent data loss.
- [ ] Settings file (`data.json`) holds a growing `baselines` map.

---

### Phase 4 — Delete propagation *(quarter day)*

**4.1 — Server endpoint**

New file: `server/src/app/api/docs/[...path]/route.ts`

```ts
export const dynamic = 'force-dynamic';
export async function DELETE(req: NextRequest, { params }: { params: { path: string[] } }): Promise<Response> {
  const auth = requireRequestAuth(req);
  if (auth instanceof Response) return auth;

  const path = params.path.map(decodeURIComponent).join('/');
  const res = getDb().query('DELETE FROM text_docs WHERE path = ?').run(path);
  return Response.json({ deleted: Number(res.changes) > 0 });
}
```

If a shared Y.Doc is in memory for this path (`docs.get(path)` in `ws/setup.ts`), also:
- Broadcast a close frame to all clients (optional; they'll re-sync on next load)
- `doc.destroy()` and `docs.delete(path)`

Export a helper `destroyDoc(path: string)` from `ws/setup.ts` for the route handler to call.

**4.2 — Plugin wires delete**

File: `plugin/src/sync/fileMirror.ts:197-207`, `onLocalDelete`

```ts
private onLocalDelete(path: string): void {
  const t = this.tracked.get(path);
  if (t) { t.ytext.unobserve(t.observer); this.tracked.delete(path); }
  this.registry.delete(path);
  void deleteDoc(this.cfg, path).catch((err) => {
    console.error('[compendium] server delete failed', path, err);
  });
}
```

Add `deleteDoc(cfg, path)` to `plugin/src/sync/http.ts` — `DELETE /api/docs/{encoded}`.

Remove the "Server-side text_docs rows linger" comment.

**Success criteria (Phase 4)**

- [ ] Delete a note on client A → within 2 s it disappears on client B.
- [ ] Server `text_docs` row count drops by one; `text_docs_fts` entry is also gone (trigger in migration v1 handles this).

---

### Phase 5 — Friend pairing UX *(half a day)*

**5.1 — Migration v5: `last_seen_at`**

File: `server/src/lib/migrations.ts`

```ts
{
  version: 5,
  description: 'friends: last_seen_at for verifiable pairing',
  sql: `ALTER TABLE friends ADD COLUMN last_seen_at INTEGER;`,
},
```

**5.2 — Touch `last_seen_at` on auth success**

File: `server/src/ws/setup.ts`, inside `handleConnection` right after confirming the doc name:

```ts
// The token was already verified at upgrade time (server.ts). If it was a
// friend token, bump the heartbeat so the admin dashboard can show
// "last seen X minutes ago".
touchFriendLastSeen(tokenFromReq(req));
```

Implement `touchFriendLastSeen(token)` in `server/src/lib/friends.ts`:

```ts
export function touchFriendLastSeen(token: string | null): void {
  if (!token) return;
  try {
    getDb()
      .query('UPDATE friends SET last_seen_at = ? WHERE token = ? AND revoked_at IS NULL')
      .run(Date.now(), token);
  } catch { /* table missing — pre-v3 deploy, ignore */ }
}
```

Pass the token into `handleConnection` from `server.ts:61` (stash on the WS or on `req` via a symbol).

**5.3 — Expose in credentials and dashboard**

File: `server/src/app/api/credentials/route.ts:32-37`

Include `lastSeenAt: f.lastSeenAt` in the response. Update `listActiveFriendsWithTokens()` in `lib/friends.ts` to select `last_seen_at`.

File: `server/src/app/page.tsx` (admin dashboard) — render per-friend status badge: green if `Date.now() - lastSeenAt < 5 min`, yellow if seen in the last day, grey if never or >1 day.

**Success criteria (Phase 5)**

- [ ] Create a friend, paste token into plugin, start plugin → dashboard shows friend as "just now" within 10 s.
- [ ] Stop the plugin, wait an hour → dashboard shows "1h ago".
- [ ] Admin can distinguish "token never used" from "active" at a glance.

---

### Phase 6 — Hardening *(half a day)*

**6.1 — Fix `bindState` ordering**

File: `server/src/lib/yjs-persistence.ts:41-53`

Swap so the observer is attached **before** `applyUpdate`:

```ts
export function bindState(docName: string, doc: Y.Doc): void {
  doc.on('update', () => schedulePersist(docName, doc));
  const row = getDb()
    .query<{ yjs_state: Uint8Array }, [string]>('SELECT yjs_state FROM text_docs WHERE path = ?')
    .get(docName);
  if (row?.yjs_state) Y.applyUpdate(doc, new Uint8Array(row.yjs_state));
}
```

Not a live bug in practice (initial apply triggers persist of existing state, no-op), but defensive.

**6.2 — Auth rate limiting**

File: `server/server.ts`

Before the `verifyToken` check, apply a per-IP token bucket (5 failed attempts → 60 s lockout). Implement in a tiny `server/src/lib/ratelimit.ts` backed by an in-memory `Map<ip, { fails: number; until: number }>`. No DB, rebuilds on restart. Acceptable trade-off for self-host.

Log `[auth] rate-limited <ip>` once per lockout start. Do **not** log tokens.

**6.3 — `lastWritten` cleanup**

File: `plugin/src/sync/fileMirror.ts:197-213` (`onLocalDelete`, `onLocalRename`)

Call `this.lastWritten.delete(path)` on both. Keeps the map bounded by live-file count, not total-historical-writes.

**Success criteria (Phase 6)**

- [ ] 6 consecutive bad-token WS attempts → 7th is rejected at the upgrade socket with 429-equivalent close. Log confirms lockout.
- [ ] `lastWritten.size <= tracked.size` after repeated renames.

---

## Risk matrix

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| `provider.synced` event fires before listener is attached | Low | Sync stuck on first load | Check `provider.synced` immediately after registering listener; treat `synced === true` as already-synced |
| `wsProbe` leaks connections on slow networks | Medium | Memory churn | Always call `ws.close()` in a `finally`; use `AbortController` with 5s timeout |
| Phase 3 marker-comment merge surprises the user | Medium | Confusing file contents | Wrap in HTML comment so Markdown still renders; also show a Notice "Compendium merged offline edits for X" |
| Migration v5 on a live DB blocks writes | Very low (single `ALTER`) | Brief stall | `ALTER TABLE ADD COLUMN` is O(1) in SQLite |
| Rate limiter blocks the admin after a key typo | Low | Lockout | Key limiter by IP only, exempt localhost in dev (`NODE_ENV !== 'production'`) |

---

## Rollback plan

1. All work on the existing `compendium-ai` branch; each phase is its own commit.
2. If a phase breaks the plugin, `git revert <sha>` — phases are independent after Phase 0.
3. Phase 3 writes new keys to `data.json` but does not remove existing ones. Reverting is safe.
4. Phase 5 migration is additive (`ADD COLUMN`); reverting the code is safe without a down-migration.

---

## Verification commands

```bash
# From compendium-ai/ root
bun run typecheck                 # Strict TS, all workspaces
bun --filter '@compendium/plugin' run build
bun --filter '@compendium/server' run build

# Server smoke
cd server && bun run server.ts &
curl -s http://localhost:3000/api/health                          # { ok: true }
curl -sI http://localhost:3000/api/inventory                      # expect 401 without token
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/inventory

# WebSocket preflight (needs websocat or similar)
websocat "ws://localhost:3000/sync/.preflight?token=$TOKEN"       # expect one binary frame then close 1000
```

---

## Out of scope (capture in follow-up)

- Full unit-test harness (vitest per ARCHITECTURE.md Phase 1 deferral)
- Per-tenant / multi-vault support
- AI assistant (Phase 3 in ARCHITECTURE.md)
- Mobile Obsidian support validation

---

## Coding standards for every diff in this plan

These override nothing but add to `.claude/rules/*` and `.claude/languages/{typescript,nextjs}/*`. Read them once before starting.

**TypeScript (`plugin/`, `server/`, `shared/`):**
- No `any`. Use `unknown` and narrow, or define a real type. `tsconfig.base.json` already enables `strict` and `noUncheckedIndexedAccess` — do not silence these.
- Every exported function in new or touched files gets an explicit return type.
- `interface` for object shapes, `type` for unions and aliases.
- Validate all inputs at the API boundary with Zod schemas from `@compendium/shared` — any new endpoint (`DELETE /api/docs/*`, updated `/api/credentials` shape) that accepts or returns data gets a schema and `z.parse` on the way in and `z.infer`-derived types on the way out.
- New error shapes use `{ code, message, details? }`. No stack traces in responses.
- Never log the auth token, the admin token, or any Bearer-prefixed header.

**Next.js route handlers (`server/src/app/api/**`):**
- `export const dynamic = 'force-dynamic'` on every route that reads auth state.
- Always call `requireRequestAuth(req)` (or `requireAdminAuth` where relevant) before touching the DB. Return the `Response` instance unchanged when auth fails.
- Keep secrets server-side only. The `getConfigValue('admin_token')` read **must not** reach any client payload.

**SQL + migrations (`server/src/lib/migrations.ts`):**
- Parameterised queries only — `db.query(sql).run(...args)`, never string concatenation.
- One logical change per migration. Do not edit a migration after it has shipped; append a new one.
- New `ALTER` statements should be additive and default-safe (`DEFAULT NULL` or `DEFAULT ''`) so a half-migrated DB still reads correctly.

**Obsidian plugin (`plugin/src/**`):**
- All HTTP traffic goes through `plugin/src/sync/http.ts` (Obsidian's `requestUrl` — bypasses Electron CORS). Do not call `fetch` directly.
- WebSocket use continues to go through `y-websocket`'s `WebsocketProvider` for persistent docs. For the one-shot preflight probe in Phase 2, use the global `WebSocket` constructor explicitly (y-websocket is overkill for a 3-second handshake test).
- DOM work in settings/status-bar uses Obsidian's `createEl` / `setText` / `addClass` helpers. No `innerHTML`, no `dangerouslySetInnerHTML` — the plugin runs inside Electron and the agent-vulnerability list in `languages/typescript/security.md` applies.

**Tests (`testing.md`):**
- Phase 1 of the ARCHITECTURE document defers a unit-test harness; this plan does not reverse that decision. But the three new pure helpers (`retryWithBackoff`, `sha256`, `preflight`'s stage dispatch) are small and deterministic — add `.test.ts` files beside them using `bun test`, AAA pattern, one behaviour per case. Skip framework wiring tests.

## Execution notes for the AI runner

1. Work in phase order. Do not start phase N+1 until `bun run typecheck` passes for phase N.
2. After each phase, run the listed success criteria and commit with message `sync: phase N — <short summary>`.
3. If a success criterion fails, **stop and surface it** — do not paper over with best-effort. A wrong green here re-creates the original bug class.
4. Phase 0 is the safety net. Every later phase relies on the tooltip and `synced`-aware aggregate to tell you whether your change worked. Do not skip it.
5. Never log the auth token in any message, Notice, tooltip, or thrown error.
6. Do not add unrelated cleanup in these commits. Keep diffs reviewable.
7. If a rule in `.claude/rules/*` or `.claude/languages/*` conflicts with a concrete instruction in this plan, follow the rule and note the conflict in the PR body so the plan can be updated.
