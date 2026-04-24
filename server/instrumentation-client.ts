import posthog from '@/lib/posthog-web';

const projectToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
if (projectToken && process.env.NODE_ENV === 'production') {
  posthog.init(projectToken, {
    api_host: '/ingest',
    ui_host: 'https://eu.posthog.com',
    defaults: '2026-01-30',
    capture_exceptions: true,
    debug: process.env.NODE_ENV === 'development',
  });
}
