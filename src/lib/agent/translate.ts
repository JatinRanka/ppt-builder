/**
 * TOOL CALL -> DECKOP TRANSLATION + VALIDATION.
 *
 * This is the trust boundary. Everything the model produces is validated here
 * against the live deck before it can touch state:
 *   - slide/block ids must actually exist (models invent them)
 *   - blocks are Zod-parsed, so a malformed chart cannot reach the renderer
 *   - ids are minted here, never accepted from the model
 *   - caps (max 8 bullets etc.) are enforced by the schema, not hoped for
 *
 * A validation failure throws ToolCallError, which the loop feeds back to the
 * model as a tool result so it can self-correct. An invented slide id becomes a
 * recoverable conversation turn rather than a crash.
 */
import { z } from 'zod';
import { Block, type Deck, type SlideKind } from '@/lib/schema/deck';
import { makeOutlineSlide, newBlockId } from '@/lib/schema/factory';
import type { DeckOp } from '@/lib/state/ops';
import type { ToolCall } from '@/lib/llm/types';
import { resolveImageUrlSeeded } from '@/lib/images';
import { MAX_SLIDES } from './limits';

export class ToolCallError extends Error {}

/** Blocks as the model supplies them: no id (server-minted), slot optional. */
const IncomingBlock = z
  .looseObject({ type: z.string(), slot: z.enum(['main', 'aside']).optional() });

function fail(msg: string): never {
  throw new ToolCallError(msg);
}

function requireSlide(deck: Deck, id: unknown, tool: string): string {
  if (typeof id !== 'string' || !id) fail(`${tool}: slide_id is required`);
  if (!deck.slides.some((s) => s.id === id)) {
    fail(
      `${tool}: no slide with id "${id}". Valid ids are: ${
        deck.slides.map((s) => s.id).join(', ') || '(deck is empty)'
      }`
    );
  }
  return id;
}

/**
 * Normalize and validate one model-supplied block into a schema-valid Block.
 * Tolerates the shapes models actually emit (metrics items as strings, chart
 * series lengths off by one) rather than rejecting outright — being strict here
 * would burn a retry round-trip on cosmetic mismatches.
 */
function normalizeBlock(raw: unknown, slot: 'main' | 'aside', seed: string): Block | null {
  const parsed = IncomingBlock.safeParse(raw);
  if (!parsed.success) fail(`block is not an object: ${JSON.stringify(raw).slice(0, 120)}`);
  const b = { ...parsed.data } as Record<string, unknown>;
  const type = b.type as string;

  b.id = newBlockId();
  b.slot = b.slot ?? slot;

  switch (type) {
    case 'bullets': {
      const items = Array.isArray(b.items) ? b.items : [];
      b.items = items.map((x) => (typeof x === 'string' ? x : String(x))).slice(0, 8);
      if ((b.items as string[]).length === 0) fail('bullets block has no items');
      b.ordered = Boolean(b.ordered);
      break;
    }
    case 'metrics': {
      const items = Array.isArray(b.items) ? b.items : [];
      // Models sometimes emit ["42% growth"] instead of [{value,label}].
      b.items = items.slice(0, 4).map((x) => {
        if (x && typeof x === 'object' && 'value' in x) {
          const o = x as { value: unknown; label?: unknown };
          return { value: String(o.value), label: String(o.label ?? '') };
        }
        const text = String(x).trim();
        // Split "42% growth" -> {value:"42%", label:"growth"}, but ONLY when the
        // leading token actually reads as a figure. The previous rule split on
        // the first space unconditionally, which turned prose into nonsense
        // metrics: "Congestion costs cities $140B" became
        // value="Congestion" / label="costs cities $140B" (seen live).
        const NUM = String.raw`[$£€₹]?\d+(?:[.,]\d+)*\s*(?:%|[KMB]n?|bn|billion|million|trillion|x)?`;
        const m = text.match(new RegExp(`^(${NUM})\\s+(.{2,})$`, 'i'));
        if (m) return { value: m[1].trim(), label: m[2].trim() };
        // Prose with an embedded figure: surface the figure as the value and
        // keep the whole phrase as the label, which at least reads correctly.
        const embedded = text.match(new RegExp(`(${NUM})`, 'i'));
        if (embedded) {
          return { value: embedded[1].trim(), label: text.replace(embedded[1], '').trim() || text };
        }
        // No figure at all: this is not metrics content. Keep it intact as the
        // label rather than inventing a value from the first word.
        return { value: '', label: text };
      });
      if ((b.items as unknown[]).length === 0) fail('metrics block has no items');
      break;
    }
    case 'table': {
      let columns = (Array.isArray(b.columns) ? b.columns : []).map(String);
      let rawRows = (Array.isArray(b.rows) ? b.rows : []).map((r) =>
        (Array.isArray(r) ? r : [r]).map(String)
      );

      // Observed model behaviour: it frequently omits `columns` entirely and
      // puts the header inside rows[0]. Promote it rather than rejecting the
      // block — the content is correct, only the shape differs.
      if (!columns.length && rawRows.length > 1) {
        columns = rawRows[0];
        rawRows = rawRows.slice(1);
      }
      if (!columns.length) fail('table block has no columns and no header row');

      columns = columns.slice(0, 6);
      const rows = rawRows.slice(0, 10).map((cells) => {
        const padded = [...cells];
        // Pad/trim so a ragged row cannot break the table renderer.
        while (padded.length < columns.length) padded.push('');
        return padded.slice(0, columns.length);
      });
      b.columns = columns;
      b.rows = rows;
      break;
    }
    case 'chart': {
      const categories = (Array.isArray(b.categories) ? b.categories : []).map(String);
      const series = (Array.isArray(b.series) ? b.series : []).slice(0, 4).map((s) => {
        const o = (s ?? {}) as { name?: unknown; data?: unknown };
        const data = (Array.isArray(o.data) ? o.data : []).map((n) => Number(n) || 0);
        // Align series length to categories so Recharts does not render gaps.
        while (data.length < categories.length) data.push(0);
        return { name: String(o.name ?? 'Series'), data: data.slice(0, categories.length) };
      });
      if (!categories.length || !series.length) {
        fail('chart block needs both categories and at least one series');
      }
      b.categories = categories;
      b.series = series;
      if (!['bar', 'line', 'pie', 'area'].includes(String(b.chartType))) b.chartType = 'bar';
      break;
    }
    case 'image': {
      const query = String(b.query ?? b.alt ?? '').trim();
      if (!query) fail('image block needs a `query` of 2-4 keywords');
      b.query = query;
      b.alt = String(b.alt ?? query);
      b.fit = b.fit === 'contain' ? 'contain' : 'cover';
      // Resolve the URL server-side now so the client never waits on it.
      b.url = resolveImageUrlSeeded(query, seed + String(b.id));
      break;
    }
    case 'heading': {
      // A heading is decorative; when the model emits one with no text there is
      // nothing to render, but failing the whole slide over it would throw away
      // the good blocks alongside it. Signal "drop me" instead.
      const headingText = String(b.text ?? '').trim();
      if (!headingText) return null;
      b.text = headingText;
      b.level = b.level === 3 ? 3 : 2;
      break;
    }
    case 'paragraph':
    case 'quote': {
      const t = String(b.text ?? '').trim();
      if (!t) return null; // empty text block: drop it, do not fail the slide
      b.text = t;
      break;
    }
    default:
      fail(
        `unknown block type "${type}". Valid types: heading, paragraph, bullets, quote, metrics, table, chart, image`
      );
  }

  const result = Block.safeParse(b);
  if (!result.success) {
    fail(`block failed validation: ${result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  }
  return result.data;
}

/**
 * Translate one tool call into zero or more DeckOps.
 * Returns ops rather than applying them so the caller controls sequencing.
 */
export function toolCallToOps(deck: Deck, call: ToolCall): DeckOp[] {
  const a = call.args;

  switch (call.name) {
    case 'add_slide': {
      // HARD CAP, enforced in code rather than only in the prompt.
      // "Never exceed 12 slides" in a system prompt is a request; a model that
      // ignores it could otherwise grow the deck without bound, one tool call
      // at a time, past what the renderer and context budget can carry.
      if (deck.slides.length >= MAX_SLIDES) {
        fail(
          `add_slide: the deck already has ${deck.slides.length} slides, which is the maximum (${MAX_SLIDES}). Delete a slide before adding another.`
        );
      }

      const kind = String(a.kind ?? 'content') as SlideKind;
      const title = String(a.title ?? '').trim();
      if (!title) fail('add_slide: title is required');

      const slide = makeOutlineSlide({
        kind,
        title,
        brief: String(a.brief ?? title),
        subtitle: a.subtitle ? String(a.subtitle) : undefined,
        layoutVariant: a.layout_variant as never,
      });

      // after_slide_id: explicit null => prepend, absent => append, id => after it.
      let afterId: string | null;
      if (a.after_slide_id === null) {
        afterId = null;
      } else if (typeof a.after_slide_id === 'string' && a.after_slide_id) {
        if (!deck.slides.some((s) => s.id === a.after_slide_id)) {
          fail(
            `add_slide: after_slide_id "${a.after_slide_id}" does not exist. Valid ids: ${
              deck.slides.map((s) => s.id).join(', ') || '(empty)'
            }`
          );
        }
        afterId = a.after_slide_id;
      } else {
        afterId = deck.slides.at(-1)?.id ?? null;
      }

      return [{ t: 'add_slide', slide, afterId }];
    }

    case 'set_blocks': {
      const slideId = requireSlide(deck, a.slide_id, 'set_blocks');
      const slot = a.slot === 'aside' ? 'aside' : 'main';

      const rawBlocks = Array.isArray(a.blocks) ? a.blocks : fail('set_blocks: blocks must be an array');

      // An empty array is legitimate for title/section slides, whose headline
      // IS the content. Treat it as "this slide is intentionally bare" and mark
      // it ready rather than leaving a skeleton the user has to chase.
      if (rawBlocks.length === 0) {
        const target = deck.slides.find((sl) => sl.id === slideId);
        if (target && (target.kind === 'title' || target.kind === 'section')) {
          return [{ t: 'update_slide', id: slideId, fields: { status: 'ready' } }];
        }
        fail('set_blocks: blocks array is empty');
      }
      // normalizeBlock returns null for empty decorative blocks; keep the rest
      // so one junk block cannot cost us an otherwise good slide.
      const blocks = rawBlocks
        .map((b) => normalizeBlock(b, slot, slideId))
        .filter((b): b is Block => b !== null);
      if (blocks.length === 0) fail('set_blocks: no usable blocks after validation');
      return [
        { t: 'set_blocks', id: slideId, slot, blocks },
        // Content has arrived, so the slide is no longer a pending skeleton.
        { t: 'update_slide', id: slideId, fields: { status: 'ready' } },
      ];
    }

    case 'update_slide': {
      const slideId = requireSlide(deck, a.slide_id, 'update_slide');
      const fields: Record<string, unknown> = {};
      if (typeof a.title === 'string') fields.title = a.title;
      if (typeof a.subtitle === 'string') fields.subtitle = a.subtitle;
      if (typeof a.speaker_notes === 'string') fields.speakerNotes = a.speaker_notes;
      if (typeof a.kind === 'string') fields.kind = a.kind;
      if (Object.keys(fields).length === 0) {
        fail('update_slide: nothing to change — provide title, subtitle, speaker_notes, or kind');
      }
      return [{ t: 'update_slide', id: slideId, fields: fields as never }];
    }

    case 'patch_block': {
      const slideId = requireSlide(deck, a.slide_id, 'patch_block');
      const slide = deck.slides.find((s) => s.id === slideId)!;
      const blockId = String(a.block_id ?? '');
      const block = slide.blocks.find((b) => b.id === blockId);
      if (!block) {
        fail(
          `patch_block: no block "${blockId}" on slide "${slideId}". That slide's blocks are: ${
            slide.blocks.map((b) => `${b.id}(${b.type})`).join(', ') || '(none)'
          }`
        );
      }
      const patch = (a.patch ?? {}) as Record<string, unknown>;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) {
        fail('patch_block: patch must be a non-empty object of fields to change');
      }
      // WHOLESALE-REWRITE GUARD.
      //
      // Array fields are replaced entirely, so a patch that keeps the same
      // element count but changes every value is almost never what the user
      // asked for. Observed live: "remove the launch date bullet" returned 4
      // brand-new bullets, destroying the user's CRM/Marketo text while the
      // reply claimed one bullet was removed.
      //
      // Same length + zero elements in common = the model regenerated rather
      // than edited. Refuse and tell it to resend the untouched items verbatim.
      for (const [field, next] of Object.entries(patch)) {
        if (!Array.isArray(next)) continue;
        const prevArr = (block as unknown as Record<string, unknown>)[field];
        if (!Array.isArray(prevArr) || prevArr.length < 3) continue;

        const norm = (v: unknown) =>
          typeof v === 'string' ? v.trim().toLowerCase() : JSON.stringify(v);
        const prevSet = new Set(prevArr.map(norm));
        const kept = next.filter((v) => prevSet.has(norm(v))).length;

        if (next.length === prevArr.length && kept === 0) {
          fail(
            `patch_block: every one of the ${prevArr.length} "${field}" entries was replaced with new text, ` +
              `which looks like a rewrite rather than the edit that was requested. ` +
              `Resend "${field}" containing the entries you are KEEPING copied exactly as they appear in the ` +
              `slide content, with only the requested change applied. ` +
              `(To delete one entry, send ${prevArr.length - 1} entries.)`
          );
        }
      }

      // Simulate the merge and run it through the SAME normalization that
      // set_blocks uses, so a patch benefits from identical coercion (metrics
      // given as bare strings, ragged table rows, misaligned chart series).
      // Validating the raw merge instead would reject shapes we already know
      // how to fix, which is exactly what happened in live testing.
      const merged = { ...block, ...patch, id: block.id, type: block.type };
      const normalized = normalizeBlock(merged, block.slot, slideId);
      if (!normalized) {
        fail(`patch_block: the patch would leave block "${blockId}" empty`);
      }

      // Reject fields that do not exist on THIS block type. Without this a
      // patch of {items:[...]} against a table block silently no-ops while the
      // model reports success — observed live: "shortened the table to three
      // rows" when nothing changed. Failing loudly lets the loop self-correct.
      const validFields = new Set(Object.keys(block));
      const unknown = Object.keys(patch).filter(
        (k) => k !== 'type' && k !== 'id' && !validFields.has(k)
      );
      if (unknown.length) {
        fail(
          `patch_block: block "${blockId}" is a ${block.type} block and has no field(s) ${unknown
            .map((u) => `"${u}"`)
            .join(', ')}. Its editable fields are: ${[...validFields]
            .filter((f) => f !== 'id' && f !== 'type' && f !== 'slot')
            .join(', ')}.`
        );
      }

      // Re-derive the patch from the normalized result so the coercions are
      // what actually land in the store, not the model's raw values.
      //
      // Crucially this includes DEPENDENT fields the model did not send.
      // Removing a chart category patches only `categories`, but a chart's
      // `series[].data` must stay the same length — normalizeBlock realigns it,
      // and copying only the model's keys threw that fix away, leaving 3
      // categories against 4 data points (observed live on "remove q4e").
      const normalizedRecord = normalized as unknown as Record<string, unknown>;
      const blockRecord = block as unknown as Record<string, unknown>;
      const effectivePatch: Record<string, unknown> = {};

      for (const k of Object.keys(normalizedRecord)) {
        if (k === 'type' || k === 'id' || k === 'slot') continue;
        const explicitlyPatched = k in patch;
        // A field normalization adjusted, even though the model never sent it.
        const changedByNormalization =
          JSON.stringify(normalizedRecord[k]) !== JSON.stringify(blockRecord[k]);
        if (explicitlyPatched || changedByNormalization) {
          effectivePatch[k] = normalizedRecord[k];
        }
      }

      if (!Object.keys(effectivePatch).length) {
        fail('patch_block: patch contained no changeable fields');
      }
      return [{ t: 'patch_block', slideId, blockId, patch: effectivePatch }];
    }

    case 'delete_slide': {
      const slideId = requireSlide(deck, a.slide_id, 'delete_slide');
      return [{ t: 'delete_slide', id: slideId }];
    }

    case 'reorder_slides': {
      const ids = Array.isArray(a.slide_ids) ? a.slide_ids.map(String) : fail('reorder_slides: slide_ids must be an array');
      const current = deck.slides.map((s) => s.id);
      if (ids.length !== current.length || new Set(ids).size !== ids.length || !ids.every((i) => current.includes(i))) {
        fail(
          `reorder_slides: must be a permutation of all ${current.length} slide ids. Expected exactly: ${current.join(', ')}`
        );
      }
      return [{ t: 'reorder', ids }];
    }

    case 'change_layout': {
      const slideId = requireSlide(deck, a.slide_id, 'change_layout');
      const layout: Record<string, unknown> = {};
      if (typeof a.variant === 'string') layout.variant = a.variant;
      if (typeof a.align === 'string') layout.align = a.align;
      if (typeof a.density === 'string') layout.density = a.density;
      if (!Object.keys(layout).length) fail('change_layout: provide variant, align, or density');
      return [{ t: 'set_layout', id: slideId, layout: layout as never }];
    }

    default:
      fail(`unknown tool "${call.name}"`);
  }
}
