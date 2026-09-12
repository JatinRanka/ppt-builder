/**
 * RATE LIMITING — the per-caller budget the size caps cannot provide.
 *
 * limits.ts bounds ONE request. That is necessary but not sufficient: a caller
 * who respects every cap can still send the maximum-size request in a loop and
 * run up an unbounded provider bill, because all three routes are
 * unauthenticated. This file bounds requests PER CALLER PER WINDOW, which is
 * the control that actually caps spend.
 *
 * SCOPE AND HONEST LIMITATIONS — read before relying on this:
 *
 *  1. IN-MEMORY, so the budget is PER SERVER INSTANCE. On a single Node host
 *     that is a real limit. On serverless/multi-region (Vercel), each instance
 *     keeps its own counter, so effective capacity is roughly
 *     limit x instances. It raises the cost of abuse by orders of magnitude but
 *     is not an exact global quota.
 *  2. Keyed on a CLIENT IP derived from proxy headers, which are forgeable
 *     unless a trusted proxy overwrites them. Vercel and most managed hosts do
 *     overwrite x-forwarded-for; a bare Node server behind nothing does not.
 *  3. Therefore this stops accidental loops, naive scripted abuse, and runaway
 *     cost from a single client. It is NOT a defence against a distributed
 *     botnet.
 *
 * For a hard global quota, back this with Redis/Upstash (swap `hit` for an
 * INCR+EXPIRE) or put the routes behind the platform's WAF. The interface here
 * is deliberately shaped so that swap touches only this file.
 */
import type { NextRequest } from 'next/server';

export interface RateLimitRule {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/**
 * Budgets by class of work, because the costs are not comparable.
 *
 * `llm` is stricter than `export`: a chat/fill request spends provider tokens
 * (real money, and slow), while an export only spends local CPU.
 */
export const RATE_LIMITS: Record<'llm' | 'export', RateLimitRule> = {
  llm: { limit: 20, windowMs: 60_000 },
  export: { limit: 30, windowMs: 60_000 },
};

interface Counter {
  count: number;
  /** Epoch ms at which this window expires. */
  resetAt: number;
}

const buckets = new Map<string, Counter>();

/**
 * Bound the map so the limiter itself cannot become the memory exhaustion bug.
 * Each distinct spoofed IP would otherwise allocate an entry forever.
 */
const MAX_TRACKED_KEYS = 10_000;

function sweep(now: number): void {
  for (const [key, c] of buckets) {
    if (c.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Best-effort client identity.
 *
 * x-forwarded-for is the de-facto standard and is rewritten by managed hosts;
 * we take the LEFTMOST entry, which is the original client when a trusted
 * proxy appends. A caller behind no proxy can forge this — see the header
 * comment. Unknown callers share one bucket, which is intentional: it means an
 * unidentifiable flood is throttled rather than exempt.
 */
function clientKey(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window resets, for Retry-After. */
  retryAfterSec: number;
}

/** Record a hit against `bucket` and report whether it is within budget. */
export function hit(key: string, rule: RateLimitRule, now = Date.now()): RateLimitResult {
  if (buckets.size > MAX_TRACKED_KEYS) sweep(now);

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + rule.windowMs });
    return {
      allowed: true,
      limit: rule.limit,
      remaining: rule.limit - 1,
      retryAfterSec: Math.ceil(rule.windowMs / 1000),
    };
  }

  existing.count += 1;
  const retryAfterSec = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
  return {
    allowed: existing.count <= rule.limit,
    limit: rule.limit,
    remaining: Math.max(0, rule.limit - existing.count),
    retryAfterSec,
  };
}

/**
 * Route guard: returns a 429 Response to return immediately, or null to
 * proceed. Shaped this way so a route reads `if (limited) return limited;`
 * with no branching on internals.
 */
export function enforceRateLimit(req: NextRequest, bucket: 'llm' | 'export'): Response | null {
  // Opt-out for local development and tests, where hammering the endpoint is
  // the point. Must be explicitly set; the safe default is ON.
  if (process.env.DISABLE_RATE_LIMIT === '1') return null;

  const rule = RATE_LIMITS[bucket];
  const result = hit(`${bucket}:${clientKey(req)}`, rule);
  if (result.allowed) return null;

  return new Response(
    JSON.stringify({
      error: `Too many requests. You can make ${rule.limit} ${bucket} requests per minute — try again in ${result.retryAfterSec}s.`,
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(result.retryAfterSec),
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': '0',
      },
    }
  );
}

/** Test seam: drop all counters so cases cannot bleed into each other. */
export function resetRateLimitsForTesting(): void {
  buckets.clear();
}
