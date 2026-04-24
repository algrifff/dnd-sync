// Next.js server instrumentation — runs once before routes are served.
// Sets up OpenTelemetry with PostHog's span processor so that Vercel AI
// SDK `experimental_telemetry` spans are forwarded to PostHog LLM
// Analytics as `$ai_generation` events.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NODE_ENV !== 'production') return;

  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
  if (!apiKey) return;

  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;

  const { NodeSDK } = await import('@opentelemetry/sdk-node');
  const { resourceFromAttributes } = await import('@opentelemetry/resources');
  const { PostHogSpanProcessor } = await import('@posthog/ai/otel');

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ 'service.name': 'compendium' }),
    spanProcessors: [
      new PostHogSpanProcessor(host ? { apiKey, host } : { apiKey }),
    ],
  });

  sdk.start();
}
