// Server-side PostHog singleton (posthog-node). Used from Server
// Actions and Route Handlers to capture authenticated events keyed by
// user id.
//
// If NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN is not set (e.g. local dev
// without analytics configured) we return a no-op client so call sites
// never need to guard individually.

import { PostHog } from 'posthog-node';

type CaptureArgs = {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
};

type IdentifyArgs = {
  distinctId: string;
  properties?: Record<string, unknown>;
};

type PostHogLike = {
  identify: (args: IdentifyArgs) => void;
  capture: (args: CaptureArgs) => void;
  flush?: () => Promise<void>;
  shutdown?: () => Promise<void>;
};

const noopClient: PostHogLike = {
  identify: () => {},
  capture: () => {},
};

let posthogClient: PostHogLike | null = null;
let warnedMissingToken = false;

export async function getPostHogClient(): Promise<PostHogLike> {
  if (posthogClient) return posthogClient;

  const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://eu.i.posthog.com';

  if (process.env.NODE_ENV !== 'production') {
    posthogClient = noopClient;
    return posthogClient;
  }

  if (!token) {
    if (!warnedMissingToken && process.env.NODE_ENV !== 'production') {
      warnedMissingToken = true;
      console.warn(
        '[posthog] NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN is not set — server events will be dropped.',
      );
    }
    posthogClient = noopClient;
    return posthogClient;
  }

  // Defaults batch events (flushAt=20, flushInterval=10s). That's fine
  // for our long-running custom server — it piggybacks on the server's
  // lifetime and flushes on shutdown below.
  posthogClient = new PostHog(token, { host });

  // Best-effort flush on process exit so we don't drop the tail of an
  // event buffer when the container stops.
  const shutdown = async (): Promise<void> => {
    try {
      await (posthogClient as PostHog).shutdown();
    } catch {
      // ignore
    }
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  process.once('beforeExit', () => void shutdown());

  return posthogClient;
}
