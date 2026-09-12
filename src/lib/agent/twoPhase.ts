/**
 * TWO-PHASE GENERATION.
 *
 * Phase 1 — Outline/Skeleton: the AI produces a lightweight structure (slide
 *   count, titles, kinds/layouts, ordering) — the "shape" of the deck with no
 *   body content. One call, tool_choice 'required', add_slide only.
 *
 * Phase 2 — Content per slide: the AI fills in each slide's actual body content
 *   (bullets, tables, charts, speaker notes) individually, slide-by-slide via
 *   tool calls.
 *
 * Why this split is more than a formality:
 *
 * 1. IT IS WHY STREAMING WORKS. Phase 1 lands N skeletons in ~2s, then phase 2
 *    fills them one at a time. Slides visibly appear and populate rather than
 *    a spinner resolving into a finished deck.
 *
 * 2. IT FITS THE TOKEN BUDGET. Providers cap output tokens (often ~4096 on
 *    entry tiers). A whole deck of rich content does not fit in one response
 *    and would truncate mid-JSON. Per-slide calls give each slide the full
 *    budget.
 *
 * 3. IT PROTECTS MANUAL EDITS. Phase 2 skips slides marked `dirty`, so
 *    regenerating a deck never overwrites the user's own writing.
 */
import type { Deck, Slide } from '@/lib/schema/deck';
import { applyOp, describeOp, type DeckOp } from '@/lib/state/ops';
import type { LLMProvider, ToolCall } from '@/lib/llm/types';
import { CONTENT_TOOLS, OUTLINE_TOOLS } from './tools';
import { contentSystemPrompt, outlineSystemPrompt } from './prompts';
import { toolCallToOps, ToolCallError } from './translate';
import type { AgentEvent } from './protocol';
import { mapWithConcurrency, PHASE2_CONCURRENCY, withRetry } from './limiter';
import { MAX_GENERATED_SLIDES } from './limits';

const OUTLINE_MAX_TOKENS = 2000;
/**
 * Per-slide content budget. Only ONE slide is generated per call, so this can
 * be generous — and it needs to be. Truncation loses the entire slide, and it
 * was observed live at both 2600 and 4000 on chart-heavy slides (chart JSON is
 * verbose: categories + per-series data arrays + captions).
 *
 * Sarvam's plan tiers cap output (Starter 4096 / Pro 16384), and the API
 * clamps rather than erroring, so asking for more than the tier allows is
 * safe. The retry below lowers its own budget if truncation recurs.
 */
const CONTENT_MAX_TOKENS = 8000;

export interface TwoPhaseResult {
  deck: Deck;
  ops: DeckOp[];
  slidesGenerated: number;
  failures: number;
}

/**
 * Generate a deck from a user prompt.
 * Ops are emitted as they are applied so the client renders progressively.
 */
export async function generateDeck(args: {
  provider: LLMProvider;
  deck: Deck;
  userPrompt: string;
  emit: (e: AgentEvent) => void;
  signal?: AbortSignal;
  /** Clear existing non-dirty slides first. True for "make me a new deck". */
  replaceExisting?: boolean;
}): Promise<TwoPhaseResult> {
  const { provider, userPrompt, emit, signal, replaceExisting = false } = args;
  let deck = args.deck;
  const allOps: DeckOp[] = [];

  // ---------- PHASE 0: CLEAR (only when replacing) ----------
  // "Create a deck about X" means replace, not append onto whatever is there.
  // Emitted as ordinary delete_slide ops so it flows through the same reducer
  // and lands on the undo stack — the user can Cmd+Z back to their old deck.
  if (replaceExisting && deck.slides.length > 0) {
    for (const slide of [...deck.slides]) {
      // Never silently discard hand-written content.
      if (slide.dirty) continue;
      const op: DeckOp = { t: 'delete_slide', id: slide.id };
      deck = applyOp(deck, op).deck;
      allOps.push(op);
      emit({ type: 'op', op });
    }
  }

  // ---------- PHASE 1: OUTLINE ----------
  emit({ type: 'phase', phase: 'outline' });

  const outlineRes = await withRetry(
    () =>
      provider.chat({
        messages: [
          { role: 'system', content: outlineSystemPrompt(deck) },
          { role: 'user', content: userPrompt },
        ],
        tools: OUTLINE_TOOLS,
        // 'required' forces tool use: without it models tend to describe the
        // deck in prose instead of building it.
        toolChoice: 'required',
        maxTokens: OUTLINE_MAX_TOKENS,
        temperature: 0.4,
        signal,
      }),
    { label: 'outline' }
  );

  if (!outlineRes.toolCalls.length) {
    throw new Error(
      'The model did not produce an outline. It replied: ' +
        (outlineRes.text?.slice(0, 200) ?? '(nothing)')
    );
  }

  const newSlideIds: string[] = [];
  for (const call of outlineRes.toolCalls) {
    if (call.name !== 'add_slide') continue;
    try {
      const ops = toolCallToOps(deck, call);
      for (const op of ops) {
        deck = applyOp(deck, op).deck;
        allOps.push(op);
        emit({ type: 'op', op });
        if (op.t === 'add_slide') newSlideIds.push(op.slide.id);
      }
      // Phase 1 previously emitted no tool events at all, so generation — the
      // phase that makes the MOST calls — appeared to make none in the UI.
      emit({
        type: 'tool',
        id: call.id,
        name: call.name,
        summary: ops.map(describeOp).join('; '),
        args: call.args,
        ops,
        phase: 'outline',
        status: 'ok',
      });
    } catch (e) {
      const msg = e instanceof ToolCallError ? e.message : String(e);
      emit({
        type: 'tool',
        id: call.id,
        name: call.name,
        summary: `skipped: ${msg}`,
        args: call.args,
        phase: 'outline',
        status: 'error',
        error: msg,
      });
    }
  }

  if (!newSlideIds.length) throw new Error('No valid slides came back from the outline phase.');

  // Models intermittently emit a single add_slide and stop, leaving a 1-slide
  // "deck". Observed live, twice. Retry in a LOOP rather than once: a single
  // follow-up sometimes also returns nothing, and shipping a 1-slide deck when
  // the user asked for five is the worst possible outcome.
  const requested = parseRequestedCount(userPrompt);
  // Clamp what the user can ask for: "make me a 200-slide deck" would otherwise
  // drive 200 sequential content calls.
  const target = Math.min(requested ?? 6, MAX_GENERATED_SLIDES);
  const MAX_OUTLINE_ROUNDS = 3;

  for (let round = 0; round < MAX_OUTLINE_ROUNDS && newSlideIds.length < Math.min(target, 4); round++) {
    const missing = Math.max(target - newSlideIds.length, 1);
    emit({
      type: 'warning',
      message: `Outline has ${newSlideIds.length} of ${target} slides; requesting ${missing} more.`,
    });
    try {
      const followUp = await provider.chat({
        messages: [
          { role: 'system', content: outlineSystemPrompt(deck) },
          { role: 'user', content: userPrompt },
          {
            role: 'assistant',
            content: `So far I have created these ${newSlideIds.length} slide(s): ${deck.slides
              .filter((sl) => newSlideIds.includes(sl.id))
              .map((sl) => `"${sl.title}"`)
              .join(', ')}`,
          },
          {
            role: 'user',
            content:
              `That is an incomplete deck. Call add_slide ${missing} more time(s) RIGHT NOW to add the ` +
              `remaining slides, continuing the narrative after the slides listed above. ` +
              `Do not repeat those. Do not reply with text — only tool calls.`,
          },
        ],
        tools: OUTLINE_TOOLS,
        toolChoice: 'required',
        maxTokens: OUTLINE_MAX_TOKENS,
        temperature: 0.6, // nudge off the degenerate single-call response
        signal,
      });

      let addedThisRound = 0;
      for (const call of followUp.toolCalls) {
        if (call.name !== 'add_slide') continue;
        try {
          // Force append: a follow-up round has no reliable idea of the ids
          // already in the deck, and a bad after_slide_id would drop the slide.
          const appendCall = {
            ...call,
            args: { ...call.args, after_slide_id: deck.slides.at(-1)?.id ?? null },
          };
          const retryOps = toolCallToOps(deck, appendCall);
          for (const op of retryOps) {
            deck = applyOp(deck, op).deck;
            allOps.push(op);
            emit({ type: 'op', op });
            if (op.t === 'add_slide') {
              newSlideIds.push(op.slide.id);
              addedThisRound++;
            }
          }
          emit({
            type: 'tool',
            id: call.id,
            name: call.name,
            summary: retryOps.map(describeOp).join('; '),
            args: appendCall.args,
            ops: retryOps,
            phase: 'outline',
            status: 'ok',
          });
        } catch (e) {
          // Surfaced, not swallowed: a silent catch here hid the real reason
          // the retry produced nothing.
          emit({
            type: 'warning',
            message: `could not add a follow-up slide: ${
              e instanceof ToolCallError ? e.message : String(e)
            }`,
          });
        }
      }

      // No progress means further rounds will not help either.
      if (addedThisRound === 0) {
        emit({
          type: 'warning',
          message: followUp.text
            ? `The model replied with text instead of adding slides: "${followUp.text.slice(0, 120)}"`
            : 'The model returned no usable slides; stopping outline retries.',
        });
        break;
      }
    } catch (e) {
      emit({ type: 'warning', message: `could not extend the outline: ${(e as Error).message}` });
      break;
    }
  }

  // Name the deck after its opening slide so the header stops reading
  // "Untitled deck". Only when the deck is entirely new (every slide came from
  // this run) — renaming a deck the user has been adding to would be rude.
  const allSlidesAreNew = deck.slides.length === newSlideIds.length;
  const titleIsPlaceholder = /^(untitled|new deck)/i.test(deck.title.trim());
  if ((replaceExisting || allSlidesAreNew) && titleIsPlaceholder) {
    const opener = deck.slides.find((sl) => newSlideIds.includes(sl.id));
    if (opener) {
      const op: DeckOp = { t: 'set_deck_title', title: opener.title };
      deck = applyOp(deck, op).deck;
      allOps.push(op);
      emit({ type: 'op', op });
    }
  }

  // ---------- PHASE 2: CONTENT, PER SLIDE ----------
  const targets = newSlideIds
    .map((id) => deck.slides.find((s) => s.id === id))
    .filter((s): s is Slide => Boolean(s) && !s!.dirty);

  emit({ type: 'phase', phase: 'content', total: targets.length });

  let done = 0;
  let failures = 0;

  // Results are collected and applied in a defined order; the calls themselves
  // run concurrently. Out-of-order completion is safe because every op targets
  // a slide by id rather than by position.
  await mapWithConcurrency(targets, PHASE2_CONCURRENCY, async (slide) => {
    const index = deck.slides.findIndex((s) => s.id === slide.id);
    const prevTitle = index > 0 ? deck.slides[index - 1]?.title : undefined;
    const nextTitle = deck.slides[index + 1]?.title;

    try {
      const res = await withRetry(
        () =>
          provider.chat({
            messages: [
              {
                role: 'system',
                content: contentSystemPrompt({
                  deckTitle: deck.title,
                  slide,
                  prevTitle,
                  nextTitle,
                }),
              },
              {
                role: 'user',
                content: `Write the content for this slide now: "${slide.title}". Goal: ${
                  slide.brief ?? slide.title
                }`,
              },
            ],
            tools: CONTENT_TOOLS,
            toolChoice: { name: 'set_blocks' },
            maxTokens: CONTENT_MAX_TOKENS,
            temperature: 0.5,
            signal,
          }),
        { label: `content:${slide.id}` }
      );

      if (res.warning) emit({ type: 'warning', message: `${slide.title}: ${res.warning}` });

      let applied = false;
      let lastError = '';
      for (const call of res.toolCalls) {
        try {
          // Re-read the live deck: a concurrent worker may have changed it.
          const ops = toolCallToOps(deck, call);
          for (const op of ops) {
            deck = applyOp(deck, op).deck;
            allOps.push(op);
            emit({ type: 'op', op });
          }
          applied = true;
          emit({
            type: 'tool',
            id: call.id,
            name: call.name,
            summary: `${slide.title}: ${ops.map(describeOp).join('; ')}`,
            args: call.args,
            ops,
            phase: 'content',
            status: 'ok',
          });
        } catch (e) {
          lastError = e instanceof ToolCallError ? e.message : String(e);
          emit({
            type: 'tool',
            id: call.id,
            name: call.name,
            summary: `${slide.title}: ${lastError}`,
            args: call.args,
            phase: 'content',
            status: 'error',
            error: lastError,
          });
        }
      }

      if (!applied) {
        // Retry once, feeding the validation error back so the model can
        // correct its block shape. Cheaper and far less visible to the user
        // than leaving an empty slide and asking them to click "retry".
        applied = await retryOnce({
          provider, deck, slide, lastError, emit,
          apply: (call) => {
            const ops = toolCallToOps(deck, call);
            for (const op of ops) {
              deck = applyOp(deck, op).deck;
              allOps.push(op);
              emit({ type: 'op', op });
            }
          },
          signal,
        });

        if (!applied) {
          failures++;
          // Leave the slide as a skeleton rather than faking content, and say so.
          emit({
            type: 'warning',
            message: `Could not generate content for "${slide.title}". It is left as an empty slide you can fill manually or retry.`,
          });
        }
      }
    } catch (e) {
      failures++;
      emit({
        type: 'warning',
        message: `"${slide.title}" failed: ${(e as Error).message}`,
      });
    } finally {
      done++;
      emit({ type: 'slide_progress', slideId: slide.id, done, total: targets.length });
    }
  });

  return { deck, ops: allOps, slidesGenerated: targets.length - failures, failures };
}

/**
 * Fill content for slides that are still skeletons — used to retry failures
 * without regenerating the whole deck.
 */
export async function fillPendingSlides(args: {
  provider: LLMProvider;
  deck: Deck;
  emit: (e: AgentEvent) => void;
  signal?: AbortSignal;
}): Promise<TwoPhaseResult> {
  const { provider, emit, signal } = args;
  let deck = args.deck;
  const allOps: DeckOp[] = [];
  const targets = deck.slides.filter((s) => s.status !== 'ready' && !s.dirty && s.blocks.length === 0);

  if (!targets.length) return { deck, ops: [], slidesGenerated: 0, failures: 0 };

  emit({ type: 'phase', phase: 'content', total: targets.length });
  let done = 0;
  let failures = 0;

  await mapWithConcurrency(targets, PHASE2_CONCURRENCY, async (slide) => {
    try {
      const res = await withRetry(
        () =>
          provider.chat({
            messages: [
              { role: 'system', content: contentSystemPrompt({ deckTitle: deck.title, slide }) },
              { role: 'user', content: `Write the content for "${slide.title}".` },
            ],
            tools: CONTENT_TOOLS,
            toolChoice: { name: 'set_blocks' },
            maxTokens: CONTENT_MAX_TOKENS,
            temperature: 0.5,
            signal,
          }),
        { label: `refill:${slide.id}` }
      );
      for (const call of res.toolCalls) {
        const ops = toolCallToOps(deck, call);
        for (const op of ops) {
          deck = applyOp(deck, op).deck;
          allOps.push(op);
          emit({ type: 'op', op });
        }
      }
    } catch (e) {
      failures++;
      emit({ type: 'warning', message: `"${slide.title}": ${(e as Error).message}` });
    } finally {
      done++;
      emit({ type: 'slide_progress', slideId: slide.id, done, total: targets.length });
    }
  });

  return { deck, ops: allOps, slidesGenerated: targets.length - failures, failures };
}


/**
 * One corrective retry for a slide whose content failed validation.
 *
 * The validation message is handed back to the model verbatim — the same
 * self-correction mechanism the edit loop uses, applied to phase 2. Most
 * failures are shape mistakes (header inside `rows`, mismatched series length)
 * that the model fixes immediately when told precisely what was wrong.
 */
async function retryOnce(args: {
  provider: LLMProvider;
  deck: Deck;
  slide: Slide;
  lastError: string;
  emit: (e: AgentEvent) => void;
  apply: (call: ToolCall) => void;
  signal?: AbortSignal;
}): Promise<boolean> {
  const { provider, deck, slide, lastError, emit, apply, signal } = args;
  try {
    const res = await provider.chat({
      messages: [
        { role: 'system', content: contentSystemPrompt({ deckTitle: deck.title, slide }) },
        { role: 'user', content: `Write the content for "${slide.title}".` },
        {
          role: 'user',
          content:
            `Your previous attempt was rejected: ${lastError}\n\n` +
            `Fix exactly that problem and call set_blocks again. Keep the response ` +
            `COMPACT: at most 2 blocks, at most 4 bullets, and for charts at most ` +
            `2 series over at most 5 categories. A shorter valid slide beats a ` +
            `longer one that gets truncated.`,
        },
      ],
      tools: CONTENT_TOOLS,
      toolChoice: { name: 'set_blocks' },
      maxTokens: CONTENT_MAX_TOKENS,
      temperature: 0.3, // lower: we want compliance, not creativity
      signal,
    });
    for (const call of res.toolCalls) {
      apply(call);
      emit({
        type: 'tool',
        id: call.id,
        name: call.name,
        summary: `${slide.title}: filled on retry`,
        args: call.args,
        phase: 'content',
        status: 'ok',
      });
      return true;
    }
  } catch (e) {
    emit({ type: 'warning', message: `retry of "${slide.title}" failed: ${(e as Error).message}` });
  }
  return false;
}


/** Pull an explicit slide count out of the user's prompt, if they gave one. */
function parseRequestedCount(prompt: string): number | null {
  const m = /\b(\d{1,2})[\s-]*(?:slide|slides|page|pages)\b/i.exec(prompt);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 2 && n <= 20 ? n : null;
}
