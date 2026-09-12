'use client';
import { useDeckStore } from '@/lib/state/store';
import { makeEmptyDeck, makeSampleDeck } from '@/lib/schema/factory';

export function DeckTitle() {
  const title = useDeckStore((s) => s.deck.title);
  const slideCount = useDeckStore((s) => s.deck.slides.length);
  const dispatch = useDeckStore((s) => s.dispatch);
  const replaceDeck = useDeckStore((s) => s.replaceDeck);

  return (
    <header className="h-14 shrink-0 border-b border-(--app-border) bg-(--app-surface) flex items-center px-4 gap-3">
      {/* Wordmark: the one place the product gets to introduce itself. The mark
          carries the accent so the rest of the chrome doesn't have to. */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="grid place-items-center w-6 h-6 rounded-[7px] bg-(--app-accent) text-white text-[11px] font-semibold tracking-tight">
          D
        </span>
        <span className="text-sm font-semibold tracking-tight text-(--app-fg) hidden sm:inline">
          Deckwright
        </span>
      </div>

      <span className="w-px h-5 bg-(--app-border) shrink-0" aria-hidden />

      <input
        value={title}
        onChange={(e) => dispatch({ t: 'set_deck_title', title: e.target.value }, { history: false })}
        className="bg-transparent text-sm font-medium text-(--app-fg) placeholder:text-(--app-faint) rounded-(--r-control) px-2 py-1.5 min-w-0 flex-1 transition-colors hover:bg-(--app-subtle) focus:outline-none focus:bg-(--app-surface) focus:ring-2 focus:ring-(--app-accent)/30"
        placeholder="Untitled deck"
        aria-label="Deck title"
      />

      <span className="text-xs text-(--app-faint) shrink-0 tabular-nums">
        {slideCount} slide{slideCount === 1 ? '' : 's'}
      </span>

      <div className="flex items-center gap-1 shrink-0">
        {/* An explicit escape hatch: the first-run sample deck is useful for
            seeing what the product does, but a user starting real work needs a
            one-click way out that does not require phrasing a prompt. */}
        <button
          onClick={() => {
            if (
              slideCount > 0 &&
              !confirm('Start a new empty deck? This clears the current slides and the conversation.')
            )
              return;
            replaceDeck(makeEmptyDeck());
          }}
          className="text-xs font-medium px-2.5 py-1.5 rounded-(--r-control) text-(--app-muted) transition-all hover:bg-(--app-subtle) hover:text-(--app-fg) active:scale-[0.97]"
          title="Clear all slides and the conversation, and start fresh"
        >
          New
        </button>
        <button
          onClick={() => replaceDeck(makeSampleDeck())}
          className="text-xs font-medium px-2.5 py-1.5 rounded-(--r-control) text-(--app-muted) transition-all hover:bg-(--app-subtle) hover:text-(--app-fg) active:scale-[0.97]"
          title="Reload the example deck"
        >
          Sample
        </button>
      </div>
    </header>
  );
}
