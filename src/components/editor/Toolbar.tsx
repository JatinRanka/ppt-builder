'use client';
/**
 * TOOLBAR — deck-level actions: undo/redo, layout, theme, export.
 *
 * Undo/redo drive the unified history stack, so a single Cmd+Z steps back
 * through AI and manual changes interleaved in the order they happened. That is
 * only possible because both go through one dispatch.
 */
import { useEffect, useState } from 'react';
import { useDeckStore } from '@/lib/state/store';
import { THEMES } from '@/lib/themes';
import type { LayoutHint, SlideKind, ThemeName } from '@/lib/schema/deck';

const LAYOUTS: LayoutHint['variant'][] = [
  'single', 'two-col', 'image-left', 'image-right', 'full-bleed', 'centered',
];
const KINDS: SlideKind[] = [
  'title', 'section', 'content', 'two-column', 'comparison', 'quote', 'metrics', 'image-full', 'blank',
];

/** One styled select, so the four controls below cannot drift apart. */
function Field({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-center gap-1.5 text-(--app-faint)">
      <span className="hidden lg:inline">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="bg-(--app-subtle) border border-(--app-border) rounded-[8px] pl-2 pr-1.5 py-1 text-(--app-fg) font-medium transition-colors hover:border-(--app-border-strong) focus:outline-none focus:ring-2 focus:ring-(--app-accent)/30 focus:border-(--app-accent)/40"
      >
        {children}
      </select>
    </label>
  );
}

export function Toolbar() {
  // Export state lives here so the button can disable itself (a double-click
  // would build the deck twice) and report failures inline instead of alert().
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const deck = useDeckStore((s) => s.deck);
  const selectedId = useDeckStore((s) => s.selectedSlideId);
  const dispatch = useDeckStore((s) => s.dispatch);
  const undo = useDeckStore((s) => s.undo);
  const redo = useDeckStore((s) => s.redo);
  const past = useDeckStore((s) => s.past.length);
  const future = useDeckStore((s) => s.future.length);

  const slide = deck.slides.find((s) => s.id === selectedId) ?? null;

  // Global keyboard shortcuts. Skipped while editing text so Cmd+Z inside a
  // contentEditable still does native character-level undo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable || target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  const iconBtn =
    'w-7 h-7 grid place-items-center rounded-[8px] text-(--app-muted) transition-all hover:bg-(--app-surface) hover:text-(--app-fg) active:scale-[0.94] disabled:opacity-30 disabled:hover:bg-transparent disabled:active:scale-100';

  return (
    <div className="relative h-12 shrink-0 border-b border-(--app-border) bg-(--app-surface) flex items-center gap-2 px-3 text-xs">
      {/* Undo/redo read as one segmented unit rather than two loose glyphs. */}
      <div className="flex items-center gap-0.5 p-0.5 rounded-[10px] bg-(--app-subtle) border border-(--app-border)">
        <button onClick={undo} disabled={past === 0} title="Undo (⌘Z)" className={iconBtn}>
          ↶
        </button>
        <button onClick={redo} disabled={future === 0} title="Redo (⌘⇧Z)" className={iconBtn}>
          ↷
        </button>
      </div>

      <span className="w-px h-5 bg-(--app-border)" aria-hidden />

      {slide ? (
        <>
          <Field
            label="Type"
            value={slide.kind}
            onChange={(v) =>
              dispatch({ t: 'update_slide', id: slide.id, fields: { kind: v as SlideKind } }, { manual: true })
            }
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </Field>

          <Field
            label="Layout"
            value={slide.layout.variant}
            onChange={(v) =>
              dispatch(
                { t: 'set_layout', id: slide.id, layout: { variant: v as LayoutHint['variant'] } },
                { manual: true }
              )
            }
          >
            {LAYOUTS.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </Field>

          <Field
            label="Align"
            value={slide.layout.align}
            onChange={(v) =>
              dispatch(
                { t: 'set_layout', id: slide.id, layout: { align: v as 'left' | 'center' } },
                { manual: true }
              )
            }
          >
            <option value="left">left</option>
            <option value="center">center</option>
          </Field>
        </>
      ) : (
        <span className="text-(--app-faint)">Select a slide to edit its layout</span>
      )}

      <div className="flex-1" />

      <Field
        label="Theme"
        value={deck.theme}
        onChange={(v) => dispatch({ t: 'set_theme', theme: v as ThemeName })}
      >
        {Object.values(THEMES).map((t) => (
          <option key={t.name} value={t.name}>{t.label}</option>
        ))}
      </Field>

      <span className="w-px h-5 bg-(--app-border)" aria-hidden />

      <a
        href="/print"
        target="_blank"
        rel="noopener noreferrer"
        className="px-2.5 py-1.5 rounded-(--r-control) font-medium text-(--app-muted) transition-all hover:bg-(--app-subtle) hover:text-(--app-fg) active:scale-[0.97]"
        title="Open a print-ready view, then use your browser's Print to PDF"
      >
        PDF
      </a>
      <button
        disabled={exporting}
        onClick={async () => {
          if (exporting) return; // a double-click would build the deck twice
          setExporting(true);
          setExportError(null);
          let href: string | null = null;
          try {
            const res = await fetch('/api/export/pptx', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ deck }),
            });
            if (!res.ok) {
              // The route returns plain-text, already user-safe.
              setExportError((await res.text()).slice(0, 200) || `Export failed (${res.status}).`);
              return;
            }
            const blob = await res.blob();
            if (blob.size === 0) {
              setExportError('The export came back empty. Try the PDF export instead.');
              return;
            }
            // A title of only punctuation would otherwise yield ".pptx".
            const safeName =
              deck.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() ||
              'presentation';
            href = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = href;
            a.download = `${safeName}.pptx`;
            a.click();
          } catch (e) {
            // A network failure never reached the route, so there is no response text.
            setExportError(
              `Could not reach the server to build the file. ${(e as Error).message ?? ''}`.trim()
            );
          } finally {
            // Revoke in finally: an early return would otherwise leak the blob.
            if (href) URL.revokeObjectURL(href);
            setExporting(false);
          }
        }}
        className="px-3 py-1.5 rounded-(--r-control) font-medium bg-(--app-accent) text-white shadow-sm transition-all hover:bg-(--app-accent-hover) active:scale-[0.97] disabled:opacity-50"
      >
        {exporting ? 'Building…' : 'Export PPTX'}
      </button>
      {/* Inline, dismissible — alert() blocks the whole tab and cannot be
          styled or copied from. */}
      {exportError && (
        <div
          role="alert"
          className="absolute right-3 top-12 z-20 max-w-xs rounded-md border border-red-800 bg-red-950/95 px-3 py-2 text-xs text-red-100 shadow-lg"
        >
          <span>{exportError}</span>
          <button
            onClick={() => setExportError(null)}
            className="ml-2 text-red-300 hover:text-white"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
