import type { NextConfig } from "next";

/**
 * SECURITY HEADERS.
 *
 * The app renders model-generated content, so it should not also be a
 * convenient host for someone else's payload. There is no XSS sink today
 * (React escapes, and the codebase has no dangerouslySetInnerHTML), but these
 * headers make a future mistake non-fatal rather than immediately exploitable.
 *
 * The Content-Security-Policy is NOT here. It needs a per-request nonce to
 * allow Next's inline hydration scripts without opening the policy to all
 * inline script, so it is built in src/proxy.ts. Do not add a CSP header to
 * this file: the browser enforces the intersection of every CSP it receives,
 * so a second static copy would re-block the scripts the nonce exists to allow.
 *
 * Everything below is request-independent, so it stays static config.
 */
const nextConfig: NextConfig = {
  // Do not advertise the framework version to scanners.
  poweredByHeader: false,

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Legacy companion to the CSP's frame-ancestors 'none'.
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
