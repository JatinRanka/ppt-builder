import posthog from 'posthog-js';

/**
 * CLIENT ANALYTICS.
 *
 * Next runs this file after the document loads and before React hydrates
 * (the `instrumentation-client` convention, Next 15.3+), which is early
 * enough for PostHog to catch the initial pageview itself.
 *
 * Two things this file depends on elsewhere:
 *  - Both vars are NEXT_PUBLIC_ on purpose. A PostHog PROJECT token is a
 *    write-only ingest key and is meant to ship to the browser; it is not a
 *    personal API key and grants no read access. Never put a phx_ key here.
 *  - The CSP in src/proxy.ts must allow the ingest host in `connect-src`, or
 *    every event is blocked by the browser and analytics fails silently.
 *
 * No key, no analytics: the app is fully usable without PostHog configured,
 * so a missing token is a no-op rather than a crash.
 */
const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;

if (token) {
  posthog.init(token, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    // Opts into PostHog's 2026-05-30 defaults bundle rather than pinning each
    // flag by hand. Changing this date changes capture behaviour, so treat it
    // as a deliberate upgrade, not a value to bump casually.
    defaults: '2026-05-30',
  });
}
