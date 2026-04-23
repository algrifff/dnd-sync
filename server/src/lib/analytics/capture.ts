// Server-side PostHog capture wrapper. Never throws, never blocks the
// calling path — all failures swallowed with a single console.warn.
//
// Use from Server Actions, API route handlers, and the Hocuspocus
// collab server. For unauthenticated traffic (pre-session 5xx, WS
// auth reject) pass no userId and we fall back to `anonymous` with
// `$process_person_profile: false` so PostHog doesn't create a ghost
// person row for every stray error.

import { getPostHogClient } from '@/lib/posthog-server';
import type { EventName } from './events';

type CaptureInput = {
  userId?: string | null;
  groupId?: string | null;
  event: EventName;
  properties?: Record<string, unknown>;
};

/** Fire-and-forget capture. Returns a promise for callers who want to
 *  await it (tests), but most call sites should `void captureServer(...)`. */
export async function captureServer(input: CaptureInput): Promise<void> {
  try {
    const client = await getPostHogClient();
    const distinctId = input.userId ?? 'anonymous';
    const properties: Record<string, unknown> = {
      ...(input.properties ?? {}),
    };
    if (input.groupId) properties.group_id = input.groupId;
    if (!input.userId) properties.$process_person_profile = false;

    client.capture({ distinctId, event: input.event, properties });
  } catch (err) {
    console.warn('[analytics] capture failed:', err);
  }
}

export async function identifyServer(
  userId: string,
  properties: Record<string, unknown>,
): Promise<void> {
  try {
    const client = await getPostHogClient();
    client.identify({ distinctId: userId, properties });
  } catch (err) {
    console.warn('[analytics] identify failed:', err);
  }
}
