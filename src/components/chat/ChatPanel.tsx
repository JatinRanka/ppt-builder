'use client';
/**
 * CHAT PANEL — consumes the NDJSON agent stream.
 *
 * The important line in this file is the `case 'op'` branch: it calls the same
 * store.dispatch that manual editing calls. AI changes are not a special path;
 * they are the same path with a different origin. That is what makes the
 * unified undo stack and the conflict guard work.
 */
import { useEffect, useRef, useState } from 'react';
import { useDeckStore } from '@/lib/state/store';
import { fillPendingSlidesClient, streamAgent } from './useAgent';
import { ToolCallList } from './ToolCallDetail';
import type { ChatToolCall } from '@/lib/state/store';

const EXAMPLES = [
  'Create a 6-slide deck on our Q3 product roadmap',
  'Make slide 3 more concise',
  'Add a slide about pricing before the conclusion',
  'Rewrite the bullets on slide 2 as a comparison table',
  'Change the tone to be more formal',
];

export function ChatPanel() {
  const deck = useDeckStore((s) => s.deck);
  const selectedSlideId = useDeckStore((s) => s.selectedSlideId);

  // Messages live in the store, not local state, so DeckTitle's "New" button
  // can clear the transcript alongside the deck.
  const messages = useDeckStore((s) => s.messages);
  const setMessages = useDeckStore((s) => s.setMessages);
  const clearChat = useDeckStore((s) => s.clearChat);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  /** Tool calls for the turn currently streaming, shown before it completes. */
  const [liveCalls, setLiveCalls] = useState<ChatToolCall[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, phase, progress]);

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;

    setInput('');
    setBusy(true);
    setPhase(null);
    setProgress(null);
    setLiveCalls([]);

    const history = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
        // Send tool provenance, not just prose: a transcript of bare "I
        // removed X" replies teaches the model that edits are done by
        // describing them, and it stops calling tools entirely.
        toolCalls: m.toolCalls?.map((t) => ({ name: t.name, status: t.status })),
      }));

    setMessages((m) => [...m, { role: 'user', content: trimmed }]);

    const toolCalls: ChatToolCall[] = [];
    const notices: string[] = [];
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Same helper the retry path uses, so both endpoints are consumed
      // identically and every op goes through store.dispatch.
      const assistantText = await streamAgent(
        '/api/chat',
        {
          message: trimmed,
          // The client deck is authoritative; the server holds no session state.
          deck: useDeckStore.getState().deck,
          history,
          focusSlideId: selectedSlideId,
        },
        {
          onPhase: (label, total) => {
            setPhase(label);
            if (total) setProgress({ done: 0, total });
          },
          onProgress: (done, total) => setProgress({ done, total }),
          onTool: (c) => {
            toolCalls.push(c);
            // Surface calls as they stream rather than only at the end, so a
            // long generation shows its work in progress.
            setLiveCalls([...toolCalls]);
          },
          onNotice: (n) => notices.push(n),
          onError: (m) => setMessages((prev) => [...prev, { role: 'system', content: m }]),
        },
        controller.signal
      );

      if (assistantText || toolCalls.length) {
        setMessages((m) => [
          ...m,
          {
            role: 'assistant',
            content: assistantText || 'Done.',
            toolCalls: [...toolCalls],
            notices: [...notices],
          },
        ]);
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setMessages((m) => [...m, { role: 'system', content: `Failed: ${(e as Error).message}` }]);
      }
    } finally {
      setBusy(false);
      setPhase(null);
      setProgress(null);
      setLiveCalls([]);
      abortRef.current = null;
    }
  };

  const pendingCount = deck.slides.filter(
    (s) => s.status !== 'ready' && s.blocks.length === 0
  ).length;

  return (
    <aside className="w-[380px] shrink-0 border-l border-(--app-border) bg-(--app-surface) flex flex-col h-full">
      <header className="h-14 shrink-0 border-b border-(--app-border) flex items-center px-4 gap-2">
        <h2 className="text-sm font-semibold tracking-tight text-(--app-fg)">Assistant</h2>
        <div className="flex-1" />
        {messages.length > 0 ? (
          <button
            onClick={() => {
              // Abort any in-flight request first: its stream would otherwise
              // append a reply to the transcript we just emptied.
              abortRef.current?.abort();
              clearChat();
            }}
            disabled={busy}
            className="text-[11px] font-medium px-2 py-1 rounded-lg text-(--app-muted) transition-all hover:bg-(--app-subtle) hover:text-(--app-fg) active:scale-[0.97] disabled:opacity-40 disabled:hover:bg-transparent"
            title="Clear the conversation (your slides are kept)"
          >
            Clear
          </button>
        ) : (
          <span className="text-[10px] text-(--app-faint)">AI presentation builder</span>
        )}
      </header>

      <div ref={scrollRef} className="pane-scroll flex-1 overflow-y-auto p-3 space-y-2.5">
        {messages.length === 0 && (
          <div className="space-y-3 pt-1">
            <p className="text-xs text-(--app-muted) leading-relaxed px-0.5">
              Describe the deck you want, then refine it in conversation. You can also edit any
              slide directly — your manual edits are preserved when the AI makes changes.
            </p>
            <div className="space-y-1.5">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  onClick={() => send(ex)}
                  className="group w-full text-left text-xs px-3 py-2.5 rounded-(--r-control) bg-(--app-subtle) border border-(--app-border) text-(--app-muted) transition-all hover:border-(--app-accent)/30 hover:bg-(--app-accent-soft) hover:text-(--app-fg) hover:-translate-y-px active:scale-[0.99] flex items-center gap-2"
                >
                  <span className="flex-1 leading-snug">{ex}</span>
                  <span className="text-(--app-faint) opacity-0 transition-opacity group-hover:opacity-100 group-hover:text-(--app-accent)">
                    ↵
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`animate-msg-in ${m.role === 'user' ? 'flex justify-end' : ''}`}>
            <div
              className={`max-w-[92%] px-3 py-2 text-xs leading-relaxed ${
                m.role === 'user'
                  ? 'bg-(--app-accent) text-white rounded-[14px] rounded-br-[5px] shadow-sm'
                  : m.role === 'system'
                  ? 'bg-(--app-danger-soft) border border-red-200 text-red-700 rounded-(--r-panel)'
                  : 'bg-(--app-subtle) border border-(--app-border) text-(--app-fg) rounded-[14px] rounded-bl-[5px]'
              }`}
            >
              <p className="whitespace-pre-wrap">{m.content}</p>
              {m.notices && m.notices.length > 0 && (
                <ul className="mt-1.5 space-y-0.5">
                  {m.notices.map((n, j) => (
                    <li key={j} className="text-[10px] text-(--app-warn) break-words">
                      ⚠ {n}
                    </li>
                  ))}
                </ul>
              )}
              {m.toolCalls && m.toolCalls.length > 0 && <ToolCallList calls={m.toolCalls} />}
            </div>
          </div>
        ))}

        {busy && (
          <div className="animate-msg-in bg-(--app-subtle) border border-(--app-border) rounded-(--r-panel) px-3 py-2.5 text-xs text-(--app-muted)">
            <div className="flex items-center gap-2">
              <span className="relative flex w-1.5 h-1.5">
                <span className="absolute inline-flex w-full h-full rounded-full bg-(--app-accent) opacity-60 animate-ping" />
                <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-(--app-accent)" />
              </span>
              <span className="font-medium text-(--app-fg)">{phase ?? 'Thinking…'}</span>
            </div>
            {progress && (
              <div className="mt-2">
                <div className="h-1 bg-(--app-border) rounded-full overflow-hidden">
                  <div
                    className="h-full bg-(--app-accent) rounded-full transition-all duration-500 ease-out"
                    style={{ width: `${(progress.done / Math.max(progress.total, 1)) * 100}%` }}
                  />
                </div>
                <p className="text-[10px] text-(--app-faint) mt-1 tabular-nums">
                  {progress.done} of {progress.total} slides
                </p>
              </div>
            )}
            {/* Live tool calls: a 12-call generation should show its work while
                it runs, not reveal everything only once it finishes. */}
            {liveCalls.length > 0 && <ToolCallList calls={liveCalls} />}
          </div>
        )}

        {!busy && pendingCount > 0 && (
          <button
            onClick={() => fillPendingSlidesClient()}
            className="w-full text-xs font-medium px-3 py-2.5 rounded-(--r-control) bg-(--app-warn-soft) border border-amber-200 text-(--app-warn) transition-all hover:border-amber-400 hover:-translate-y-px active:scale-[0.99]"
          >
            Retry content for {pendingCount} empty slide{pendingCount === 1 ? '' : 's'}
          </button>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="shrink-0 border-t border-(--app-border) p-3"
      >
        <div className="relative">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            rows={2}
            placeholder={
              deck.slides.length === 0
                ? 'Describe the deck you want…'
                : 'Ask for a change, e.g. "make slide 2 more concise"'
            }
            disabled={busy}
            className="w-full bg-(--app-subtle) border border-(--app-border) rounded-(--r-panel) px-3 py-2.5 pr-16 text-xs text-(--app-fg) placeholder:text-(--app-faint) resize-none transition-colors hover:border-(--app-border-strong) focus:outline-none focus:bg-(--app-surface) focus:border-(--app-accent)/40 focus:ring-2 focus:ring-(--app-accent)/20 disabled:opacity-60"
          />
          {busy ? (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="absolute right-2 bottom-2 text-[10px] font-medium px-2 py-1 rounded-lg bg-(--app-surface) border border-(--app-border) text-(--app-muted) transition-all hover:text-(--app-fg) hover:border-(--app-border-strong) active:scale-[0.95]"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="absolute right-2 bottom-2 text-[10px] font-medium px-2.5 py-1 rounded-lg bg-(--app-accent) text-white shadow-sm transition-all hover:bg-(--app-accent-hover) active:scale-[0.95] disabled:opacity-30 disabled:shadow-none"
            >
              Send ↵
            </button>
          )}
        </div>
        {selectedSlideId && (
          <p className="text-[10px] text-(--app-faint) mt-1.5 px-0.5">
            Slide {deck.slides.findIndex((s) => s.id === selectedSlideId) + 1} selected — &ldquo;this
            slide&rdquo; refers to it
          </p>
        )}
      </form>
    </aside>
  );
}
