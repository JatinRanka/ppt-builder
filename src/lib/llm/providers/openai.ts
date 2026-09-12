/**
 * OPENAI ADAPTER — included to demonstrate that the LLMProvider seam is real.
 *
 * Not used by default (LLM_PROVIDER=sarvam). It exists because an abstraction
 * with exactly one implementation is untested by definition: writing the second
 * adapter is what proves the interface does not leak Sarvam assumptions.
 *
 * To use: set LLM_PROVIDER=openai and OPENAI_API_KEY in .env.local.
 *
 * Note how little is here. Everything Sarvam-specific — the reasoning_effort
 * override, the api-subscription-key header, the configurable base path — is
 * absent, because those belong to that provider and not to the interface.
 */
import OpenAI from 'openai';
import type {
  ChatDelta,
  ChatRequest,
  ChatResponse,
  FinishReason,
  LLMProvider,
  ProviderCapabilities,
  ToolCall,
} from '../types';
import { LLMError, parseToolArgs } from '../types';
import { toWireMessages, toWireTools, toWireToolChoice } from './wire';

const DEFAULT_MODEL = 'gpt-4.1';

export class OpenAIProvider implements LLMProvider {
  readonly id = 'openai';
  readonly model: string;
  readonly capabilities: ProviderCapabilities = {
    toolCalling: true,
    streaming: true,
    streamingToolCalls: true, // documented and reliable here
    jsonSchema: true,
    parallelToolCalls: true,
  };
  private client: OpenAI;

  constructor(opts: { apiKey: string; model?: string }) {
    if (!opts.apiKey) throw new LLMError('OPENAI_API_KEY is not set.');
    this.model = opts.model ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
    this.client = new OpenAI({ apiKey: opts.apiKey, maxRetries: 2 });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    try {
      const res = await this.client.chat.completions.create({
        model: this.model,
        messages: toWireMessages(req.messages),
        max_tokens: req.maxTokens,
        temperature: req.temperature ?? 0.3,
        ...(req.tools?.length
          ? { tools: toWireTools(req.tools), tool_choice: toWireToolChoice(req.toolChoice) }
          : {}),
      });
      const choice = res.choices[0];
      const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((c, i) => {
        const fn = (c as { function?: { name?: string; arguments?: unknown } }).function;
        const name = fn?.name ?? '';
        return { id: c.id ?? `call_${i}`, name, args: parseToolArgs(fn?.arguments, name) };
      });
      return {
        text: choice.message.content ?? null,
        toolCalls,
        finishReason: (toolCalls.length ? 'tool_calls' : choice.finish_reason ?? 'stop') as FinishReason,
        usage: res.usage
          ? { inputTokens: res.usage.prompt_tokens, outputTokens: res.usage.completion_tokens }
          : undefined,
      };
    } catch (e) {
      throw new LLMError(`OpenAI error: ${(e as Error).message}`, (e as { status?: number }).status);
    }
  }

  async *streamChat(req: ChatRequest): AsyncIterable<ChatDelta> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: toWireMessages(req.messages),
      max_tokens: req.maxTokens,
      temperature: req.temperature ?? 0.3,
      stream: true,
      ...(req.tools?.length
        ? { tools: toWireTools(req.tools), tool_choice: toWireToolChoice(req.toolChoice) }
        : {}),
    });
    const seen = new Set<number>();
    let finish: FinishReason = 'stop';
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      if (choice.delta?.content) yield { type: 'text', text: choice.delta.content };
      for (const tc of choice.delta?.tool_calls ?? []) {
        const index = tc.index ?? 0;
        if (!seen.has(index) && tc.function?.name) {
          seen.add(index);
          yield { type: 'tool_call_start', index, id: tc.id ?? `call_${index}`, name: tc.function.name };
        }
        if (tc.function?.arguments) {
          yield { type: 'tool_call_args', index, argsFragment: tc.function.arguments };
        }
      }
      if (choice.finish_reason) {
        finish = (seen.size ? 'tool_calls' : choice.finish_reason) as FinishReason;
      }
    }
    yield { type: 'finish', reason: finish };
  }
}
