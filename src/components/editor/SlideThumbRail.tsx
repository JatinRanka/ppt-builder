'use client';
/**
 * THUMBNAIL RAIL — selection, drag-to-reorder, delete, duplicate.
 *
 * Reorder dispatches the same `reorder` op the AI uses, with a full permutation
 * of slide ids. Native HTML5 drag-and-drop is used rather than a library: the
 * interaction is simple enough that a dependency would not pay for itself.
 */
import { useState } from 'react';
import { useDeckStore } from '@/lib/state/store';
import { SlideFrame, SLIDE_W, SLIDE_H } from './SlideFrame';
import { cloneSlide, makeBlankSlide } from '@/lib/schema/factory';

/**
 * Rail geometry, derived rather than guessed.
 *
 * THUMB_SCALE used to be a hardcoded 0.148, which made the thumbnail
 * 1280*0.148 = 189.4px inside a flex column that allotted 187px. Every row
 * overflowed by ~2px, so the scroller's content (235px) exceeded its viewport
 * (223px) and the right edge of every thumbnail was clipped.
 *
 * Now the width is fixed and the SCALE follows from it, so they cannot drift.
 */
const RAIL_W = 224;
/** aside padding (8+8) + number gutter (14) + gap (6) + ring allowance (4). */
const RAIL_CHROME = 40;
const THUMB_W = RAIL_W - RAIL_CHROME;
const THUMB_SCALE = THUMB_W / SLIDE_W;

export function SlideThumbRail() {
  const deck = useDeckStore((s) => s.deck);
  const selectedId = useDeckStore((s) => s.selectedSlideId);
  const selectSlide = useDeckStore((s) => s.selectSlide);
  const dispatch = useDeckStore((s) => s.dispatch);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const reorder = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const ids = deck.slides.map((s) => s.id);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    dispatch({ t: 'reorder', ids }, { manual: true });
  };

  return (
    <aside
      style={{ width: RAIL_W }}
      className="shrink-0 border-r border-(--app-border) bg-(--app-surface) flex flex-col"
    >
      <div className="px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-(--app-faint) flex items-center justify-between">
        <span>Slides</span>
        <span className="tabular-nums">{deck.slides.length}</span>
      </div>

      <div className="pane-scroll flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2 space-y-1.5">
        {deck.slides.map((slide, i) => {
          const isSel = slide.id === selectedId;
          const isOver = overId === slide.id && dragId !== slide.id;
          return (
            <div
              key={slide.id}
              draggable
              onDragStart={() => setDragId(slide.id)}
              onDragOver={(e) => {
                e.preventDefault();
                setOverId(slide.id);
              }}
              onDragLeave={() => setOverId((c) => (c === slide.id ? null : c))}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId) reorder(dragId, slide.id);
                setDragId(null);
                setOverId(null);
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
              onClick={() => selectSlide(slide.id)}
              className={`group flex items-start gap-1.5 cursor-pointer ${
                dragId === slide.id ? 'opacity-40' : ''
              }`}
            >
              {/* The number lives in its own gutter column. It used to be
                  absolutely positioned INSIDE the thumbnail, where it sat on
                  top of the slide title. */}
              <span
                className={`shrink-0 w-3.5 pt-2 text-right text-[10px] tabular-nums select-none transition-colors ${
                  isSel ? 'text-(--app-accent) font-semibold' : 'text-(--app-faint)'
                }`}
              >
                {i + 1}
              </span>
              <div
                style={{ width: THUMB_W }}
                className={`relative shrink-0 rounded-[10px] transition-all duration-150 ${
                  isSel
                    ? 'ring-2 ring-(--app-accent) shadow-sm'
                    : 'ring-1 ring-(--app-border) hover:ring-(--app-border-strong) hover:-translate-y-px hover:shadow-sm'
                } ${isOver ? 'ring-2 ring-(--app-accent)/50 translate-y-0.5' : ''}`}
              >
              {/* Fixed-size wrapper clips the transform-scaled slide. */}
              <div
                className="overflow-hidden rounded-[10px] pointer-events-none"
                style={{ width: THUMB_W, height: Math.round(SLIDE_H * THUMB_SCALE) }}
              >
                <SlideFrame slide={slide} themeName={deck.theme} scale={THUMB_SCALE} />
              </div>

              {slide.status !== 'ready' && (
                <div className="absolute bottom-1.5 left-1.5 text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-(--app-accent) text-white shadow-sm">
                  {slide.status}
                </div>
              )}
              {slide.dirty && (
                <div
                  className="absolute top-1.5 left-1.5 w-1.5 h-1.5 rounded-full bg-amber-500 ring-2 ring-white/70"
                  title="manually edited — AI regeneration will skip this slide"
                />
              )}

              <div className="absolute top-1 right-1 hidden group-hover:flex gap-0.5 bg-white/95 backdrop-blur-sm rounded-lg p-0.5 shadow-sm ring-1 ring-(--app-border)">
                <button
                  title="Duplicate"
                  onClick={(e) => {
                    e.stopPropagation();
                    dispatch({ t: 'add_slide', slide: cloneSlide(slide), afterId: slide.id }, { manual: true });
                  }}
                  className="w-5 h-5 grid place-items-center rounded-md text-[10px] text-(--app-muted) transition-colors hover:bg-(--app-subtle) hover:text-(--app-fg)"
                >
                  ⧉
                </button>
                <button
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (selectedId === slide.id) selectSlide(null);
                    dispatch({ t: 'delete_slide', id: slide.id }, { manual: true });
                  }}
                  className="w-5 h-5 grid place-items-center rounded-md text-[10px] text-(--app-muted) transition-colors hover:bg-(--app-danger-soft) hover:text-(--app-danger)"
                >
                  ✕
                </button>
                </div>
              </div>
            </div>
          );
        })}

        <button
          style={{ marginLeft: RAIL_CHROME - 20, width: THUMB_W }}
          onClick={() => {
            const slide = makeBlankSlide();
            const last = deck.slides.at(-1)?.id ?? null;
            dispatch({ t: 'add_slide', slide, afterId: last }, { manual: true });
            selectSlide(slide.id);
          }}
          className="mt-1.5 py-3 rounded-[10px] border border-dashed border-(--app-border-strong) text-(--app-muted) text-xs font-medium transition-all hover:border-(--app-accent) hover:text-(--app-accent) hover:bg-(--app-accent-soft) active:scale-[0.98]"
        >
          + Add slide
        </button>
      </div>
    </aside>
  );
}
