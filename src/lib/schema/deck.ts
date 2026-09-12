/**
 * THE SLIDE SCHEMA — the contract between AI and UI.
 *
 * Four decisions keep this from going fragile:
 *
 * 1. BLOCKS ARE A FLAT, ID'D ARRAY — never nested. Nesting would force
 *    path-based patching (content.children[0].items[2]), which an LLM emits
 *    unreliably and which breaks after any reorder. A flat Block[] with stable
 *    ids means every patch is addressed as {slideId, blockId, patch}. This is
 *    what makes surgical, diff-based edits possible.
 *
 * 2. LAYOUT IS ORTHOGONAL TO CONTENT. A naive schema fuses them
 *    (kind: 'two-column-with-image'), so changing the layout forces
 *    regenerating content. Kept separate, change_layout is a one-field patch.
 *
 * 3. SLOTS, NOT COLUMNS. Blocks declare slot: 'main' | 'aside'; the layout
 *    decides how slots render. Reflowing two-column -> single is a layout
 *    change, not a content migration.
 *
 * 4. IDS ARE SERVER-MINTED, NEVER MODEL-GENERATED. Models emit colliding ids.
 *    The model may only *reference* ids that already exist.
 *
 * The max() caps are not decoration — they are prompt constraints enforced in
 * code. Without them the model emits 15 bullets and blows the layout. The
 * schema is where the design system gets defended.
 */
import { z } from 'zod';
import { isSafeImageUrlScheme } from '@/lib/safeUrl';

/**
 * STRING LENGTH CAPS.
 *
 * The array caps below (max 8 bullets, max 10 rows) bounded the SHAPE of a
 * deck but not the SIZE of any single field, so a 900KB paragraph on one slide
 * parsed clean and only bumped into the 1MB whole-deck backstop. That is a
 * cost problem (the text is forwarded to the model as context), a rendering
 * problem, and an export problem.
 *
 * Values are generous — far above any real slide, since this schema also
 * validates decks a user typed by hand. They bound abuse, not authorship.
 */
const TEXT = {
  /** Slide/deck titles and other one-line fields. */
  line: 300,
  /** Body copy: a paragraph, a quote, one bullet, one table cell. */
  body: 2_000,
  /** Speaker notes — legitimately the longest field on a slide. */
  notes: 5_000,
  /** Ids are minted by nanoid; this only bounds what a client may send back. */
  id: 128,
} as const;

/** A bounded string for short single-line fields. */
const line = (max: number = TEXT.line) => z.string().max(max);

/** Slide archetypes. Describes the *semantic role*, not the visual layout. */
export const SlideKind = z.enum([
  'title',
  'section',
  'content',
  'two-column',
  'comparison',
  'quote',
  'metrics',
  'image-full',
  'blank',
]);
export type SlideKind = z.output<typeof SlideKind>;

/** Which region of a layout a block belongs to. */
export const Slot = z.enum(['main', 'aside']);
export type Slot = z.output<typeof Slot>;

/**
 * Presentation hints, deliberately separate from content.
 * `accent` is a THEME TOKEN NAME, never a hex value — that keeps AI output
 * theme-compatible and makes themes a real feature rather than a repaint.
 */
export const LayoutHint = z.object({
  variant: z
    .enum(['single', 'two-col', 'image-left', 'image-right', 'full-bleed', 'centered'])
    .default('single'),
  align: z.enum(['left', 'center']).default('left'),
  density: z.enum(['compact', 'normal', 'roomy']).default('normal'),
  accent: line(64).optional(),
});
export type LayoutHint = z.output<typeof LayoutHint>;

// --- Blocks -----------------------------------------------------------------
// A discriminated union so TypeScript enforces exhaustiveness in BlockRenderer:
// adding a block type surfaces every site that needs updating.

const blockBase = {
  id: z.string().max(TEXT.id),
  slot: Slot.default('main'),
};

export const HeadingBlock = z.object({
  ...blockBase,
  type: z.literal('heading'),
  text: line(),
  level: z.union([z.literal(2), z.literal(3)]).default(2),
});

export const ParagraphBlock = z.object({
  ...blockBase,
  type: z.literal('paragraph'),
  text: z.string().max(TEXT.body),
});

export const BulletsBlock = z.object({
  ...blockBase,
  type: z.literal('bullets'),
  items: z.array(z.string().max(TEXT.body)).max(8),
  ordered: z.boolean().default(false),
});

export const QuoteBlock = z.object({
  ...blockBase,
  type: z.literal('quote'),
  text: z.string().max(TEXT.body),
  attribution: line().optional(),
});

export const MetricsBlock = z.object({
  ...blockBase,
  type: z.literal('metrics'),
  items: z.array(z.object({ value: line(64), label: line() })).max(4),
});

export const TableBlock = z.object({
  ...blockBase,
  type: z.literal('table'),
  columns: z.array(line()).max(6),
  rows: z.array(z.array(z.string().max(TEXT.body)).max(6)).max(10),
});

/**
 * Chart data mirrors Recharts' shape but stays fully serializable — no
 * functions, no JSX. This is also what makes native PPTX chart export possible.
 */
export const ChartBlock = z.object({
  ...blockBase,
  type: z.literal('chart'),
  chartType: z.enum(['bar', 'line', 'pie', 'area']),
  series: z
    .array(z.object({ name: line(), data: z.array(z.number().finite()).max(24) }))
    .max(4),
  categories: z.array(line(120)).max(24),
  caption: line().optional(),
});

/**
 * The model emits `query` (keywords) — NOT a url. Models hallucinate broken
 * image urls. The server resolves query -> url deterministically in
 * src/lib/images.ts, so no image-generation key is needed.
 */
export const ImageBlock = z.object({
  ...blockBase,
  type: z.literal('image'),
  query: line(),
  // Scheme-restricted: z.string().url() alone accepted javascript: and data:,
  // which are XSS sinks the moment this value reaches an href. The SERVER-side
  // fetch is separately allowlisted in safeUrl.ts (SSRF).
  url: z.string().max(2_048).refine(isSafeImageUrlScheme, 'Unsupported image URL scheme').optional(),
  alt: line(),
  fit: z.enum(['cover', 'contain']).default('cover'),
});

export const Block = z.discriminatedUnion('type', [
  HeadingBlock,
  ParagraphBlock,
  BulletsBlock,
  QuoteBlock,
  MetricsBlock,
  TableBlock,
  ChartBlock,
  ImageBlock,
]);
export type Block = z.output<typeof Block>;
export type BlockType = Block['type'];

/** Narrow helper for the renderer switch. */
export type BlockOfType<T extends BlockType> = Extract<Block, { type: T }>;

// --- Slide ------------------------------------------------------------------

/**
 * `status` and `brief` make TWO-PHASE GENERATION a first-class schema concept
 * rather than an implementation detail:
 *
 *   Phase 1 (outline)  -> slides written with status 'outline' + a `brief`
 *                         (title, kind, layout, order — the deck's "shape").
 *   Phase 2 (content)  -> blocks filled in per slide, status flips to 'ready'.
 *
 * `dirty` is how manual edits survive AI generation: it is set on any manual
 * edit, and phase 2 skips dirty slides. Manual edits are preserved by
 * construction, not by convention.
 */
export const Slide = z.object({
  id: z.string().max(TEXT.id),
  kind: SlideKind,
  title: line(),
  subtitle: line().optional(),
  // 5000 blocks on one slide parsed fine before this cap, each one a render
  // node and an export shape. A designed slide has 1-3.
  blocks: z.array(Block).max(12).default([]),
  layout: LayoutHint.prefault({}),
  speakerNotes: z.string().max(TEXT.notes).default(''),
  status: z.enum(['outline', 'generating', 'ready']).default('ready'),
  brief: z.string().max(TEXT.body).optional(),
  dirty: z.boolean().default(false),
});
export type Slide = z.output<typeof Slide>;

export const ThemeName = z.enum(['midnight', 'paper', 'sunrise']);
export type ThemeName = z.output<typeof ThemeName>;

export const Deck = z.object({
  id: z.string().max(TEXT.id),
  title: line(),
  theme: ThemeName.default('sunrise'),
  // Slide-count cap lives here too, not just in the route handlers, so every
  // parse site inherits it — including localStorage rehydration.
  slides: z.array(Slide).max(60),
  /** Bumped on every applied op. Useful for cheap staleness checks. */
  rev: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
});
export type Deck = z.output<typeof Deck>;

// --- Context serialization --------------------------------------------------

/**
 * Compact deck view sent to the LLM instead of full JSON.
 * ~20 tokens/slide vs ~400, so a 20-slide deck costs ~400 tokens of context.
 * Full block content is sent only for the slide(s) a message actually targets.
 *
 * Example output:
 *   #s1 [title] "Q3 Review" (single) blocks: —
 *   #s2 [content] "Revenue" (two-col) blocks: b1:bullets(4) b2:chart(bar)
 */
export function serializeDeckOutline(deck: Deck): string {
  if (deck.slides.length === 0) return '(empty deck — no slides yet)';
  return deck.slides
    .map((s, i) => {
      const blocks = s.blocks.length
        ? s.blocks.map(describeBlock).join(' ')
        : '—';
      const flags = [
        s.status !== 'ready' ? s.status : null,
        s.dirty ? 'manually-edited' : null,
      ]
        .filter(Boolean)
        .join(',');
      return `#${i + 1} id=${s.id} [${s.kind}] "${s.title}" (${s.layout.variant}) blocks: ${blocks}${
        flags ? ` <${flags}>` : ''
      }`;
    })
    .join('\n');
}

function describeBlock(b: Block): string {
  switch (b.type) {
    case 'bullets':
      return `${b.id}:bullets(${b.items.length})`;
    case 'table':
      return `${b.id}:table(${b.columns.length}x${b.rows.length})`;
    case 'chart':
      return `${b.id}:chart(${b.chartType})`;
    case 'metrics':
      return `${b.id}:metrics(${b.items.length})`;
    case 'image':
      return `${b.id}:image`;
    case 'heading':
      return `${b.id}:heading`;
    case 'paragraph':
      return `${b.id}:paragraph`;
    case 'quote':
      return `${b.id}:quote`;
  }
}

/** Full detail for a single slide — sent only for slides a request targets. */
export function serializeSlideDetail(slide: Slide): string {
  return JSON.stringify(
    {
      id: slide.id,
      kind: slide.kind,
      title: slide.title,
      subtitle: slide.subtitle,
      layout: slide.layout,
      speakerNotes: slide.speakerNotes,
      blocks: slide.blocks,
    },
    null,
    1
  );
}
