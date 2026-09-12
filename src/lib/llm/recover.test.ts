/**
 * Recovery of tool calls that a provider emitted as TEXT.
 *
 * Observed live: with a multi-turn history and tool_choice:'required',
 * sarvam-105b returns the call as JSON in `content` and pads whitespace until
 * max_tokens — 5 of 6 runs. The decision and arguments are correct, only the
 * channel is wrong, so recovering it beats discarding the intent.
 *
 * These tests exercise the adapter's parser through a fake HTTP layer, and
 * pin the negative cases: ordinary prose must never be read as a tool call.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { SarvamProvider } from './providers/sarvam';

/** Stub one chat completion response body. */
function stubResponse(message: Record<string, unknown>, finish = 'length') {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        id: 'x',
        choices: [{ index: 0, message, finish_reason: finish }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const provider = () => new SarvamProvider({ apiKey: 'test-key' });
const ask = () =>
  provider().chat({ messages: [{ role: 'user', content: 'remove slide 4' }], maxTokens: 100 });

afterEach(() => vi.unstubAllGlobals());

describe('leaked tool call recovery', () => {
  it('recovers the exact shape seen live (array, "parameters", whitespace padding)', async () => {
    stubResponse({
      role: 'assistant',
      content:
        '[\n{"name": "delete_slide", "parameters": {"slide_id": "s_sample5"}}\n  \n  \n  \n  \n  ',
      tool_calls: null,
    });
    const res = await ask();
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].name).toBe('delete_slide');
    expect(res.toolCalls[0].args).toEqual({ slide_id: 's_sample5' });
    expect(res.finishReason).toBe('tool_calls');
    // The leaked JSON must not be shown to the user as a reply.
    expect(res.text).toBeNull();
    expect(res.warning).toMatch(/recovered/);
  });

  it('recovers a bare object using OpenAI-style "arguments"', async () => {
    stubResponse({
      role: 'assistant',
      content: '{"name":"update_slide","arguments":{"slide_id":"s_1","title":"New"}}',
      tool_calls: null,
    });
    const res = await ask();
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].args).toEqual({ slide_id: 's_1', title: 'New' });
  });

  it('recovers from inside a ```json fence', async () => {
    stubResponse({
      role: 'assistant',
      content: '```json\n[{"name":"delete_slide","parameters":{"slide_id":"s_9"}}]\n```',
      tool_calls: null,
    });
    const res = await ask();
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].args).toEqual({ slide_id: 's_9' });
  });

  it('leaves a real reply alone', async () => {
    stubResponse(
      { role: 'assistant', content: 'I shortened slide 2 to three bullets.', tool_calls: null },
      'stop'
    );
    const res = await ask();
    expect(res.toolCalls).toEqual([]);
    expect(res.text).toBe('I shortened slide 2 to three bullets.');
    expect(res.finishReason).toBe('stop');
  });

  it('does not mistake non-tool JSON for a tool call', async () => {
    stubResponse({ role: 'assistant', content: '{"slides": 3, "ok": true}', tool_calls: null }, 'stop');
    const res = await ask();
    expect(res.toolCalls).toEqual([]);
    expect(res.text).toBe('{"slides": 3, "ok": true}');
  });

  it('prefers genuine tool_calls over parsing the text', async () => {
    stubResponse({
      role: 'assistant',
      content: '{"name":"delete_slide","parameters":{"slide_id":"WRONG"}}',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'delete_slide', arguments: '{"slide_id":"RIGHT"}' } },
      ],
    });
    const res = await ask();
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].args).toEqual({ slide_id: 'RIGHT' });
  });
});
