/**
 * THE SINGLE MUTATION PATH.
 *
 * Core insight: manual edits and AI edits are the same thing. Both compile to a
 * DeckOp and flow through applyOp(). There is no second code path, so they
 * cannot diverge — this is the structural answer to the requirement that
 * "manual edits and AI-driven edits must coexist without one destroying the
 * other."
 *
 * applyOp returns its own INVERSE. That is the entire undo/redo system, written
 * while writing the reducer rather than retrofitted later (retrofitting an
 * inverse for a destructive op like delete_slide after the fact is painful —
 * you need the deleted data, which is already gone).
 *
 * Every op is a DIFF. There is deliberately no `replace_deck` op: full
 * regeneration is not expressible in this vocabulary, so it cannot happen by
 * accident.
 */
import type { Block, Deck, LayoutHint, Slide, Slot, ThemeName } from '@/lib/schema/deck';

export type DeckOp =
  | { t: 'add_slide'; slide: Slide; afterId: string | null }
  | { t: 'update_slide'; id: string; fields: Partial<Omit<Slide, 'id' | 'blocks'>> }
  | { t: 'set_blocks'; id: string; slot: Slot; blocks: Block[] }
  | { t: 'patch_block'; slideId: string; blockId: string; patch: Record<string, unknown> }
  | { t: 'add_block'; slideId: string; block: Block; index?: number }
  | { t: 'delete_block'; slideId: string; blockId: string }
  | { t: 'delete_slide'; id: string }
  | { t: 'reorder'; ids: string[] }
  | { t: 'set_layout'; id: string; layout: Partial<LayoutHint> }
  | { t: 'set_theme'; theme: ThemeName }
  | { t: 'set_deck_title'; title: string };

export class OpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpError';
  }
}

export interface ApplyResult {
  deck: Deck;
  /** The op that undoes this one. Push onto the history stack. */
  inverse: DeckOp;
}

function findSlide(deck: Deck, id: string): { slide: Slide; index: number } {
  const index = deck.slides.findIndex((s) => s.id === id);
  if (index === -1) throw new OpError(`no slide with id "${id}"`);
  return { slide: deck.slides[index], index };
}

/**
 * Apply one op immutably, returning the new deck and the inverse op.
 *
 * Throws OpError for references to things that do not exist. Callers in the
 * agent loop turn that message into a tool result so the model can self-correct
 * — an invented slide id becomes a recoverable conversation turn, not a crash.
 */
export function applyOp(deck: Deck, op: DeckOp): ApplyResult {
  switch (op.t) {
    case 'add_slide': {
      const slides = [...deck.slides];
      // afterId null => prepend; unknown id => append (tolerant: the model
      // often references the "end" loosely, and appending is the safe read).
      const at =
        op.afterId === null
          ? 0
          : (() => {
              const i = slides.findIndex((s) => s.id === op.afterId);
              return i === -1 ? slides.length : i + 1;
            })();
      slides.splice(at, 0, op.slide);
      return {
        deck: { ...deck, slides, rev: deck.rev + 1 },
        inverse: { t: 'delete_slide', id: op.slide.id },
      };
    }

    case 'update_slide': {
      const { slide, index } = findSlide(deck, op.id);
      // Capture only the keys being changed, so the inverse is minimal.
      const prev: Partial<Slide> = {};
      for (const k of Object.keys(op.fields) as (keyof Slide)[]) {
        (prev as Record<string, unknown>)[k] = slide[k];
      }
      const slides = [...deck.slides];
      slides[index] = { ...slide, ...op.fields };
      return {
        deck: { ...deck, slides, rev: deck.rev + 1 },
        inverse: { t: 'update_slide', id: op.id, fields: prev },
      };
    }

    case 'set_blocks': {
      const { slide, index } = findSlide(deck, op.id);
      // Replaces only the target slot; the other slot is untouched. This is why
      // filling a slide's main content cannot wipe its aside image.
      const replaced = slide.blocks.filter((b) => b.slot === op.slot);
      const incoming = op.blocks.map((b) => ({ ...b, slot: op.slot }));

      // Splice the new blocks in at the position the old ones occupied rather
      // than appending them. Appending would reorder the slide on every fill,
      // and would make undo non-exact when both slots are populated.
      const firstIdx = slide.blocks.findIndex((b) => b.slot === op.slot);
      const insertAt = firstIdx === -1 ? slide.blocks.length : firstIdx;
      const others = slide.blocks.filter((b) => b.slot !== op.slot);
      const before = others.filter((b) => slide.blocks.indexOf(b) < insertAt);
      const after = others.filter((b) => slide.blocks.indexOf(b) >= insertAt);

      const slides = [...deck.slides];
      slides[index] = { ...slide, blocks: [...before, ...incoming, ...after] };
      return {
        deck: { ...deck, slides, rev: deck.rev + 1 },
        inverse: { t: 'set_blocks', id: op.id, slot: op.slot, blocks: replaced },
      };
    }

    case 'patch_block': {
      const { slide, index } = findSlide(deck, op.slideId);
      const bIndex = slide.blocks.findIndex((b) => b.id === op.blockId);
      if (bIndex === -1) {
        throw new OpError(`no block with id "${op.blockId}" on slide "${op.slideId}"`);
      }
      const block = slide.blocks[bIndex];
      // `type` is the discriminant — patching it would break the union, so it
      // is not patchable, and `id` is server-owned. Both are stripped.
      // Changing a block's type means delete + add.
      const safePatch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(op.patch)) {
        if (k !== 'type' && k !== 'id') safePatch[k] = v;
      }
      const prev: Record<string, unknown> = {};
      for (const k of Object.keys(safePatch)) {
        prev[k] = (block as unknown as Record<string, unknown>)[k];
      }
      const blocks = [...slide.blocks];
      blocks[bIndex] = { ...block, ...safePatch } as Block;
      const slides = [...deck.slides];
      slides[index] = { ...slide, blocks };
      return {
        deck: { ...deck, slides, rev: deck.rev + 1 },
        inverse: { t: 'patch_block', slideId: op.slideId, blockId: op.blockId, patch: prev },
      };
    }

    case 'add_block': {
      const { slide, index } = findSlide(deck, op.slideId);
      const blocks = [...slide.blocks];
      blocks.splice(op.index ?? blocks.length, 0, op.block);
      const slides = [...deck.slides];
      slides[index] = { ...slide, blocks };
      return {
        deck: { ...deck, slides, rev: deck.rev + 1 },
        inverse: { t: 'delete_block', slideId: op.slideId, blockId: op.block.id },
      };
    }

    case 'delete_block': {
      const { slide, index } = findSlide(deck, op.slideId);
      const bIndex = slide.blocks.findIndex((b) => b.id === op.blockId);
      if (bIndex === -1) throw new OpError(`no block with id "${op.blockId}"`);
      const block = slide.blocks[bIndex];
      const blocks = slide.blocks.filter((b) => b.id !== op.blockId);
      const slides = [...deck.slides];
      slides[index] = { ...slide, blocks };
      return {
        deck: { ...deck, slides, rev: deck.rev + 1 },
        inverse: { t: 'add_block', slideId: op.slideId, block, index: bIndex },
      };
    }

    case 'delete_slide': {
      const { slide, index } = findSlide(deck, op.id);
      const slides = deck.slides.filter((s) => s.id !== op.id);
      // Inverse must restore position, so capture the preceding slide's id.
      const afterId = index === 0 ? null : deck.slides[index - 1].id;
      return {
        deck: { ...deck, slides, rev: deck.rev + 1 },
        inverse: { t: 'add_slide', slide, afterId },
      };
    }

    case 'reorder': {
      // Validate as a strict permutation. Rejecting anything else is why the
      // model is asked for a full desired order rather than a relative move.
      const current = deck.slides.map((s) => s.id);
      if (
        op.ids.length !== current.length ||
        new Set(op.ids).size !== op.ids.length ||
        !op.ids.every((id) => current.includes(id))
      ) {
        throw new OpError(
          `reorder must be a permutation of existing slide ids. got [${op.ids.join(
            ', '
          )}], expected the ${current.length} ids [${current.join(', ')}]`
        );
      }
      const byId = new Map(deck.slides.map((s) => [s.id, s]));
      return {
        deck: { ...deck, slides: op.ids.map((id) => byId.get(id)!), rev: deck.rev + 1 },
        inverse: { t: 'reorder', ids: current },
      };
    }

    case 'set_layout': {
      const { slide, index } = findSlide(deck, op.id);
      const prev: Partial<LayoutHint> = {};
      for (const k of Object.keys(op.layout) as (keyof LayoutHint)[]) {
        (prev as Record<string, unknown>)[k] = slide.layout[k];
      }
      const slides = [...deck.slides];
      slides[index] = { ...slide, layout: { ...slide.layout, ...op.layout } };
      return {
        deck: { ...deck, slides, rev: deck.rev + 1 },
        inverse: { t: 'set_layout', id: op.id, layout: prev },
      };
    }

    case 'set_theme':
      return {
        deck: { ...deck, theme: op.theme, rev: deck.rev + 1 },
        inverse: { t: 'set_theme', theme: deck.theme },
      };

    case 'set_deck_title':
      return {
        deck: { ...deck, title: op.title, rev: deck.rev + 1 },
        inverse: { t: 'set_deck_title', title: deck.title },
      };
  }
}

/** Apply a batch, collecting inverses in reverse order for correct undo. */
export function applyOps(deck: Deck, ops: DeckOp[]): { deck: Deck; inverses: DeckOp[] } {
  let cur = deck;
  const inverses: DeckOp[] = [];
  for (const op of ops) {
    const r = applyOp(cur, op);
    cur = r.deck;
    inverses.unshift(r.inverse);
  }
  return { deck: cur, inverses };
}

/** Which slide an op targets — used by the editing-conflict guard. */
export function opTargetSlide(op: DeckOp): string | null {
  switch (op.t) {
    case 'add_slide':
      return op.slide.id;
    case 'update_slide':
    case 'set_blocks':
    case 'delete_slide':
    case 'set_layout':
      return op.id;
    case 'patch_block':
    case 'add_block':
    case 'delete_block':
      return op.slideId;
    case 'reorder':
    case 'set_theme':
    case 'set_deck_title':
      return null;
  }
}

/** Human-readable label for the history UI and chat activity log. */
export function describeOp(op: DeckOp): string {
  switch (op.t) {
    case 'add_slide':
      return `Added slide "${op.slide.title}"`;
    case 'update_slide':
      return `Updated ${Object.keys(op.fields).join(', ')}`;
    case 'set_blocks':
      return `Filled ${op.blocks.length} block(s)`;
    case 'patch_block':
      return `Edited ${Object.keys(op.patch).join(', ')}`;
    case 'add_block':
      return `Added ${op.block.type} block`;
    case 'delete_block':
      return 'Deleted block';
    case 'delete_slide':
      return 'Deleted slide';
    case 'reorder':
      return 'Reordered slides';
    case 'set_layout':
      return 'Changed layout';
    case 'set_theme':
      return `Theme -> ${op.theme}`;
    case 'set_deck_title':
      return 'Renamed deck';
  }
}
