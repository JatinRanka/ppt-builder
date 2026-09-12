/**
 * WIRE PROTOCOL — NDJSON events from server to client.
 *
 * NDJSON rather than SSE: simpler to emit and parse, and it avoids SSE's
 * automatic-reconnect semantics, which we do not want (a retried generation
 * would duplicate slides).
 *
 * `op` is the ONLY event that mutates deck state on the client. Everything else
 * is presentational. That invariant is what keeps AI edits flowing through the
 * same single dispatch path as manual ones.
 */
import type { DeckOp } from '@/lib/state/ops';

export type AgentEvent =
  /** Which generation phase we entered; drives the progress UI. */
  | { type: 'phase'; phase: 'outline' | 'content' | 'edit'; total?: number }
  /** A validated deck mutation. Apply verbatim via store.dispatch. */
  | { type: 'op'; op: DeckOp }
  /** Progress within phase 2. */
  | { type: 'slide_progress'; slideId: string; done: number; total: number }
  /** Assistant chat text (may arrive in fragments). */
  | { type: 'message'; text: string; final?: boolean }
  /**
   * A tool call was made. Carries the FULL call so the UI can show exactly what
   * the agent did: the arguments the model produced, the ops they compiled to,
   * and whether it succeeded. A one-line summary alone hides the interesting
   * part — which slide was targeted and what changed.
   */
  | {
      type: 'tool';
      /** Provider-assigned id, for correlating retries of the same call. */
      id?: string;
      name: string;
      /** Human-readable one-liner, still used for the collapsed row. */
      summary: string;
      /** Raw arguments the model emitted, post-JSON-parse. */
      args?: Record<string, unknown>;
      /** The DeckOps this call compiled to, after validation/normalization. */
      ops?: DeckOp[];
      /** Which generation phase produced it. */
      phase?: 'outline' | 'content' | 'edit';
      status: 'ok' | 'error';
      /** Validation message when status is 'error'. */
      error?: string;
      /** Wall-clock duration of the provider call, when known. */
      ms?: number;
    }
  /** Recoverable problem; generation continues. */
  | { type: 'warning'; message: string }
  /** Fatal for this request. */
  | { type: 'error'; message: string; slideId?: string }
  | { type: 'done' };

/** Serialize one event as a single NDJSON line. */
export function encodeEvent(e: AgentEvent): string {
  return JSON.stringify(e) + '\n';
}

/** Parse a stream of NDJSON into events, tolerating split chunks. */
export function createEventParser() {
  let buffer = '';
  return function parse(chunk: string): AgentEvent[] {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? ''; // last element is an incomplete line
    const events: AgentEvent[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as AgentEvent);
      } catch {
        // A malformed line is skipped rather than killing the stream.
      }
    }
    return events;
  };
}
