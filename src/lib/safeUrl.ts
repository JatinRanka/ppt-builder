/**
 * SSRF GUARD — what the server is allowed to fetch on a client's behalf.
 *
 * The PPTX exporter fetches `block.url` for every image block. That deck
 * arrives in the POST body, so the URL is fully attacker-controlled: before
 * this file, `{"type":"image","url":"http://169.254.169.254/latest/meta-data/"}`
 * made the server read its own cloud instance credentials, and `file:///etc/passwd`
 * parsed clean through `z.string().url()`. `redirect: 'follow'` meant a public
 * host could bounce the request inward too.
 *
 * The defence is an ALLOWLIST, not a blocklist. Blocklisting internal ranges is
 * a losing game — decimal IPs (http://2852039166/), IPv6-mapped IPv4
 * (http://[::ffff:169.254.169.254]/), DNS names that resolve to 127.0.0.1, and
 * rebinding all defeat it. An allowlist is correct here because the app only
 * ever *generates* Unsplash URLs (see images.ts), so any other host is already
 * outside the product's own vocabulary and has nothing legitimate to lose.
 */

/**
 * Hosts the exporter may fetch images from.
 *
 * Exact match or a subdomain of these, nothing else. Extend deliberately: each
 * entry is a host trusted to receive a server-side request carrying this
 * deployment's egress IP.
 */
export const IMAGE_HOST_ALLOWLIST = [
  'images.unsplash.com',
  'source.unsplash.com',
  'plus.unsplash.com',
] as const;

/** Literal addresses that must never be fetched, in any notation we can spot. */
const BLOCKED_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /\.localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^169\.254\./, // link-local — cloud metadata (AWS/Azure/GCP/DO)
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?::1\]?$/,
  /^\[?(fc|fd)/i, // IPv6 unique-local
  /^\[?fe80:/i, // IPv6 link-local
  /\.internal$/i, // metadata.google.internal
  /\.local$/i,
];

/**
 * Is this URL safe for the server to fetch?
 *
 * Checks, in order: parseable, https only, host on the allowlist, host is not
 * an internal literal. The internal-literal check is redundant behind the
 * allowlist by construction, but it is kept so that widening the allowlist
 * later cannot silently open an SSRF path.
 */
export function isAllowedImageUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  // https only. Blocks file:, data:, gopher:, blob: and plain http (which a
  // MITM could redirect and which no allowlisted host needs).
  if (url.protocol !== 'https:') return false;

  // Credentials in a URL are never legitimate for a stock photo and are a
  // classic way to make a blocked host look allowlisted to a naive parser.
  if (url.username || url.password) return false;

  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAME_PATTERNS.some((re) => re.test(host))) return false;

  return IMAGE_HOST_ALLOWLIST.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/**
 * Reject the URL schemes that are dangerous as a browser `img src`, for schema
 * validation. Broader than isAllowedImageUrl: a deck may legitimately carry a
 * third-party image URL for the CLIENT to render (the browser sandboxes that,
 * and the user's own IP fetches it). Only the SERVER-side fetch needs the
 * allowlist. This just keeps `javascript:` and `data:` out of the stored deck,
 * since both are XSS sinks the moment this value reaches an href or a
 * dangerouslySetInnerHTML.
 */
export function isSafeImageUrlScheme(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}
