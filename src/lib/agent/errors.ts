/**
 * USER-FACING ERROR TRANSLATION.
 *
 * Raw provider errors are either unhelpful ("Request failed with status code
 * 429") or actively leak internals (base URLs, header names, stack frames).
 * This maps them to something a user can act on, while the original is logged
 * server-side for debugging.
 *
 * The default is deliberately vague rather than echoing an unknown message:
 * an error we have not classified is exactly the kind most likely to contain
 * something that should not reach a browser.
 */
import { LLMError } from '@/lib/llm/types';

export interface FriendlyError {
  message: string;
  /** Whether retrying the same request might succeed. */
  retryable: boolean;
  /** HTTP status to use when this surfaces as a response rather than a stream. */
  status: number;
}

export function toFriendlyError(e: unknown): FriendlyError {
  const raw = e instanceof Error ? e.message : String(e);

  // Client disconnected / user pressed Stop. Not an error worth reporting.
  if (e instanceof Error && (e.name === 'AbortError' || /aborted/i.test(raw))) {
    return { message: 'Request cancelled.', retryable: true, status: 499 };
  }

  if (/timed out/i.test(raw)) {
    return {
      message:
        'That took too long and was stopped. Try asking for fewer slides, or a smaller change.',
      retryable: true,
      status: 504,
    };
  }

  if (e instanceof LLMError) {
    const status = e.status ?? 0;
    if (status === 401 || status === 403) {
      return {
        message:
          'The AI provider rejected the API key. Check SARVAM_API_KEY in your environment.',
        retryable: false,
        status: 502,
      };
    }
    if (status === 429) {
      return {
        message: 'The AI provider is rate-limiting requests. Wait a moment and try again.',
        retryable: true,
        status: 429,
      };
    }
    if (status >= 500) {
      return {
        message: 'The AI provider is having trouble. Please try again.',
        retryable: true,
        status: 502,
      };
    }
    if (/api key|not set/i.test(raw)) {
      return {
        message: 'No AI provider key is configured. See the README setup section.',
        retryable: false,
        status: 503,
      };
    }
    if (/truncated|max_tokens/i.test(raw)) {
      return {
        message:
          'The AI response was cut off before it completed. Try asking for a smaller change.',
        retryable: true,
        status: 502,
      };
    }
    // A classified provider error with an unrecognised status: the message
    // comes from our own adapter, so it is safe to surface.
    return { message: raw, retryable: e.retryable, status: 502 };
  }

  // Network-level failures never reached the provider.
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|socket hang up|network/i.test(raw)) {
    return {
      message: 'Could not reach the AI provider. Check your network connection.',
      retryable: true,
      status: 502,
    };
  }

  // Our own guardrails throw plain Errors with intentionally readable text.
  if (/did not produce an outline|no valid slides/i.test(raw)) {
    return {
      message:
        'The AI did not return a usable deck. Try rephrasing your request, or asking for a specific number of slides.',
      retryable: true,
      status: 502,
    };
  }

  return {
    message: 'Something went wrong on our side. Please try again.',
    retryable: true,
    status: 500,
  };
}

/** One-line server log with the original error preserved. */
export function logError(scope: string, e: unknown): void {
  const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  console.error(`[${scope}] ${detail}`, e instanceof Error ? e.stack : '');
}
