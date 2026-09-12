import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * CSP WITH A PER-REQUEST NONCE.
 *
 * This lives here rather than in next.config.ts because the policy is no longer
 * a constant: Next streams the RSC payload to the browser in INLINE
 * `<script>self.__next_f.push(...)</script>` tags, and a static
 * `script-src 'self'` blocks every one of them. The page then renders but never
 * hydrates (React #412) — so the deployed app looked fine and no button worked.
 *
 * A nonce is the fix that keeps the policy strict. Next parses the CSP header
 * off the incoming request, extracts `'nonce-...'`, and applies it to the
 * framework runtime, the page bundles, and its own inline scripts. Nothing has
 * to be nonced by hand.
 *
 * Two consequences worth knowing:
 *  - The nonce must be unique per request, so every page must be DYNAMICALLY
 *    rendered — a build-time prerender has no request to read a nonce from.
 *    `/` and `/print` each call `await connection()` for exactly this reason.
 *    Do not add `export const dynamic = 'force-static'` to a page.
 *  - CSP must be set in ONE place. If next.config.ts also emitted a CSP, the
 *    browser would enforce the intersection of both, and the non-nonce copy
 *    would blocklist the inline scripts all over again.
 */
const isDev = process.env.NODE_ENV === 'development';

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');

  const csp = [
    "default-src 'self'",
    // 'strict-dynamic' makes the browser ignore host allowlists for scripts and
    // trust the nonce plus anything a nonced script loads — which is how Next's
    // chunk loading works. 'unsafe-eval' is dev-only: React uses eval there to
    // rebuild server error stacks in the browser, and never in production.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    // Styles keep 'unsafe-inline' and deliberately do NOT use the nonce: a
    // nonce authorises <style> elements, not inline `style=` ATTRIBUTES, and the
    // slide canvas positions every block with those. Tailwind v4 needs it too.
    "style-src 'self' 'unsafe-inline'",
    // Decks legitimately reference third-party image URLs, which the BROWSER
    // fetches (sandboxed, user's own IP). The dangerous case is the SERVER
    // fetching them, and that is allowlisted separately in src/lib/safeUrl.ts.
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    // The app talks only to its own API routes; the LLM call is server-side.
    `connect-src 'self'${isDev ? ' ws: wss:' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // Blocks clickjacking of the editor, which has destructive one-click
    // controls (delete slide, new deck). X-Frame-Options in next.config.ts
    // covers browsers that predate frame-ancestors.
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');

  // The request copy is what Next renders against — this is how it learns the
  // nonce. The response copy is what the browser enforces. Both are required.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('content-security-policy', csp);
  requestHeaders.set('x-nonce', nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Static assets and JSON API responses have nothing for a CSP to govern,
      // and prefetches are not documents. Skipping them avoids paying for a
      // nonce on requests that cannot use one.
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
