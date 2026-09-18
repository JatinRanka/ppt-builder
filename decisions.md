# decisions.md

Project: **Deckwright**, an AI presentation builder.
Problem statement 3 (pick your own problem).

---

## The brief

**The problem.** Tools that generate slide decks with AI are good at the first
draft and bad at everything after it. You ask for a change, the model rewrites
the whole deck, and the three slides you had already fixed by hand come back
wrong. So people generate once, export, and finish the work in PowerPoint. The
AI never becomes a collaborator.

Deckwright is for someone who needs a deck in the next hour and wants to keep
the AI in the loop the whole way: generate a draft, then refine it by
conversation _and_ by direct editing, in any order, without either one
destroying the other.

**The hard part.** Co-editing a single structured document between a human and a
model. The naive version is "send the deck as JSON, ask for the deck back" and it
breaks in four separate ways:

- It cannot preserve manual edits. A full rewrite has no way to know slide 3 was
  hand-tuned, so it silently reverts it.
- It does not fit. A 20 slide deck is thousands of tokens each way, and a whole
  deck response hits the output limit mid-JSON.
- It is slow and opaque. The user waits on one long call and sees nothing until
  it either lands or fails.
- It races. The user is typing in a text field while a patch for that exact
  field arrives from the stream. One of the two writes loses.

**The slice I shipped.** One end-to-end path: describe a deck, watch slides
appear one at a time, edit any slide by hand, ask for a targeted change, export
to PDF or PPTX. The failure case I chose to actually handle is the collision
above: an AI edit landing on the field the user is typing in right now.

**Why this rather than a fixed prompt.** The document-to-structured-data prompt
and the schema version control prompt are both backend heavy problems. This one
forces a product call, a UX call, and a systems call in the same codebase, and
the hard part sits exactly where the user can feel it.

---

## 1. Diffs as the only vocabulary, no `replace_deck`

**Chose.** Seven tools, every one a diff: `add_slide`, `set_blocks`,
`patch_block`, `update_slide`, `delete_slide`, `reorder_slides`, `change_layout`.
There is deliberately no tool that replaces the deck.

**Rejected.** "Return the updated deck" with structured output. Also considered
letting the model emit JSON Patch, which is more expressive and much easier to
get subtly wrong.

**Reasoning.** Whole-deck regeneration is not a bug to be prompted away, it is a
capability. If the model cannot express "here is a new deck", it cannot do it on
a bad turn, and no prompt drift reintroduces it. This is also the security
boundary: the deck arrives from an unauthenticated client and is treated as
untrusted, but an injection that gets through can only garble slides through
those same seven undoable diff tools. Narrowing the capability was cheaper and
more reliable than tightening the instructions.

---

## 2. Flat, ID'd blocks instead of a nested tree

**Chose.** A slide is a flat array of blocks, each with a server-minted id.
Layout is a separate hint (`variant`, `align`, `density`) kept orthogonal to
content.

**Rejected.** A nested layout tree (rows containing columns containing blocks),
which is closer to how slides look.

**Reasoning.** Flatness is what makes patching addressable: every edit is
`{slideId, blockId, patch}`, with no path to resolve and no tree to restructure.
Orthogonal layout means "make this two columns" never regenerates the text. The
tree would have been prettier to render and much worse to patch.

Ids are server-minted and the `id` field is absent from the AI-facing tool
schema, because models emit collisions. Rather than validate and retry, I
removed the model's ability to choose.

**Cut.** Nested groups, and z-order for flowed layouts. Free positioning came
later, as an explicit per-slide opt-in (see 6).

---

## 3. Two-phase generation, enforced by the schema

**Chose.** Phase 1 produces the deck's _shape_ (count, titles, kinds, order).
Phase 2 fills each slide's content in its own call. Visible in the schema as
`slide.status` and `slide.brief`.

**Rejected.** One call for the whole deck. Also rejected doing the split in the
prompt only ("first outline, then fill").

**Reasoning.** `add_slide` has no `blocks` parameter, so the model physically
cannot emit a finished deck in one call. That structural enforcement buys three
things at once: skeletons land in about 2 seconds so the user sees the shape
immediately, output token limits are never hit, and one bad slide fails alone
instead of taking the deck with it.

**Tradeoff accepted.** N+1 model calls per deck, so more total latency and cost
than a single call. Worth it, because perceived latency is what the user
experiences, and partial failure becomes recoverable.

---

## 4. One reducer for AI edits and manual edits

**Chose.** Manual edits and AI edits compile to the same `DeckOp` and pass
through the same `applyOp` reducer. `applyOp` returns its own inverse, so undo is
one stack over both kinds of edit.

**Rejected.** Letting the editor mutate React state directly and reserving ops
for the AI. Also rejected CRDTs or a real OT layer.

**Reasoning.** Two write paths into one document will diverge, and the divergence
is the exact bug this project is about. One path makes "an AI edit cannot clobber
your work" structural rather than a promise. CRDTs were the wrong tool: one human
and one model, both writing through the same client, so there is no distributed
merge problem, just an ordering problem.

Three mechanisms sit on this single path:

1. A manual edit marks its slide `dirty`, and phase 2 skips dirty slides.
   Content you wrote is preserved by construction, not by the model being careful.
2. An AI op targeting the field you are focused in is **deferred, not dropped**,
   and replayed on blur. Your keystroke wins and the model's intent is not lost.
   Dropping was the easier implementation and the worse product.
3. Failed tool calls go back to the model as tool results rather than throwing,
   so an invented slide id becomes a turn the model corrects itself from.

**Known gap.** The deferral guard matches on the focused field, and for bullet
lists, tables and metric blocks that match is not precise enough, so live typing
in those block types is not actually protected yet. Plain text blocks are.

---

## 5. Never send the whole deck to the model

**Chose.** The deck goes as a compact outline, roughly 20 tokens per slide. Full
text is included only for the slides a message actually references, resolved from
the message itself ("slide 4", "the last slide"), the current selection, or a
content search.

**Rejected.** Sending the full deck JSON every turn. Also rejected embedding
slides and retrieving by vector similarity.

**Reasoning.** Full JSON grows unboundedly and spends most of the context on
slides the turn will not touch. Embeddings were overkill: at 10 to 40 slides, a
reference resolver plus a substring search is more predictable, needs no second
datastore, and fails in ways I can debug.

**Tradeoff accepted.** A vague message about an unnamed slide can resolve to the
wrong one. Mitigated by the selection feeding resolution, so "make this punchier"
means the slide you are looking at.

---

## 6. Free positioning as a per-slide opt-in

**Chose.** Blocks carry an optional `frame` (x, y, w, h, z in logical slide
pixels) and a slide opts into a `free` variant to use it. `free` is absent from
the AI's layout enum, so no generated deck lands there by accident.

**Rejected.** Making every block absolutely positioned, which is how most slide
editors work. Also rejected per-block opt-in.

**Reasoning.** Per-block opt-in produces slides that are half flowed and half
positioned, where dragging one block visibly reflows its siblings. Going fully
absolute would have thrown away the automatic layouts that make generated decks
look right with zero user effort. Per-slide is the seam where the user's mental
model stays coherent: this slide is auto-arranged, or this one is mine.

Two details that were only obvious once they were wrong on screen:

- Coordinates are stored in logical pixels, not normalized fractions. The slide
  is already a fixed 1280x720 surface scaled by a CSS transform, so pixels are
  its native unit, the aspect ratio is fixed deck-wide so fractions buy nothing,
  and dragging produces readable values instead of `0.4703125`.
- The pointer-to-coordinate math lives in a pure module
  (`src/lib/chart/dragMath.ts`) with no React and no DOM, because that is where
  the bugs are. Pointer events arrive in post-transform screen pixels while every
  stored coordinate is pre-transform, and mixing them makes a dragged block
  travel `1/scale` too far. Deriving the scale from the element rather than
  threading it as a prop also self-corrects when the window is resized mid-drag,
  which users do.

**Cut.** Snapping, alignment guides, multi-select. Polish on top of a seam that
had to be right first.

---

## 7. Tolerant normalization, but only for content

**Chose.** Malformed-but-recoverable model output is normalized rather than
rejected: ragged table rows are padded, a header emitted as `rows[0]` is
accepted, chart series are reconciled against categories. Structural errors
(unknown slide id, unknown block type) still fail loudly and go back to the model.

**Rejected.** Strict Zod rejection with a retry on any deviation.

**Reasoning.** The split is about what the model can act on. "Your table row had
3 cells and the others had 4" is not usable information; padding costs nothing
and saves a round trip. "Slide `xyz` does not exist" is exactly what it
self-corrects from in one turn. Tolerant everywhere hides real bugs; strict
everywhere burns latency on non-problems.

---

## 8. What I deliberately did not build

- **Token-level streaming in the UI.** The plumbing exists (`streamChat`, and the
  provider supports streamed tool calls) but is not wired up. Per-slide streaming
  already delivered most of the perceived speed. First thing next.
- **Real-time multiplayer.** The one thing that _would_ have justified CRDTs. It
  would have eaten the whole timebox while making the single-user experience no
  better.
- **Image generation.** Keyword-matched stock photos instead: a second API key
  and seconds of added latency per slide, for a nicer picture.
- **Multi-deck dashboard, templates, theme editor, slide-level image upload.**
  Breadth, not depth.
- **Per-keystroke undo for text.** Undo is per commit, on blur. Native
  character-level undo still works inside a focused field.

**Next, in order:** fix the deferral guard for bullet, table and metric blocks;
wire token-level streaming into the UI; move rate limiting to a shared store;
snapping and alignment guides for free slides.
