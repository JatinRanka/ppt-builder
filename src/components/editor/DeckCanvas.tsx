'use client';
/**
 * CANVAS — the scrolling slide list. Clicking a slide selects it; the selected
 * slide renders larger and becomes editable.
 *
 * A single scrolling column (rather than one-slide-at-a-time) makes AI
 * streaming legible: as phase 2 fills slides you watch them populate in place.
 */
import { useEffect, useRef, useState } from 'react';
import { useDeckStore } from '@/lib/state/store';
import { SlideFrame, SLIDE_W, SLIDE_H } from './SlideFrame';

/** Horizontal padding around the slide column, in px. */
const GUTTER = 88;
const MAX_SCALE = 0.75;
const MIN_SCALE = 0.28;

export function DeckCanvas() {
  const deck = useDeckStore((s) => s.deck);
  const selectedId = useDeckStore((s) => s.selectedSlideId);
  const selectSlide = useDeckStore((s) => s.selectSlide);
  const lastError = useDeckStore((s) => s.lastError);
  const clearError = useDeckStore((s) => s.clearError);
  const containerRef = useRef<HTMLDivElement>(null);

  // A fixed scale clipped the slide whenever the window was narrower than
  // 1280*scale + gutter (observed at 1280px viewport: 794px slide in a 685px
  // canvas). Derive the scale from the measured canvas instead so the slide
  // always fits, and never exceed MAX_SCALE on wide screens.
  const [scale, setScale] = useState(0.55);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const usable = el.clientWidth - GUTTER;
      setScale(Math.max(MIN_SCALE, Math.min(MAX_SCALE, usable / SLIDE_W)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Select the first slide on load so the editor is immediately usable —
  // otherwise a new visitor sees no editable text and no layout controls.
  useEffect(() => {
    if (!selectedId && deck.slides.length > 0) selectSlide(deck.slides[0].id);
  }, [selectedId, deck.slides, selectSlide]);

  // Keep the selected slide in view when selection changes from elsewhere
  // (e.g. the AI adds a slide and we jump to it).
  useEffect(() => {
    if (!selectedId) return;
    const el = containerRef.current?.querySelector(`[data-slide-id="${selectedId}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [selectedId]);

  return (
    <div
      ref={containerRef}
      className="pane-scroll flex-1 overflow-y-auto overflow-x-hidden bg-(--app-bg) py-8 px-10"
    >
      {lastError && (
        <div className="mb-4 mx-auto max-w-[800px] rounded-(--r-panel) border border-red-200 bg-(--app-danger-soft) px-3.5 py-2.5 text-xs text-red-700 flex items-start gap-2 shadow-sm">
          <span className="flex-1 leading-relaxed">{lastError}</span>
          <button
            onClick={clearError}
            className="shrink-0 w-4 h-4 grid place-items-center rounded text-red-400 transition-colors hover:text-red-700"
            aria-label="Dismiss error"
          >
            ✕
          </button>
        </div>
      )}

      {deck.slides.length === 0 ? (
        <div className="h-full grid place-items-center text-center">
          <div className="max-w-sm space-y-3">
            {/* A quiet placeholder glyph rather than bare text: the empty
                state is the first thing a new user sees. */}
            <div className="mx-auto w-12 h-12 rounded-(--r-panel) border border-dashed border-(--app-border-strong) grid place-items-center text-(--app-faint)">
              ▤
            </div>
            <p className="text-(--app-fg) text-sm font-medium">This deck is empty</p>
            <p className="text-(--app-muted) text-xs leading-relaxed">
              Describe the deck you want in the chat panel, or add a blank slide from the rail.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-8">
          {deck.slides.map((slide, i) => {
            const isSel = slide.id === selectedId;
            return (
              <div
                key={slide.id}
                data-slide-id={slide.id}
                onClick={() => selectSlide(slide.id)}
                /* Keyed on id, so a slide arriving from phase 2 plays the
                   entrance once rather than on every re-render. */
                className="relative animate-slide-in"
              >
                <div className="absolute -left-7 top-0.5 text-[11px] text-(--app-faint) tabular-nums select-none">
                  {i + 1}
                </div>
                <div
                  className={`overflow-hidden rounded-(--r-slide) transition-all duration-200 ${
                    isSel
                      ? 'ring-2 ring-(--app-accent) shadow-[0_10px_34px_-8px_rgb(0_0_0/0.22)]'
                      : 'ring-1 ring-black/[0.07] shadow-[0_2px_8px_-2px_rgb(0_0_0/0.12)] hover:ring-black/[0.12] hover:shadow-[0_6px_20px_-4px_rgb(0_0_0/0.16)]'
                  }`}
                  style={{ width: SLIDE_W * scale, height: SLIDE_H * scale }}
                >
                  <SlideFrame
                    slide={slide}
                    themeName={deck.theme}
                    scale={scale}
                    editable={isSel}
                  />
                </div>
                {isSel && (
                  <div className="mt-2 flex items-start gap-2 text-[11px]">
                    <span className="shrink-0 pt-1.5 text-(--app-faint) font-medium">Notes</span>
                    <SpeakerNotes slideId={slide.id} notes={slide.speakerNotes} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Speaker notes live outside the slide surface but are part of the schema. */
function SpeakerNotes({ slideId, notes }: { slideId: string; notes: string }) {
  const dispatch = useDeckStore((s) => s.dispatch);
  const setEditingField = useDeckStore((s) => s.setEditingField);
  return (
    <textarea
      defaultValue={notes}
      key={notes}
      rows={2}
      placeholder="Speaker notes…"
      onFocus={() => setEditingField({ slideId, blockId: null, field: 'speakerNotes' })}
      onBlur={(e) => {
        setEditingField(null);
        if (e.target.value !== notes) {
          dispatch(
            { t: 'update_slide', id: slideId, fields: { speakerNotes: e.target.value } },
            { manual: true }
          );
        }
      }}
      className="flex-1 bg-(--app-surface) border border-(--app-border) rounded-(--r-control) px-2.5 py-1.5 text-(--app-fg) placeholder:text-(--app-faint) resize-y transition-colors hover:border-(--app-border-strong) focus:outline-none focus:border-(--app-accent)/40 focus:ring-2 focus:ring-(--app-accent)/20"
    />
  );
}
