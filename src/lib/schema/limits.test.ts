/**
 * Schema SIZE guardrails, as opposed to the shape guardrails in deck.ts.
 *
 * Every "rejects" case here was verified ACCEPTED before the string caps were
 * added: the array caps bounded how MANY blocks/bullets a deck had, but no
 * field had a length limit, so one 900KB paragraph sailed through.
 */
import { describe, expect, it } from 'vitest';
import { Deck, Slide, ParagraphBlock, ImageBlock } from './deck';

const slide = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  kind: 'content',
  title: 'Title',
  blocks: [],
  ...over,
});

describe('string length caps', () => {
  it('rejects a megabyte paragraph on a single slide', () => {
    const r = ParagraphBlock.safeParse({
      id: 'b1',
      type: 'paragraph',
      text: 'A'.repeat(900_000),
    });
    expect(r.success).toBe(false);
  });

  it('rejects an oversized deck title even with zero slides', () => {
    // The route's byte cap did not catch this: 500KB of title, no slides.
    const r = Deck.safeParse({ id: 'd', title: 'B'.repeat(500_000), slides: [] });
    expect(r.success).toBe(false);
  });

  it('rejects an oversized slide title and speaker notes', () => {
    expect(Slide.safeParse(slide({ title: 'x'.repeat(5_000) })).success).toBe(false);
    expect(Slide.safeParse(slide({ speakerNotes: 'x'.repeat(50_000) })).success).toBe(false);
  });

  it('accepts realistic content comfortably', () => {
    expect(
      Slide.safeParse(
        slide({
          title: 'Revenue grew 40% on enterprise expansion',
          subtitle: 'Q3 FY25 results, presented to the board',
          speakerNotes: 'Walk through the segment split. '.repeat(60),
          blocks: [
            { id: 'b1', type: 'paragraph', text: 'Lorem ipsum dolor sit amet. '.repeat(50) },
            { id: 'b2', type: 'bullets', items: ['Enterprise up 40%', 'SMB flat', 'Churn down 2pts'] },
          ],
        })
      ).success
    ).toBe(true);
  });
});

describe('collection caps', () => {
  it('rejects thousands of blocks on one slide', () => {
    const blocks = Array.from({ length: 5_000 }, (_, i) => ({
      id: `b${i}`,
      type: 'paragraph',
      text: 'x',
    }));
    expect(Slide.safeParse(slide({ blocks })).success).toBe(false);
  });

  it('rejects a deck with more slides than the hard cap', () => {
    const slides = Array.from({ length: 500 }, (_, i) => slide({ id: `s${i}` }));
    expect(Deck.safeParse({ id: 'd', title: 't', slides }).success).toBe(false);
  });

  it('bounds chart series data and categories', () => {
    const bigChart = {
      id: 'b1',
      type: 'chart',
      chartType: 'bar',
      series: [{ name: 's', data: Array.from({ length: 10_000 }, () => 1) }],
      categories: ['a'],
    };
    expect(Slide.safeParse(slide({ blocks: [bigChart] })).success).toBe(false);
  });

  it('rejects non-finite chart numbers', () => {
    // NaN/Infinity render as blank axes and crash some export paths.
    const r = Slide.safeParse(
      slide({
        blocks: [
          {
            id: 'b1',
            type: 'chart',
            chartType: 'bar',
            series: [{ name: 's', data: [1, Number.POSITIVE_INFINITY] }],
            categories: ['a', 'b'],
          },
        ],
      })
    );
    expect(r.success).toBe(false);
  });
});

describe('image url scheme', () => {
  it('rejects javascript: urls', () => {
    const r = ImageBlock.safeParse({
      id: 'b1',
      type: 'image',
      query: 'q',
      alt: 'a',
      url: 'javascript:alert(1)',
    });
    expect(r.success).toBe(false);
  });

  it('accepts a normal https image url', () => {
    const r = ImageBlock.safeParse({
      id: 'b1',
      type: 'image',
      query: 'q',
      alt: 'a',
      url: 'https://images.unsplash.com/photo-1',
    });
    expect(r.success).toBe(true);
  });
});
