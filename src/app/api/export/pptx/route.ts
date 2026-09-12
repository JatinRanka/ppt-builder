/**
 * /api/export/pptx — generates a real .pptx download.
 *
 * Runs server-side because PptxGenJS's node output path produces a Buffer and
 * fetches remote images; doing it in the browser would need a different code
 * path and would hit CORS on the image URLs.
 */
import { NextRequest } from 'next/server';
import { Deck } from '@/lib/schema/deck';
import { deckToPptx } from '@/lib/export/pptx';
import { EXPORT_TIMEOUT_MS, MAX_DECK_BYTES, MAX_SLIDES, withTimeout } from '@/lib/agent/limits';
import { logError } from '@/lib/agent/errors';
import { enforceRateLimit } from '@/lib/rateLimit';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  // Building a .pptx is CPU- and memory-bound and fetches remote images, so
  // it gets its own (looser than LLM) per-caller budget.
  const limited = enforceRateLimit(req, 'export');
  if (limited) return limited;

  const body = (await req.json().catch(() => null)) as { deck?: unknown } | null;
  const parsed = Deck.safeParse(body?.deck);
  if (!parsed.success) {
    return new Response('Invalid deck payload: ' + parsed.error.issues[0]?.message, { status: 400 });
  }

  // Same size bounds as the chat route: this endpoint is also unauthenticated
  // and building a .pptx is CPU- and memory-bound.
  if (parsed.data.slides.length > MAX_SLIDES) {
    return new Response(
      `This deck has ${parsed.data.slides.length} slides; the export limit is ${MAX_SLIDES}.`,
      { status: 413 }
    );
  }
  if (JSON.stringify(parsed.data).length > MAX_DECK_BYTES) {
    return new Response('Deck payload is too large to export.', { status: 413 });
  }

  try {
    // Hard ceiling on the whole build. Images are pre-fetched with their own
    // per-image timeout, but this bounds pathological decks as well.
    const buffer = await withTimeout(deckToPptx(parsed.data), EXPORT_TIMEOUT_MS, 'PPTX export');
    const filename = `${parsed.data.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'deck'}.pptx`;
    return new Response(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(buffer.byteLength),
      },
    });
  } catch (e) {
    logError('export/pptx', e);
    const timedOut = /timed out/i.test((e as Error)?.message ?? '');
    return new Response(
      timedOut
        ? 'The export took too long and was stopped. Try again, or remove image-heavy slides.'
        : 'Could not build the PowerPoint file. Try the PDF export instead.',
      { status: timedOut ? 504 : 500 }
    );
  }
}
