/**
 * The model providers the hub AI calls, built from the stored `ProviderRecord`s with their keys revealed from the
 * secret vault: `@aeye/openai` for OpenAI (and OpenAI-compatible base URLs), `@aeye/openrouter` for OpenRouter, and a
 * local Ollama through `@aeye/openai` with its native API for abilities and served windows (`contextor/ollama.ts`). The
 * bootstrap OpenRouter key in the model env slice only seeds the first record, when none is stored yet; after that the
 * records are the one source. The hub AI is rebuilt whenever a record changes (`reload`).
 */
import type { Provider, Providers } from '@aeye/ai';
import { OpenAIProvider } from '@aeye/openai';
import { OpenRouterProvider } from '@aeye/openrouter';
import type { Logger } from '@ayepi/log';
import { mintId, type ActorId, type ProviderConfig, type SecretId } from '@harness/core';
import type { SecretVault } from '../api/index.ts';
import { allRows } from '../catalog/rows.ts';
import { OllamaProvider } from '../contextor/ollama.ts';
import { messageOf } from '../catalog/scope.ts';
import type { HubStore } from '../store/index.ts';

/** The app name OpenRouter shows for the hub's calls. */
const APP_NAME = 'harness';

/** Build the aeye provider for one stored config, revealing its keys with `key`. */
export async function buildProvider(config: ProviderConfig, key: (id: SecretId) => Promise<string>, ollamaCap: number): Promise<Provider> {
  switch (config.provider) {
    case 'openai': return new OpenAIProvider({ apiKey: await key(config.apiKey), ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }) });
    case 'openrouter': return new OpenRouterProvider({ apiKey: await key(config.apiKey), defaultParams: { appName: APP_NAME } });
    case 'ollama': return new OllamaProvider({ ...config, cap: ollamaCap });
  }
}

/** The providers for one OpenRouter key: OpenRouter alone, or none without a key (tests and live checks). */
export function openRouterProviders(apiKey: string | undefined): Providers {
  return apiKey === undefined ? {} : { openrouter: new OpenRouterProvider({ apiKey, defaultParams: { appName: APP_NAME } }) };
}

/** Where the hub AI's providers come from when they can change while the hub runs. */
export interface ProviderSource {
  /** The providers of every usable stored record, by kind. */
  load(): Promise<Providers>;
}

/** What the stored providers need. */
export interface StoredProvidersDeps {
  readonly store: HubStore;
  readonly secrets: Pick<SecretVault, 'store' | 'reveal'>;
  readonly log: Logger;
  readonly clock: () => number;
  /** The bootstrap OpenRouter key, stored as the first record when there is none. */
  readonly seed?: { readonly key: string; readonly owner: ActorId } | undefined;
  /** The most window assumed for an Ollama model with no `num_ctx` (`HARNESS_OLLAMA_DEFAULT_CTX`). */
  readonly ollamaCap: number;
}

/** Providers from the store's provider records. */
export class StoredProviders implements ProviderSource {
  readonly #deps: StoredProvidersDeps;

  constructor(deps: StoredProvidersDeps) {
    this.#deps = deps;
  }

  async load(): Promise<Providers> {
    const { store, secrets, log } = this.#deps;
    await this.#seed();
    const providers: Record<string, Provider> = {};
    const reveal = async (id: SecretId): Promise<string> => {
      const value = await secrets.reveal(id);
      if (value === undefined) throw new Error(`its key (${id}) is missing from the vault`);
      return value;
    };
    for (const record of await allRows(store.table('providers'))) {
      try {
        providers[record.config.provider] = await buildProvider(record.config, reveal, this.#deps.ollamaCap);
      } catch (error) {
        log.warn('provider.unusable', { provider: record.config.provider, record: record.id, error: messageOf(error) });
      }
    }
    log.info('providers.loaded', { providers: Object.keys(providers) });
    return providers;
  }

  /** Store the bootstrap key as the OpenRouter record, once, when no provider is configured. */
  async #seed(): Promise<void> {
    const { store, secrets, clock, log, seed } = this.#deps;
    if (seed === undefined || (await store.table('providers').count()) > 0) return;
    const apiKey = await secrets.store({ name: 'provider:openrouter', owner: seed.owner, value: seed.key });
    await store.table('providers').insert({ id: mintId('provider'), config: { provider: 'openrouter', apiKey }, createdAt: clock() });
    log.info('provider.seeded', { provider: 'openrouter' });
  }
}
