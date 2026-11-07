/**
 * The model providers the hub AI calls. Today that is OpenRouter, configured from the bootstrap key in the model env
 * slice; providers stored as `ProviderRecord`s (with keys in the secret vault) come next.
 */
import type { Providers } from '@aeye/ai';
import { OpenRouterProvider } from '@aeye/openrouter';

/** The providers for an OpenRouter key: OpenRouter alone, or none without a key. */
export function openRouterProviders(apiKey: string | undefined): Providers {
  return apiKey === undefined ? {} : { openrouter: new OpenRouterProvider({ apiKey, defaultParams: { appName: 'harness' } }) };
}
