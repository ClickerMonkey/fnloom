/**
 * The model providers the hub AI calls. Today that is OpenRouter, configured from the bootstrap key in the model env
 * slice; providers stored as `ProviderRecord`s (with keys in the secret vault) come next.
 */
import type { Provider, Providers } from '@aeye/ai';
import { OpenRouterProvider, type OpenRouterConfig } from '@aeye/openrouter';

/**
 * An aeye provider as the `Provider` interface. aeye's OpenAI-based classes type `defaultMetadata` as possibly
 * `undefined`, which `exactOptionalPropertyTypes` refuses for the interface's optional field (library ask), so the
 * hub hands aeye this delegate, which forwards every call the hub uses.
 */
export function asProvider(provider: OpenRouterProvider): Provider<OpenRouterConfig> {
  const metadata = provider.defaultMetadata;
  return {
    name: provider.name,
    config: provider.config,
    ...(metadata === undefined ? {} : { defaultMetadata: metadata }),
    listModels: (config) => provider.listModels(config),
    checkHealth: (config) => provider.checkHealth(config),
    createExecutor: (config) => provider.createExecutor(config),
    createStreamer: (config) => provider.createStreamer(config),
    embed: (request, ctx, config) => {
      if (provider.embed === undefined) throw new Error(`${provider.name} has no embeddings`);
      return provider.embed(request, ctx, config);
    },
  };
}

/** The providers for an OpenRouter key: OpenRouter alone, or none without a key. */
export function openRouterProviders(apiKey: string | undefined): Providers {
  return apiKey === undefined ? {} : { openrouter: asProvider(new OpenRouterProvider({ apiKey, defaultParams: { appName: 'harness' } })) };
}
