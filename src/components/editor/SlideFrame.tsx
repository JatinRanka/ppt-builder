'use client';
/**
 * SLIDE FRAME — renders one slide at a fixed 16:9 logical size (1280x720) and
 * scales it with a CSS transform.
 *
 * Fixed logical dimensions + transform scale is what makes the editor, the
 * thumbnail rail, and the print view pixel-identical: every context renders the
 * same 1280x720 surface and only the scale factor differs. Font sizes use `em`
 * relative to a root size set here, so text scales with the frame instead of
 * needing per-context breakpoints.
 */
import type { Slide } from '@/lib/schema/deck';
import { getTheme } from '@/lib/themes';
import { BlockRenderer } from '@/components/blocks/BlockRenderer';
import { EditableText } from '@/components/blocks/EditableText';
import { useDeckStore } from '@/lib/state/store';

export const SLIDE_W = 1280;
export const SLIDE_H = 720;

interface Props {
  slide: Slide;
  themeName: string;
  /** 1 = full size. Thumbnails ~0.15, editor ~0.6-0.9. */
  scale?: number;
  editable?: boolean;
  className?: string;
}

export function SlideFrame({ slide, themeName, scale = 1, editable = false, className = '' }: Props) {
  const theme = getTheme(themeName);
  const dispatch = useDeckStore((s) => s.dispatch);

  const main = slide.blocks.filter((b) => b.slot === 'main');
  const aside = slide.blocks.filter((b) => b.slot === 'aside');
  // Visual blocks expand to use the slide; pure text stacks from the top so it
  // does not float oddly in the middle of an otherwise empty slide.
  const hasVisual = slide.blocks.some(
    (b) => b.type === 'chart' || b.type === 'image'
  );
  const { variant, align, density } = slide.layout;

  const pad = density === 'compact' ? 56 : density === 'roomy' ? 88 : 72;
  const gap = density === 'compact' ? 16 : density === 'roomy' ? 32 : 24;
  const isCentered = align === 'center';
  const isTitleish = slide.kind === 'title' || slide.kind === 'section';
  // A title slide is designed for a headline, not a body. Models sometimes
  // attach content to one anyway; render it smaller rather than overflowing,
  // and keep it consistent with what the PPTX/PDF exporters produce.
  const titleWithBody = isTitleish && slide.blocks.length > 0;

  // Skeleton state for phase-1 slides that have no content yet.
  const isPending = slide.status !== 'ready' && slide.blocks.length === 0;

  return (
    <div
      className={`relative shrink-0 origin-top-left overflow-hidden ${className}`}
      style={{
        width: SLIDE_W,
        height: SLIDE_H,
        transform: `scale(${scale})`,
        background: 'var(--slide-bg)',
        color: 'var(--slide-fg)',
        fontFamily: 'var(--slide-font-body)',
        fontSize: 24, // the `em` root every block sizes against
        ...(theme.vars as React.CSSProperties),
      }}
    >
      {/* Accent mark: visual identity, and marks non-title slides. Inset to the
          slide's own padding and rounded, so it reads as a deliberate mark
          rather than a bar welded to the corner. */}
      {!isTitleish && (
        <div
          className="absolute rounded-full"
          style={{ top: pad, left: pad, height: 4, width: 56, background: 'var(--slide-accent)' }}
        />
      )}

      <div
        className={`w-full h-full flex flex-col ${
          // A centered title/section slide centres as a whole. Scoped to
          // title-ish slides so an empty CONTENT slide still starts at the top,
          // where its first block will appear.
          isCentered && isTitleish && !titleWithBody ? 'justify-center' : ''
        }`}
        style={{ padding: pad, gap }}
      >
        {/* --- Title --- */}
        <header
          className={`shrink-0 flex flex-col gap-[0.25em] ${
            isCentered ? 'text-center items-center' : ''
          }`}
          style={{ marginTop: isTitleish ? 0 : 20 }}
        >
          {editable ? (
            <EditableText
              as="h1"
              value={slide.title}
              onCommit={(title) => dispatch({ t: 'update_slide', id: slide.id, fields: { title } }, { manual: true })}
              slideId={slide.id}
              blockId={null}
              field="title"
              placeholder="Slide title"
              className={`font-bold leading-tight ${
                titleWithBody ? 'text-[2em]' : isTitleish ? 'text-[2.6em]' : 'text-[1.9em]'
              }`}
            />
          ) : (
            <h1
              className={`font-bold leading-tight ${
                titleWithBody ? 'text-[2em]' : isTitleish ? 'text-[2.6em]' : 'text-[1.9em]'
              }`}
              style={{ fontFamily: 'var(--slide-font-title)' }}
            >
              {slide.title}
            </h1>
          )}
          {(slide.subtitle || (editable && isTitleish)) && (
            editable ? (
              <EditableText
                as="p"
                value={slide.subtitle ?? ''}
                onCommit={(subtitle) =>
                  dispatch({ t: 'update_slide', id: slide.id, fields: { subtitle } }, { manual: true })
                }
                slideId={slide.id}
                blockId={null}
                field="subtitle"
                placeholder="Add a subtitle"
                className="text-[1.1em]"
              />
            ) : (
              <p className="text-[1.1em]" style={{ color: 'var(--slide-muted)' }}>
                {slide.subtitle}
              </p>
            )
          )}
        </header>

        {/* --- Body ---
            A slide with no blocks renders NO body wrapper. The wrapper is
            `flex-1`, so an empty one still claimed all the leftover height and
            pushed the header to the top — which is why a centered title slide
            read as sitting high rather than centred. */}
        {isPending ? (
          <PendingSkeleton />
        ) : slide.blocks.length === 0 ? null : (
          <div
            className={`flex-1 min-h-0 overflow-hidden ${
              variant === 'two-col' || variant === 'image-left' || variant === 'image-right'
                ? 'grid'
                : 'flex flex-col'
            } ${titleWithBody ? 'text-[0.82em] justify-start' : ''} ${
              isCentered && isTitleish && !titleWithBody ? 'justify-center' : ''
            }`}
            style={
              variant === 'two-col'
                ? { gridTemplateColumns: '1fr 1fr', gap: gap * 1.5 }
                : variant === 'image-left'
                ? { gridTemplateColumns: '0.9fr 1.1fr', gap: gap * 1.5 }
                : variant === 'image-right'
                ? { gridTemplateColumns: '1.1fr 0.9fr', gap: gap * 1.5 }
                : { gap }
            }
          >
            {/* h-full, not flex-1: this wrapper is a flex child in
                single-column layouts but a GRID child in two-col/image-*,
                where flex-1 has no effect. Without a resolved height it
                collapsed to ~16px and starved any chart inside it. */}
            <div
              className={`flex flex-col min-h-0 h-full ${hasVisual ? '' : 'justify-start'}`}
              style={{ gap, order: variant === 'image-left' ? 2 : 1 }}
            >
              {main.map((b) => (
                <BlockRenderer key={b.id} block={b} slideId={slide.id} themeName={themeName} editable={editable} />
              ))}
            </div>
            {aside.length > 0 && (
              <div
                className="flex flex-col min-h-0 h-full"
                style={{ gap, order: variant === 'image-left' ? 1 : 2 }}
              >
                {aside.map((b) => (
                  <BlockRenderer key={b.id} block={b} slideId={slide.id} themeName={themeName} editable={editable} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Shown for phase-1 outline slides while phase-2 content is still generating. */
function PendingSkeleton() {
  return (
    <div className="flex-1 flex flex-col gap-4 justify-start pt-2" aria-label="generating content">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-[1.2em] rounded-full shimmer"
          style={{
            width: `${[88, 74, 60][i]}%`,
            animationDelay: `${i * 160}ms`,
          }}
        />
      ))}
    </div>
  );
}
