/**
 * INPUT GUARDRAILS — the outer boundary of the agent.
 *
 * Every one of these caps exists because the endpoint is an *unauthenticated*
 * door onto a paid LLM. Without them a single request can burn arbitrary tokens
 * (a 1MB prompt was accepted and forwarded verbatim before this file existed)
 * or pin the server building context for a 500-slide deck.
 *
 * The numbers are deliberately generous — they bound abuse and accidents, not
 * legitimate use. A real deck is well under every limit here.
 */

/** A prompt longer than this is not a slide request. ~2k tokens. */
export const MAX_MESSAGE_CHARS = 8_000;

/** Decks beyond this are rejected: context cost grows with slide count. */
export const MAX_SLIDES = 60;

/** Total serialized deck size, as a backstop against pathological blocks. */
export const MAX_DECK_BYTES = 1_000_000;

/** Conversation turns replayed to the model. */
export const MAX_HISTORY_TURNS = 6;

/** Per-history-message content, to stop one giant turn dominating context. */
export const MAX_HISTORY_MESSAGE_CHARS = 2_000;

/** Slides whose full text gets inlined into the prompt. */
export const MAX_FOCUS_SLIDES = 3;

/** Slides one generation request may create. */
export const MAX_GENERATED_SLIDES = 20;

/** Wall-clock ceiling for one agent request, under the route's maxDuration. */
export const AGENT_TIMEOUT_MS = 240_000;

/** Wall-clock ceiling for a PPTX build (it fetches remote images). */
export const EXPORT_TIMEOUT_MS = 20_000;

/** Per-image fetch timeout inside the PPTX exporter. */
export const IMAGE_FETCH_TIMEOUT_MS = 5_000;

export class RequestTooLargeError extends Error {
  constructor(
    message: string,
    readonly field: string
  ) {
    super(message);
    this.name = 'RequestTooLargeError';
  }
}

/**
 * Validate the shape/size of a chat request before any LLM call.
 *
 * Returns a user-facing message on rejection rather than throwing, so the route
 * can answer 413 with something actionable instead of a stack trace.
 */
export function validateChatInput(input: {
  message: string;
  slideCount: number;
  deckBytes: number;
}): string | null {
  if (input.message.length > MAX_MESSAGE_CHARS) {
    return `Your message is ${input.message.length.toLocaleString()} characters; the limit is ${MAX_MESSAGE_CHARS.toLocaleString()}. Try summarising what you want changed.`;
  }
  if (input.slideCount > MAX_SLIDES) {
    return `This deck has ${input.slideCount} slides; the limit is ${MAX_SLIDES}. Split it into smaller decks.`;
  }
  if (input.deckBytes > MAX_DECK_BYTES) {
    return `The deck payload is ${Math.round(input.deckBytes / 1024)}KB; the limit is ${Math.round(
      MAX_DECK_BYTES / 1024
    )}KB.`;
  }
  return null;
}

/**
 * Slides one /api/fill request may fill.
 *
 * Fill is the highest-amplification endpoint in the app: it issues ONE
 * content call per pending slide, each with an 8000-token budget and up to 3
 * retry attempts. A deck of 500 skeleton slides — ~100KB, trivially postable
 * to an unauthenticated route — meant up to 1500 provider calls and ~4M output
 * tokens for a single request. Capped well above any real deck's failure count.
 */
export const MAX_FILL_SLIDES = 20;

/**
 * Validate a deck-only request body (/api/fill, /api/export/pptx).
 *
 * The chat route has had these bounds since it was written; fill and export
 * were parsing the deck for SHAPE with Deck.safeParse and calling that
 * validation. Shape is not size — a schema-valid deck can still be enormous.
 */
export function validateDeckSize(input: {
  slideCount: number;
  deckBytes: number;
  maxSlides?: number;
}): string | null {
  const maxSlides = input.maxSlides ?? MAX_SLIDES;
  if (input.slideCount > maxSlides) {
    return `This deck has ${input.slideCount} slides; the limit for this operation is ${maxSlides}.`;
  }
  if (input.deckBytes > MAX_DECK_BYTES) {
    return `The deck payload is ${Math.round(input.deckBytes / 1024)}KB; the limit is ${Math.round(
      MAX_DECK_BYTES / 1024
    )}KB.`;
  }
  return null;
}

/** Clamp a history array to the replay budget, trimming oversized turns. */
export function clampHistory<T extends { content: string }>(history: T[]): T[] {
  return history.slice(-MAX_HISTORY_TURNS).map((m) =>
    m.content.length > MAX_HISTORY_MESSAGE_CHARS
      ? { ...m, content: m.content.slice(0, MAX_HISTORY_MESSAGE_CHARS) + '… [truncated]' }
      : m
  );
}

/**
 * Race a promise against a timeout.
 *
 * Used for the whole-request ceiling: a provider that accepts a connection and
 * never responds would otherwise hold a serverless invocation open until the
 * platform kills it, with no diagnostic for the user.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
          ms
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
