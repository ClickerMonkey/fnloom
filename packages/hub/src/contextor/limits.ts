/**
 * Every model's limits, resolved field by field from the first source that knows: an admin's record
 * (`modelLimits`), a probe of the provider that serves it (Ollama's `/api/show`, cached for `HARNESS_MODEL_PROBE_TTL`),
 * aeye's model info (the hub AI's model list and the `@aeye/models` registry), then the hub's defaults (logged once
 * per model as `model.limits.guessed`). A reasoning model reserves half its output for thinking unless a source sets
 * it. An output limit that no admin set is held to a quarter of the window, since model cards often give the whole
 * window as the output limit. The view carries the model's calibration ratio too.
 */
import type { ModelInfo as AeyeModelInfo } from '@aeye/ai';
import { OllamaApi, reasons, servedWindow, unsetWindow, type OllamaShow } from '@aeye/ollama';
import type { Logger } from '@ayepi/log';
import { messageOf, MODEL_LIMIT_FIELDS, namesModel, type ActorId, type LimitSource, type ModelInfo, type ModelLimitField, type ModelLimits, type ModelLimitsView, type ProviderConfig, type ResolvedModelLimits } from '@harness/core';
import { allRows } from '../store/rows.ts';
import type { HubStore } from '../store/index.ts';
import type { ContextorEnv } from './env.ts';
import type { ModelLimitsService } from './index.ts';
import { CALIBRATION, DEFAULT_CHARS_PER_TOKEN, TOKENIZER_CHARS } from './tokens.ts';


/** The model key limits are resolved under when the model is picked automatically (by weights). */
export const AUTO_MODEL = 'auto';

/** Asks a provider what it really serves a model with. */
export interface ModelProbe {
  probe(model: string): Promise<ModelLimits | undefined>;
}

/** Makes the probe of one provider record (none for providers with nothing to ask). */
export type ProbeFactory = (config: ProviderConfig) => ModelProbe | undefined;

/** Characters per token by Ollama model family. */
const FAMILY_CHARS: Readonly<Record<string, number>> = { qwen2: 3.5, qwen3: 3.5, llama: 3.5, gemma: 3.8, gemma2: 3.8, gemma3: 3.8, mistral: 3.6, phi3: 3.8 };

/** What a probe of one Ollama model found, given the window of a model with no `num_ctx`: its served window, and no thinking budget when it doesn't think. */
export function limitsOf(model: string, show: OllamaShow, unset: number): ModelLimits {
  return { contextWindow: servedWindow(show, unset), ...(reasons(model, show) ? {} : { reasoningTokens: 0 }) };
}

/**
 * The window an Ollama provider record serves models with no `num_ctx` at, and the most assumed when it sets none
 * (`HARNESS_OLLAMA_DEFAULT_CTX`): the provider (`@aeye/ollama`'s `contextWindow` and `maxContextWindow`) and the probe
 * read the same two, so they agree.
 */
export interface OllamaWindow {
  readonly contextWindow?: number | undefined;
  readonly cap: number;
}

/** Probes Ollama models: the served window (`servedWindow`; Ollama's default held to `cap`), and whether the model thinks. */
export class OllamaProbe implements ModelProbe {
  readonly #api: OllamaApi;
  readonly #config: OllamaWindow;

  constructor(api: OllamaApi, config: OllamaWindow) {
    this.#api = api;
    this.#config = config;
  }

  async probe(model: string): Promise<ModelLimits | undefined> {
    const unsetOf = async (): Promise<number> => unsetWindow(await this.#api.version(), this.#config.contextWindow, this.#config.cap);
    const [show, unset] = await Promise.all([this.#api.show(model), unsetOf()]);
    const family = show.details?.family;
    const chars = family === undefined ? undefined : FAMILY_CHARS[family];
    return { ...limitsOf(model, show, unset), ...(chars === undefined ? {} : { charsPerToken: chars }) };
  }
}

/** The probe factory for the providers the hub can probe. */
export function defaultProbes(cap: number, fetcher: typeof fetch = fetch): ProbeFactory {
  return (config) => (config.provider === 'ollama' ? new OllamaProbe(new OllamaApi(config.baseURL, fetcher), { contextWindow: config.contextWindow, cap }) : undefined);
}

/** What the limits service reads. */
export interface ModelLimitsDeps {
  readonly store: HubStore;
  readonly settings: Pick<ContextorEnv, 'HARNESS_DEFAULT_CONTEXT_WINDOW' | 'HARNESS_DEFAULT_MAX_OUTPUT' | 'HARNESS_MODEL_PROBE_TTL'>;
  /** The chat models the hub AI can call now. */
  readonly models: () => Promise<readonly ModelInfo[]>;
  /** aeye's registry of known models (`@aeye/models`). */
  readonly registry: readonly AeyeModelInfo[];
  readonly probes: ProbeFactory;
  readonly log: Logger;
  readonly clock: () => number;
}

/** Model limits from the admin's records, the providers, aeye and the defaults. */
export class HubModelLimits implements ModelLimitsService {
  readonly #deps: ModelLimitsDeps;
  readonly #probed = new Map<string, { readonly at: number; readonly limits: ModelLimits | undefined }>();
  readonly #guessed = new Set<string>();

  constructor(deps: ModelLimitsDeps) {
    this.#deps = deps;
  }

  async resolve(model: string): Promise<ModelLimitsView> {
    const { store, settings } = this.#deps;
    const admin = (await store.table('modelLimits').get(model))?.limits ?? {};
    const info = (await this.#deps.models()).find((m) => namesModel(model, m));
    const known = this.#deps.registry.find((m) => namesModel(model, m));
    const probe = info === undefined ? {} : (await this.#probe(info)) ?? {};
    const card: ModelLimits = {
      ...(info?.contextWindow !== undefined && info.contextWindow > 0 ? { contextWindow: info.contextWindow } : known !== undefined && known.contextWindow > 0 ? { contextWindow: known.contextWindow } : {}),
      ...(known?.maxOutputTokens === undefined ? {} : { maxOutputTokens: known.maxOutputTokens }),
      ...(known?.tokenizer === undefined || TOKENIZER_CHARS[known.tokenizer] === undefined ? {} : { charsPerToken: TOKENIZER_CHARS[known.tokenizer] }),
    };
    const sources: Partial<Record<ModelLimitField, LimitSource>> = {};
    const pick = (field: ModelLimitField, fallback: number): number => {
      for (const [source, limits] of [['admin', admin], ['probe', probe], ['model-info', card]] as const) {
        const value = limits[field];
        if (value !== undefined) { sources[field] = source; return value; }
      }
      sources[field] = 'default';
      return fallback;
    };
    const contextWindow = pick('contextWindow', settings.HARNESS_DEFAULT_CONTEXT_WINDOW);
    const output = pick('maxOutputTokens', settings.HARNESS_DEFAULT_MAX_OUTPUT);
    const maxOutputTokens = sources.maxOutputTokens === 'admin' ? output : Math.min(output, Math.floor(contextWindow / 4));
    const reasoning = (info?.capabilities.includes('reasoning') ?? false) || (known?.capabilities.has('reasoning') ?? false);
    const reasoningTokens = pick('reasoningTokens', reasoning ? Math.ceil(maxOutputTokens / 2) : 0);
    if (sources.reasoningTokens === 'default' && reasoning) sources.reasoningTokens = 'model-info';
    const charsPerToken = pick('charsPerToken', DEFAULT_CHARS_PER_TOKEN);
    if (sources.contextWindow === 'default' && !this.#guessed.has(model)) {
      this.#guessed.add(model);
      this.#deps.log.info('model.limits.guessed', { model, contextWindow, maxOutputTokens });
    }
    const limits: ResolvedModelLimits = { contextWindow, maxOutputTokens, reasoningTokens, charsPerToken };
    const ratio = (await store.table('modelCalibration').get(model))?.ratio ?? CALIBRATION.start;
    return { model, limits, sources: { contextWindow: sources.contextWindow ?? 'default', maxOutputTokens: sources.maxOutputTokens ?? 'default', reasoningTokens: sources.reasoningTokens ?? 'default', charsPerToken: sources.charsPerToken ?? 'default' }, ratio };
  }

  async list(): Promise<ModelLimitsView[]> {
    const models = (await this.#deps.models()).filter((m) => m.capabilities.includes('chat')).map((m) => m.id);
    return Promise.all([...new Set(models)].map((model) => this.resolve(model)));
  }

  async set(model: string, limits: ModelLimits, by: ActorId): Promise<ModelLimitsView> {
    const table = this.#deps.store.table('modelLimits');
    const given = Object.fromEntries(MODEL_LIMIT_FIELDS.flatMap((field) => (limits[field] === undefined ? [] : [[field, limits[field]]])));
    if (Object.keys(given).length === 0) await table.remove(model);
    else await table.put({ model, limits, setBy: by, updatedAt: this.#deps.clock() });
    this.#guessed.delete(model);
    return this.resolve(model);
  }

  /** The probe of a model's provider, cached; a probe that fails counts as nothing known (and is logged). */
  async #probe(info: ModelInfo): Promise<ModelLimits | undefined> {
    const { clock, settings, store, probes, log } = this.#deps;
    const key = `${info.provider}/${info.id}`;
    const cached = this.#probed.get(key);
    if (cached !== undefined && clock() - cached.at < settings.HARNESS_MODEL_PROBE_TTL) return cached.limits;
    const config = (await allRows(store.table('providers'))).find((record) => record.config.provider === info.provider)?.config;
    const probe = config === undefined ? undefined : probes(config);
    let limits: ModelLimits | undefined;
    try {
      limits = await probe?.probe(info.id);
    } catch (error) {
      log.warn('model.limits.probe-failed', { model: info.id, provider: info.provider, error: messageOf(error) });
    }
    this.#probed.set(key, { at: clock(), limits });
    return limits;
  }
}

/** The limits a `modelLimits` read answers: one model's when it names one, else every chat model's. */
export async function limitsFor(limits: Pick<ModelLimitsService, 'list' | 'resolve'>, model: string | undefined): Promise<ModelLimitsView[]> {
  return model === undefined ? limits.list() : [await limits.resolve(model)];
}
