'use client';
/**
 * PRINT VIEW — the PDF export path.
 *
 * Reuses SlideFrame at scale 1 (1280x720) with @page sized to match, so one
 * slide fills one landscape page exactly. Because it renders the SAME
 * components as the editor, the PDF cannot drift from what the user saw — which
 * is the main argument for this approach over a separate export renderer.
 *
 * Reads the deck from the persisted store, so opening this in a new tab picks
 * up the current deck without passing it through the URL.
 */
import { useEffect, useState } from 'react';
import { useDeckStore } from '@/lib/state/store';
import { SlideFrame } from '@/components/editor/SlideFrame';

export default function PrintPage() {
  const deck = useDeckStore((s) => s.deck);

  // Zustand's persist middleware rehydrates from localStorage after mount, so
  // rendering immediately would print the default deck instead of the user's.
  // Subscribing to the persist API directly is not viable here: this route is
  // statically prerendered, where `useDeckStore.persist` does not exist yet.
  // A mount flag is the portable option, and the effect body is a plain
  // assignment so it cannot cascade.
  const [mounted, setMounted] = useState(false);

  // Fit the 1280px slide to the window for the on-screen preview. Without this
  // the page scrolled sideways on any viewport under ~1330px.
  const [previewScale, setPreviewScale] = useState(1);
  useEffect(() => {
    const fit = () => setPreviewScale(Math.min(1, (window.innerWidth - 64) / 1280));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  useEffect(() => {
    let cancelled = false;
    // Defer past rehydration, which persist performs synchronously on mount.
    const id = requestAnimationFrame(() => {
      if (!cancelled) setMounted(true);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
    };
  }, []);

  if (!mounted) {
    return <div className="p-8 text-sm text-(--app-muted)">Loading deck…</div>;
  }

  return (
    <div className="bg-(--app-bg) min-h-screen print:bg-white">
      <div className="no-print sticky top-0 z-10 bg-(--app-surface)/90 backdrop-blur-md border-b border-(--app-border) px-5 py-3 flex items-center gap-3">
        <div className="flex-1">
          <p className="text-sm font-semibold tracking-tight text-(--app-fg)">{deck.title}</p>
          <p className="text-xs text-(--app-muted)">
            {deck.slides.length} slides · print or save as PDF at 1280×720 landscape
          </p>
        </div>
        <button
          onClick={() => window.print()}
          className="px-3.5 py-2 rounded-(--r-control) bg-(--app-accent) hover:bg-(--app-accent-hover) text-white text-xs font-medium shadow-sm transition-all active:scale-[0.97]"
        >
          Print / Save as PDF
        </button>
      </div>

      <div className="flex flex-col items-center gap-6 p-6 print:p-0 print:gap-0">
        {deck.slides.map((slide) => (
          /* The outer box reserves the SCALED height so the document flows
             correctly; the inner slide stays exactly 1280x720 and is scaled
             visually. Print resets the scale to 1 (see globals.css) so pages
             come out at true size. */
          <div
            key={slide.id}
            className="preview-page print-page rounded-(--r-slide) overflow-hidden ring-1 ring-(--app-border) shadow-[0_4px_24px_-6px_rgb(0_0_0/0.12)] print:rounded-none print:ring-0 print:shadow-none"
            style={{
              width: 1280 * previewScale,
              height: 720 * previewScale,
            }}
          >
            <div
              className="origin-top-left"
              style={{ width: 1280, height: 720, transform: `scale(${previewScale})` }}
            >
              <SlideFrame slide={slide} themeName={deck.theme} scale={1} />
            </div>
          </div>
        ))}
      </div>

      {deck.slides.some((s) => s.speakerNotes) && (
        <div className="no-print max-w-[1280px] mx-auto p-6 text-xs text-(--app-muted) space-y-2">
          <h2 className="text-sm text-(--app-fg) font-semibold tracking-tight">Speaker notes</h2>
          {deck.slides.map((s, i) =>
            s.speakerNotes ? (
              <p key={s.id}>
                <span className="text-(--app-faint) tabular-nums">{i + 1}.</span> {s.speakerNotes}
              </p>
            ) : null
          )}
        </div>
      )}
    </div>
  );
}
