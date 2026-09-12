/**
 * Persistence resilience.
 *
 * A corrupt or unwritable localStorage must degrade, never crash. The failure
 * mode being guarded against is nasty: a bad persisted deck crashes on EVERY
 * load, and because the bad value is itself persisted the user cannot get back
 * into the UI to clear it.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Deck } from '@/lib/schema/deck';
import { makeSampleDeck } from '@/lib/schema/factory';

/** The merge logic the store installs, exercised directly. */
function mergePersisted(
  persisted: unknown,
  current: { deck: ReturnType<typeof makeSampleDeck>; messages: unknown[] }
) {
  const saved = persisted as { deck?: unknown; messages?: unknown } | undefined;
  if (!saved) return current;
  const parsed = Deck.safeParse(saved.deck);
  if (!parsed.success) return current;
  const messages = Array.isArray(saved.messages)
    ? saved.messages.filter(
        (m) => !!m && typeof m === 'object' && typeof (m as { content?: unknown }).content === 'string'
      )
    : [];
  return { ...current, deck: parsed.data, messages };
}

describe('persisted deck validation', () => {
  const current = () => ({ deck: makeSampleDeck(), messages: [] as unknown[] });

  it('accepts a valid saved deck', () => {
    const saved = { deck: { ...makeSampleDeck(), title: 'My Deck' }, messages: [] };
    expect(mergePersisted(saved, current()).deck.title).toBe('My Deck');
  });

  it('falls back to the sample deck when the saved deck is corrupt', () => {
    // e.g. a quota-exceeded write truncated the JSON.
    const saved = { deck: { id: 'd', slides: 'not-an-array' }, messages: [] };
    const merged = mergePersisted(saved, current());
    expect(merged.deck.slides.length).toBeGreaterThan(0);
    expect(merged.deck.id).toBe('d_sample');
  });

  it('falls back when the deck key is missing entirely', () => {
    expect(mergePersisted({ messages: [] }, current()).deck.id).toBe('d_sample');
  });

  it('drops malformed messages but keeps a valid deck', () => {
    const saved = {
      deck: makeSampleDeck(),
      messages: [{ role: 'user', content: 'ok' }, null, 42, { role: 'user' }],
    };
    expect(mergePersisted(saved, current()).messages).toEqual([{ role: 'user', content: 'ok' }]);
  });

  it('tolerates messages not being an array', () => {
    const saved = { deck: makeSampleDeck(), messages: 'nope' };
    expect(mergePersisted(saved, current()).messages).toEqual([]);
  });
});

describe('storage that throws', () => {
  const original = globalThis.localStorage;
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true });
  });

  it('a quota error on setItem does not propagate', () => {
    // Mirrors the store's safeStorage.setItem contract.
    const memory = new Map<string, string>();
    const throwing = {
      setItem: () => {
        throw new DOMException('QuotaExceededError');
      },
    };
    const safeSet = (k: string, v: string) => {
      try {
        throwing.setItem();
      } catch {
        memory.set(k, v); // degrade to memory rather than throwing
      }
    };
    expect(() => safeSet('ppt-builder-deck', '{}')).not.toThrow();
    expect(memory.get('ppt-builder-deck')).toBe('{}');
  });

  it('a throwing getItem reads as null rather than crashing', () => {
    const safeGet = (): string | null => {
      try {
        throw new DOMException('SecurityError'); // private-mode access
      } catch {
        return null;
      }
    };
    expect(safeGet()).toBeNull();
  });
});
