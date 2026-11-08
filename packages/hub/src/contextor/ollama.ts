/**
 * A local Ollama as a model provider. Chat goes through its OpenAI-compatible `/v1` (`@aeye/openai`, Chat Completions
 * only); what each model can do and the window it is served with come from Ollama's native API (`/api/tags`,
 * `/api/show`, `/api/version`). The served window is the one that matters: Ollama runs a model with its Modelfile's
 * `num_ctx` (or its own default) and silently cuts the front of a longer prompt, whatever length the model was
 * trained to, and its OpenAI endpoint takes no `num_ctx`.
 */
import type { ModelCapability, ModelInfo } from '@aeye/ai';
import { OpenAIProvider } from '@aeye/openai';
import { OLLAMA_BASE_URL, type ModelLimits } from '@harness/core';
import { z } from 'zod';

/** What `/api/show` says about a model (the parts the hub reads). */
export const OllamaShow = z.object({
  /** Modelfile parameters, one `name value` per line (`num_ctx 8192`). */
  parameters: z.string().optional(),
  template: z.string().optional(),
  /** `<architecture>.context_length` is the trained length. */
  model_info: z.record(z.string(), z.unknown()).optional(),
  /** Newer Ollamas list abilities: `completion`, `tools`, `thinking`, `vision`. */
  capabilities: z.array(z.string()).optional(),
  details: z.object({ family: z.string().optional(), parameter_size: z.string().optional() }).optional(),
});
export type OllamaShow = z.infer<typeof OllamaShow>;

/** What `/api/tags` lists. */
export const OllamaTags = z.object({ models: z.array(z.object({ name: z.string(), model: z.string() })) });
export type OllamaTags = z.infer<typeof OllamaTags>;

const OllamaVersion = z.object({ version: z.string() });

/** The window Ollama served before 0.6 when a Modelfile set no `num_ctx`. */
export const OLLAMA_LEGACY_CTX = 2_048;
/** The window Ollama serves from 0.6 when a Modelfile sets no `num_ctx`. */
export const OLLAMA_CTX = 4_096;

/** Ollama's native API, over an injected `fetch` (tests pass a fake). */
export class OllamaApi {
  readonly baseURL: string;
  readonly #fetch: typeof fetch;

  constructor(baseURL: string = OLLAMA_BASE_URL, fetcher: typeof fetch = fetch) {
    this.baseURL = baseURL.replace(/\/+$/, '');
    this.#fetch = fetcher;
  }

  async tags(): Promise<OllamaTags> {
    return OllamaTags.parse(await this.#json('/api/tags', undefined));
  }

  async show(model: string): Promise<OllamaShow> {
    return OllamaShow.parse(await this.#json('/api/show', { model }));
  }

  async version(): Promise<string> {
    return OllamaVersion.parse(await this.#json('/api/version', undefined)).version;
  }

  async #json(path: string, body: Record<string, string> | undefined): Promise<unknown> {
    const response = await this.#fetch(`${this.baseURL}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`Ollama ${path} answered ${response.status}`);
    return response.json();
  }
}

/** The `num_ctx` a Modelfile sets, if any. */
export function numCtxOf(show: OllamaShow): number | undefined {
  const line = show.parameters?.split('\n').map((l) => l.trim().split(/\s+/)).find(([name]) => name === 'num_ctx');
  const value = Number(line?.[1]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** The length the model was trained to (`<architecture>.context_length`). */
export function trainedLengthOf(show: OllamaShow): number | undefined {
  for (const [key, value] of Object.entries(show.model_info ?? {})) {
    if (key.endsWith('.context_length') && typeof value === 'number') return value;
  }
  return undefined;
}

/** The window Ollama serves when nothing sets `num_ctx`, by its version (`0.5.7` → 2048). */
export function servedDefault(version: string): number {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major === 0 && minor < 6 ? OLLAMA_LEGACY_CTX : OLLAMA_CTX;
}

/**
 * The window an Ollama serves a model with when its Modelfile sets no `num_ctx`: the provider record's window (an
 * admin's statement about that server, which may set `OLLAMA_CONTEXT_LENGTH`), else Ollama's own default for its
 * version, held to `cap`.
 */
export function unsetWindow(version: string, configured: number | undefined, cap: number = Number.POSITIVE_INFINITY): number {
  return configured ?? Math.min(cap, servedDefault(version));
}

/** The window a model is served with: its Modelfile's `num_ctx`, else `unset` (see `unsetWindow`), never more than it was trained to. */
export function servedWindow(show: OllamaShow, unset: number): number {
  return Math.min(numCtxOf(show) ?? unset, trainedLengthOf(show) ?? Number.POSITIVE_INFINITY);
}

/** Whether a model takes native tools: listed as an ability, or its template renders `.Tools`. */
export function takesTools(show: OllamaShow): boolean {
  return show.capabilities?.includes('tools') ?? show.template?.includes('.Tools') ?? false;
}

/** Whether a model thinks before it answers (its thinking counts against its output). */
export function reasons(model: string, show: OllamaShow): boolean {
  return show.capabilities?.includes('thinking') ?? (/(^|[^a-z])(r1|qwq|think)/i.test(model) || (show.template?.includes('<think>') ?? false));
}

/** What a probe of one Ollama model found, given the window of a model with no `num_ctx`. */
export function limitsOf(model: string, show: OllamaShow, unset: number): ModelLimits {
  return { contextWindow: servedWindow(show, unset), ...(reasons(model, show) ? {} : { reasoningTokens: 0 }) };
}

/**
 * Where an Ollama provider listens, the window to assume for models with no `num_ctx`, and the most window assumed
 * when none is set (`HARNESS_OLLAMA_DEFAULT_CTX`), so the model list and the probe (`OllamaProbe`) agree.
 */
export interface OllamaProviderConfig {
  readonly baseURL: string;
  readonly contextWindow?: number | undefined;
  readonly cap: number;
}

/** The window an Ollama serves a model with no `num_ctx` at: the configured one, else its version's default held to `cap`. */
export function unsetWindowOf(api: Pick<OllamaApi, 'version'>, config: Pick<OllamaProviderConfig, 'contextWindow' | 'cap'>): Promise<number> {
  return api.version().then((version) => unsetWindow(version, config.contextWindow, config.cap));
}

/** Ollama through `@aeye/openai`: chat over `/v1`, the model list and abilities from the native API. */
export class OllamaProvider extends OpenAIProvider {
  override readonly name = 'ollama';
  readonly #api: OllamaApi;
  readonly #config: OllamaProviderConfig;

  constructor(config: OllamaProviderConfig, fetcher: typeof fetch = fetch) {
    const api = new OllamaApi(config.baseURL, fetcher);
    super({ apiKey: 'ollama', baseURL: `${api.baseURL}/v1`, api: 'chat' });
    this.#api = api;
    this.#config = config;
  }

  override async listModels(): Promise<ModelInfo[]> {
    const [tags, unset] = await Promise.all([this.#api.tags(), unsetWindowOf(this.#api, this.#config)]);
    return Promise.all(tags.models.map(async ({ name }) => {
      const show = await this.#api.show(name);
      const capabilities = new Set<ModelCapability>(['chat', 'streaming', 'json']);
      if (takesTools(show)) capabilities.add('tools');
      if (reasons(name, show)) capabilities.add('reasoning');
      if (show.capabilities?.includes('vision') === true) capabilities.add('vision');
      return {
        provider: this.name, id: name, name, capabilities, tier: 'efficient', pricing: { text: { input: 0, output: 0 } },
        contextWindow: servedWindow(show, unset), metadata: { family: show.details?.family, size: show.details?.parameter_size },
      } satisfies ModelInfo;
    }));
  }
}
