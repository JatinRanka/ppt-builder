/**
 * PROVIDER FACTORY — the single place a concrete provider is chosen.
 *
 * Agent code calls getProvider() and depends only on the LLMProvider interface.
 * Adding a provider: write an adapter in ./providers, add a case here, document
 * the env var. Nothing else changes.
 *
 * Server-only: this module reads API keys from process.env and must never be
 * imported into a client component.
 */
import type { LLMProvider } from './types';
import { LLMError } from './types';
import { SarvamProvider } from './providers/sarvam';
import { OpenAIProvider } from './providers/openai';

export type ProviderId = 'sarvam' | 'openai';

let cached: LLMProvider | null = null;

/**
 * Resolve the configured provider. Cached because constructing an SDK client
 * per request is wasteful, and the config cannot change at runtime.
 */
export function getProvider(): LLMProvider {
  if (cached) return cached;

  const id = (process.env.LLM_PROVIDER ?? 'sarvam').toLowerCase() as ProviderId;

  switch (id) {
    case 'sarvam':
      cached = new SarvamProvider({ apiKey: process.env.SARVAM_API_KEY ?? '' });
      break;
    case 'openai':
      cached = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY ?? '' });
      break;
    default:
      throw new LLMError(
        `Unknown LLM_PROVIDER "${id}". Supported: sarvam, openai.`
      );
  }
  return cached;
}

/** Test seam: inject a fake provider without touching env or the network. */
export function setProviderForTesting(p: LLMProvider | null) {
  cached = p;
}

/** Whether the configured provider has a usable key, for a friendly 503. */
export function isProviderConfigured(): boolean {
  const id = (process.env.LLM_PROVIDER ?? 'sarvam').toLowerCase();
  if (id === 'openai') return Boolean(process.env.OPENAI_API_KEY);
  return Boolean(process.env.SARVAM_API_KEY);
}

export * from './types';
