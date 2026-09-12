/**
 * /api/chat — the single agent endpoint.
 *
 * Streams NDJSON AgentEvents so the client applies ops as they happen. The
 * client's deck is authoritative and is posted with each request, so the server
 * holds no session state — no sync protocol, and a page reload cannot desync.
 *
 * Routing: an empty deck (or an explicit "build me a deck" ask) goes to
 * two-phase generation; anything else goes to the edit loop, which patches.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { Deck, type Slide } from '@/lib/schema/deck';
import { getProvider, isProviderConfigured } from '@/lib/llm';
import { runAgentLoop } from '@/lib/agent/loop';
import { generateDeck } from '@/lib/agent/twoPhase';
import { editSystemPrompt } from '@/lib/agent/prompts';
import { encodeEvent, type AgentEvent } from '@/lib/agent/protocol';
import { DECK_TOOLS } from '@/lib/agent/tools';
import type { LLMMessage } from '@/lib/llm/types';

export const runtime = 'nodejs';
/** Two-phase generation of a 10-slide deck takes well over the default. */
export const maxDuration = 300;

import { logError, toFriendlyError } from '@/lib/agent/errors';
import {
  AGENT_TIMEOUT_MS,
  clampHistory,
  MAX_FOCUS_SLIDES,
  validateChatInput,
  withTimeout,
} from '@/lib/agent/limits';
import { enforceRateLimit } from '@/lib/rateLimit';

interface ChatBody {
  message: string;
  deck: unknown;
  history?: {
    role: 'user' | 'assistant';
    content: string;
    /**
     * Tools the assistant invoked on that turn. Replaying assistant turns as
     * bare prose taught the model that edits are performed by DESCRIBING them:
     * after three "I removed X" replies with no visible tool calls, "remove
     * slide 3" came back as a sentence and no delete_slide. Summarising the
     * calls keeps the transcript honest about how work actually gets done.
     */
    toolCalls?: { name: string; status?: 'ok' | 'error' }[];
  }[];
  /** Slide the user has selected — used to resolve "this slide". */
  focusSlideId?: string | null;
  /** Explicit override; otherwise intent is inferred. */
  mode?: 'auto' | 'generate' | 'edit';
}

export async function POST(req: NextRequest) {
  if (!isProviderConfigured()) {
    return new Response(
      JSON.stringify({
        error:
          'No LLM API key configured. Copy .env.example to .env.local and set SARVAM_API_KEY (see README).',
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Per-caller budget. The size caps below bound ONE request; this bounds how
  // many a single caller may send, which is what actually caps provider spend
  // on an unauthenticated route.
  const limited = enforceRateLimit(req, 'llm');
  if (limited) return limited;

  let body: ChatBody;
  try {
    body = (await req.json()) as ChatBody;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 });
  }

  const parsedDeck = Deck.safeParse(body.deck);
  if (!parsedDeck.success) {
    return new Response(
      JSON.stringify({ error: 'Invalid deck payload: ' + parsedDeck.error.issues[0]?.message }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const deck = parsedDeck.data;
  const message = String(body.message ?? '').trim();
  if (!message) {
    return new Response(JSON.stringify({ error: 'Message is empty' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // GUARDRAIL: bound the request before spending a single token. This endpoint
  // is unauthenticated, so an oversized prompt or deck is a cost and
  // availability problem, not just a correctness one.
  const tooLarge = validateChatInput({
    message,
    slideCount: deck.slides.length,
    deckBytes: JSON.stringify(deck).length,
  });
  if (tooLarge) {
    return new Response(JSON.stringify({ error: tooLarge }), {
      status: 413,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const provider = getProvider();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit = (e: AgentEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(encodeEvent(e)));
        } catch {
          closed = true;
        }
      };

      try {
        const mode = resolveMode(body.mode, message, deck.slides.length);

        if (mode === 'generate') {
          const result = await withTimeout(
            generateDeck({
            provider,
            deck,
            userPrompt: message,
            emit,
            signal: req.signal,
            // A request for a new deck replaces what is there rather than
            // appending to it. Dirty slides are preserved, and the clear is
            // undoable because it flows through normal delete_slide ops.
            replaceExisting: deck.slides.length > 0,
            }),
            AGENT_TIMEOUT_MS,
            'Deck generation'
          );
          const parts = [
            `Built a ${result.slidesGenerated + result.failures}-slide deck.`,
            result.failures
              ? `${result.failures} slide${result.failures === 1 ? '' : 's'} came back empty — ask me to retry those.`
              : '',
          ].filter(Boolean);
          emit({ type: 'message', text: parts.join(' '), final: true });
        } else {
          // Which slides' FULL content to include in the prompt.
          //
          // The compact outline only carries block shapes (b_x:bullets(4)), not
          // text. That is right for token economy, but it meant a request like
          // "remove the launch date bullet from slide 4" reached a model that
          // could not see a single bullet — so it invented four replacements
          // and reported success. Resolving slide references from the message
          // itself is what makes content-level edits possible.
          const focusSlides = resolveFocusSlides(deck, message, body.focusSlideId);

          const history: LLMMessage[] = clampHistory(body.history ?? [])
            .map((m) => {
              if (m.role === 'user') return { role: 'user' as const, content: m.content };

              // Note WHICH tools produced the change. A real assistant
              // tool-call turn would need matching tool-result messages to be
              // a valid conversation, so the calls are summarised inline
              // instead — enough to show that edits come from tools.
              const applied = (m.toolCalls ?? []).filter((t) => t.status !== 'error');
              const note = applied.length
                ? ` [applied via ${[...new Set(applied.map((t) => t.name))].join(', ')}]`
                : '';
              return { role: 'assistant' as const, content: m.content + note };
            });

          emit({ type: 'phase', phase: 'edit' });
          const result = await withTimeout(
            runAgentLoop({
            provider,
            deck,
            messages: [
              { role: 'system', content: editSystemPrompt(deck, focusSlides) },
              ...history,
              { role: 'user', content: message },
            ],
            tools: DECK_TOOLS,
            emit,
            signal: req.signal,
            }),
            AGENT_TIMEOUT_MS,
            'Edit'
          );

          emit({
            type: 'message',
            text:
              result.reply ??
              (result.ops.length
                ? `Applied ${result.ops.length} change${result.ops.length === 1 ? '' : 's'}.`
                : "I couldn't work out what to change — could you be more specific?"),
            final: true,
          });
        }

        emit({ type: 'done' });
      } catch (e) {
        // Translate before emitting: raw provider errors are unhelpful and can
        // leak internals (base urls, header names, stack frames). The original
        // is logged server-side.
        logError('api/chat', e);
        const friendly = toFriendlyError(e);
        if (friendly.status !== 499) {
          emit({ type: 'error', message: friendly.message });
        }
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Prevents proxies from buffering the stream, which would defeat the
      // whole point of incremental slide delivery.
      'X-Accel-Buffering': 'no',
    },
  });
}

/**
 * Pick the slides whose full content belongs in the prompt.
 *
 * Sources, in order:
 *   1. Explicit numbers in the message ("slide 4", "slides 2 and 3").
 *   2. Ordinal words ("the last slide", "the first slide").
 *   3. The slide the user has selected in the editor ("this slide").
 *
 * Capped so a request naming many slides cannot blow up the context. When
 * nothing resolves we send no detail, which is correct for structural asks
 * ("add a slide about pricing") that do not need existing text.
 */
export function resolveFocusSlides(
  deck: z.infer<typeof Deck>,
  message: string,
  selectedId?: string | null
): Slide[] {
  const picked = new Map<string, Slide>();
  const add = (slide: Slide | undefined) => {
    if (slide && picked.size < MAX_FOCUS_SLIDES) picked.set(slide.id, slide);
  };

  // "slide 4" / "slide #4", and shared-prefix lists like "slides 2 and 3" or
  // "slides 1, 3 and 5" — the plural form names the numbers only once, so
  // requiring the word "slide" before each one misses all but the first.
  for (const m of message.matchAll(/\bslides?\s*#?\s*(\d{1,2}(?:\s*(?:,|and|&|to|-|through)\s*#?\d{1,2})*)/gi)) {
    const group = m[1];
    const numbers = [...group.matchAll(/\d{1,2}/g)].map((d) => Number(d[0]));

    // A range ("slides 2-4", "slides 2 to 4") expands; a list does not.
    const isRange = /\b(?:to|through)\b|-/.test(group) && numbers.length === 2;
    const expanded = isRange
      ? Array.from(
          { length: Math.abs(numbers[1] - numbers[0]) + 1 },
          (_, i) => Math.min(...numbers) + i
        )
      : numbers;

    for (const n of expanded) {
      if (n >= 1 && n <= deck.slides.length) add(deck.slides[n - 1]);
    }
  }

  // Ordinal references, which are as common as numbers in practice.
  const lower = message.toLowerCase();
  if (/\b(last|final|closing|concluding)\s+slide\b/.test(lower)) add(deck.slides.at(-1));
  if (/\b(first|opening|title)\s+slide\b/.test(lower)) add(deck.slides[0]);

  // The selected slide backs "this slide" / "here".
  if (selectedId) add(deck.slides.find((s) => s.id === selectedId));

  // CONTENT SEARCH FALLBACK.
  //
  // Requests often name the content rather than the slide: "remove the annual
  // cost row", "drop Q4E". With no slide number and no selection those
  // resolved to nothing, so the model saw only block shapes, could not find
  // the thing to remove, and answered as if it had (observed live: two
  // consecutive edits claimed done, neither applied).
  //
  // Searching the deck for distinctive words from the message finds the slide
  // that actually contains the referenced content.
  if (picked.size === 0) {
    const scored = deck.slides
      .map((slide) => ({ slide, score: contentMatchScore(slide, message) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    for (const { slide } of scored.slice(0, 2)) add(slide);
  }

  return [...picked.values()];
}

/** Words too common to identify a slide. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of',
  'with', 'from', 'this', 'that', 'these', 'those', 'it', 'its', 'slide',
  'slides', 'remove', 'delete', 'drop', 'add', 'change', 'make', 'update',
  'edit', 'rewrite', 'point', 'points', 'bullet', 'bullets', 'row', 'rows',
  'column', 'columns', 'about', 'more', 'less', 'please', 'can', 'you',
  'my', 'our', 'be', 'is', 'are', 'as', 'into',
]);

/**
 * How strongly a slide's text matches the distinctive words in a message.
 * Longer tokens score higher because they are more identifying — "q4e" or
 * "annual" pins a slide, "cost" alone might not.
 */
function contentMatchScore(slide: Slide, message: string): number {
  const tokens = message
    .toLowerCase()
    .split(/[^a-z0-9$%.+/-]+/i)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
  if (!tokens.length) return 0;

  const haystack = [
    slide.title,
    slide.subtitle ?? '',
    ...slide.blocks.flatMap(blockText),
  ]
    .join(' \n ')
    .toLowerCase();

  let score = 0;
  for (const t of tokens) {
    if (haystack.includes(t)) score += Math.min(t.length, 8);
  }
  return score;
}

/** All human-readable strings in a block, for the content search. */
function blockText(block: Slide['blocks'][number]): string[] {
  switch (block.type) {
    case 'heading':
    case 'paragraph':
    case 'quote':
      return [block.text];
    case 'bullets':
      return block.items;
    case 'metrics':
      return block.items.flatMap((m) => [m.value, m.label]);
    case 'table':
      return [...block.columns, ...block.rows.flat()];
    case 'chart':
      return [...block.categories, ...block.series.map((se) => se.name), block.caption ?? ''];
    case 'image':
      return [block.alt, block.query];
  }
}

/**
 * Decide whether this message builds a new deck or edits the existing one.
 *
 * Deliberately conservative: editing is the safe default because it patches,
 * while generating appends a whole new outline. We only pick 'generate' when
 * the deck is empty or the user clearly asked for a new deck.
 */
function resolveMode(
  explicit: ChatBody['mode'],
  message: string,
  slideCount: number
): 'generate' | 'edit' {
  if (explicit === 'generate' || explicit === 'edit') return explicit;
  if (slideCount === 0) return 'generate';

  const m = message.toLowerCase();
  const wantsNewDeck =
    /\b(create|generate|build|make|draft|put together|write me)\b[^.]*\b(deck|presentation|slides|slide deck)\b/.test(m) ||
    /\b(start over|from scratch|new deck|replace the deck)\b/.test(m);
  return wantsNewDeck ? 'generate' : 'edit';
}
