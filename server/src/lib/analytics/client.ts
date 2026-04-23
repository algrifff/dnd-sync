// Browser-side analytics wrapper. Init lives in
// `server/instrumentation-client.ts`; this module is the one every
// client component imports so we have a single chokepoint for default
// properties, throttling, and pre-init safety.

'use client';

import posthog from '@/lib/posthog-web';
import { EVENTS, type EventName } from './events';

type Props = Record<string, unknown>;

function ready(): boolean {
  // posthog-js exposes __loaded once init() has resolved. Before that
  // capture() queues to a best-effort buffer — harmless but we'd rather
  // not rely on it in error paths.
  return typeof window !== 'undefined' && (posthog as unknown as { __loaded?: boolean }).__loaded === true;
}

export function track(event: EventName, properties?: Props): void {
  try {
    if (!ready()) return;
    posthog.capture(event, properties);
  } catch (err) {
    // Never let analytics break the UI.
    if (process.env.NODE_ENV !== 'production') console.warn('[analytics/client]', err);
  }
}

export function trackError(err: unknown, context?: Props): void {
  try {
    if (!ready()) return;
    const error = err instanceof Error ? err : new Error(String(err));
    posthog.captureException(error, context);
    posthog.capture(EVENTS.CLIENT_ERROR, {
      message: error.message.slice(0, 200),
      stack: error.stack?.slice(0, 2000),
      ...context,
    });
  } catch {
    // swallow
  }
}

export function identify(userId: string, properties?: Props): void {
  try {
    if (!ready()) return;
    posthog.identify(userId, properties);
  } catch {
    // swallow
  }
}

/** Associate the current person with a world (PostHog Group analytics).
 *  Lets dashboards slice by world without adding `group_id` to every
 *  single capture. */
export function setWorld(groupId: string): void {
  try {
    if (!ready()) return;
    posthog.group('world', groupId);
  } catch {
    // swallow
  }
}

export { EVENTS };
