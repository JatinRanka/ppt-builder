/**
 * TOOL DEFINITIONS — the agent's entire vocabulary for changing a deck.
 *
 * Every tool is a DIFF. There is deliberately no `set_deck` / `replace_all`
 * tool, so full regeneration is not expressible: the model cannot destroy
 * manual edits even if it wants to.
 *
 * Two schema decisions do real work here:
 *
 * 1. `add_slide` HAS NO `blocks` PARAMETER. The model physically cannot emit a
 *    complete deck in one call, which is what *structurally* enforces two-phase
 *    generation rather than relying on the prompt to ask nicely.
 *
 * 2. BLOCK PARAMS OMIT `id`. Ids are minted server-side (see schema/factory).
 *    Models reliably emit duplicate ids; not offering the field removes the
 *    failure mode entirely.
 */
import type { ToolDef } from '@/lib/llm/types';

const SLIDE_KINDS = [
  'title', 'section', 'content', 'two-column', 'comparison',
  'quote', 'metrics', 'image-full', 'blank',
];
const LAYOUT_VARIANTS = [
  'single', 'two-col', 'image-left', 'image-right', 'full-bleed', 'centered',
];

/**
 * JSON Schema for a content block, mirroring Block in schema/deck.ts minus the
 * server-minted `id`. Written by hand rather than generated from Zod because
 * the model needs terse, instructive descriptions that a generator will not
 * produce — and because the AI-facing shape intentionally differs (no ids).
 */
const BLOCK_SCHEMA = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: ['heading', 'paragraph', 'bullets', 'quote', 'metrics', 'table', 'chart', 'image'],
      description: 'The kind of content block.',
    },
    slot: {
      type: 'string',
      enum: ['main', 'aside'],
      description:
        "Which region of the layout. Use 'aside' for the secondary column on two-col/image-* layouts; 'main' otherwise.",
    },
    text: { type: 'string', description: 'For heading, paragraph, quote.' },
    level: { type: 'integer', enum: [2, 3], description: 'For heading only.' },
    items: {
      type: 'array',
      description:
        'For bullets: an array of strings, max 8. For metrics: an array of {value,label} objects, max 4.',
      items: {},
    },
    ordered: { type: 'boolean', description: 'For bullets: numbered instead of dotted.' },
    attribution: { type: 'string', description: 'For quote: who said it.' },
    columns: { type: 'array', items: { type: 'string' }, description: 'For table: header cells, max 6.' },
    rows: {
      type: 'array',
      items: { type: 'array', items: { type: 'string' } },
      description: 'For table: rows of cells, max 10 rows. Each row length must equal columns length.',
    },
    chartType: { type: 'string', enum: ['bar', 'line', 'pie', 'area'], description: 'For chart.' },
    categories: {
      type: 'array',
      items: { type: 'string' },
      description: 'For chart: the x-axis labels.',
    },
    series: {
      type: 'array',
      description:
        'For chart: up to 4 series. Each is {name, data:[numbers]} and data length MUST equal categories length.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          data: { type: 'array', items: { type: 'number' } },
        },
        required: ['name', 'data'],
      },
    },
    caption: { type: 'string', description: 'For chart: a short note on units or source.' },
    query: {
      type: 'string',
      description:
        'For image: 2-4 KEYWORDS describing the photo (e.g. "solar panels desert"). Never a URL — the server resolves it.',
    },
    alt: { type: 'string', description: 'For image: accessible description.' },
    fit: { type: 'string', enum: ['cover', 'contain'], description: 'For image.' },
  },
  required: ['type'],
} as const;

export const DECK_TOOLS: ToolDef[] = [
  {
    name: 'add_slide',
    description:
      'Add ONE new slide to the deck. This creates the slide SHAPE only (title, type, layout) — you do NOT provide content here. Content is filled in afterwards with set_blocks. Use this for every slide when building a new deck outline.',
    parameters: {
      type: 'object',
      properties: {
        after_slide_id: {
          type: ['string', 'null'],
          description:
            'Insert after this slide id. Use null to insert at the very beginning. Omit to append at the end.',
        },
        kind: { type: 'string', enum: SLIDE_KINDS, description: 'The slide archetype.' },
        title: { type: 'string', description: 'The slide headline. Specific and substantive, not generic.' },
        brief: {
          type: 'string',
          description:
            'One sentence on what this slide must convey. This is the instruction used later to generate its content, so be concrete.',
        },
        subtitle: { type: 'string', description: 'Optional; mainly for title slides.' },
        layout_variant: { type: 'string', enum: LAYOUT_VARIANTS, description: 'Optional layout override.' },
      },
      required: ['kind', 'title', 'brief'],
    },
  },
  {
    name: 'set_blocks',
    description:
      "Replace the content blocks in one slot of one slide. This is how slide content gets written. Only the named slot is touched, so filling 'main' leaves an 'aside' image intact.",
    parameters: {
      type: 'object',
      properties: {
        slide_id: { type: 'string', description: 'Target slide id from the deck outline.' },
        slot: {
          type: 'string',
          enum: ['main', 'aside'],
          description: "Which region to replace. Defaults to 'main'.",
        },
        blocks: { type: 'array', items: BLOCK_SCHEMA, description: 'The new blocks for this slot.' },
      },
      required: ['slide_id', 'blocks'],
    },
  },
  {
    name: 'update_slide',
    description:
      'Change a slide\'s scalar fields (title, subtitle, speaker notes, kind). Use this for "retitle slide 2" or "add speaker notes". Does NOT touch content blocks — use patch_block or set_blocks for those.',
    parameters: {
      type: 'object',
      properties: {
        slide_id: { type: 'string' },
        title: { type: 'string' },
        subtitle: { type: 'string' },
        speaker_notes: { type: 'string' },
        kind: { type: 'string', enum: SLIDE_KINDS },
      },
      required: ['slide_id'],
    },
  },
  {
    name: 'patch_block',
    description:
      'Surgically change ONE field of ONE existing block. This is the preferred tool for small edits like "make bullet 3 punchier" or "fix the typo in the table" — it is far cheaper and safer than replacing the whole slot. Only send the fields you are changing.',
    parameters: {
      type: 'object',
      properties: {
        slide_id: { type: 'string' },
        block_id: { type: 'string', description: 'Block id from the deck outline (e.g. b_a1b2c3).' },
        patch: {
          type: 'object',
          description:
            'The fields to overwrite, e.g. {"items": ["new first bullet", "second"]} or {"text": "revised paragraph"}. Arrays are replaced wholesale, so include all elements.',
          additionalProperties: true,
        },
      },
      required: ['slide_id', 'block_id', 'patch'],
    },
  },
  {
    name: 'delete_slide',
    description: 'Remove one slide from the deck.',
    parameters: {
      type: 'object',
      properties: { slide_id: { type: 'string' } },
      required: ['slide_id'],
    },
  },
  {
    name: 'reorder_slides',
    description:
      'Set the complete slide order. You MUST list every existing slide id exactly once — this is a permutation, not a partial move.',
    parameters: {
      type: 'object',
      properties: {
        slide_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'All slide ids in the desired final order.',
        },
      },
      required: ['slide_ids'],
    },
  },
  {
    name: 'change_layout',
    description:
      'Change how a slide is laid out without touching its content. Use for "make slide 4 two columns" or "center that title".',
    parameters: {
      type: 'object',
      properties: {
        slide_id: { type: 'string' },
        variant: { type: 'string', enum: LAYOUT_VARIANTS },
        align: { type: 'string', enum: ['left', 'center'] },
        density: { type: 'string', enum: ['compact', 'normal', 'roomy'] },
      },
      required: ['slide_id'],
    },
  },
];

/** Tools offered during phase 1 (outline): shape only. */
export const OUTLINE_TOOLS: ToolDef[] = DECK_TOOLS.filter((t) => t.name === 'add_slide');

/** Tools offered during phase 2 (content fill): writing blocks only. */
export const CONTENT_TOOLS: ToolDef[] = DECK_TOOLS.filter(
  (t) => t.name === 'set_blocks' || t.name === 'update_slide'
);

export const TOOL_NAMES = DECK_TOOLS.map((t) => t.name);
