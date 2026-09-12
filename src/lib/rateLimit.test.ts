import { beforeEach, describe, expect, it } from 'vitest';
import { hit, RATE_LIMITS, resetRateLimitsForTesting } from './rateLimit';

beforeEach(() => resetRateLimitsForTesting());

describe('hit', () => {
  const rule = { limit: 3, windowMs: 60_000 };

  it('allows up to the limit and denies past it', () => {
    const now = Date.now();
    expect(hit('a', rule, now).allowed).toBe(true);
    expect(hit('a', rule, now).allowed).toBe(true);
    expect(hit('a', rule, now).allowed).toBe(true);
    expect(hit('a', rule, now).allowed).toBe(false);
  });

  it('reports remaining budget', () => {
    const now = Date.now();
    expect(hit('a', rule, now).remaining).toBe(2);
    expect(hit('a', rule, now).remaining).toBe(1);
    expect(hit('a', rule, now).remaining).toBe(0);
  });

  it('keeps callers in separate buckets', () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) hit('a', rule, now);
    expect(hit('a', rule, now).allowed).toBe(false);
    // A different caller is unaffected by the first one's exhausted budget.
    expect(hit('b', rule, now).allowed).toBe(true);
  });

  it('resets after the window elapses', () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) hit('a', rule, now);
    expect(hit('a', rule, now).allowed).toBe(false);
    expect(hit('a', rule, now + rule.windowMs + 1).allowed).toBe(true);
  });

  it('reports a retry-after inside the window', () => {
    const now = Date.now();
    for (let i = 0; i < 4; i++) hit('a', rule, now);
    const r = hit('a', rule, now + 10_000);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSec).toBeGreaterThan(0);
    expect(r.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it('throttles LLM work more tightly than exports', () => {
    // Token spend is the expensive axis; CPU-bound export is looser.
    expect(RATE_LIMITS.llm.limit).toBeLessThan(RATE_LIMITS.export.limit);
  });

  it('caps a sustained flood well below an unbounded loop', () => {
    const now = Date.now();
    let allowed = 0;
    for (let i = 0; i < 500; i++) if (hit('flood', RATE_LIMITS.llm, now).allowed) allowed++;
    expect(allowed).toBe(RATE_LIMITS.llm.limit);
  });
});
