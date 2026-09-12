/**
 * Translation-layer tests: the trust boundary between model output and state.
 *
 * These cover what models ACTUALLY get wrong (invented ids, ragged tables,
 * metrics as bare strings, chart series length mismatches), because that is
 * where a schema either absorbs reality or falls over.
 */
import { describe, expect, it } from 'vitest';
import { toolCallToOps, ToolCallError } from './translate';
import { makeSampleDeck } from '@/lib/schema/factory';
import { applyOp } from '@/lib/state/ops';
import type { ToolCall } from '@/lib/llm/types';

const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  id: 'c1', name, args,
});

describe('add_slide', () => {
  it('mints its own slide id and starts as an outline skeleton', () => {
    const deck = makeSampleDeck();
    const ops = toolCallToOps(
      deck,
      call('add_slide', { kind: 'content', title: 'Pricing', brief: 'Show the three tiers' })
    );
    expect(ops).toHaveLength(1);
    const op = ops[0];
    if (op.t !== 'add_slide') throw new Error('expected add_slide');
    expect(op.slide.id).toMatch(/^s_/);
    expect(op.slide.status).toBe('outline');
    expect(op.slide.brief).toBe('Show the three tiers');
    expect(op.slide.blocks).toEqual([]); // shape only — phase 2 fills content
  });

  it('treats explicit null after_slide_id as prepend', () => {
    const deck = makeSampleDeck();
    const ops = toolCallToOps(
      deck,
      call('add_slide', { kind: 'content', title: 'X', brief: 'y', after_slide_id: null })
    );
    expect(ops[0]).toMatchObject({ afterId: null });
  });

  it('appends when after_slide_id is omitted', () => {
    const deck = makeSampleDeck();
    const ops = toolCallToOps(deck, call('add_slide', { kind: 'content', title: 'X', brief: 'y' }));
    expect(ops[0]).toMatchObject({ afterId: deck.slides.at(-1)!.id });
  });

  it('rejects an invented after_slide_id with the valid ids listed', () => {
    const deck = makeSampleDeck();
    expect(() =>
      toolCallToOps(deck, call('add_slide', { kind: 'content', title: 'X', brief: 'y', after_slide_id: 'slide_3' }))
    ).toThrow(/slide_3/);
  });
});

describe('set_blocks normalization', () => {
  it('mints block ids and flips the slide to ready', () => {
    const deck = makeSampleDeck();
    const id = deck.slides[1].id;
    const ops = toolCallToOps(
      deck,
      call('set_blocks', { slide_id: id, blocks: [{ type: 'bullets', items: ['a', 'b'] }] })
    );
    expect(ops).toHaveLength(2);
    if (ops[0].t !== 'set_blocks') throw new Error();
    expect(ops[0].blocks[0].id).toMatch(/^b_/);
    expect(ops[1]).toMatchObject({ t: 'update_slide', fields: { status: 'ready' } });
  });

  it('caps bullets at 8 so a verbose model cannot blow the layout', () => {
    const deck = makeSampleDeck();
    const items = Array.from({ length: 15 }, (_, i) => `item ${i}`);
    const ops = toolCallToOps(
      deck,
      call('set_blocks', { slide_id: deck.slides[1].id, blocks: [{ type: 'bullets', items }] })
    );
    if (ops[0].t !== 'set_blocks') throw new Error();
    const b = ops[0].blocks[0];
    expect(b.type === 'bullets' && b.items).toHaveLength(8);
  });

  it('coerces metrics given as bare strings into {value,label}', () => {
    const deck = makeSampleDeck();
    const ops = toolCallToOps(
      deck,
      call('set_blocks', {
        slide_id: deck.slides[1].id,
        blocks: [{ type: 'metrics', items: ['42% growth', '1.2M users'] }],
      })
    );
    if (ops[0].t !== 'set_blocks') throw new Error();
    const b = ops[0].blocks[0];
    expect(b.type === 'metrics' && b.items[0]).toEqual({ value: '42%', label: 'growth' });
    expect(b.type === 'metrics' && b.items[1]).toEqual({ value: '1.2M', label: 'users' });
  });

  it('does NOT split prose into a fake metric value', () => {
    // Observed live via the tool-detail view: a patch sent bullet-style prose
    // to a metrics block and the old rule split on the first space, producing
    // value="Congestion" / label="costs U.S. cities $140B annually".
    const deck = makeSampleDeck();
    const ops = toolCallToOps(
      deck,
      call('set_blocks', {
        slide_id: deck.slides[1].id,
        blocks: [{
          type: 'metrics',
          items: ['Congestion costs U.S. cities $140B annually', 'Lost productivity and fuel waste'],
        }],
      })
    );
    if (ops[0].t !== 'set_blocks') throw new Error();
    const b = ops[0].blocks[0];
    if (b.type !== 'metrics') throw new Error();

    // The figure is surfaced as the value, never the first word.
    expect(b.items[0].value).not.toBe('Congestion');
    expect(b.items[0].value).toBe('$140B');
    // Prose with no figure keeps its text intact instead of inventing a value.
    expect(b.items[1].value).toBe('');
    expect(b.items[1].label).toBe('Lost productivity and fuel waste');
  });

  it('promotes a header row when the model omits `columns` entirely', () => {
    // Observed live: sarvam-105b emits tables with rows only, header inside
    // rows[0], and no columns array. Rejecting that cost us whole slides.
    const deck = makeSampleDeck();
    const ops = toolCallToOps(
      deck,
      call('set_blocks', {
        slide_id: deck.slides[1].id,
        blocks: [{
          type: 'table',
          rows: [
            ['', 'Battery Swapping', 'Fast Charging'],
            ['Time to refuel', '~2 minutes', '30-60 minutes'],
            ['Cost per station', 'Rs 5-10 lakh', 'Rs 50-100 lakh'],
          ],
        }],
      })
    );
    if (ops[0].t !== 'set_blocks') throw new Error();
    const b = ops[0].blocks[0];
    if (b.type !== 'table') throw new Error('expected a table');
    expect(b.columns).toEqual(['', 'Battery Swapping', 'Fast Charging']);
    expect(b.rows).toHaveLength(2);
    expect(b.rows[0]).toEqual(['Time to refuel', '~2 minutes', '30-60 minutes']);
  });

  it('drops an empty heading instead of failing the whole slide', () => {
    // A decorative block with no text should not cost us the good blocks
    // sitting next to it.
    const deck = makeSampleDeck();
    const ops = toolCallToOps(
      deck,
      call('set_blocks', {
        slide_id: deck.slides[1].id,
        blocks: [
          { type: 'heading', text: '   ' },
          { type: 'bullets', items: ['this must survive'] },
        ],
      })
    );
    if (ops[0].t !== 'set_blocks') throw new Error();
    expect(ops[0].blocks).toHaveLength(1);
    expect(ops[0].blocks[0].type).toBe('bullets');
  });

  it('accepts an empty blocks array for a title slide and marks it ready', () => {
    // A title slide's headline IS its content. Treating an empty array as an
    // error left such slides stuck as skeletons forever.
    const deck = makeSampleDeck();
    const titleSlide = deck.slides.find((s) => s.kind === 'title')!;
    const ops = toolCallToOps(
      deck,
      call('set_blocks', { slide_id: titleSlide.id, blocks: [] })
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ t: 'update_slide', fields: { status: 'ready' } });
  });

  it('still rejects an empty blocks array for a content slide', () => {
    const deck = makeSampleDeck();
    const contentSlide = deck.slides.find((s) => s.kind === 'content')!;
    expect(() =>
      toolCallToOps(deck, call('set_blocks', { slide_id: contentSlide.id, blocks: [] }))
    ).toThrow(/empty/);
  });

  it('fails only when NO block survives validation', () => {
    const deck = makeSampleDeck();
    expect(() =>
      toolCallToOps(deck, call('set_blocks', {
        slide_id: deck.slides[1].id,
        blocks: [{ type: 'heading', text: '' }, { type: 'paragraph', text: '  ' }],
      }))
    ).toThrow(/no usable blocks/);
  });

  it('pads ragged table rows to the column count', () => {
    const deck = makeSampleDeck();
    const ops = toolCallToOps(
      deck,
      call('set_blocks', {
        slide_id: deck.slides[1].id,
        blocks: [{ type: 'table', columns: ['A', 'B', 'C'], rows: [['1'], ['1', '2', '3', '4']] }],
      })
    );
    if (ops[0].t !== 'set_blocks') throw new Error();
    const b = ops[0].blocks[0];
    if (b.type !== 'table') throw new Error();
    expect(b.rows[0]).toEqual(['1', '', '']);
    expect(b.rows[1]).toHaveLength(3);
  });

  it('aligns chart series length to categories', () => {
    const deck = makeSampleDeck();
    const ops = toolCallToOps(
      deck,
      call('set_blocks', {
        slide_id: deck.slides[1].id,
        blocks: [{
          type: 'chart', chartType: 'line',
          categories: ['Q1', 'Q2', 'Q3'],
          series: [{ name: 'Rev', data: [1] }],
        }],
      })
    );
    if (ops[0].t !== 'set_blocks') throw new Error();
    const b = ops[0].blocks[0];
    expect(b.type === 'chart' && b.series[0].data).toEqual([1, 0, 0]);
  });

  it('resolves an image query to a url and never trusts a model url', () => {
    const deck = makeSampleDeck();
    const ops = toolCallToOps(
      deck,
      call('set_blocks', {
        slide_id: deck.slides[1].id,
        blocks: [{ type: 'image', query: 'solar panels', alt: 'panels', url: 'http://evil.example/x.png' }],
      })
    );
    if (ops[0].t !== 'set_blocks') throw new Error();
    const b = ops[0].blocks[0];
    if (b.type !== 'image') throw new Error();
    expect(b.url).toContain('unsplash');
    expect(b.url).not.toContain('evil.example');
  });

  it('rejects an unknown block type by name', () => {
    const deck = makeSampleDeck();
    expect(() =>
      toolCallToOps(deck, call('set_blocks', { slide_id: deck.slides[1].id, blocks: [{ type: 'carousel' }] }))
    ).toThrow(/carousel/);
  });
});

describe('patch_block — the diff-based edit path', () => {
  it('produces exactly one op touching one block', () => {
    const deck = makeSampleDeck();
    const slide = deck.slides[1];
    const ops = toolCallToOps(
      deck,
      call('patch_block', {
        slide_id: slide.id,
        block_id: slide.blocks[0].id,
        patch: { items: ['tighter first point'] },
      })
    );
    expect(ops).toHaveLength(1);
    expect(ops[0].t).toBe('patch_block');

    // Crucially: applying it leaves every OTHER slide byte-identical.
    const after = applyOp(deck, ops[0]).deck;
    for (let i = 0; i < deck.slides.length; i++) {
      if (i === 1) continue;
      expect(after.slides[i]).toBe(deck.slides[i]); // reference equality
    }
  });

  it('coerces a patch the same way set_blocks would', () => {
    // Observed live: the model patched a metrics block with bare strings.
    // Validating the raw merge rejected a shape normalizeBlock already fixes,
    // costing a round-trip. patch_block now shares that normalization.
    const base = makeSampleDeck();
    const metricsSlide = base.slides.find((s) =>
      s.blocks.some((b) => b.type === 'metrics')
    )!;
    const metricsBlock = metricsSlide.blocks.find((b) => b.type === 'metrics')!;

    const ops = toolCallToOps(
      base,
      call('patch_block', {
        slide_id: metricsSlide.id,
        block_id: metricsBlock.id,
        patch: { items: ['45% YoY growth', '1.5M units sold'] },
      })
    );
    expect(ops).toHaveLength(1);
    if (ops[0].t !== 'patch_block') throw new Error();
    // The strings were coerced into {value,label} objects, not rejected.
    expect(ops[0].patch.items).toEqual([
      { value: '45%', label: 'YoY growth' },
      { value: '1.5M', label: 'units sold' },
    ]);
  });

  it('rejects a wholesale rewrite disguised as a small edit', () => {
    // Observed live: "in slide 4, remove the launch date bullet point" returned
    // 4 entirely NEW bullets (destroying the user's CRM/Marketo text) while the
    // reply claimed one bullet had been removed. Same length + nothing in
    // common means the model regenerated instead of editing.
    const deck = makeSampleDeck();
    const slide = deck.slides.find((s) => s.blocks.some((b) => b.type === 'bullets'))!;
    const block = slide.blocks.find((b) => b.type === 'bullets')!;
    if (block.type !== 'bullets') throw new Error();
    expect(block.items.length).toBeGreaterThanOrEqual(3);

    try {
      toolCallToOps(deck, call('patch_block', {
        slide_id: slide.id,
        block_id: block.id,
        patch: {
          items: block.items.map((_, i) => `Completely invented bullet ${i + 1}`),
        },
      }));
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('rewrite');
      // The message must tell the model how to comply.
      expect(msg).toContain('KEEPING');
      expect(msg).toContain(String(block.items.length - 1));
    }
  });

  it('allows a genuine deletion that keeps the remaining items verbatim', () => {
    const deck = makeSampleDeck();
    const slide = deck.slides.find((s) => s.blocks.some((b) => b.type === 'bullets'))!;
    const block = slide.blocks.find((b) => b.type === 'bullets')!;
    if (block.type !== 'bullets') throw new Error();

    // Drop the first item, keep the rest exactly.
    const ops = toolCallToOps(deck, call('patch_block', {
      slide_id: slide.id, block_id: block.id, patch: { items: block.items.slice(1) },
    }));
    expect(ops).toHaveLength(1);
    if (ops[0].t !== 'patch_block') throw new Error();
    expect(ops[0].patch.items).toEqual(block.items.slice(1));
  });

  it('allows a legitimate full rewrite when the user asks for one', () => {
    // A rewrite that CHANGES the length is not the failure pattern — e.g.
    // "condense these 4 bullets into 2" must still work.
    const deck = makeSampleDeck();
    const slide = deck.slides.find((s) => s.blocks.some((b) => b.type === 'bullets'))!;
    const block = slide.blocks.find((b) => b.type === 'bullets')!;

    const ops = toolCallToOps(deck, call('patch_block', {
      slide_id: slide.id, block_id: block.id,
      patch: { items: ['Condensed point one', 'Condensed point two'] },
    }));
    expect(ops).toHaveLength(1);
  });

  it('rejects a patch naming a field the block type does not have', () => {
    // Observed live: the model patched a TABLE with {items:[...]}, which
    // silently no-opped while it reported "shortened the table to three rows".
    // A wrong-field patch must fail so the agent loop can correct itself.
    const deck = makeSampleDeck();
    const tableSlide = deck.slides.find((s) => s.blocks.some((b) => b.type === 'table'))!;
    const tableBlock = tableSlide.blocks.find((b) => b.type === 'table')!;
    try {
      toolCallToOps(deck, call('patch_block', {
        slide_id: tableSlide.id,
        block_id: tableBlock.id,
        patch: { items: ['a', 'b', 'c'] },
      }));
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('table');
      // The message must name the real fields so the model can retry correctly.
      expect(msg).toContain('rows');
      expect(msg).toContain('columns');
    }
  });

  it('realigns chart series when a category is removed', () => {
    // Observed live: "remove q4e" patched only `categories`, leaving each
    // series with 4 data points against 3 categories — an inconsistent chart.
    // The patch must carry the dependent `series` fix normalization applies.
    const deck = makeSampleDeck();
    const slide = deck.slides.find((s) => s.blocks.some((b) => b.type === 'chart'))!;
    const chart = slide.blocks.find((b) => b.type === 'chart')!;
    if (chart.type !== 'chart') throw new Error();
    expect(chart.categories).toHaveLength(4);

    const ops = toolCallToOps(deck, call('patch_block', {
      slide_id: slide.id, block_id: chart.id,
      patch: { categories: chart.categories.slice(0, 3) },
    }));

    if (ops[0].t !== 'patch_block') throw new Error();
    // `series` is included even though the model never sent it.
    expect(Object.keys(ops[0].patch)).toContain('series');

    const after = applyOp(deck, ops[0]).deck;
    const patched = after.slides.find((s) => s.id === slide.id)!.blocks[0];
    if (patched.type !== 'chart') throw new Error();
    expect(patched.categories).toHaveLength(3);
    for (const se of patched.series) {
      expect(se.data).toHaveLength(3);
    }
  });

  it('refuses a patch that would make the block invalid', () => {
    const deck = makeSampleDeck();
    const slide = deck.slides[1];
    expect(() =>
      toolCallToOps(deck, call('patch_block', {
        slide_id: slide.id, block_id: slide.blocks[0].id, patch: { items: 'not an array' },
      }))
    ).toThrow(ToolCallError);
  });

  it('lists the slide real block ids when the model invents one', () => {
    const deck = makeSampleDeck();
    const slide = deck.slides[1];
    try {
      toolCallToOps(deck, call('patch_block', { slide_id: slide.id, block_id: 'b_nope', patch: { text: 'x' } }));
      throw new Error('should have thrown');
    } catch (e) {
      // The model needs the real ids to self-correct on the next turn.
      expect((e as Error).message).toContain(slide.blocks[0].id);
    }
  });
});

describe('reorder_slides', () => {
  it('accepts a full permutation', () => {
    const deck = makeSampleDeck();
    const ids = deck.slides.map((s) => s.id);
    const ops = toolCallToOps(deck, call('reorder_slides', { slide_ids: [...ids].reverse() }));
    expect(ops[0]).toMatchObject({ t: 'reorder' });
  });

  it('rejects a partial list, naming the expected ids', () => {
    const deck = makeSampleDeck();
    const ids = deck.slides.map((s) => s.id);
    expect(() => toolCallToOps(deck, call('reorder_slides', { slide_ids: ids.slice(0, 2) })))
      .toThrow(/permutation/);
  });
});

describe('unknown tools', () => {
  it('fails loudly rather than silently ignoring', () => {
    const deck = makeSampleDeck();
    expect(() => toolCallToOps(deck, call('regenerate_deck', {}))).toThrow(/regenerate_deck/);
  });
});
