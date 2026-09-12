/**
 * Focus-slide resolution: the root cause of the "agent claimed it edited but
 * nothing changed" bug.
 *
 * The compact deck outline sent to the model carries only block SHAPES
 * (b_x:bullets(4)), never text. If a request names a slide and we fail to
 * include that slide's content, the model is being asked to edit text it cannot
 * see — and it invents replacements. These tests pin the resolution rules.
 */
import { describe, expect, it } from 'vitest';
import { resolveFocusSlides } from '@/app/api/chat/route';
import { makeSampleDeck } from '@/lib/schema/factory';
import { editSystemPrompt } from '@/lib/agent/prompts';

const deck = makeSampleDeck();

describe('resolveFocusSlides', () => {
  it('resolves an explicit slide number', () => {
    const f = resolveFocusSlides(deck, 'in slide 4, remove the launch date bullet point', null);
    expect(f).toHaveLength(1);
    expect(f[0].id).toBe(deck.slides[3].id);
  });

  it('resolves several numbers in one message', () => {
    const f = resolveFocusSlides(deck, 'make slides 2 and 3 more concise', null);
    expect(f.map((s) => s.id)).toEqual([deck.slides[1].id, deck.slides[2].id]);
  });

  it('expands a range like "slides 2-4"', () => {
    const f = resolveFocusSlides(deck, 'tighten slides 2-4', null);
    expect(f.map((s) => s.id)).toEqual([
      deck.slides[1].id, deck.slides[2].id, deck.slides[3].id,
    ]);
  });

  it('resolves "the last slide" and "the first slide"', () => {
    expect(resolveFocusSlides(deck, 'tighten the last slide', null)[0].id)
      .toBe(deck.slides.at(-1)!.id);
    expect(resolveFocusSlides(deck, 'retitle the first slide', null)[0].id)
      .toBe(deck.slides[0].id);
  });

  it('falls back to the selected slide for "this slide"', () => {
    const selected = deck.slides[2].id;
    const f = resolveFocusSlides(deck, 'make this slide punchier', selected);
    expect(f[0].id).toBe(selected);
  });

  it('ignores out-of-range numbers rather than throwing', () => {
    expect(resolveFocusSlides(deck, 'edit slide 99', null)).toEqual([]);
  });

  it('returns nothing for a structural request that needs no existing text', () => {
    expect(resolveFocusSlides(deck, 'add a slide about pricing', null)).toEqual([]);
  });

  it('finds the slide by CONTENT when no slide is named or selected', () => {
    // Observed live: "in this slide, remove annual cost" with nothing selected
    // resolved to no focus, so the model saw only block shapes, could not find
    // the row, and claimed success without calling a tool.
    const table = deck.slides.find((s) => s.blocks.some((b) => b.type === 'table'))!;
    const f = resolveFocusSlides(deck, 'in this slide, remove annual cost', null);
    expect(f.map((s) => s.id)).toContain(table.id);
  });

  it('finds a chart slide from a category name', () => {
    const chart = deck.slides.find((s) => s.blocks.some((b) => b.type === 'chart'))!;
    const f = resolveFocusSlides(deck, 'in this slide, remove q3e', null);
    expect(f.map((s) => s.id)).toContain(chart.id);
  });

  it('prefers an explicit slide number over the content search', () => {
    // A number is unambiguous; content matching must not override it.
    const f = resolveFocusSlides(deck, 'in slide 1, remove annual cost', null);
    expect(f).toHaveLength(1);
    expect(f[0].id).toBe(deck.slides[0].id);
  });

  it('does not match on filler words alone', () => {
    expect(resolveFocusSlides(deck, 'please make this better', null)).toEqual([]);
  });

  it('caps how many slides it will inline, to bound the prompt', () => {
    const f = resolveFocusSlides(deck, 'update slides 1 and 2 and 3 and 4 and 5', null);
    expect(f.length).toBeLessThanOrEqual(3);
  });
});

describe('editSystemPrompt', () => {
  it('includes the referenced slide BULLET TEXT, not just the block shape', () => {
    // This is the assertion that would have caught the original bug.
    const target = deck.slides[1];
    const bullets = target.blocks.find((b) => b.type === 'bullets');
    if (bullets?.type !== 'bullets') throw new Error('fixture needs a bullets block');

    const withFocus = editSystemPrompt(deck, [target]);
    for (const item of bullets.items) {
      expect(withFocus).toContain(item);
    }

    // Without focus the text is absent — which is exactly why the model guessed.
    const withoutFocus = editSystemPrompt(deck, []);
    expect(withoutFocus).not.toContain(bullets.items[0]);
  });

  it('labels the focus slide with its position so "slide 4" lines up', () => {
    const p = editSystemPrompt(deck, [deck.slides[3]]);
    expect(p).toContain('(slide #4)');
  });
});
