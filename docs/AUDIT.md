# Compendium — Full Codebase Audit & Vercel Eve Migration Plan

*Read-only audit. 2026-07-12. Method: 9 domain auditors (Sonnet) fanned across the repo; every critical/high finding adversarially re-checked by an independent Opus verifier against the code on disk; Eve researched live from the docs (past training cutoff). `bun run typecheck` passes cleanly on both workspaces.*

**Severity legend:** ✅ = independently verified against code (Opus refutation pass). ◻︎ = single-pass finding, credible but not independently re-verified — treat as "very likely" pending a quick confirm.

---

## Part 1 — The short version

The core is better-built than a self-hosted side project usually is: Argon2id hashing, timing-safe token compares, session rotation on login, real double-submit CSRF, correct cookie flags, WAL + busy_timeout + foreign_keys on SQLite, clean typecheck, disciplined append-only migrations, and most hot read paths already avoid dragging the `yjs_state` blob. The problems are not "it's held together with tape" — they're **specific broken chains**, and they cluster in three places:

1. **A visibility model that half-exists.** There are two "hide this note" flags — `dm_only` (hide from viewers) and `gm_only` (admin-only) — and enforcement is applied inconsistently across the ~6 surfaces that can return a note body. The file tree hides them; the REST GET, the note page, preview popovers, backlinks, the graph, and several AI tools do not. This is the single biggest theme and it produces the two worst findings.

2. **Three writers to one note, no coordination.** REST saves, the Yjs/Hocuspocus live doc, and the AI tools all write note content — and the AI tools + import pipeline write *directly* to the columns without evicting the live editor, so an open editor silently clobbers the AI's write (or vice versa). The realtime layer is where "snappy" and "correct" are fighting each other.

3. **Unbounded growth and missing back-pressure.** `audit_log` never prunes, expired sessions only clear at boot, client-supplied chat history has no length cap, and streaming has no abort-on-disconnect. None of these bite on day one; all of them bite a long-running instance.

**Nothing here requires a rewrite.** Most of the criticals are small, surgical fixes (add a `dm_only` check that already exists three files over; call `closeDocumentConnections()` that every *other* write path already calls). The through-line is drift: the code moved on, `CLAUDE.md` and the enforcement invariants didn't, and the gaps opened in the seams.

**On Vercel Eve:** it's real, it's genuinely good for exactly your import-pipeline use case (durable, resumable, human-in-the-loop workflows), but it's **beta**, requires **Node 24** (you're on 22), and its Next.js integration explicitly assumes it owns the build pipeline — which your custom `server.ts` does not allow. Verdict: **partial go, and not yet.** Run it as a separate sidecar service behind a feature flag, port chat only, keep the AI SDK as the default and fallback. Details in Part 4.

---

## Part 2 — Findings by priority

### 🔴 Critical — fix before anything else

**C1. `dm_only` note bodies are served to viewers by the REST API and the note page** ✅
`server/src/app/api/notes/[...path]/route.ts:29` · `server/src/app/(app)/(content)/notes/[...path]/page.tsx:47`
The canonical note-fetch endpoint checks `note.gm_only` but **never** `note.dm_only`. The flag is live and writable (`/api/notes/visibility` still writes `dm_only=1`; `NoteMenu.tsx` still renders the toggle). `loadNote()` returns the full body regardless of role. The collab WebSocket layer and the AI `note_read` tool both enforce `dm_only` correctly — so this is an inconsistency, not a design choice. A viewer who knows/guesses/searches a note path reads the full body of GM-hidden content. `backend.md` claims "every note read path routes through `loadNote()` which already withholds the body" — **`loadNote()` does no such thing**; the documented invariant is false.
*Fix (small):* add `if (note.dm_only === 1 && session.role === 'viewer') return notFound()` to both the route and the page, mirroring the existing `gm_only` line. Then sweep the sibling leaks (M-series below) that share the root cause.

**C2. AI tool writes and import-apply silently discard live Yjs edits** ✅
`server/src/lib/ai/tools.ts:630` (`entity_edit_content`), `:815` (`backlink_create`), `:582` (`entity_edit_sheet`) · `server/src/lib/import-apply.ts:~533`
These write `content_json` / `yjs_state` (setting `yjs_state=NULL` in two cases) **without** calling `closeDocumentConnections()`. If a note is open in an editor, the in-memory Y.Doc flushes on its next 200 ms–1.5 s debounce and overwrites the AI's write — or the AI's `yjs_state=NULL` gets clobbered back on the next keystroke. Two writers stomp each other with no conflict detection and no user-visible warning. `move-folder.ts`, `move-rewrite.ts`, and `campaign-index.ts` all call `closeDocumentConnections()` after such writes — the AI tools and import path just forgot to. The admin vault-upload route does it correctly; import-apply (reachable from the same UI) does not.
*Fix (medium):* import `closeDocumentConnections` from `@/collab/server` and `await` it after every content/yjs write in `tools.ts` and `import-apply.ts`, matching the established pattern.

**C3. AI chat tools never check `gm_only` — editors can read/search/edit admin-only notes** ✅
`server/src/lib/ai/tools.ts` (throughout; `gm_only` appears nowhere in the file)
`getToolsForRole` collapses both `admin` and `editor` session roles to `ctx.role = 'dm'` (`chat/route.ts:48`). Every tool branches only on `dm_only` / `role !== 'dm'`, never `gm_only`. But every *direct* surface (REST GET, note page, collab, graph, ui/search) restricts `gm_only` to `admin` only. So an editor can ask the assistant to read/search/edit a note the UI itself would 404 them out of.
*Fix (medium):* thread the real session role into `ToolContext` (not the collapsed dm/player/viewer tri-state) and guard `gm_only` for non-admins in `note_read` / `entity_search` / `entity_edit_*` / `entity_move`, mirroring the collab server's `isNoteGmOnly` gate.

### 🟠 High — fix soon

**H1. `entity_search` AI tool leaks `dm_only`/`gm_only` titles + snippets to viewers** ✅
`server/src/lib/ai/tools.ts:372` — the tool is available to `player` and `viewer` roles and runs an ungated FTS query over the whole group with zero visibility filtering, unlike its sibling `campaign_browse` (`:328`) which *does* filter. A viewer asking the AI to "search for X" gets hidden note titles and 20-char excerpts, which the model relays. *Fix (small):* join `dm_only`/`gm_only` and filter identically to `/api/ui/search`.

**H2. Legacy `binary_files` / `text_docs` tables have no `group_id` and are exposed via a shared bearer token** ✅
`server/src/app/api/files/[...path]/route.ts`, `/api/inventory`, `/api/search` · migration v1 schema
These pre-multi-tenant tables have no tenant column at all. The routes are gated only by the install-wide `ADMIN_TOKEN`/`PLAYER_TOKEN` bearer credential — no group concept. On any multi-world instance, anyone holding the player token can read/overwrite/delete any world's blobs and full-text-search the legacy corpus. **Confirmed dead from the frontend** (zero fetches in the app) and `/api/search` queries `text_docs_fts`, which nothing writes to anymore (real content lives in `notes_fts`) — so it also returns stale/empty results. This is a live cross-tenant hole on a dead surface. *Fix (medium):* retire the routes + tables in a migration (superseded by group-scoped `/api/assets/*`), or add `group_id` + session auth if any plugin client still needs them.

**H3. `/api/files/[...path]` reimplements path decoding without the traversal guards** ✅
`server/src/app/api/files/[...path]/route.ts:11` — local `decodePath` is `segments.map(decodeURIComponent).join('/')`, skipping the `..`/`.`/null-byte/backslash/colon checks in the vetted `@/lib/notes` version. `['..','..','etc','passwd']` survives intact. Only reaches a SQLite key match today (not the FS), but it's the exact anti-pattern the rest of the app guards against, on the same route as H2. *Fix (small):* import the shared `decodePath`.

**H4. Deleting a world silently redirects other members into a world they may not belong to** ✅
`server/src/lib/groups.ts:319` — `deleteWorld()` resolves `otherWorld` as *any* world the **deleting admin** belongs to, then repoints **every** session on the deleted group to it. Opus correction on the impact: because `loadSessionRowById` LEFT-JOINs `group_members` and defaults a missing role to `viewer`, and data routes trust `session.currentGroupId` with no per-request membership re-check, the real consequence is **silent cross-tenant read access** to another world's data (as a viewer), not the lockout the finding first assumed. *Fix (medium):* resolve a fallback world **per session's own user** via `group_members`, or null it to an onboarding state.

**H5. Sheet-PATCH "creator" check actually grants full-write to the last editor** ✅
`server/src/app/api/notes/sheet/route.ts:101` — the doc comment says "creator may write any field," but `canWriteAll` is `note.updated_by === session.userId || isCreatorMatch(...)`. `updated_by` is overwritten by every write, including this route's own prior call. So any player who makes one allowed `playerEditable` edit becomes `updated_by`, and on their **next** PATCH satisfies `canWriteAll` and can write every field. Privilege escalation beyond the intended model. *Fix (small):* drop the `updated_by` clause; rely on `created_by` + PC-owner match.

**H6. `/api/admin/login` has no rate limiting** ✅
`server/src/app/api/admin/login/route.ts:14` — timing-safe-compares against `ADMIN_TOKEN` but calls no limiter, unlike every other credential route (`webLoginLimiter`, `signupLimiter`, etc. all exist and are used). A weak operator-set `ADMIN_TOKEN` is brute-forceable with unlimited attempts → the `__sa` super-admin cookie. (The auto-generated default is 192-bit, so only weak *operator-set* tokens are at risk — but the missing-limiter inconsistency is real and violates the repo's own backend rule.) *Fix (small):* add an IP-keyed `adminLoginLimiter`.

**H7. Note save is split into two non-atomic writes** ✅
`server/src/collab/server.ts:295` — the Hocuspocus `store()` hook commits `UPDATE notes SET yjs_state=...` immediately, then defers `deriveAndPersist()` (content_text/FTS/links/character-index) via `setImmediate()` in a *separate* transaction. A crash between them leaves `yjs_state` out of sync with FTS/derived indexes — search won't find text the user already sees synced, or the characters index silently drifts. *Fix (medium):* run derive synchronously in the same `store()` call (Hocuspocus already debounces, so this isn't on the keystroke hot path), or at minimum merge the yjs + content writes into one transaction.

**H8. Ephemeral awareness channels aren't group-scoped server-side** ✅
`server/src/collab/server.ts:143` — `.presence:<groupId>` and `.graph-state:<groupId>` channels skip the dm_only/gm_only/ownership checks, and `onAuthenticate` **never verifies the embedded `groupId` against `session.currentGroupId`**. Document names are built client-side by string interpolation. Any authenticated user who knows another group's id can open its presence/graph channel and observe (and write) its live cursor/username/graph-pin awareness — the `graph-groups:` docs already do this check at `:262`, the ephemeral ones don't. *Fix (small):* parse and verify the embedded groupId for all `.`-prefixed docs in `onAuthenticate`.

**H9. Visibility toggle doesn't evict already-connected sockets** ✅
`server/src/app/api/notes/visibility/route.ts:52` · `/api/notes/promote` — flipping `dm_only`/`gm_only` never calls `closeDocumentConnections()`. The gate is evaluated once, at connect time. A viewer connected *before* a note is marked dm_only keeps receiving live updates (and writing, if they had edit rights) indefinitely. The `promote` rename sub-case is worse: the live editor's provider stays connected under the old documentName and its next `store()` runs `UPDATE ... WHERE path=<old path>` matching zero rows — a silent no-op with no error surfaced. *Fix (small):* call `closeDocumentConnections()` after every visibility flip / rename.

**H10. `audit_log` never prunes; expired sessions only clear at boot** ✅
`server/src/lib/audit.ts` (no time-based delete anywhere; the only DELETE is on full group deletion) · `server/server.ts:46` (`cleanupExpiredSessions()` runs once at startup, never again). On a long-running instance both grow linearly forever — every login/logout writes an audit row; reads stay fast (indexed) but table/WAL/backup size climbs without bound. *Fix (small):* retention job on an interval (mirror the existing heartbeat `setInterval`), and a periodic session cleanup.

**H11. Import jobs are orphaned on restart; import-apply isn't transactional** ◻︎
`server/src/lib/import-orchestrate.ts:91` · `import-analyse.ts:69` · `import-apply.ts`
Job state lives in in-process Maps (`inFlight`, `aborters`, `pendingAnswers`). A crash/redeploy while a job is `analysing` or `waiting_for_answer` strands it forever — the DM's answer resolver is gone, nothing advances it. Separately, the entities phase writes notes one-by-one with per-note try/catch and no batch transaction, so a crash mid-apply leaves partial writes plus an orphaned ZIP (deleted only at the very end). *Fix (medium):* persist resumable job state to the DB; add a stalled-job timeout + recovery; batch writes in transactions with a checkpoint table. **This is exactly what Eve's durable workflows are designed to solve** — see Part 4.

**H12. Unbounded client-supplied chat history → cost/DoS** ◻︎
`server/src/app/api/chat/route.ts:64` — the `messages` array is passed straight to `convertToModelMessages()` with no length cap. `stepCountIs(8)` bounds the tool loop, not the input. A client sending thousands of messages runs up an arbitrarily large bill before any tool call. Same gap in `/api/sessions/end`. *Fix (small):* cap message count (and ideally estimate input tokens) before conversion.

**H13. No abort-on-disconnect for streaming chat** ◻︎
`server/src/app/api/chat/route.ts:114` — `streamText(...)` gets no `AbortSignal`; if the client disconnects mid-stream the OpenAI call runs to completion, wasting tokens. Rapid connect/abort loops burn quota. *Fix (small):* pass `req.signal` to `streamText`. (Worth a quick check that AI SDK v6 forwards it.)

### 🟡 Medium — robustness & correctness debt

- **M1. Preview popover leaks dm_only/gm_only** ✅ — `loadPreview` (`notes.ts:120`) selects title + 240-char excerpt with only group_id+path filtering, no visibility check. Same root cause as C1. *(small)*
- **M2. Backlinks & graph never filter dm_only** ✅ — `loadBacklinks` has a `hideDmOnly` flag no caller passes; `graph.ts` filters `gm_only` but not `dm_only`. dm_only titles/edges visible to viewers in the backlinks panel and mind-map. *(small)*
- **M3. Session-end AI extraction has no double-submit lock** ✅ — `sessions/end/route.ts:63` runs a multi-second AI extraction between the status check and the final "closed" upsert with no lock. Double-click → two pipelines → duplicate entities + backlinks. *(medium)*
- **M4. Check-then-write races on path creation** ✅ — notes/characters/folders/sessions/duplicate all do `SELECT COUNT` then unguarded `INSERT` outside a transaction against a `UNIQUE(group_id,path)`. Concurrent same-path requests throw a raw SQLite constraint error as an unhandled 500 instead of a clean 409. *(medium)* *Fix: attempt INSERT, catch the constraint, translate to 409.*
- **M5. `worlds/[id]` PATCH applies 5 updates without a transaction** ✅ — partial writes survive a mid-request 404 (e.g. name + color commit, then bad personality id → error, but rename already applied). *(small)*
- **M6. Mislabeled audit actions** ✅ — tag edits log `note.create`; all world-settings changes log `group.switch` (same action as actually switching worlds). Audit trail can't distinguish these. *(small)*
- **M7. Prompt-injection surface via note/import content** ◻︎ — untrusted note bodies and imported vault markdown flow undelimited into model context (`note_read` returns raw `content_md`; import classify/extract prompt on raw uploaded files). Editors already have broad tool access so in-app blast radius is limited, but the **import pipeline** (attacker authors a vault with injection payloads that run during AI analysis) is the sharp edge. *(medium)* *Fix: delimit/label untrusted content in tool results; pre-scan imported content.*
- **M8. Import token cap is soft** ◻︎ — `import-analyse.ts:159` checks the budget *after* each call completes, so a single large call can overrun by 100k+ tokens per worker. *(small)*
- **M9. Character-sheet live sync rides ephemeral awareness only** ✅ — `usePatchSheet` broadcasts via `setLocalStateField('sheetEdit')`, not a persisted Y update. A client connecting after the edit never sees it; the AI's `entity_edit_sheet` touches neither awareness nor Yjs, so an open sheet shows no live update at all after an AI edit. Contradicts CLAUDE.md's "Hocuspocus broadcasts the frontmatter delta automatically." *(medium)*
- **M10. `buildNeighborhood` N+1** ✅ — `graph.ts:172` issues 2 queries per node per hop instead of the 2 bulk queries its sibling `buildGraph` already demonstrates. Hub notes → hundreds of round-trips. *(small)*
- **M11. `getUserStorageStats` correlated subqueries over unindexed FKs** ✅ — `users.ts:136` sums notes/assets per user with no index on `notes.created_by` / `assets.uploaded_by` → O(users × (notes+assets)) on every admin/users render. *(small)* *Fix: add the two indexes.*
- **M12. Model-default fragmentation incl. an invalid default** ◻︎ — four call sites, four defaults: `gpt-5.4-mini` (chat — **not a real model name**, would 400 if `OPENAI_MODEL` is unset), `gpt-4o-mini` (sessions/end), `gpt-5-mini` (openai.ts, import). *(small)* *Fix: one `resolveModel()` config point.*
- **M13. `slugify` duplicated in 9 files, `decodePath` in 2** ◻︎ — identical `slugify` bodies across `compendium.ts` (canonical) + 8 locals; the files-route `decodePath` is the unsafe copy (see H3). Pure drift risk. *(small)*
- **M14. `mark-closed` and manual-backlink routes skip existence checks** ✅ — `sessions/mark-closed` upserts a `session_notes` row for any path with no note-exists/kind check; `notes/backlink` validates `fromPath` but not `toPath` (dangling graph edges). *(small)*

### 🟢 Low — polish, and the docs that lie

- **UX/frontend:** ChatPane never got commit ae67da1's "surface AI errors" fix — AI failures leave a frozen "Thinking…" (HomeChat is fixed) ✅ · `NewSessionButton` swallows all failures silently ✅ · **no mobile nav at all** — sidebar + world switcher are `hidden md:*` with no drawer/hamburger; only global search remains reachable below `md` ✅ · invite expiry/invalid message silently dropped for logged-in users ✅ · native `confirm/alert/prompt` mixed with styled dialogs (folder delete — same blast radius as campaign delete — gets a bare OS confirm) · no focus management in any custom modal (no trap/auto-focus/restore) · `ImportLauncher` rendered twice on the vault settings page · assets gallery has no delete UI though the endpoint exists.
- **Frontend perf:** `TreeRow` unmemoized (50+ rows reconcile on every awareness broadcast) · `PresenceClient` fires an unthrottled `router.refresh()` on every peer tree change · ChatPane message array + localStorage grow unbounded · Dashboard polls `/api/stats` every 2 s and UpdateToast `/api/health` every 60 s on every session · graph page not lazy-loaded (pulls three/sigma/graphology into the client chunk on navigate) · `usePatchSheet` doesn't reconcile local state on a rejected PATCH (peers keep the stale optimistic value).
- **DB:** redundant `notes_group_path` index duplicates the `UNIQUE(group_id,path)` implicit index (write amplification, no read benefit) · boot-time backfills run nested per-folder queries serially before the server accepts connections.
- **Backend hygiene:** `admin/vault/upload` returns `err.stack` head to the client (violates the no-stack-traces rule) · several routes pass raw `err.message` through on 500s · README documents `POST /api/inventory` which doesn't exist.
- **Docs drift (worth fixing because it caused C1):** CLAUDE.md says "18 migrations" — actual is **45** (non-sequential, a `v800`) · CLAUDE.md says "dm_only enforced at the API layer" and migration v32 says the toggle was "retired" — both false; the toggle and write path are live and read enforcement is missing · `gm_only` (a whole second visibility namespace with stricter admin-only semantics) is undocumented in CLAUDE.md · Dockerfile comment still references a `compendium-ai/` build context that no longer exists.
- **The uncommitted change** in `campaigns/delete/route.ts` adds a *local* `slugify` (feeding M13) — finish it by importing from `@/lib/compendium` rather than committing another copy. (The architecture agent rated this "critical"; it isn't — it's an incomplete cleanup, low risk.)

---

## Part 3 — Themes & suggested sequencing

The findings collapse into five workstreams. Do them roughly in this order:

**Sprint 1 — Close the visibility holes (mostly small, high value).** C1 → M1, M2 (all one root cause: add the `dm_only`/`gm_only` check the other surfaces already have). H1, H3, H8, H9. This is the "start working properly" security sprint and it's mostly one-line guards plus one `closeDocumentConnections()` sweep.

**Sprint 2 — Fix the realtime write coordination.** C2 (AI/import call `closeDocumentConnections`), H7 (atomic note save), M9 (AI sheet edits reach open clients). This is where "snappier and correct" live together — right now they conflict.

**Sprint 3 — Auth & tenancy correctness.** C3, H4, H5, H6, H2 (retire the dead legacy surface). Consolidate the two GM-only-enforcement mechanisms into one self-guarding check per tool (this also de-risks the eventual Eve move — see Part 4 §5).

**Sprint 4 — Back-pressure & lifecycle.** H10 (retention jobs), H11 (durable import jobs), H12/H13 (chat cost caps + abort), M3/M4/M5 (transactions & locks). "More robust" against a long-running instance.

**Sprint 5 — Perf & UX polish.** The M-perf items (indexes M11, N+1 M10, memoize TreeRow, throttle refresh, lazy-load graph), mobile nav, the ChatPane error fix, focus management, and the docs drift.

**Quick wins you can knock out in an afternoon:** H1, H3, H5, H6, M11 (two indexes), M12 (model default), the ChatPane error fix, and updating CLAUDE.md's migration count + dm_only/gm_only reality.

---

## Part 4 — Vercel Eve migration plan

*Eve is past the training cutoff; this is from live doc research on 2026-07-12. Flagging up front: the prompt's `npx skills add vercel/eve` command **does not appear to exist** — that's the separate `skills` package (`npx skills add <owner/repo>`). Eve installs via `npx eve@latest init`. Some specifics below (exact version strings, GitHub star counts) came from a single research pass and should be re-confirmed against the live docs before you commit engineering time.*

### What Eve is
Vercel's open-source, **filesystem-first framework for durable AI agents** — "Next.js for agents." An agent is a *directory*: `instructions.md` (system prompt), `agent.ts` (model config), and `tools/`, `skills/`, `channels/`, `schedules/` subfolders, auto-discovered by location. It does **not replace** the AI SDK — it's a layer *on top* of it (still calls through `@ai-sdk/*` model objects). Its headline feature is **durability**: every turn runs as a checkpointed workflow (on the open-source Workflow SDK) that survives crashes/redeploys, supports human-approval pauses, and can span days.

### Verdict: PARTIAL GO — and not yet
**GO** for chat via an out-of-process sidecar. **NO-GO** on `withEve()` in-process integration. **NO-GO** on adopting Eve's durability layer for the import pipeline *in the first iteration* (attractive later).

Two hard blockers, both real:
1. **Node version floor.** Eve needs **Node 24+**; you're pinned to **Node 22** (and your `better-sqlite3` ABI is rebuilt against 22 in the Dockerfile). Running Eve in-process forces a runtime bump on the whole app. Running it out-of-process lets the Eve service use Node 24 while the main app stays on 22 — *this alone argues for the sidecar.*
2. **`withEve()` assumes it owns the Next.js build.** Your app runs a hand-rolled `node:http` server (`server.ts`) that multiplexes Next + the Hocuspocus `ws` upgrade on one port. The docs are explicitly silent on custom servers; folding `withEve()` in is unsupported territory. The documented escape hatch is the **remote-agent HTTP pattern** — which fits you.

There's also a sharp self-hosting trap: the reverse proxy must forward **both** `/eve/` **and** `/.well-known/workflow/`. Forward only `/eve/` and sessions *start* but silently stall forever (workflow callbacks never arrive). This is the #1 cited self-hosting gotcha.

**Because Eve is beta and explicitly unstable, and your current `streamText` usage is exactly the "simpler chat" case Eve says the raw AI SDK still serves well: migrate behind a feature flag, keep the AI SDK as default + fallback, and only flip once the durability/HITL features justify a second Node-24 service. If your real goal is just cleaner tool registration + better error surfacing, you can get that on the AI SDK today at a fraction of the risk.**

### Target architecture — Eve as a co-located sidecar
```
 Railway
 ┌── Service A: Compendium web (Node 22, EXISTING) ──────────────┐
 │  server.ts → Next handler + ws upgrade (/collab)              │
 │  /api/chat        → proxy to {EVE_ORIGIN}/eve/v1/session      │
 │  /api/sessions/end→ keep on AI SDK (for now)                  │
 │  import pipeline  → UNCHANGED (not on the AI SDK at all)      │
 │  getDb() ─────────► /data/*.sqlite ◄──────────┐              │
 └───────────────────────────────────────────────┼──────────────┘
                                          same volume
 ┌── Service B: Eve agent (Node 24, NEW) ─────────┼──────────────┐
 │  eve build && eve start → Nitro server (PORT)  │              │
 │  agent/agent.ts, instructions.md, tools/*.ts ──┘ getDb()      │
 │  Exposes BOTH /eve/v1/* AND /.well-known/workflow/*           │
 └───────────────────────────────────────────────────────────────┘
```
The crux dependency: Eve tools run **in the Eve process** with full `process.env`, and your tools call `getDb()` directly — so the Eve service must reach the same SQLite file (shared Railway volume) and have `better-sqlite3` built for Node 24.

### Scope: what actually moves
The AI SDK is used in exactly **2 server routes** (`/api/chat`, `/api/sessions/end`) + **2 client components** (`ChatPane`, `HomeChat`) + 1 helper (`chat-tree-refresh.ts`). **The entire import pipeline is NOT on the AI SDK** — it's hand-rolled `generateStructured()` fetches to OpenAI. So an AI-SDK→Eve migration touches only the first group; the import pipeline needs zero migration work (and is a separate, later, opt-in project for Eve's durable workflows).

### Concept mapping (the load-bearing rows)
| Current (AI SDK v6) | Eve equivalent | Status |
|---|---|---|
| `streamText({model,tools,messages,system})` | `defineAgent({model})` + durable `POST /eve/v1/session` | session-based, not one-shot |
| `.toUIMessageStreamResponse()` | NDJSON `/eve/v1/session/<id>/stream` | **different wire format** → frontend rewrite |
| `tool({description,inputSchema,execute})` | `agent/tools/<name>.ts` → `defineTool(...)` | same Zod shape; filename = tool name |
| `getToolsForRole()` per-request filter | **no native equivalent** (discovery is global) | **must re-implement in-tool** — see §5 |
| `buildSystemPrompt()` static + dynamic | `instructions.md` (static) + per-session context injection | dynamic-injection hook = **open question** |
| `stepCountIs(8)` / `stepCountIs(20)` | built-in per-turn step checkpointing | step-budget config = **open question** |
| `useChat()` + UI-message-stream | `useEveAgent()` hook | rewrites tool-bubble rendering |
| `experimental_telemetry` → PostHog | OTel exporter | **not a PostHog drop-in** |
| import `generateStructured()` | (leave as-is) | out of scope |

### §5 — Auth is the sharpest risk
Today authz is two mechanisms: omission from `getToolsForRole()`'s map, plus inline `if (ctx.role !== 'dm')` in only **2 of 4** GM-only tools. Eve auto-discovers tools **globally** with no per-request filter — so mechanism (a) doesn't survive, and `entity_move`/`entity_change_kind` (which rely solely on it) would end up with **no server-side authz** unless you act. Strategy:
1. **Make every tool self-guarding** — read role from `ctx.session`, reject disallowed roles inside `execute`. **Do this now, on the AI SDK** (it's finding C3/H-adjacent and de-risks the move regardless).
2. **Bind trusted auth context to the Eve session** from your proxy's `requireSession` — role must come from the cookie session, never the message. *Open question: the exact write path for `ctx.session` isn't in the research.*
3. **Approval gates** (`approval: once()`) on the non-idempotent GM tools double as replay-safety (Eve re-runs interrupted steps).
4. Keep every tool query `group_id`-filtered from server-set context.

### Phased plan (each phase independently shippable)
- **Phase 0 — de-risk on the current stack (S, low).** Fix ChatPane error parity; unify the 4 model defaults into one `resolveModel()`; add inline role guards to all 4 GM tools; cap chat message history. *All of these are audit findings you want regardless of Eve.*
- **Phase 1 — stand up the Eve service, zero traffic (M, med).** `npx eve@latest init`; Node-24 Railway service sharing the `/data` volume; configure the Workflow SDK "world"; **verify a curl session actually completes** (the stall trap).
- **Phase 2 — port tools to `defineTool` (L, med).** One file per tool; move `execute` bodies verbatim; add idempotency/approval gates; move role checks in-tool; confirm `getDb()` resolves under Node 24.
- **Phase 3 — `/api/chat` proxies Eve behind `AI_BACKEND=eve|aisdk` (M, high).** Default `aisdk`. Both paths coexist.
- **Phase 4 — frontend consumes Eve's stream (L, high).** Swap `useChat`→`useEveAgent`; rebuild tool bubbles against Eve events; carry the error-surfacing fix into both components. Largest chunk; point of no return.
- **Phase 5 — cutover + cleanup (S, med).** Flip the flag; bake; delete the AI SDK chat path.
- **Deferred (own project):** port the import pipeline to Eve durable workflows + HITL — this is the genuinely compelling Eve win (it directly fixes H11), but it's separate from the chat migration.

### Open questions to resolve before Phase 2
Per-session dynamic system-prompt injection hook · binding server-side auth context to `ctx.session` · step-budget configurability · Workflow SDK "world" on a shared SQLite volume (does local-disk world tolerate a network volume, or do you need Postgres just for Eve durability?) · `getDb()` + `better-sqlite3` Node-24 reachability in-process · whether `useEveAgent()` can render incremental tool-call UI equivalent to today's · keeping PostHog telemetry without an OTel→PostHog bridge.

### What NOT to migrate
The import pipeline (not on the AI SDK — migrating buys nothing now) · `/api/sessions/end` initially (non-streaming, low value early) · `orchestrator.ts` skill detection + `personalities.ts`/`pricing.ts`/`paths.ts` (no SDK coupling — *reuse*, don't migrate) · the custom `server.ts` (keep on Node 22; Eve lives out-of-process) · AI Gateway (use direct `@ai-sdk/openai`, no Vercel dependency).
