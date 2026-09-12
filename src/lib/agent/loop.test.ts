/**
 * End-to-end agent pipeline tests using a FAKE provider.
 *
 * This is where the LLMProvider abstraction earns its keep a second time: the
 * whole tool loop and two-phase orchestration are testable with zero network
 * and no API key, because the agent depends on an interface rather than an SDK.
 *
 * These tests assert the properties that actually matter:
 *   - the model's tool calls become real deck mutations
 *   - an edit produces a TARGETED patch, not a regenerated deck
 *   - validation errors are fed back so the model can self-correct
 *   - two-phase generation runs outline-then-content
 *   - manually-edited slides are never overwritten
 */
import { describe, expect, it } from 'vitest';
import { runAgentLoop } from './loop';
import { generateDeck } from './twoPhase';
import { makeSampleDeck, makeEmptyDeck } from '@/lib/schema/factory';
import type { AgentEvent } from './protocol';
import type { ChatRequest, ChatResponse, LLMProvider, ToolCall } from '@/lib/llm/types';

/** A provider that replays a scripted list of responses. */
function fakeProvider(script: ChatResponse[]): LLMProvider & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  let i = 0;
  return {
    id: 'fake',
    model: 'fake-1',
    capabilities: {
      toolCalling: true, streaming: false, streamingToolCalls: false,
      jsonSchema: true, parallelToolCalls: true,
    },
    calls,
    async chat(req) {
      calls.push(req);
      return script[Math.min(i++, script.length - 1)];
    },
  };
}

const tc = (name: string, args: Record<string, unknown>, id = 'c' + Math.random()): ToolCall =>
  ({ id, name, args });

const reply = (text: string): ChatResponse => ({
  text, toolCalls: [], finishReason: 'stop',
});
const withTools = (...toolCalls: ToolCall[]): ChatResponse => ({
  text: null, toolCalls, finishReason: 'tool_calls',
});

describe('runAgentLoop', () => {
  it('applies a tool call to the deck and emits the op', async () => {
    const deck = makeSampleDeck();
    const slide = deck.slides[1];
    const provider = fakeProvider([
      withTools(tc('patch_block', {
        slide_id: slide.id, block_id: slide.blocks[0].id, patch: { items: ['one tight point'] },
      })),
      reply('Tightened slide 2.'),
    ]);

    const events: AgentEvent[] = [];
    const res = await runAgentLoop({
      provider, deck,
      messages: [{ role: 'user', content: 'make slide 2 concise' }],
      emit: (e) => events.push(e),
    });

    expect(res.ops).toHaveLength(1);
    expect(res.reply).toBe('Tightened slide 2.');
    expect(events.filter((e) => e.type === 'op')).toHaveLength(1);

    const patched = res.deck.slides[1].blocks[0];
    expect(patched.type === 'bullets' && patched.items).toEqual(['one tight point']);
  });

  it('emits full tool detail (args + resulting ops) for the UI', async () => {
    // The UI shows args and ops so the agentic/diff-based claims are
    // verifiable rather than asserted. A summary string alone once hid a
    // no-op patch that the model reported as a success.
    const deck = makeSampleDeck();
    const slide = deck.slides[1];
    const provider = fakeProvider([
      withTools(tc('patch_block', {
        slide_id: slide.id, block_id: slide.blocks[0].id, patch: { items: ['tightened'] },
      })),
      reply('Done.'),
    ]);

    const events: AgentEvent[] = [];
    await runAgentLoop({
      provider, deck, messages: [{ role: 'user', content: 'tighten slide 2' }],
      emit: (e) => events.push(e),
    });

    const toolEvent = events.find((e) => e.type === 'tool');
    expect(toolEvent).toBeDefined();
    if (toolEvent?.type !== 'tool') throw new Error('expected a tool event');

    expect(toolEvent.status).toBe('ok');
    expect(toolEvent.name).toBe('patch_block');
    expect(toolEvent.phase).toBe('edit');
    // The raw arguments the model produced.
    expect(toolEvent.args).toMatchObject({ slide_id: slide.id, block_id: slide.blocks[0].id });
    // And the ops they compiled to — exactly one, proving it is a diff.
    expect(toolEvent.ops).toHaveLength(1);
    expect(toolEvent.ops?.[0].t).toBe('patch_block');
  });

  it('produces a TARGETED patch — other slides keep reference identity', async () => {
    const deck = makeSampleDeck();
    const slide = deck.slides[3];
    const provider = fakeProvider([
      withTools(tc('update_slide', { slide_id: slide.id, title: 'Build vs Buy: Search (revised)' })),
      reply('Retitled.'),
    ]);
    const res = await runAgentLoop({
      provider, deck, messages: [{ role: 'user', content: 'retitle slide 4' }], emit: () => {},
    });
    // The untouched slides are the SAME OBJECTS, so nothing was regenerated.
    expect(res.deck.slides[0]).toBe(deck.slides[0]);
    expect(res.deck.slides[1]).toBe(deck.slides[1]);
    expect(res.deck.slides[4]).toBe(deck.slides[4]);
    expect(res.deck.slides[3].title).toContain('revised');
  });

  it('feeds a validation error back so the model can self-correct', async () => {
    const deck = makeSampleDeck();
    const provider = fakeProvider([
      // First the model invents a slide id...
      withTools(tc('update_slide', { slide_id: 'slide_99', title: 'nope' })),
      // ...then corrects itself using the real id from the error.
      withTools(tc('update_slide', { slide_id: deck.slides[0].id, title: 'Corrected' })),
      reply('Fixed it.'),
    ]);

    const events: AgentEvent[] = [];
    const res = await runAgentLoop({
      provider, deck, messages: [{ role: 'user', content: 'retitle the first slide' }],
      emit: (e) => events.push(e),
    });

    // A rejected call is now a tool event with status 'error' (it used to be an
    // opaque warning), so the UI can show the bad args next to the reason.
    const rejected = events.find((e) => e.type === 'tool' && e.status === 'error');
    expect(rejected).toBeDefined();
    if (rejected?.type === 'tool') {
      expect(rejected.name).toBe('update_slide');
      expect(rejected.args).toMatchObject({ slide_id: 'slide_99' });
      expect(rejected.error).toContain('slide_99');
    }
    expect(res.deck.slides[0].title).toBe('Corrected');

    // The error was delivered as a tool result, which is what enables recovery.
    const secondCall = provider.calls[1];
    const toolMsg = secondCall.messages.find((m) => m.role === 'tool');
    expect(toolMsg && 'content' in toolMsg && toolMsg.content).toContain('ERROR');
  });

  it('blocks a mistargeted set_blocks from wiping an existing slide', async () => {
    // Observed live: "add a slide about investment opportunities" caused
    // add_slide (id minted server-side) followed by a set_blocks that GUESSED
    // an id — hitting slide 5 and destroying content an earlier edit had just
    // produced. The guard must reject that and tell the model the right id.
    const deck = makeSampleDeck();
    const populated = deck.slides[1]; // has a bullets block
    expect(populated.blocks.length).toBeGreaterThan(0);

    let phase = 0;
    const provider: LLMProvider = {
      id: 'fake', model: 'f',
      capabilities: {
        toolCalling: true, streaming: false, streamingToolCalls: false,
        jsonSchema: true, parallelToolCalls: true,
      },
      async chat() {
        phase++;
        if (phase === 1) {
          return withTools(
            tc('add_slide', { kind: 'content', title: 'New Slide', brief: 'b' }),
            // Wrong target: an existing, populated slide.
            tc('set_blocks', {
              slide_id: populated.id,
              blocks: [{ type: 'paragraph', text: 'this must not land' }],
            })
          );
        }
        return reply('ok');
      },
    };

    const events: AgentEvent[] = [];
    const res = await runAgentLoop({
      provider, deck,
      messages: [{ role: 'user', content: 'add a slide' }],
      emit: (e) => events.push(e),
    });

    // The populated slide kept its original content.
    const after = res.deck.slides.find((s) => s.id === populated.id)!;
    expect(after.blocks).toEqual(populated.blocks);
    expect(after.blocks.some((b) => b.type === 'paragraph')).toBe(false);

    // And the model was told which id to use instead.
    const warned = events.find(
      (e) => e.type === 'tool' && e.status === 'error' && e.error?.includes('you just created')
    );
    expect(warned).toBeDefined();
  });

  it('forces a tool call when the model only CLAIMS it made an edit', async () => {
    // Observed live, 7 out of 8 runs: with a conversation history of prose
    // replies ("I removed X"), "remove slide 3" came back as another sentence
    // and no delete_slide — a claimed edit that never happened.
    const deck = makeSampleDeck();
    const target = deck.slides[2];
    let call_n = 0;
    const provider: LLMProvider & { choices: unknown[] } = {
      id: 'fake', model: 'f',
      capabilities: {
        toolCalling: true, streaming: false, streamingToolCalls: false,
        jsonSchema: true, parallelToolCalls: true,
      },
      choices: [] as unknown[],
      async chat(req) {
        (this.choices as unknown[]).push(req.toolChoice);
        // First turn: assert success without acting.
        if (call_n++ === 0) return reply('I removed slide 3 from the deck.');
        return withTools(tc('delete_slide', { slide_id: target.id }));
      },
    };

    const events: AgentEvent[] = [];
    const res = await runAgentLoop({
      provider, deck,
      messages: [{ role: 'user', content: 'remove slide 3' }],
      emit: (e) => events.push(e),
    });

    // The edit actually happened.
    expect(res.deck.slides.find((s) => s.id === target.id)).toBeUndefined();
    expect(res.ops.map((o) => o.t)).toContain('delete_slide');
    // The retry was forced, not optional.
    expect(provider.choices[1]).toBe('required');
    // And the user was told, rather than it being papered over.
    expect(
      events.some((e) => e.type === 'warning' && /without making one/.test(e.message))
    ).toBe(true);
  });

  it('does NOT force a tool call for a legitimate text-only reply', async () => {
    // Questions and refusals are valid zero-tool answers. Forcing a call there
    // would make the agent act on a request it did not understand.
    for (const text of [
      'Which slide did you mean?',
      'I cannot do that with the available tools.',
      'There is no slide 9 in this deck.',
    ]) {
      const deck = makeSampleDeck();
      let n = 0;
      const provider: LLMProvider = {
        id: 'fake', model: 'f',
        capabilities: {
          toolCalling: true, streaming: false, streamingToolCalls: false,
          jsonSchema: true, parallelToolCalls: true,
        },
        async chat() {
          n++;
          return reply(text);
        },
      };
      const res = await runAgentLoop({
        provider, deck, messages: [{ role: 'user', content: 'do something vague' }],
        emit: () => {},
      });
      // Exactly one call — no forced retry.
      expect(n).toBe(1);
      expect(res.reply).toBe(text);
      expect(res.ops).toEqual([]);
    }
  });

  it('stops after the iteration cap instead of looping forever', async () => {
    const deck = makeSampleDeck();
    // A model that always calls a tool and never replies.
    const provider = fakeProvider([
      withTools(tc('update_slide', { slide_id: deck.slides[0].id, title: 'again' })),
    ]);
    const events: AgentEvent[] = [];
    await runAgentLoop({
      provider, deck, messages: [{ role: 'user', content: 'loop' }], emit: (e) => events.push(e),
    });
    expect(provider.calls.length).toBeLessThanOrEqual(8);
    expect(events.some((e) => e.type === 'warning' && /limit/i.test(e.message))).toBe(true);
  });
});

describe('generateDeck — two-phase', () => {
  it('runs outline first, then one content call per slide', async () => {
    const deck = makeEmptyDeck('Test');
    // Phase 1 returns three add_slide calls; every later call fills one slide.
    const provider: LLMProvider & { calls: ChatRequest[] } = (() => {
      const calls: ChatRequest[] = [];
      let n = 0;
      return {
        id: 'fake', model: 'f',
        capabilities: { toolCalling: true, streaming: false, streamingToolCalls: false, jsonSchema: true, parallelToolCalls: true },
        calls,
        async chat(req) {
          calls.push(req);
          if (n++ === 0) {
            return withTools(
              tc('add_slide', { kind: 'title', title: 'Intro', brief: 'open' }),
              tc('add_slide', { kind: 'content', title: 'Body', brief: 'middle' }),
              tc('add_slide', { kind: 'content', title: 'Close', brief: 'end' })
            );
          }
          // Phase 2: the forced tool is set_blocks, targeting the asked slide.
          const sys = req.messages[0];
          const id = 'content' in sys ? /id=(s_\w+)/.exec(String(sys.content))?.[1] : undefined;
          return withTools(tc('set_blocks', {
            slide_id: id, blocks: [{ type: 'bullets', items: ['generated point'] }],
          }));
        },
      };
    })();

    const events: AgentEvent[] = [];
    const res = await generateDeck({
      provider, deck, userPrompt: 'a 3 slide deck', emit: (e) => events.push(e),
    });

    // Phase ordering is observable in the event stream.
    const phases = events.filter((e) => e.type === 'phase').map((e) => (e as { phase: string }).phase);
    expect(phases).toEqual(['outline', 'content']);

    // 1 outline call + 3 content calls.
    expect(provider.calls).toHaveLength(4);
    expect(provider.calls[0].toolChoice).toBe('required');
    expect(provider.calls[1].toolChoice).toEqual({ name: 'set_blocks' });

    expect(res.deck.slides).toHaveLength(3);
    expect(res.slidesGenerated).toBe(3);
    for (const s of res.deck.slides) {
      expect(s.status).toBe('ready');
      expect(s.blocks.length).toBeGreaterThan(0);
    }

    // Slides were emitted progressively — that is the visible streaming.
    const opEvents = events.filter((e) => e.type === 'op');
    expect(opEvents.length).toBeGreaterThanOrEqual(6); // 3 adds + 3 fills (+status)
  });

  it('emits tool events for BOTH phases of generation', async () => {
    // Generation makes the most tool calls of any flow, yet previously emitted
    // none — so the UI showed "0 tool calls" for the deck build itself.
    const deck = makeEmptyDeck('Test');
    let n = 0;
    const provider: LLMProvider = {
      id: 'fake', model: 'f',
      capabilities: {
        toolCalling: true, streaming: false, streamingToolCalls: false,
        jsonSchema: true, parallelToolCalls: true,
      },
      async chat(req) {
        if (n++ === 0) {
          return withTools(
            tc('add_slide', { kind: 'title', title: 'Intro', brief: 'open' }),
            tc('add_slide', { kind: 'content', title: 'Body', brief: 'middle' }),
            tc('add_slide', { kind: 'content', title: 'End', brief: 'close' }),
            tc('add_slide', { kind: 'content', title: 'Extra', brief: 'more' })
          );
        }
        const sys = req.messages[0];
        const id = 'content' in sys ? /id=(s_\w+)/.exec(String(sys.content))?.[1] : undefined;
        return withTools(tc('set_blocks', {
          slide_id: id, blocks: [{ type: 'bullets', items: ['point'] }],
        }));
      },
    };

    const events: AgentEvent[] = [];
    await generateDeck({
      provider, deck, userPrompt: 'a 4 slide deck', emit: (e) => events.push(e),
    });

    const tools = events.filter((e) => e.type === 'tool');
    const phases = new Set(tools.map((t) => (t.type === 'tool' ? t.phase : null)));
    expect(phases).toContain('outline');
    expect(phases).toContain('content');
    // Four add_slide calls plus four content fills.
    expect(tools.length).toBeGreaterThanOrEqual(8);
    // Every one carries its args.
    expect(tools.every((t) => t.type === 'tool' && t.args !== undefined)).toBe(true);
  });

  it('never overwrites a manually-edited slide during phase 2', async () => {
    // A deck whose only slide is an outline skeleton the user has since edited.
    const base = makeEmptyDeck('Test');
    const deck = {
      ...base,
      slides: [
        {
          id: 's_manual', kind: 'content' as const, title: 'My own words',
          blocks: [], layout: { variant: 'single' as const, align: 'left' as const, density: 'normal' as const },
          speakerNotes: '', status: 'outline' as const, brief: 'x', dirty: true,
        },
      ],
    };

    // Phase 2 resolves the real minted id from the system prompt, so this fake
    // fills whichever slide it is actually asked about.
    let n = 0;
    const provider: LLMProvider & { calls: ChatRequest[] } = {
      id: 'fake', model: 'f',
      capabilities: {
        toolCalling: true, streaming: false, streamingToolCalls: false,
        jsonSchema: true, parallelToolCalls: true,
      },
      calls: [] as ChatRequest[],
      async chat(req) {
        (this.calls as ChatRequest[]).push(req);
        if (n++ === 0) {
          return withTools(tc('add_slide', { kind: 'content', title: 'New', brief: 'new slide' }));
        }
        const sys = req.messages[0];
        const id = 'content' in sys ? /id=(s_\w+)/.exec(String(sys.content))?.[1] : undefined;
        return withTools(tc('set_blocks', {
          slide_id: id, blocks: [{ type: 'bullets', items: ['x'] }],
        }));
      },
    };

    const res = await generateDeck({
      provider, deck, userPrompt: 'add a slide', emit: () => {},
    });

    // The dirty slide is excluded from phase 2 entirely: still no blocks.
    expect(res.deck.slides[0].id).toBe('s_manual');
    expect(res.deck.slides[0].dirty).toBe(true);
    expect(res.deck.slides[0].blocks).toEqual([]);

    // Exactly one content call, and it targeted the NEW slide, not the dirty one.
    const contentCalls = provider.calls.filter((c) => typeof c.toolChoice === 'object');
    expect(contentCalls).toHaveLength(1);
    const sys = contentCalls[0].messages[0];
    expect('content' in sys && String(sys.content)).not.toContain('s_manual');
  });

  it('recovers when the outline comes back with only one slide', async () => {
    // Observed live twice: sarvam-105b intermittently emits a single add_slide
    // and stops. Shipping a 1-slide deck when the user asked for five is the
    // worst outcome, so phase 1 retries. The follow-up round also hallucinates
    // after_slide_id values, which the retry neutralises by forcing an append.
    let round = 0;
    const provider: LLMProvider = {
      id: 'fake', model: 'f',
      capabilities: {
        toolCalling: true, streaming: false, streamingToolCalls: false,
        jsonSchema: true, parallelToolCalls: true,
      },
      async chat(req) {
        const sys = String((req.messages[0] as { content: string }).content);
        if (sys.includes('slide-content agent')) {
          const id = /id=(s_\w+)/.exec(sys)?.[1];
          return withTools(tc('set_blocks', {
            slide_id: id, blocks: [{ type: 'bullets', items: ['x'] }],
          }));
        }
        if (++round === 1) {
          return withTools(tc('add_slide', { kind: 'title', title: 'Only One', brief: 'b' }));
        }
        return withTools(
          ...[2, 3, 4, 5].map((i) =>
            tc('add_slide', {
              kind: 'content', title: `Slide ${i}`, brief: 'b',
              // Deliberately bogus: the retry must not drop the slide over it.
              after_slide_id: 's_hallucinated',
            })
          )
        );
      },
    };

    const res = await generateDeck({
      provider, deck: makeEmptyDeck(),
      userPrompt: 'Create a 5-slide deck about testing',
      emit: () => {},
    });

    expect(res.deck.slides).toHaveLength(5);
    expect(res.deck.slides[0].title).toBe('Only One');
    expect(round).toBeGreaterThan(1); // it actually retried
  });

  it('throws a clear error when the model refuses to call tools', async () => {
    const provider = fakeProvider([reply('Here is a deck about cats: slide 1...')]);
    await expect(
      generateDeck({ provider, deck: makeEmptyDeck(), userPrompt: 'x', emit: () => {} })
    ).rejects.toThrow(/did not produce an outline/);
  });
});
