// Route-level error helper. Fires an `api_error` event to PostHog,
// logs to stdout with the conventional `[route-name]` prefix, and
// returns the project's standard 500 response shape.

import { captureServer } from './capture';
import { EVENTS } from './events';

type SessionContext = {
  userId: string;
  currentGroupId: string;
};

export function classifyError(err: unknown): string {
  if (err && typeof err === 'object') {
    const name = (err as { name?: string }).name;
    if (name === 'ZodError') return 'zod_invalid';
    if (name === 'SyntaxError') return 'bad_json';
  }
  return 'unknown';
}

/** Capture + log + return 500. Use in API route catch blocks where the
 *  route previously did ad-hoc `console.error` + 500. Do NOT use for
 *  expected 4xx branches — those are user errors, not defects. */
export function apiErrorResponse(
  route: string,
  err: unknown,
  session?: SessionContext,
): Response {
  const code = classifyError(err);
  const message = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);

  void captureServer({
    userId: session?.userId ?? null,
    groupId: session?.currentGroupId ?? null,
    event: EVENTS.API_ERROR,
    properties: { route, code, message },
  });

  console.error(`[${route}]`, err);

  return new Response(JSON.stringify({ error: 'internal_error' }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
  });
}
