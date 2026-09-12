/**
 * CONCURRENCY + RATE LIMITING for phase 2.
 *
 * Phase 2 issues one request per slide, so a 10-slide deck is ~11 calls. Entry
 * API tiers allow only tens of requests per minute, so unbounded parallelism
 * would 429 halfway through and leave a half-filled deck.
 *
 * Concurrency 3 keeps generation visibly fast while staying inside the budget.
 */
export const PHASE2_CONCURRENCY = 3;

/** Run tasks with bounded concurrency, preserving input order in the result. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return results;
}

/** Retry with exponential backoff, for 429s and transient 5xxs. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number; label?: string } = {}
): Promise<T> {
  const { attempts = 3, baseMs = 700, label = 'request' } = opts;
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const retryable = (e as { retryable?: boolean; status?: number }).retryable
        ?? [429, 500, 502, 503, 504].includes((e as { status?: number }).status ?? 0);
      if (!retryable || i === attempts - 1) throw e;
      // Jitter avoids all three phase-2 workers retrying in lockstep.
      const delay = baseMs * 2 ** i + Math.random() * 250;
      await new Promise((r) => setTimeout(r, delay));
      console.warn(`[limiter] retrying ${label} after ${Math.round(delay)}ms (attempt ${i + 2}/${attempts})`);
    }
  }
  throw lastError;
}
