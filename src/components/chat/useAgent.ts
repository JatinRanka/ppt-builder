'use client';
/**
 * Shared client-side stream consumption.
 *
 * Extracted so /api/chat and /api/fill are read identically: both emit the same
 * AgentEvent protocol, and both route every `op` through store.dispatch.
 */
import { useDeckStore } from '@/lib/state/store';
import { createEventParser, type AgentEvent } from '@/lib/agent/protocol';
import type { ChatToolCall } from '@/lib/state/store';

export interface StreamHandlers {
  onPhase?: (label: string, total?: number) => void;
  onProgress?: (done: number, total: number) => void;
  /** Full tool event, so the UI can show args and resulting ops. */
  onTool?: (call: ChatToolCall) => void;
  /** Non-tool notices (truncation, rate-limit retries). */
  onNotice?: (line: string) => void;
  onMessage?: (text: string) => void;
  onError?: (message: string) => void;
}

/**
 * POST to an agent endpoint and apply the streamed ops.
 * Returns the final assistant message, if any.
 */
export async function streamAgent(
  url: string,
  body: unknown,
  handlers: StreamHandlers = {},
  signal?: AbortSignal
): Promise<string | null> {
  const { dispatch, selectSlide } = useDeckStore.getState();

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    handlers.onError?.(err.error ?? `HTTP ${res.status}`);
    return null;
  }
  if (!res.body) {
    handlers.onError?.('No response body');
    return null;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parse = createEventParser();
  let finalText: string | null = null;
  let firstNew: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const ev of parse(decoder.decode(value, { stream: true }))) {
        // Isolate each event. One malformed op must not abandon the rest of
        // the stream — the alternative leaves the UI stuck "busy" forever with
        // a half-applied deck and no explanation.
        try {
          applyEvent(ev);
        } catch (err) {
          console.error('[stream] failed to apply event', ev.type, err);
          handlers.onNotice?.(
            `An update could not be applied (${ev.type}). The rest of the response continued.`
          );
        }
      }
    }
  } catch (err) {
    // A mid-stream network drop: report it rather than hanging.
    if ((err as Error)?.name !== 'AbortError') {
      handlers.onError?.(
        `The connection dropped partway through. ${
          firstNew ? 'Changes made so far were kept.' : 'Please try again.'
        }`
      );
    }
  } finally {
    // Always release the lock, even on an early throw, so a later request can
    // read a fresh body.
    reader.releaseLock();
  }

  function applyEvent(ev: AgentEvent) {
    switch (ev.type) {
      case 'op':
        dispatch(ev.op);
        if (ev.op.t === 'add_slide' && !firstNew) {
          firstNew = ev.op.slide.id;
          selectSlide(ev.op.slide.id);
        }
        break;
      case 'phase':
        handlers.onPhase?.(
          ev.phase === 'outline'
            ? 'Planning the deck outline…'
            : ev.phase === 'content'
            ? 'Writing slide content…'
            : 'Working out the change…',
          ev.total
        );
        break;
      case 'slide_progress':
        handlers.onProgress?.(ev.done, ev.total);
        break;
      case 'tool':
        handlers.onTool?.({
          name: ev.name,
          summary: ev.summary,
          status: ev.status,
          args: ev.args,
          ops: ev.ops,
          phase: ev.phase,
          error: ev.error,
        });
        break;
      case 'warning':
        handlers.onNotice?.(ev.message);
        break;
      case 'message':
        finalText = ev.text;
        handlers.onMessage?.(ev.text);
        break;
      case 'error':
        handlers.onError?.(ev.message);
        break;
      case 'done':
        break;
    }
  }

  return finalText;
}

/** Retry content generation for slides still sitting as empty skeletons. */
export async function fillPendingSlidesClient() {
  const { setMessages } = useDeckStore.getState();
  const toolCalls: ChatToolCall[] = [];
  const notices: string[] = [];
  const text = await streamAgent(
    '/api/fill',
    { deck: useDeckStore.getState().deck },
    {
      onTool: (c) => toolCalls.push(c),
      onNotice: (n) => notices.push(n),
      onError: (m) => setMessages((prev) => [...prev, { role: 'system', content: m }]),
    }
  );
  if (text || toolCalls.length) {
    setMessages((prev) => [
      ...prev,
      { role: 'assistant', content: text ?? 'Done.', toolCalls, notices },
    ]);
  }
}
