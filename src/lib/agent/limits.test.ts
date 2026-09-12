/**
 * Guardrail tests.
 *
 * /api/chat is an unauthenticated door onto a paid LLM, so these bounds are a
 * cost and availability control, not just input hygiene. Before them, a 1MB
 * prompt and a 500-slide deck were both accepted and forwarded to the provider.
 */
import { describe, expect, it } from 'vitest';
import {
  clampHistory,
  MAX_DECK_BYTES,
  MAX_FILL_SLIDES,
  MAX_HISTORY_MESSAGE_CHARS,
  MAX_HISTORY_TURNS,
  MAX_MESSAGE_CHARS,
  MAX_SLIDES,
  validateChatInput,
  validateDeckSize,
  withTimeout,
} from './limits';
import { toolCallToOps } from './translate';
import { makeSampleDeck, makeBlankSlide } from '@/lib/schema/factory';
import { toFriendlyError } from './errors';
import { LLMError } from '@/lib/llm/types';

const ok = { message: 'make slide 1 concise', slideCount: 5, deckBytes: 4_000 };

describe('validateChatInput', () => {
  it('accepts a normal request', () => {
    expect(validateChatInput(ok)).toBeNull();
  });

  it('rejects an oversized message and says what the limit is', () => {
    const err = validateChatInput({ ...ok, message: 'x'.repeat(MAX_MESSAGE_CHARS + 1) });
    expect(err).toBeTruthy();
    expect(err).toContain(String(MAX_MESSAGE_CHARS).slice(0, 1)); // limit is quoted
  });

  it('rejects too many slides', () => {
    expect(validateChatInput({ ...ok, slideCount: MAX_SLIDES + 1 })).toMatch(/limit is/);
  });

  it('rejects an oversized deck payload', () => {
    expect(validateChatInput({ ...ok, deckBytes: 99_000_000 })).toMatch(/too large|limit/i);
  });

  it('allows exactly the limits (boundaries are inclusive)', () => {
    expect(
      validateChatInput({ message: 'x'.repeat(MAX_MESSAGE_CHARS), slideCount: MAX_SLIDES, deckBytes: 4_000 })
    ).toBeNull();
  });
});

describe('clampHistory', () => {
  it('keeps only the most recent turns', () => {
    const hist = Array.from({ length: 20 }, (_, i) => ({ content: `m${i}` }));
    const out = clampHistory(hist);
    expect(out).toHaveLength(MAX_HISTORY_TURNS);
    expect(out.at(-1)!.content).toBe('m19'); // the newest, not the oldest
  });

  it('truncates one enormous turn rather than dropping it', () => {
    const out = clampHistory([{ content: 'y'.repeat(MAX_HISTORY_MESSAGE_CHARS + 500) }]);
    expect(out[0].content.length).toBeLessThan(MAX_HISTORY_MESSAGE_CHARS + 50);
    expect(out[0].content).toMatch(/truncated/);
  });
});

describe('withTimeout', () => {
  it('passes a value through when it resolves in time', async () => {
    await expect(withTimeout(Promise.resolve('done'), 1_000, 'x')).resolves.toBe('done');
  });

  it('rejects with a labelled message when it does not', async () => {
    const never = new Promise<never>(() => {});
    await expect(withTimeout(never, 20, 'Deck generation')).rejects.toThrow(
      /Deck generation timed out/
    );
  });
});

describe('add_slide respects the deck cap', () => {
  it('refuses to grow a deck past MAX_SLIDES', () => {
    // The prompt says "never exceed 12", but a prompt is a request — a model
    // that ignores it must still be stopped in code.
    const base = makeSampleDeck();
    const full = {
      ...base,
      slides: Array.from({ length: MAX_SLIDES }, () => makeBlankSlide()),
    };
    expect(() =>
      toolCallToOps(full, {
        id: 'c', name: 'add_slide',
        args: { kind: 'content', title: 'One more', brief: 'b' },
      })
    ).toThrow(`maximum (${MAX_SLIDES})`);
  });

  it('still allows a slide when there is room', () => {
    const deck = makeSampleDeck();
    expect(() =>
      toolCallToOps(deck, {
        id: 'c', name: 'add_slide',
        args: { kind: 'content', title: 'Fine', brief: 'b' },
      })
    ).not.toThrow();
  });
});

describe('toFriendlyError', () => {
  it('does not leak an unclassified error message', () => {
    const leaky = new Error('connect ECONN at https://internal.host/v1 key=sk_live_abc');
    const out = toFriendlyError(leaky);
    // Network-ish, so it is classified — but never echoes the raw string.
    expect(out.message).not.toContain('sk_live_abc');
    expect(out.message).not.toContain('internal.host');
  });

  it('hides a truly unknown error behind a generic message', () => {
    const out = toFriendlyError(new Error('Segfault in libfoo at 0xdeadbeef'));
    expect(out.message).toBe('Something went wrong on our side. Please try again.');
    expect(out.status).toBe(500);
  });

  it('maps rate limits to a retryable 429', () => {
    const out = toFriendlyError(new LLMError('too many requests', 429));
    expect(out.status).toBe(429);
    expect(out.retryable).toBe(true);
    expect(out.message).toMatch(/rate-limit/i);
  });

  it('maps a bad key to a non-retryable message naming the env var', () => {
    const out = toFriendlyError(new LLMError('unauthorized', 401));
    expect(out.retryable).toBe(false);
    expect(out.message).toMatch(/SARVAM_API_KEY/);
  });

  it('treats an abort as a cancellation, not a failure', () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    expect(toFriendlyError(abort).status).toBe(499);
  });

  it('maps a timeout to 504 with actionable advice', () => {
    const out = toFriendlyError(new Error('Deck generation timed out after 240s'));
    expect(out.status).toBe(504);
    expect(out.message).toMatch(/fewer slides|smaller/i);
  });
});

/**
 * DECK-SIZE bounds for the deck-only routes (/api/fill, /api/export/pptx).
 *
 * /api/fill previously validated the deck's SHAPE with Deck.safeParse and
 * nothing else. Shape is not size: a schema-valid 500-slide skeleton deck
 * (~100KB, trivially postable to an unauthenticated route) produced one
 * 8000-token content call PER PENDING SLIDE, with up to 3 retries each —
 * measured at up to 1500 provider calls and ~4M output tokens for a single
 * HTTP request. These are the caps that make that impossible.
 */
describe('validateDeckSize', () => {
  it('accepts a realistic deck', () => {
    expect(validateDeckSize({ slideCount: 10, deckBytes: 40_000 })).toBeNull();
  });

  it('rejects the fill-amplification deck', () => {
    const err = validateDeckSize({
      slideCount: 500,
      deckBytes: 101_839,
      maxSlides: MAX_FILL_SLIDES,
    });
    expect(err).toMatch(/500 slides/);
    expect(err).toMatch(new RegExp(String(MAX_FILL_SLIDES)));
  });

  it('caps fill more tightly than the general deck limit', () => {
    // Fill is the highest-amplification endpoint, so it gets the tighter cap.
    expect(MAX_FILL_SLIDES).toBeLessThan(MAX_SLIDES);
  });

  it('rejects an oversized payload even within the slide count', () => {
    expect(validateDeckSize({ slideCount: 5, deckBytes: MAX_DECK_BYTES + 1 })).toMatch(/limit/i);
  });

  it('defaults to the general slide cap when none is given', () => {
    expect(validateDeckSize({ slideCount: MAX_SLIDES + 1, deckBytes: 1_000 })).toMatch(/limit/i);
    expect(validateDeckSize({ slideCount: MAX_SLIDES, deckBytes: 1_000 })).toBeNull();
  });
});
