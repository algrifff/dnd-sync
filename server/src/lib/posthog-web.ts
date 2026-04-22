// Re-export of the posthog-js browser singleton.
//
// Initialisation lives in `instrumentation-client.ts` (Next.js 15.3+
// instrumentation hook), which reads NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN
// and calls `posthog.init(...)` once per page load. Every client
// component that wants to capture an event imports from this module so
// there's a single instance to talk to.

import posthog from 'posthog-js';

export default posthog;
