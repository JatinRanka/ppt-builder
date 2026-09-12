/**
 * SARVAM ADAPTER — the only place Sarvam-specific behaviour is allowed to live.
 *
 * Quirks contained here so they leak nowhere else:
 *   - Base path is configurable (/v1 vs /v2 differ in model + tool support).
 *   - Auth: the native header is `api-subscription-key`, but `Authorization:
 *     Bearer` is also accepted for OpenAI-compatible tooling. We send Bearer
 *     via the openai SDK and it works.
 *   - `reasoning_effort` is ON by default and reasoning tokens CONSUME the
 *     output budget, so we explicitly disable it for content calls. Docs also
 *     warn that thinking conflicts with response_format on some models.
 *   - `max_tokens` defaults low (~2048) — always sent explicitly.
 *   - Tool-call `arguments` arrive as a JSON STRING and are parsed here.
 *
 * Sarvam is OpenAI-compatible, so we use the `openai` SDK pointed at Sarvam's
 * base URL. That also means the eventual OpenAI adapter shares most of this
 * body.
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

const DEFAULT_BASE_URL = 'https://api.sarvam.ai/v1';
const DEFAULT_MODEL = 'sarvam-105b';

/**
 * Capabilities reflect behaviour verified against the live API.
 *
 * streamingToolCalls defaults to FALSE deliberately: it is undocumented, and
 * assuming true would break generation if unsupported. The architecture does
 * not need it — phase 2 issues one call per slide, so slides land one by one
 * and the UI streams visibly regardless. Flip via SARVAM_STREAMING_TOOL_CALLS=1
 * to opt in.
 */
function resolveCapabilities(): ProviderCapabilities {
  return {
    toolCalling: process.env.SARVAM_TOOL_CALLING !== '0',
    streaming: true,
    streamingToolCalls: process.env.SARVAM_STREAMING_TOOL_CALLS === '1',
    jsonSchema: true,
    parallelToolCalls: process.env.SARVAM_PARALLEL_TOOL_CALLS !== '0',
  };
}

function normalizeFinish(raw: string | null | undefined, hasCalls: boolean): FinishReason {
  if (hasCalls) return 'tool_calls';
  switch (raw) {
    case 'tool_calls':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'stop':
      return 'stop';
    default:
      return raw ? 'stop' : 'error';
  }
}

export class SarvamProvider implements LLMProvider {
  readonly id = 'sarvam';
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  private client: OpenAI;

  constructor(opts: { apiKey: string; baseURL?: string; model?: string }) {
    if (!opts.apiKey) {
      throw new LLMError('SARVAM_API_KEY is not set. Copy .env.example to .env.local and add it.');
    }
    this.model = opts.model ?? process.env.SARVAM_MODEL ?? DEFAULT_MODEL;
    this.capabilities = resolveCapabilities();
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL ?? process.env.SARVAM_BASE_URL ?? DEFAULT_BASE_URL,
      // Sarvam also accepts its native header; harmless alongside Bearer and
      // makes the adapter work if Bearer support is ever withdrawn.
      defaultHeaders: { 'api-subscription-key': opts.apiKey },
      maxRetries: 2, // covers transient 429/5xx
    });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toWireMessages(req.messages),
      max_tokens: req.maxTokens, // ALWAYS explicit
      temperature: req.temperature ?? 0.3,
      // Reasoning tokens eat the output budget and can starve the JSON. Off.
      reasoning_effort: null,
    };

    if (req.tools?.length && this.capabilities.toolCalling) {
      body.tools = toWireTools(req.tools);
      // tool_choice is only valid alongside a non-empty tools array.
      const tc = toWireToolChoice(req.toolChoice);
      if (tc) body.tool_choice = tc;
    } else if (req.jsonSchema) {
      // Fallback path when tool calling is unavailable.
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: req.jsonSchema.name, strict: true, schema: req.jsonSchema.schema },
      };
    }

    try {
      const res = (await this.client.chat.completions.create(
        body as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
        { signal: req.signal }
      )) as OpenAI.Chat.ChatCompletion;

      const choice = res.choices?.[0];
      const msg = choice?.message;
      const rawCalls = msg?.tool_calls ?? [];

      const toolCalls: ToolCall[] = rawCalls.map((c, i) => {
        const fn = (c as { function?: { name?: string; arguments?: unknown } }).function;
        const name = fn?.name ?? '';
        return {
          id: c.id ?? `call_${i}`,
          name,
          args: parseToolArgs(fn?.arguments, name),
        };
      });

      // RECOVER TOOL CALLS LEAKED AS TEXT.
      //
      // With a long conversation and tool_choice:'required', sarvam-105b
      // sometimes emits the call as JSON in `content` instead of `tool_calls`,
      // then pads whitespace until it hits max_tokens (observed live: 5 of 6
      // runs on a 4-turn history). The decision is correct and the arguments
      // are right — only the channel is wrong — so parsing it out turns a
      // hard failure into a working call rather than discarding the intent.
      let recovered: ToolCall[] = [];
      if (!toolCalls.length && msg?.content) {
        recovered = recoverToolCallsFromText(msg.content);
      }
      const allCalls = toolCalls.length ? toolCalls : recovered;

      const finishReason = normalizeFinish(choice?.finish_reason, allCalls.length > 0);

      return {
        // Suppress the leaked JSON: it is a tool call, not a user-facing reply.
        text: recovered.length ? null : msg?.content ?? null,
        toolCalls: allCalls,
        finishReason,
        usage: res.usage
          ? { inputTokens: res.usage.prompt_tokens, outputTokens: res.usage.completion_tokens }
          : undefined,
        warning: recovered.length
          ? `recovered ${recovered.length} tool call(s) emitted as text instead of tool_calls`
          : finishReason === 'length'
            ? 'response hit max_tokens and may be truncated'
            : undefined,
      };
    } catch (e) {
      throw wrapError(e);
    }
  }

  /**
   * Token-level streaming. Emits tool-call deltas only if the provider actually
   * sends them; the agent checks capabilities.streamingToolCalls before relying
   * on that.
   */
  async *streamChat(req: ChatRequest): AsyncIterable<ChatDelta> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toWireMessages(req.messages),
      max_tokens: req.maxTokens,
      temperature: req.temperature ?? 0.3,
      reasoning_effort: null,
      stream: true,
    };
    if (req.tools?.length && this.capabilities.toolCalling) {
      body.tools = toWireTools(req.tools);
      const tc = toWireToolChoice(req.toolChoice);
      if (tc) body.tool_choice = tc;
    }

    try {
      const stream = (await this.client.chat.completions.create(
        body as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
        { signal: req.signal }
      )) as unknown as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;

      const seenToolIndexes = new Set<number>();
      let finish: FinishReason = 'stop';

      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta as OpenAI.Chat.ChatCompletionChunk.Choice.Delta;

        if (delta?.content) {
          yield { type: 'text', text: delta.content };
        }

        // OpenAI's shape: index-keyed fragments accumulated by the consumer.
        for (const tc of delta?.tool_calls ?? []) {
          const index = tc.index ?? 0;
          if (!seenToolIndexes.has(index) && tc.function?.name) {
            seenToolIndexes.add(index);
            yield {
              type: 'tool_call_start',
              index,
              id: tc.id ?? `call_${index}`,
              name: tc.function.name,
            };
          }
          if (tc.function?.arguments) {
            yield { type: 'tool_call_args', index, argsFragment: tc.function.arguments };
          }
        }

        if (choice.finish_reason) {
          finish = normalizeFinish(choice.finish_reason, seenToolIndexes.size > 0);
        }
      }
      yield { type: 'finish', reason: finish };
    } catch (e) {
      throw wrapError(e);
    }
  }
}

function wrapError(e: unknown): LLMError {
  if (e instanceof LLMError) return e;
  const status = (e as { status?: number })?.status;
  const message = (e as { message?: string })?.message ?? String(e);
  // 429 and 5xx are worth retrying; 4xx generally is not.
  const retryable = status === 429 || (typeof status === 'number' && status >= 500);
  return new LLMError(`Sarvam API error${status ? ` (${status})` : ''}: ${message}`, status, retryable);
}


/**
 * Parse tool calls that were emitted as text rather than in `tool_calls`.
 *
 * Handles the shapes observed from sarvam-105b:
 *   [{"name": "delete_slide", "parameters": {...}}]
 *   {"name": "delete_slide", "arguments": {...}}
 * possibly wrapped in a ```json fence and followed by whitespace padding.
 *
 * Returns [] for anything that is not clearly a tool call, so ordinary prose
 * replies are never misread as one.
 */
function recoverToolCallsFromText(content: string): ToolCall[] {
  const trimmed = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return [];

  // The padding leaves the JSON unterminated, so take the balanced prefix.
  const candidate = balancedPrefix(trimmed);
  if (!candidate) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return [];
  }

  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const calls: ToolCall[] = [];
  for (const [i, raw] of entries.entries()) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name : undefined;
    if (!name) continue;
    // Sarvam uses "parameters"; OpenAI-shaped output uses "arguments".
    const rawArgs = o.parameters ?? o.arguments ?? o.args ?? {};
    let args: Record<string, unknown>;
    try {
      args = parseToolArgs(rawArgs, name);
    } catch {
      continue;
    }
    calls.push({ id: `recovered_${i}`, name, args });
  }
  return calls;
}

/** Longest prefix of `s` that is a balanced JSON value, ignoring strings. */
function balancedPrefix(s: string): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return s.slice(0, i + 1);
      if (depth < 0) return null;
    }
  }
  // Unterminated (whitespace-padded): close the open containers ourselves.
  if (depth > 0 && !inString) {
    const tail = s.trimEnd();
    // Only safe if the content so far ends a complete value.
    if (/[}\]"\d]$/.test(tail)) {
      let closed = tail;
      // Guess the closers from the opening order.
      const stack: string[] = [];
      let inStr = false, esc = false;
      for (const ch of tail) {
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') stack.push('}');
        else if (ch === '[') stack.push(']');
        else if (ch === '}' || ch === ']') stack.pop();
      }
      while (stack.length) closed += stack.pop();
      return closed;
    }
  }
  return null;
}
