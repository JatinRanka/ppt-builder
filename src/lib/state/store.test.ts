/**
 * Store tests for chat-transcript lifecycle.
 *
 * The transcript lives in the store (not in ChatPanel) specifically so that
 * "New deck" can clear it. These tests pin that coupling, because the failure
 * mode is subtle: a stale transcript makes the AI reason about slide ids that
 * no longer exist.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useDeckStore } from './store';
import { makeEmptyDeck, makeSampleDeck, makeBlankSlide } from '@/lib/schema/factory';

describe('chat transcript', () => {
  beforeEach(() => {
    useDeckStore.setState({ deck: makeSampleDeck(), messages: [], past: [], future: [] });
  });

  it('clearChat empties the transcript but KEEPS the deck', () => {
    const store = useDeckStore.getState();
    store.setMessages([
      { role: 'user', content: 'make a deck' },
      { role: 'assistant', content: 'done' },
    ]);
    expect(useDeckStore.getState().messages).toHaveLength(2);

    const slidesBefore = useDeckStore.getState().deck.slides.length;
    useDeckStore.getState().clearChat();

    expect(useDeckStore.getState().messages).toEqual([]);
    // Clearing the conversation must not destroy the user's work.
    expect(useDeckStore.getState().deck.slides).toHaveLength(slidesBefore);
  });

  it('replaceDeck (the "New" button) clears the transcript too', () => {
    useDeckStore.getState().setMessages([{ role: 'user', content: 'about the old deck' }]);
    useDeckStore.getState().replaceDeck(makeEmptyDeck());

    expect(useDeckStore.getState().messages).toEqual([]);
    expect(useDeckStore.getState().deck.slides).toEqual([]);
  });

  it('replaceDeck also resets undo history, so undo cannot resurrect old slides', () => {
    useDeckStore.getState().dispatch({ t: 'add_slide', slide: makeBlankSlide(), afterId: null });
    expect(useDeckStore.getState().past.length).toBeGreaterThan(0);

    useDeckStore.getState().replaceDeck(makeEmptyDeck());
    expect(useDeckStore.getState().past).toEqual([]);
    expect(useDeckStore.getState().future).toEqual([]);
  });

  it('setMessages accepts an updater function, like the old useState API', () => {
    useDeckStore.getState().setMessages([{ role: 'user', content: 'one' }]);
    useDeckStore.getState().setMessages((prev) => [...prev, { role: 'assistant', content: 'two' }]);
    expect(useDeckStore.getState().messages.map((m) => m.content)).toEqual(['one', 'two']);
  });
});
