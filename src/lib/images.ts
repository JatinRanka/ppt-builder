/**
 * IMAGE RESOLUTION — model emits keywords, server resolves a URL.
 *
 * The model is asked for `query` (keywords) rather than a url because models
 * reliably hallucinate broken image urls. This maps a query to a real image
 * deterministically and needs no image-generation key.
 *
 * Uses Unsplash's keyword endpoint by default. If UNSPLASH_ACCESS_KEY is set we
 * could hit the real API for better relevance, but the keyword URL avoids a
 * network round-trip during generation, which matters for perceived latency.
 */
const FALLBACK = 'https://images.unsplash.com/photo-1451187580459-43490279c0fa';

export function resolveImageUrl(query: string, width = 1600, height = 900): string {
  const cleaned = query.trim().replace(/\s+/g, ',').replace(/[^a-zA-Z0-9,\-]/g, '');
  if (!cleaned) return `${FALLBACK}?w=${width}&h=${height}&fit=crop`;
  // `featured` biases toward higher-quality curated results than plain random.
  return `https://source.unsplash.com/featured/${width}x${height}/?${encodeURIComponent(cleaned)}`;
}

/** Deterministic per-slide variation so repeated queries do not all match. */
export function resolveImageUrlSeeded(query: string, seed: string, width = 1600, height = 900): string {
  return `${resolveImageUrl(query, width, height)}&sig=${encodeURIComponent(seed)}`;
}
