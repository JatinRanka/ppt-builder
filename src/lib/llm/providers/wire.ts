/**
 * Shared OpenAI-wire-format translation.
 *
 * Sarvam is OpenAI-compatible, so both adapters need the same message/tool
 * translation. It lives here rather than being duplicated — but note it is
 * confined to ./providers, so this wire format never becomes part of the
 * LLMProvider contract. A future non-OpenAI-shaped provider (Anthropic's
 * native API, Ollama) writes its own translation and ignores this file.
 */
import type OpenAI from 'openai';
import type { LLMMessage, ToolChoice, ToolDef } from '../types';

export function toWireMessages(
  messages: LLMMessage[]
): OpenAI.Chat.ChatCompletionMessageParam[] {
  return messages.map((m): OpenAI.Chat.ChatCompletionMessageParam => {
    switch (m.role) {
      case 'system':
        return { role: 'system', content: m.content };
      case 'user':
        return { role: 'user', content: m.content };
      case 'tool':
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      case 'assistant':
        return {
          role: 'assistant',
          content: m.content ?? null,
          ...(m.toolCalls?.length
            ? {
                tool_calls: m.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: 'function' as const,
                  function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                })),
              }
            : {}),
        };
    }
  });
}

export function toWireTools(tools: ToolDef[]): OpenAI.Chat.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export function toWireToolChoice(
  choice: ToolChoice | undefined
): OpenAI.Chat.ChatCompletionToolChoiceOption | undefined {
  if (!choice) return undefined;
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  return { type: 'function', function: { name: choice.name } };
}
