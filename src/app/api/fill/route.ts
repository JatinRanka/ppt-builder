/**
 * /api/fill — retry phase-2 content for slides left as empty skeletons.
 *
 * Exists because a partial failure should be recoverable without regenerating
 * the deck (which would discard everything that did succeed, plus any manual
 * edits). Same NDJSON protocol as /api/chat.
 */
import { NextRequest } from 'next/server';
import { Deck } from '@/lib/schema/deck';
import { getProvider, isProviderConfigured } from '@/lib/llm';
import { fillPendingSlides } from '@/lib/agent/twoPhase';
import { encodeEvent, type AgentEvent } from '@/lib/agent/protocol';
import { logError, toFriendlyError } from '@/lib/agent/errors';
import {
  AGENT_TIMEOUT_MS,
  MAX_FILL_SLIDES,
  validateDeckSize,
  withTimeout,
} from '@/lib/agent/limits';
import { enforceRateLimit } from '@/lib/rateLimit';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!isProviderConfigured()) {
    return new Response(JSON.stringify({ error: 'No LLM API key configured.' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Fill is the highest-amplification route in the app (one 8000-token call per
  // pending slide), so it is rate limited on the same budget as chat.
  const limited = enforceRateLimit(req, 'llm');
  if (limited) return limited;

  const body = (await req.json().catch(() => null)) as { deck?: unknown } | null;
  const parsed = Deck.safeParse(body?.deck);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: 'Invalid deck payload' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // GUARDRAIL: this route was previously bounded only by the schema's SHAPE,
  // which says nothing about size. A schema-valid 500-slide skeleton deck
  // bought 500 content calls for one anonymous request.
  const tooLarge = validateDeckSize({
    slideCount: parsed.data.slides.length,
    deckBytes: JSON.stringify(parsed.data).length,
    maxSlides: MAX_FILL_SLIDES,
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
      const emit = (e: AgentEvent) => {
        try {
          controller.enqueue(encoder.encode(encodeEvent(e)));
        } catch {
          /* stream closed */
        }
      };
      try {
        // Wall-clock ceiling, matching /api/chat. Without it a provider that
        // accepts connections and never answers holds the invocation open
        // until the platform kills it, with no diagnostic for the user.
        const r = await withTimeout(
          fillPendingSlides({
            provider,
            deck: parsed.data,
            emit,
            signal: req.signal,
          }),
          AGENT_TIMEOUT_MS,
          'Fill'
        );
        emit({
          type: 'message',
          text: r.failures
            ? `Filled ${r.slidesGenerated}; ${r.failures} still failed.`
            : `Filled ${r.slidesGenerated} slide${r.slidesGenerated === 1 ? '' : 's'}.`,
          final: true,
        });
        emit({ type: 'done' });
      } catch (e) {
        // Translate before emitting. Echoing the raw message leaked provider
        // internals (base urls, header names, stack frames) straight to the
        // browser; /api/chat has always translated, this route did not.
        logError('api/fill', e);
        const friendly = toFriendlyError(e);
        if (friendly.status !== 499) {
          emit({ type: 'error', message: friendly.message });
        }
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
