# Deckwright — AI Presentation Builder

Describe a deck in natural language, watch the AI build it slide by slide, then
refine it through conversation **or** edit any slide by hand — without either
destroying the other.

---

# 1. Setup

## Prerequisites

- Node.js 20+ (developed on 22)
- A Sarvam API key - [dashboard.sarvam.ai](https://dashboard.sarvam.ai)

## Install and run

```bash
npm install
cp .env.example .env.local      # then add your key (see below)
npm run dev                     # http://localhost:3000
```

## Environment variables

Put these in `.env.local` (or `.env` — both are gitignored).

### Required

| Variable         | Notes                                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `SARVAM_API_KEY` | **Server-side only.** Never prefix with `NEXT_PUBLIC_` — that would ship your key to the browser. It is read exclusively inside route handlers. |

### Optional

| Variable          | Default                    | Notes                                 |
| ----------------- | -------------------------- | ------------------------------------- |
| `LLM_PROVIDER`    | `sarvam`                   | `sarvam` or `openai`.                 |
| `SARVAM_MODEL`    | `sarvam-105b`              |                                       |
| `SARVAM_BASE_URL` | `https://api.sarvam.ai/v1` | `/v2` is beta-gated on standard keys. |
| `OPENAI_API_KEY`  | —                          | Only if `LLM_PROVIDER=openai`.        |
| `OPENAI_MODEL`    | `gpt-4.1`                  |                                       |

## Commands

```bash
npm run dev      # dev server
npm run build    # production build
npm start        # serve the production build
npm test
npm run lint
```

## Deployment

Deploy-ready for Vercel or any Node host. Set `SARVAM_API_KEY` as a
**server-side** environment variable in the host's dashboard. There is no
database and no auth: the deck lives in `localStorage`, and the API is stateless.

---

# 2. Architecture

## What lives where

**`src/lib/schema`** — the slide schema (Zod). The contract between AI and UI,
and the backbone of everything else.

**`src/lib/llm`** — the provider boundary. A narrow `LLMProvider` interface plus
one adapter per vendor; the agent never imports a vendor SDK, so swapping
providers means adding an adapter and setting `LLM_PROVIDER`.

**`src/lib/agent`** — the agentic layer: tool definitions, system prompts, the
tool-calling loop, two-phase generation, and `translate.ts`, which validates
every model tool call against the live deck before it can touch state.

**`src/lib/state`** — `ops.ts` (the reducer, with inverses for undo) and
`store.ts` (Zustand + localStorage). The single mutation path.

**`src/app/api`** — three route handlers: `/chat` (the agent), `/fill` (retry
empty slides), `/export/pptx`. All stateless; the API key is read only here.

**`src/components`** — `chat/` (conversation + tool-call detail), `editor/`
(slide canvas, thumbnail rail, toolbar), `blocks/` (one renderer per block type,
plus inline editing).

## Data flow

```
user message
  └─► POST /api/chat  { message, deck, history, focusSlideId }
        │   the CLIENT deck is authoritative — the server keeps no session state
        ├─► provider.chat(…)      via the LLMProvider interface
        ├─► toolCallToOps()       validate the tool call against the live deck
        └─► NDJSON stream ──► { type: 'op', op }
                                     │
                                     ▼
                            store.dispatch(op)   ◄── manual edits enter HERE too
                                     ▼
                    React re-renders only the affected slide
```

Three things worth knowing about this flow:

- **`op` is the only event that mutates state.** Everything else the stream
  emits (`phase`, `tool`, `warning`, `message`) is presentational.
- **Manual edits and AI edits are the same thing.** Both compile to a `DeckOp`
  and pass through one reducer, so they cannot diverge. That is what makes a
  unified undo stack work, and why an AI edit cannot clobber hand-written
  content: `applyOp` returns its own inverse, manual edits mark a slide `dirty`
  (which generation then skips), and an AI op targeting the field you are
  actively typing in is deferred rather than dropped.
- **The deck is never sent as full JSON.** It goes as a compact outline
  (~20 tokens/slide), with full text included only for the slides a message
  actually references — resolved from the message itself ("slide 4", "the last
  slide"), the current selection, or a content search.

## Core design decisions

**Structured output** — the AI returns JSON conforming to the Zod schema in
`schema/deck.ts`. Blocks are a flat, ID'd array rather than a nested tree, which
is what makes surgical patching possible: every edit is addressed as
`{slideId, blockId, patch}`. Layout is kept orthogonal to content, so changing a
slide's layout never regenerates its text. IDs are server-minted — the `id`
field is absent from the AI-facing tool schema, because models emit collisions.

**Agentic tool use** — seven tools (`add_slide`, `set_blocks`, `patch_block`,
`update_slide`, `delete_slide`, `reorder_slides`, `change_layout`), every one a
diff. There is deliberately **no `replace_deck` tool**, so whole-deck
regeneration is not expressible in the agent's vocabulary. Failed calls are fed
back as tool results rather than thrown, so an invented slide id becomes a
recoverable turn the model corrects itself from.

**Diff-based edits** — "make bullet 2 punchier" produces exactly one
`patch_block`. This is enforced by test, using reference equality on the slides
that should not have changed:

```ts
expect(res.deck.slides[0]).toBe(deck.slides[0]); // same object, not a copy
```

**Two-phase generation** — **phase 1** produces the deck's _shape_ (count,
titles, kinds, order) and **phase 2** fills each slide's content individually.
It is visible in the schema (`slide.status`, `slide.brief`) and _structurally
enforced_ — `add_slide` has no `blocks` parameter, so the model physically
cannot emit a finished deck in one call. This is also why streaming works
(skeletons land in ~2s, then fill one by one) and why output-token limits are
never hit by a whole-deck response.

## Notable implementation details

- **Rich content.** Charts are Recharts fed from `{chartType, categories,
series}` with animation disabled so the print view is correct. Tables tolerate
  ragged rows and a header emitted as `rows[0]`. Images are AI-chosen
  _keywords_, resolved server-side to Unsplash — models hallucinate broken URLs,
  so a model-supplied one is discarded.
- **Export.** `/print` renders slides at exactly 1280×720 using the _same_
  components as the editor, so the PDF cannot drift from what you saw. PPTX goes
  through PptxGenJS, and the flat block schema maps cleanly onto native
  PowerPoint objects — including real editable charts rather than images.

## Security

The API routes are unauthenticated, so the posted deck is treated as untrusted.

- **Size caps.** Zod proved decks well-formed but not small — one 900KB
  paragraph passed. Per-field caps in `schema/deck.ts`, per-request caps in
  `agent/limits.ts`, checked before any provider call.
- **Rate limiting.** 20 LLM and 30 export requests/min per IP
  (`src/lib/rateLimit.ts`). In-memory, so the budget is **per instance**, not a
  global quota.
- **Cost.** `/api/fill` spends one 8000-token call per pending slide; a
  500-slide skeleton deck bought ~1500 calls per request. Now capped at 20.
- **Prompt injection.** Deck content is fenced as data (`agent/prompts.ts`), but
  the real bound is capability: seven diff-only tools, no `replace_deck`. An
  injection can garble slides (undoable), not exfiltrate or execute.
- **Headers.** CSP, `frame-ancestors 'none'`, and `no-store` on `/api/*`.
- **Not covered.** No auth — anyone who can reach the deployment can spend your
  tokens within the rate limit.

# 3. Known issues & incomplete features

### Incomplete

- **Streaming is per-slide, not per-token.** Slides appear one at a time as
  phase 2 completes each, so slides do appear one by one. Token-level
  typewriter streaming _within_ a slide is **not wired into the UI**, though the
  plumbing exists (`streamChat` in the adapter, and Sarvam does support streamed
  tool calls). This is the main thing I'd build next.
- **Single deck.** Persisted to `localStorage`; there's no multi-deck dashboard.
- **Images are keyword-matched, not generated.** Unsplash returns a relevant
  stock photo, not a bespoke illustration. A deliberate scope trade — no second
  API key, no generation latency.
- **No slide-level image upload.** Images only arrive via the AI's keywords.

### Known issues

- **Truncation warnings on chart-heavy slides.** The per-slide budget is 8000
  tokens; verbose chart JSON can still hit it. The slide is retried
  automatically with an instruction to be more compact, and a warning surfaces
  in the chat.
- **Undo granularity for text is per-commit** (on blur), not per-keystroke.
  Native character-level undo still works inside a focused field.
- **No auth, no backend persistence** — both explicitly out of scope for this
  project. Size caps and per-IP rate limiting are in place; see Security.

### Trade-offs worth naming

- **Editing is the default intent.** Full generation only triggers when the deck
  is empty or the user clearly asks for a new deck. Misrouting toward "edit" is
  cheap; misrouting toward "generate" appends unwanted slides.
- **Tolerant normalization over strict rejection.** Padding a ragged table beats
  a retry round-trip. Structural errors (unknown ids, unknown block types) still
  fail loudly, because those are what the model can actually self-correct from.
