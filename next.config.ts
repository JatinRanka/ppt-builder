import type { NextConfig } from "next";

/**
 * SECURITY HEADERS.
 *
 * The app renders model-generated content, so it should not also be a
 * convenient host for someone else's payload. There is no XSS sink today
 * (React escapes, and the codebase has no dangerouslySetInnerHTML), but these
 * headers make a future mistake non-fatal rather than immediately exploitable.
 *
 * CSP notes:
 *  - 'unsafe-inline' for styles is required by Tailwind v4 and React's inline
 *    style attributes (the slide canvas positions everything with them).
 *  - 'unsafe-inline'/'unsafe-eval' for scripts in DEV only — Next's dev
 *    overlay and HMR need them. Production gets the strict form.
 *  - img-src allows https: broadly because decks legitimately reference
 *    third-party image URLs, which the BROWSER fetches (sandboxed, user's own
 *    IP). The dangerous case is the SERVER fetching them, and that is
 *    allowlisted separately in src/lib/safeUrl.ts.
 *  - frame-ancestors 'none' plus X-Frame-Options blocks clickjacking of the
 *    editor, which has destructive one-click controls (delete slide, new deck).
 */
const isDev = process.env.NODE_ENV === "development";

const csp = [
  "default-src 'self'",
  `script-src 'self'${isDev ? " 'unsafe-inline' 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  // The app talks only to its own API routes; the LLM call is server-side.
  `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

const nextConfig: NextConfig = {
  // Do not advertise the framework version to scanners.
  poweredByHeader: false,

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // No feature in this app needs any of these.
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
      {
        // API responses are per-request and must never be cached by a shared
        // proxy — one user's deck reaching another's response would be a data
        // leak, and these routes are all POST-only anyway.
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, must-revalidate" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
