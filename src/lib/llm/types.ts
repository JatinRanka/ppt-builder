/**
 * THE PROVIDER-AGNOSTIC BOUNDARY.
 *
 * The agent never imports a vendor SDK. It depends only on the LLMProvider
 * interface below, so adding OpenAI / Anthropic / Ollama later means writing
 * one adapter file in ./providers and setting LLM_PROVIDER — no agent code
 * changes.
 *
 * Two rules keep this abstraction real rather than decorative:
 *
 * 1. NORMALIZE AT THE BOUNDARY. Vendor wire formats never escape ./providers.
 *    In particular, tool-call `arguments` arrive from some providers as a JSON
 *    *string*; adapters parse them so the agent always receives an object.
 *
 * 2. CAPABILITIES ARE DATA, NOT ASSUMPTIONS. The agent branches on
 *    provider.capabilities rather than hardcoding what a vendor can do. A
 *    provider that supports streamed tool calls gets the better code path for
 *    free; one that does not degrades gracefully.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** A tool call as emitted by the model, normalized. */
export interface ToolCall {
  id: string;
  name: string;
  /** ALREADY PARSED into an object by the adapter. Never a JSON string. */
  args: Record<string, unknown>;
}

export type LLMMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content?: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

/** JSON-Schema description of a callable tool. */
export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema object for the parameters. */
  parameters: Record<string, unknown>;
}

export type ToolChoice = 'auto' | 'none' | 'required' | { name: string };

export interface ChatRequest {
  messages: LLMMessage[];
  tools?: ToolDef[];
  toolChoice?: ToolChoice;
  /**
   * REQUIRED — never defaulted by us. Providers default this low (Sarvam
   * ~2048), and silent mid-object JSON truncation is the single most likely
   * failure mode in this app.
   */
  maxTokens: number;
  temperature?: number;
  /** Structured-output fallback used when a provider lacks tool calling. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  signal?: AbortSignal;
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'error';

export interface ChatResponse {
  text: string | null;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage?: { inputTokens: number; outputTokens: number };
  /** Adapter-level note (e.g. a retry happened) for logging, not control flow. */
  warning?: string;
}

/** Incremental token/tool delta for streaming responses. */
export type ChatDelta =
  | { type: 'text'; text: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_args'; index: number; argsFragment: string }
  | { type: 'finish'; reason: FinishReason };

export interface ProviderCapabilities {
  toolCalling: boolean;
  streaming: boolean;
  /**
   * Whether tool calls arrive incrementally when stream:true is combined with
   * tools. Undocumented for Sarvam, so it was resolved empirically against the
   * live API and recorded here rather than assumed.
   */
  streamingToolCalls: boolean;
  jsonSchema: boolean;
  /** Multiple tool calls in a single assistant turn. */
  parallelToolCalls: boolean;
}

export interface LLMProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  chat(req: ChatRequest): Promise<ChatResponse>;
  streamChat?(req: ChatRequest): AsyncIterable<ChatDelta>;
}

/** Thrown by adapters for provider-side failures, normalized. */
export class LLMError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

/** Safely parse a provider's tool-call arguments string. */
export function parseToolArgs(raw: unknown, toolName: string): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') {
    throw new LLMError(`tool "${toolName}" arguments had unexpected type ${typeof raw}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    // Truncated JSON is the classic max_tokens symptom — say so explicitly so
    // the failure is diagnosable rather than a bare parse error.
    throw new LLMError(
      `tool "${toolName}" returned unparseable arguments (likely truncated by max_tokens): ${String(
        raw
      ).slice(0, 200)}`
    );
  }
}
