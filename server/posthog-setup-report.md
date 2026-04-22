<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog into Compendium, covering both product analytics and LLM analytics. Here's a summary of all changes made:

**New files created:**
- `instrumentation-client.ts` — client-side PostHog initialization using Next.js 15.3+ instrumentation hook. Enables automatic error tracking (`capture_exceptions: true`) and routes events through the reverse proxy at `/ingest`.
- `instrumentation.ts` — server-side Next.js instrumentation hook. Initializes the OpenTelemetry SDK with PostHog's `PostHogSpanProcessor` so that every `streamText` call emits `$ai_generation` events to PostHog LLM Analytics automatically.
- `src/lib/posthog-server.ts` — singleton server-side PostHog client (posthog-node) used by server actions and API routes.

**Existing files modified:**
- `next.config.ts` — added `/ingest/*` reverse proxy rewrites for both the ingestion endpoint and static assets (EU region), plus `skipTrailingSlashRedirect: true`.
- `tsconfig.json` — added `instrumentation-client.ts` and `instrumentation.ts` to the TypeScript include list.
- `package.json` — added `posthog-js`, `posthog-node`, `@posthog/ai`, `@opentelemetry/sdk-node`, and `@opentelemetry/resources`. Run `bun install` from the repo root to install them.
- `server/.env.local` — added `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` and `NEXT_PUBLIC_POSTHOG_HOST` environment variables.
- `src/app/login/actions.ts` — server-side `user_logged_in` and `user_logged_out` events via posthog-node; includes `identify()` call on login.
- `src/app/ChatPane.tsx` — client-side `ai_message_sent` (with attachment metadata) and `session_review_submitted` events.
- `src/app/HomeChat.tsx` — client-side `ai_message_sent`, `ai_quick_action_triggered` (with action key), and `ai_chat_cleared` events.
- `src/app/settings/vault/UploadForm.tsx` — client-side `vault_upload_completed` (with ingestion stats) and `vault_upload_failed` events.
- `src/app/settings/import/[id]/ImportJobPanel.tsx` — client-side `import_job_applied` (with move/merge/kept counts) and `import_job_cancelled` events.
- `src/app/api/chat/route.ts` — added `experimental_telemetry` to the `streamText` call, linking each generation to the authenticated user via `posthog_distinct_id`.

## Events instrumented

| Event | Description | File |
|-------|-------------|------|
| `user_logged_in` | User successfully authenticated | `src/app/login/actions.ts` |
| `user_logged_out` | User ended their session | `src/app/login/actions.ts` |
| `ai_message_sent` | User sent a message to the AI assistant | `src/app/ChatPane.tsx`, `src/app/HomeChat.tsx` |
| `ai_quick_action_triggered` | User clicked a quick-create shortcut | `src/app/HomeChat.tsx` |
| `ai_chat_cleared` | User cleared chat history | `src/app/HomeChat.tsx` |
| `vault_upload_completed` | Vault ZIP successfully ingested | `src/app/settings/vault/UploadForm.tsx` |
| `vault_upload_failed` | Vault ZIP upload or ingestion failed | `src/app/settings/vault/UploadForm.tsx` |
| `import_job_applied` | AI-assisted import job applied to vault | `src/app/settings/import/[id]/ImportJobPanel.tsx` |
| `import_job_cancelled` | Import job cancelled by user | `src/app/settings/import/[id]/ImportJobPanel.tsx` |
| `session_review_submitted` | Session review changes submitted | `src/app/ChatPane.tsx` |
| `$ai_generation` | Auto-captured per LLM call via OpenTelemetry — includes model, tokens, latency, cost | `src/app/api/chat/route.ts` (via OTel) |

## Next steps

We've built a dashboard and insights for you to keep an eye on user behavior and LLM performance:

- **Dashboard**: [Analytics basics](https://eu.posthog.com/project/164222/dashboard/636799)
- **Insight**: [Daily active users (logins)](https://eu.posthog.com/project/164222/insights/yYSZpQjt)
- **Insight**: [AI assistant usage — messages sent](https://eu.posthog.com/project/164222/insights/kb244ahL)
- **Insight**: [Import pipeline funnel](https://eu.posthog.com/project/164222/insights/DGJE0T6j)
- **Insight**: [Quick action popularity breakdown](https://eu.posthog.com/project/164222/insights/qIwwJsnL)
- **Insight**: [Vault upload success vs failure rate](https://eu.posthog.com/project/164222/insights/vPxLu1f0)
- **Insight**: [AI generation cost over time](https://eu.posthog.com/project/164222/insights/nAqsak8f)
- **Insight**: [Average AI response latency](https://eu.posthog.com/project/164222/insights/DboF0Ot0)

**To complete setup**, run from the repo root:
```bash
bun install
```

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
