/**
 * THE STORE — one dispatch, one history, for both AI and manual edits.
 *
 * Everything that mutates the deck goes through dispatch(). AI ops arriving
 * over the wire and a user typing in a text block both call the same function,
 * so a unified undo/redo stack comes for free and the two paths cannot diverge.
 *
 * Zustand chosen over Redux (boilerplate) and Context (re-render storms across
 * a 20-slide grid). Selector granularity means an AI patch to slide 7
 * re-renders only slide 7.
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { Deck, type Slide, type ThemeName } from '@/lib/schema/deck';
import { applyOp, describeOp, opTargetSlide, OpError, type DeckOp } from './ops';
import { makeSampleDeck } from '@/lib/schema/factory';

const HISTORY_LIMIT = 100;

/**
 * A chat turn. Lives in the store rather than in ChatPanel's local state
 * because "New deck" (in DeckTitle, a sibling component) must also clear the
 * conversation — starting a fresh deck while keeping the old transcript would
 * leave the AI answering against slides that no longer exist.
 */
/** One tool invocation, recorded for display under an assistant turn. */
export interface ChatToolCall {
  name: string;
  summary: string;
  status: 'ok' | 'error';
  /** Raw arguments the model produced. */
  args?: Record<string, unknown>;
  /** DeckOps the call compiled to after validation. */
  ops?: DeckOp[];
  phase?: 'outline' | 'content' | 'edit';
  error?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /**
   * Structured tool calls, not pre-formatted strings: the UI needs the args
   * and resulting ops to show what the agent actually did, and a flat string
   * cannot carry that.
   */
  toolCalls?: ChatToolCall[];
  /** Non-tool notices (truncation warnings, rate-limit retries). */
  notices?: string[];
}

/** Identifies the exact field a user has focused, for conflict deferral. */
export interface EditingField {
  slideId: string;
  blockId: string | null; // null => a slide-level field (title/subtitle)
  field: string;
}

interface HistoryEntry {
  /** Op that undoes the change. */
  inverse: DeckOp;
  /** Op that redoes it. */
  redo: DeckOp;
  label: string;
}

export interface DispatchOptions {
  /** Skip pushing to history (used when replaying undo/redo itself). */
  history?: boolean;
  /** A manual edit marks the slide dirty so AI phase 2 skips it. */
  manual?: boolean;
  /** Bypass the editing-field guard (used when flushing deferred ops). */
  force?: boolean;
}

interface DeckState {
  deck: Deck;
  messages: ChatMessage[];
  selectedSlideId: string | null;
  editingField: EditingField | null;
  /** AI ops deferred because they hit the field the user is editing. */
  deferred: DeckOp[];
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** Last op error, surfaced in the UI rather than thrown into the void. */
  lastError: string | null;

  dispatch: (op: DeckOp, opts?: DispatchOptions) => boolean;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  setMessages: (next: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
  clearChat: () => void;

  selectSlide: (id: string | null) => void;
  setEditingField: (f: EditingField | null) => void;
  setTheme: (t: ThemeName) => void;
  replaceDeck: (deck: Deck) => void;
  clearError: () => void;
}

/** Does this op collide with the exact field the user currently has focused? */
function collidesWithEditing(op: DeckOp, editing: EditingField | null): boolean {
  if (!editing) return false;
  if (opTargetSlide(op) !== editing.slideId) return false;

  if (op.t === 'patch_block') {
    return op.blockId === editing.blockId && Object.keys(op.patch).includes(editing.field);
  }
  if (op.t === 'update_slide') {
    // Slide-level field (title/subtitle) being edited by hand.
    return editing.blockId === null && Object.keys(op.fields).includes(editing.field);
  }
  if (op.t === 'set_blocks') {
    // Wholesale block replacement would nuke the block being typed in.
    return editing.blockId !== null;
  }
  if (op.t === 'delete_slide') return true;
  return false;
}

export const useDeckStore = create<DeckState>()(
  persist(
    (set, get) => ({
      deck: makeSampleDeck(),
      messages: [],
      selectedSlideId: null,
      editingField: null,
      deferred: [],
      past: [],
      future: [],
      lastError: null,

      /**
       * The one mutation entry point. Returns false if the op was rejected or
       * deferred, so callers (like the agent stream) can report accurately.
       */
      dispatch: (op, opts = {}) => {
        const { history = true, manual = false, force = false } = opts;
        const state = get();

        // Guard: defer (never drop) an AI op that would clobber active typing.
        // The user's keystroke always wins; the op is replayed on blur.
        if (!force && !manual && collidesWithEditing(op, state.editingField)) {
          set({ deferred: [...state.deferred, op] });
          return false;
        }

        try {
          const { deck, inverse } = applyOp(state.deck, op);

          // A manual edit marks the slide dirty -> AI phase 2 will skip it, so
          // hand-written content is preserved by construction.
          let finalDeck = deck;
          if (manual) {
            const target = opTargetSlide(op);
            if (target) {
              finalDeck = {
                ...deck,
                slides: deck.slides.map((s) =>
                  s.id === target ? { ...s, dirty: true } : s
                ),
              };
            }
          }

          set({
            deck: finalDeck,
            lastError: null,
            ...(history
              ? {
                  past: [
                    ...state.past.slice(-(HISTORY_LIMIT - 1)),
                    { inverse, redo: op, label: describeOp(op) },
                  ],
                  future: [], // a new action invalidates the redo branch
                }
              : {}),
          });
          return true;
        } catch (e) {
          const msg = e instanceof OpError ? e.message : String(e);
          set({ lastError: msg });
          return false;
        }
      },

      undo: () => {
        const { past, deck } = get();
        const entry = past[past.length - 1];
        if (!entry) return;
        try {
          const { deck: next } = applyOp(deck, entry.inverse);
          set({
            deck: next,
            past: past.slice(0, -1),
            future: [entry, ...get().future],
          });
        } catch (e) {
          set({ lastError: `undo failed: ${String(e)}` });
        }
      },

      redo: () => {
        const { future, deck } = get();
        const entry = future[0];
        if (!entry) return;
        try {
          const { deck: next } = applyOp(deck, entry.redo);
          set({
            deck: next,
            future: future.slice(1),
            past: [...get().past, entry],
          });
        } catch (e) {
          set({ lastError: `redo failed: ${String(e)}` });
        }
      },

      canUndo: () => get().past.length > 0,
      canRedo: () => get().future.length > 0,

      setMessages: (next) =>
        set((s) => ({
          messages: typeof next === 'function' ? next(s.messages) : next,
        })),

      /** Drop the transcript. The deck is deliberately left untouched. */
      clearChat: () => set({ messages: [] }),

      selectSlide: (id) => set({ selectedSlideId: id }),

      /**
       * On blur, flush any ops that were deferred while this field was focused.
       * Applied with force so they cannot be deferred a second time.
       */
      setEditingField: (f) => {
        const { editingField, deferred } = get();
        const isBlur = editingField !== null && f === null;
        set({ editingField: f });
        if (isBlur && deferred.length) {
          set({ deferred: [] });
          for (const op of deferred) {
            get().dispatch(op, { force: true, history: false });
          }
        }
      },

      setTheme: (theme) => {
        get().dispatch({ t: 'set_theme', theme });
      },

      /**
       * Swap in a whole new deck. Also clears the chat: a transcript about the
       * previous deck's slides is worse than no transcript, because the AI
       * would keep reasoning about slide ids that no longer exist.
       */
      replaceDeck: (deck) =>
        set({
          deck,
          messages: [],
          past: [],
          future: [],
          selectedSlideId: null,
          deferred: [],
        }),

      clearError: () => set({ lastError: null }),
    }),
    {
      name: 'ppt-builder-deck',
      // History and transient UI state are deliberately not persisted — only
      // the deck and transcript survive a reload. Reloading to find your slides
      // intact but the conversation gone is disorienting, and the history we
      // send the model would silently reset.
      partialize: (s) => ({ deck: s.deck, messages: s.messages }),
      version: 1,
      storage: createJSONStorage(() => safeStorage),

      /**
       * Validate what came out of storage before trusting it.
       *
       * A persisted deck can be corrupt for mundane reasons: a quota-exceeded
       * write truncated the JSON, or it predates a schema change. Feeding that
       * straight into the renderer crashes on every load, and because the bad
       * value is persisted the crash is permanent — the user cannot get back in
       * to fix it. Validating here fails soft to the sample deck instead.
       */
      merge: (persisted, current) => {
        const saved = persisted as Partial<DeckState> | undefined;
        if (!saved) return current;

        const parsed = Deck.safeParse(saved.deck);
        if (!parsed.success) {
          console.warn(
            '[store] discarding unreadable saved deck:',
            parsed.error.issues[0]?.message
          );
          return current; // falls back to the sample deck
        }

        // Messages are cosmetic; drop them rather than fail if malformed.
        const messages = Array.isArray(saved.messages)
          ? saved.messages.filter(
              (m): m is ChatMessage =>
                !!m && typeof m === 'object' && typeof (m as ChatMessage).content === 'string'
            )
          : [];

        return { ...current, deck: parsed.data, messages };
      },
    }
  )
);

/**
 * localStorage that cannot throw.
 *
 * `localStorage` throws on access in some privacy modes, and `setItem` throws
 * QuotaExceededError once a deck grows past the ~5MB budget (images are URLs,
 * but a 60-slide deck with long text gets close). An unhandled throw here would
 * take down whatever action triggered the write — i.e. editing a slide would
 * fail because *saving* failed. Degrading to in-memory keeps the app usable for
 * the session and warns once.
 */
let storageWarned = false;
const memoryFallback = new Map<string, string>();

const safeStorage: Storage = {
  get length() {
    try {
      return window.localStorage.length;
    } catch {
      return memoryFallback.size;
    }
  },
  key(i) {
    try {
      return window.localStorage.key(i);
    } catch {
      return [...memoryFallback.keys()][i] ?? null;
    }
  },
  getItem(k) {
    try {
      return window.localStorage.getItem(k);
    } catch {
      return memoryFallback.get(k) ?? null;
    }
  },
  setItem(k, v) {
    try {
      window.localStorage.setItem(k, v);
    } catch (e) {
      memoryFallback.set(k, v);
      if (!storageWarned) {
        storageWarned = true;
        console.warn(
          '[store] could not save to localStorage (quota or private mode). ' +
            'The deck is kept in memory for this session only.',
          e
        );
      }
    }
  },
  removeItem(k) {
    try {
      window.localStorage.removeItem(k);
    } catch {
      memoryFallback.delete(k);
    }
  },
  clear() {
    try {
      window.localStorage.clear();
    } catch {
      memoryFallback.clear();
    }
  },
};

// --- Selectors (keep components subscribed as narrowly as possible) ---------

export const selectSlides = (s: DeckState) => s.deck.slides;
export const selectTheme = (s: DeckState) => s.deck.theme;
export const selectSlideById = (id: string) => (s: DeckState) =>
  s.deck.slides.find((sl) => sl.id === id);

export function slideIndex(slides: Slide[], id: string | null): number {
  return id ? slides.findIndex((s) => s.id === id) : -1;
}
