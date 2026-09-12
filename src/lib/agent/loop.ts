/**
 * THE AGENT LOOP — tool-calling cycle for conversational edits.
 *
 * Flow per turn:
 *   1. Send messages + tools, tool_choice 'auto'.
 *   2. If the model returned tool calls: validate each against the live deck,
 *      apply it, emit the resulting op, and append a tool result message.
 *   3. Loop (capped) so the model can chain calls and react to errors.
 *   4. When it returns text instead, that is the user-facing reply.
 *
 * Validation failures are fed BACK to the model as tool results rather than
 * thrown. An invented slide id becomes a recoverable turn — this is the agent
 * loop earning its keep instead of a hard failure.
 *
 * Tool-selection turns are deliberately NON-STREAMED: they are short, and this
 * sidesteps any provider-specific streamed-tool-call shape. Visible streaming
 * comes from phase 2 emitting one slide at a time (see twoPhase.ts).
 */
import type { Deck } from '@/lib/schema/deck';
import { applyOp } from '@/lib/state/ops';
import type { DeckOp } from '@/lib/state/ops';
import type { LLMMessage, LLMProvider, ToolDef } from '@/lib/llm/types';
import { DECK_TOOLS } from './tools';
import { toolCallToOps, ToolCallError } from './translate';
import { describeOp } from '@/lib/state/ops';
import type { AgentEvent } from './protocol';

const MAX_ITERATIONS = 8;
/** Tool-selection turns are short; a big budget just invites rambling. */
const EDIT_MAX_TOKENS = 1600;

export interface LoopResult {
  deck: Deck;
  ops: DeckOp[];
  reply: string | null;
}

/**
 * Run the tool loop until the model stops calling tools.
 * `emit` is called synchronously for each event so the client sees ops land in
 * real time rather than at the end.
 */
export async function runAgentLoop(args: {
  provider: LLMProvider;
  deck: Deck;
  messages: LLMMessage[];
  tools?: ToolDef[];
  emit: (e: AgentEvent) => void;
  signal?: AbortSignal;
}): Promise<LoopResult> {
  const { provider, messages, tools = DECK_TOOLS, emit, signal } = args;
  let deck = args.deck;
  const allOps: DeckOp[] = [];
  const convo: LLMMessage[] = [...messages];
  let reply: string | null = null;
  /** Slide ids minted during THIS turn, used by the mistargeted-fill guard. */
  const createdThisTurn: string[] = [];
  /** Whether the "claimed an edit without acting" retry has already fired. */
  let forcedOnce = false;
  /** The user's request this turn, for the did-we-actually-do-it check. */
  const userRequest = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'user') return m.content;
    }
    return '';
  })();

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const res = await provider.chat({
      messages: convo,
      tools,
      // After a claimed-but-unperformed edit, require a call rather than
      // letting it talk its way out a second time.
      toolChoice: forcedOnce && allOps.length === 0 ? 'required' : 'auto',
      maxTokens: EDIT_MAX_TOKENS,
      temperature: 0.3,
      signal,
    });

    if (res.warning) emit({ type: 'warning', message: res.warning });

    // No tool calls => the model is done acting and this is its reply.
    if (!res.toolCalls.length) {
      const text = res.text?.trim() || null;

      // GUARD: the model sometimes ANSWERS AS IF IT ACTED, or insists the work
      // is already done. Two variants seen live:
      //   1. "I removed slide 3 from the deck."  (claimed, never happened)
      //   2. "I already removed slide 4..."      (refused, citing stale history)
      //
      // Variant 2 is why this cannot be a purely linguistic test: that reply
      // ends in a question and reads like a refusal, yet the slide it claims
      // is gone is still in the deck. The reliable signal is FACTUAL — the
      // user named a target that still exists and nothing was applied.
      const unmetRequest = referencesLiveTarget(userRequest, deck);
      if (text && allOps.length === 0 && !forcedOnce && (claimsAnEdit(text) || unmetRequest)) {
        forcedOnce = true;
        emit({
          type: 'warning',
          message: 'The model described a change without making one; forcing a tool call.',
        });
        convo.push({ role: 'assistant', content: text });
        convo.push({
          role: 'user',
          content:
            'You did not call any tool, so the deck is UNCHANGED.\n' +
            (unmetRequest
              ? `The deck RIGHT NOW contains ${deck.slides.length} slide(s):\n` +
                deck.slides
                  .map((sl, i) => `  #${i + 1} id=${sl.id} "${sl.title}"`)
                  .join('\n') +
                '\nWhatever you said earlier, that target still exists. '
              : '') +
            'Do not describe the change and do not claim it was already done — ' +
            'perform it now by calling the appropriate tool. If it genuinely ' +
            'cannot be done with the available tools, say exactly that.',
        });
        continue;
      }

      reply = text;
      break;
    }

    // Record the assistant's tool-call turn before the results.
    convo.push({ role: 'assistant', content: res.text ?? null, toolCalls: res.toolCalls });

    for (const call of res.toolCalls) {
      try {
        // MISTARGETED-FILL GUARD.
        //
        // After add_slide mints an id the model cannot know, its follow-up
        // set_blocks sometimes guesses — and a guess that names an existing
        // populated slide silently destroys that slide's content. Observed
        // live: "add a slide about X" wiped slide 5.
        //
        // The signal is narrow on purpose: only when this turn created a slide
        // AND the fill targets a DIFFERENT, already-populated slide. That
        // leaves legitimate rewrites ("turn slide 2's bullets into a table")
        // completely unaffected, because those turns create nothing.
        if (call.name === 'set_blocks' && createdThisTurn.length > 0) {
          const targetId = String(call.args.slide_id ?? '');
          if (!createdThisTurn.includes(targetId)) {
            const victim = deck.slides.find((sl) => sl.id === targetId);
            if (victim && victim.blocks.length > 0) {
              throw new ToolCallError(
                `set_blocks targeted slide "${targetId}" ("${victim.title}"), which already ` +
                  `has content, but you just created slide ${createdThisTurn.join(', ')}. ` +
                  `Fill the slide you created: use slide_id "${createdThisTurn[0]}".`
              );
            }
          }
        }

        const ops = toolCallToOps(deck, call);
        const applied: string[] = [];
        const mintedIds: string[] = [];
        for (const op of ops) {
          const r = applyOp(deck, op);
          deck = r.deck;
          allOps.push(op);
          emit({ type: 'op', op });
          applied.push(describeOp(op));
          if (op.t === 'add_slide') {
            mintedIds.push(op.slide.id);
            createdThisTurn.push(op.slide.id);
          }
        }
        emit({
          type: 'tool',
          id: call.id,
          name: call.name,
          summary: applied.join('; '),
          args: call.args,
          ops,
          phase: 'edit',
          status: 'ok',
        });

        // Tell the model the SERVER-MINTED id of anything it just created.
        // Without this it has to guess an id for the follow-up set_blocks —
        // and a guess that collides with a real slide silently overwrites that
        // slide's content. Observed live: adding a slide wiped an earlier one.
        const idNote = mintedIds.length
          ? ` The new slide id is ${mintedIds.join(', ')} — use exactly this id for set_blocks.`
          : '';
        convo.push({
          role: 'tool',
          toolCallId: call.id,
          content: `OK. ${applied.join('; ')}.${idNote}`,
        });
      } catch (e) {
        // Hand the error back so the model can correct itself next iteration.
        const msg = e instanceof ToolCallError ? e.message : `unexpected error: ${String(e)}`;
        // Emitted as a tool event, not just a warning: a rejected call is the
        // most informative thing to inspect, and the UI should show its
        // arguments next to the reason it was refused.
        emit({
          type: 'tool',
          id: call.id,
          name: call.name,
          summary: msg,
          args: call.args,
          phase: 'edit',
          status: 'error',
          error: msg,
        });
        convo.push({ role: 'tool', toolCallId: call.id, content: `ERROR: ${msg}` });
      }
    }

    if (iter === MAX_ITERATIONS - 1) {
      emit({
        type: 'warning',
        message: 'Reached the tool-call limit for this turn; stopping here.',
      });
    }
  }

  return { deck, ops: allOps, reply };
}


/**
 * Did the user name a slide that STILL EXISTS, implying an action we never
 * performed?
 *
 * This is the factual counterpart to claimsAnEdit. The "I already removed
 * slide 4" case reads like a refusal and ends in a question, so no wording
 * heuristic catches it — but slide 4 was right there in the deck, which is
 * checkable. Restricted to mutating verbs so questions about a slide
 * ("what's on slide 4?") do not trigger a forced tool call.
 */
function referencesLiveTarget(request: string, deck: Deck): boolean {
  if (!request) return false;
  const t = request.toLowerCase();
  if (!/\b(remove|delete|drop|reorder|move|rename|retitle|rewrite|change|update|edit|add|shorten|condense|make)\b/.test(t)) {
    return false;
  }
  const m = /\bslides?\s*#?\s*(\d{1,2})\b/.exec(t);
  if (!m) return false;
  const n = Number(m[1]);
  return n >= 1 && n <= deck.slides.length;
}

/**
 * Does this reply assert that the deck was changed?
 *
 * Deliberately narrow: past-tense completion claims only. Questions
 * ("which slide did you mean?"), refusals ("I cannot do that"), and
 * descriptions of intent are all legitimate zero-tool replies and must not
 * trigger a forced retry.
 */
function claimsAnEdit(text: string): boolean {
  const t = text.toLowerCase();
  if (/\?\s*$/.test(t.trim())) return false; // a question, not a claim
  if (/\b(cannot|can't|unable|couldn't|could not|no slide|not possible)\b/.test(t)) return false;
  return /\b(removed|deleted|added|updated|changed|rewrote|reordered|renamed|replaced|moved|shortened|condensed|tightened|made)\b/.test(
    t
  );
}
