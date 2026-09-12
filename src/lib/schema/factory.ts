/**
 * ID minting and slide/block constructors.
 *
 * All ids originate here — never from the model. Models reliably emit colliding
 * or duplicate ids ("slide1" three times), so the model may only *reference*
 * existing ids while the server mints new ones.
 *
 * Ids are short and readable (s_a3f2b1, b_9c4d0e) because they appear in the
 * compact deck outline sent to the LLM, where every token counts.
 */
import { customAlphabet } from 'nanoid';
import type { Block, Deck, Slide, SlideKind, Slot } from './deck';

const nano = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 6);

export const newSlideId = () => `s_${nano()}`;
export const newBlockId = () => `b_${nano()}`;
export const newDeckId = () => `d_${nano()}`;

/** A slide as produced by phase 1: shape only, no content yet. */
export function makeOutlineSlide(input: {
  kind: SlideKind;
  title: string;
  brief: string;
  subtitle?: string;
  layoutVariant?: Slide['layout']['variant'];
}): Slide {
  return {
    id: newSlideId(),
    kind: input.kind,
    title: input.title,
    subtitle: input.subtitle,
    blocks: [],
    layout: {
      variant: input.layoutVariant ?? defaultVariantFor(input.kind),
      align: input.kind === 'title' || input.kind === 'section' ? 'center' : 'left',
      density: 'normal',
    },
    speakerNotes: '',
    status: 'outline',
    brief: input.brief,
    dirty: false,
  };
}

/** An empty slide added manually via the toolbar. Ready, not outline. */
export function makeBlankSlide(kind: SlideKind = 'content'): Slide {
  return {
    id: newSlideId(),
    kind,
    title: kind === 'title' ? 'Presentation title' : 'New slide',
    blocks: [],
    layout: {
      variant: defaultVariantFor(kind),
      align: kind === 'title' || kind === 'section' ? 'center' : 'left',
      density: 'normal',
    },
    speakerNotes: '',
    status: 'ready',
    brief: undefined,
    dirty: false,
  };
}

/** Sensible starting layout per slide archetype. */
export function defaultVariantFor(kind: SlideKind): Slide['layout']['variant'] {
  switch (kind) {
    case 'title':
    case 'section':
    case 'quote':
      return 'centered';
    case 'two-column':
    case 'comparison':
      return 'two-col';
    case 'image-full':
      return 'full-bleed';
    default:
      return 'single';
  }
}

/**
 * Assign fresh ids to model-supplied blocks. The model omits ids entirely (they
 * are stripped from the tool schema); this is where they get minted.
 */
export function mintBlockIds(blocks: Omit<Block, 'id'>[], slot: Slot): Block[] {
  return blocks.map((b) => ({ ...b, id: newBlockId(), slot }) as Block);
}

/** A deep copy of a slide with all-new ids, for duplicate-slide. */
export function cloneSlide(slide: Slide): Slide {
  return {
    ...slide,
    id: newSlideId(),
    blocks: slide.blocks.map((b) => ({ ...b, id: newBlockId() })),
  };
}

export function makeEmptyDeck(title = 'Untitled deck'): Deck {
  return { id: newDeckId(), title, theme: 'sunrise', slides: [], rev: 0 };
}

/**
 * Sample deck used to render the editor before any AI is wired up, and as the
 * first-run state so a visitor sees a real deck immediately rather than a void.
 * Exercises every block type, which makes it a useful renderer smoke test.
 */
export function makeSampleDeck(): Deck {
  // FIXED ids, not minted ones. This deck is rendered on the server during
  // prerender and again on the client after hydration; random ids would differ
  // between the two passes and trip React's hydration check every time.
  const s = (n: number) => `s_sample${n}`;
  const b = (n: number) => `b_sample${n}`;
  return {
    id: 'd_sample',
    title: 'Q3 Product Roadmap',
    theme: 'sunrise',
    rev: 0,
    slides: [
      {
        id: s(1),
        kind: 'title',
        title: 'Q3 Product Roadmap',
        subtitle: 'Shipping velocity, platform bets, and what we are cutting',
        blocks: [],
        layout: { variant: 'centered', align: 'center', density: 'roomy' },
        speakerNotes: 'Set the frame: this quarter is about consolidation, not expansion.',
        status: 'ready',
        dirty: false,
      },
      {
        id: s(2),
        kind: 'content',
        title: 'Where We Landed in Q2',
        blocks: [
          {
            id: b(1),
            slot: 'main',
            type: 'bullets',
            ordered: false,
            items: [
              'Shipped collaborative editing to all tiers',
              'Cut p95 latency from 840ms to 210ms',
              'Onboarding completion up 34% after the rewrite',
              'Deferred the mobile client to Q4',
            ],
          },
        ],
        layout: { variant: 'single', align: 'left', density: 'normal' },
        speakerNotes: 'Acknowledge the mobile slip early so it does not dominate Q&A.',
        status: 'ready',
        dirty: false,
      },
      {
        id: s(3),
        kind: 'content',
        title: 'Revenue Trajectory',
        blocks: [
          {
            id: b(2),
            slot: 'main',
            type: 'chart',
            chartType: 'bar',
            categories: ['Q1', 'Q2', 'Q3E', 'Q4E'],
            series: [
              { name: 'Self-serve', data: [420, 512, 610, 720] },
              { name: 'Enterprise', data: [180, 310, 480, 640] },
            ],
            caption: 'ARR in $K. Q3/Q4 are forecast.',
          },
        ],
        layout: { variant: 'single', align: 'left', density: 'normal' },
        speakerNotes: 'Enterprise is the growth story — it crosses self-serve in Q4.',
        status: 'ready',
        dirty: false,
      },
      {
        id: s(4),
        kind: 'comparison',
        title: 'Build vs Buy: Search',
        blocks: [
          {
            id: b(3),
            slot: 'main',
            type: 'table',
            columns: ['', 'Build', 'Buy'],
            rows: [
              ['Time to ship', '10 weeks', '2 weeks'],
              ['Annual cost', '$0 + 2 FTE', '$48K'],
              ['Relevance tuning', 'Full control', 'Limited'],
              ['Ops burden', 'Ours', 'Vendor'],
            ],
          },
        ],
        layout: { variant: 'single', align: 'left', density: 'compact' },
        speakerNotes: 'Recommendation is buy now, revisit at 10x volume.',
        status: 'ready',
        dirty: false,
      },
      {
        id: s(5),
        kind: 'metrics',
        title: 'The Numbers That Matter',
        blocks: [
          {
            id: b(4),
            slot: 'main',
            type: 'metrics',
            items: [
              { value: '210ms', label: 'p95 latency' },
              { value: '+34%', label: 'Onboarding completion' },
              { value: '1.4M', label: 'Monthly active' },
              { value: '4.6/5', label: 'CSAT' },
            ],
          },
        ],
        layout: { variant: 'single', align: 'center', density: 'roomy' },
        speakerNotes: 'Land on latency — it unblocked the enterprise deals.',
        status: 'ready',
        dirty: false,
      },
    ],
  };
}
