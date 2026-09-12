/**
 * Reducer tests. The critical property is that every op's INVERSE restores the
 * exact prior deck — that is what makes unified undo/redo trustworthy across
 * interleaved AI and manual changes.
 */
import { describe, expect, it } from 'vitest';
import { applyOp, applyOps, OpError, type DeckOp } from './ops';
import { makeSampleDeck, makeBlankSlide, newBlockId } from '@/lib/schema/factory';
import type { Block, Deck } from '@/lib/schema/deck';

const bullets = (items: string[]): Block => ({
  id: newBlockId(), slot: 'main', type: 'bullets', items, ordered: false,
});

/** Round-trip helper: apply, then apply the inverse, expect the original back. */
function expectInvertible(deck: Deck, op: DeckOp) {
  const { deck: after, inverse } = applyOp(deck, op);
  const { deck: restored } = applyOp(after, inverse);
  // rev advances monotonically by design, so compare everything else.
  expect({ ...restored, rev: 0 }).toEqual({ ...deck, rev: 0 });
}

describe('applyOp inverses', () => {
  it('inverts add_slide', () => {
    const deck = makeSampleDeck();
    expectInvertible(deck, { t: 'add_slide', slide: makeBlankSlide(), afterId: deck.slides[1].id });
  });

  it('inverts delete_slide, restoring position', () => {
    const deck = makeSampleDeck();
    const victim = deck.slides[2];
    expectInvertible(deck, { t: 'delete_slide', id: victim.id });
    // Position specifically, not just membership.
    const { deck: after, inverse } = applyOp(deck, { t: 'delete_slide', id: victim.id });
    const { deck: restored } = applyOp(after, inverse);
    expect(restored.slides[2].id).toBe(victim.id);
  });

  it('inverts deleting the FIRST slide back to index 0', () => {
    const deck = makeSampleDeck();
    const first = deck.slides[0];
    const { deck: after, inverse } = applyOp(deck, { t: 'delete_slide', id: first.id });
    const { deck: restored } = applyOp(after, inverse);
    expect(restored.slides[0].id).toBe(first.id);
  });

  it('inverts update_slide with only the changed keys', () => {
    const deck = makeSampleDeck();
    const id = deck.slides[1].id;
    const { inverse } = applyOp(deck, {
      t: 'update_slide', id, fields: { title: 'New title' },
    });
    expect(inverse).toEqual({ t: 'update_slide', id, fields: { title: deck.slides[1].title } });
    expectInvertible(deck, { t: 'update_slide', id, fields: { title: 'New title' } });
  });

  it('inverts patch_block', () => {
    const deck = makeSampleDeck();
    const slide = deck.slides[1];
    const block = slide.blocks[0];
    expectInvertible(deck, {
      t: 'patch_block', slideId: slide.id, blockId: block.id, patch: { items: ['only one'] },
    });
  });

  it('inverts set_blocks per slot, leaving the other slot untouched', () => {
    let deck = makeSampleDeck();
    const slideId = deck.slides[1].id;
    const aside = { ...bullets(['aside item']), slot: 'aside' as const };
    deck = applyOp(deck, { t: 'set_blocks', id: slideId, slot: 'aside', blocks: [aside] }).deck;

    const { deck: after } = applyOp(deck, {
      t: 'set_blocks', id: slideId, slot: 'main', blocks: [bullets(['replaced'])],
    });
    const slide = after.slides.find((s) => s.id === slideId)!;
    // The aside survived a main-slot replacement.
    expect(slide.blocks.filter((b) => b.slot === 'aside')).toHaveLength(1);
    expectInvertible(deck, { t: 'set_blocks', id: slideId, slot: 'main', blocks: [bullets(['x'])] });
  });

  it('inverts reorder', () => {
    const deck = makeSampleDeck();
    const ids = deck.slides.map((s) => s.id);
    expectInvertible(deck, { t: 'reorder', ids: [...ids].reverse() });
  });

  it('inverts set_layout and set_theme', () => {
    const deck = makeSampleDeck();
    expectInvertible(deck, { t: 'set_layout', id: deck.slides[1].id, layout: { variant: 'two-col' } });
    expectInvertible(deck, { t: 'set_theme', theme: 'paper' });
  });
});

describe('validation', () => {
  it('rejects an unknown slide id with a message naming valid ids', () => {
    const deck = makeSampleDeck();
    expect(() => applyOp(deck, { t: 'update_slide', id: 'nope', fields: { title: 'x' } }))
      .toThrow(OpError);
    try {
      applyOp(deck, { t: 'update_slide', id: 'nope', fields: { title: 'x' } });
    } catch (e) {
      // The message must be actionable, since it is fed back to the model.
      expect((e as Error).message).toContain('nope');
    }
  });

  it('rejects a reorder that is not a permutation', () => {
    const deck = makeSampleDeck();
    const ids = deck.slides.map((s) => s.id);
    expect(() => applyOp(deck, { t: 'reorder', ids: ids.slice(1) })).toThrow(/permutation/);
    expect(() => applyOp(deck, { t: 'reorder', ids: [...ids.slice(1), ids[1]] })).toThrow(/permutation/);
  });

  it('refuses to patch a block that does not exist', () => {
    const deck = makeSampleDeck();
    expect(() =>
      applyOp(deck, { t: 'patch_block', slideId: deck.slides[1].id, blockId: 'b_missing', patch: { text: 'x' } })
    ).toThrow(/b_missing/);
  });

  it('never lets a patch change a block type (would break the union)', () => {
    const deck = makeSampleDeck();
    const slide = deck.slides[1];
    const { deck: after } = applyOp(deck, {
      t: 'patch_block', slideId: slide.id, blockId: slide.blocks[0].id,
      patch: { type: 'chart', items: ['still bullets'] },
    });
    expect(after.slides.find((s) => s.id === slide.id)!.blocks[0].type).toBe('bullets');
  });
});

describe('applyOps batching', () => {
  it('collects inverses in reverse order so undo replays correctly', () => {
    const deck = makeSampleDeck();
    const a = makeBlankSlide();
    const b = makeBlankSlide();
    const { deck: after, inverses } = applyOps(deck, [
      { t: 'add_slide', slide: a, afterId: null },
      { t: 'add_slide', slide: b, afterId: a.id },
    ]);
    expect(after.slides).toHaveLength(deck.slides.length + 2);
    const { deck: restored } = applyOps(after, inverses);
    expect(restored.slides.map((s) => s.id)).toEqual(deck.slides.map((s) => s.id));
  });
});
