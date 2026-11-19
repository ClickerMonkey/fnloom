/**
 * Model providers systems bring (manifest `providers`). Each declared provider of a connected system becomes a
 * `RemoteProvider`, an aeye `Provider` registered on the hub AI as `<system>/<provider>`. Its models are the declared
 * ones (the set an admin reviewed, priced from their `pricing`, abilities from their `capabilities`), narrowed to those
 * the provider serves now, with the limits it serves them with (`providerModels`, its aeye `listModels`). A chat,
 * embedding or decision call to one goes over the system's link (`providerChat`, streamed, `providerEmbed` and
 * `providerDecide`). The hub AI's hooks record and price those calls like any other.
 *
 * `OfferedProviders` lists the providers of connected systems that are offered now (live, not switched off);
 * `SystemProviderSource` makes them aeye providers and says when that set changes, so the hub AI is rebuilt with them as
 * systems come and go. The index's embedders (`index/embedders.ts`) follow the same list.
 */
import type {
  DecisionAnswer, DecisionQuestion, DecisionRequest, DecisionResponse, EmbeddingInput, EmbeddingRequest, EmbeddingResponse, ModelCapability, ModelInfo, Provider, Providers,
} from '@aeye/ai';
import { embeddingImageURL, embeddingInputs, isEmbeddingImage } from '@aeye/ai';
import { getResponseFromChunks, type Chunk, type Request, type Response } from '@aeye/core';
import {
  qualify, type Compact, type DecisionAnswer as WireDecisionAnswer, type EmbedInput as WireEmbedInput, type DecisionQuestion as WireDecisionQuestion, type LiveProviderModel, type ProviderChat, type ProviderModelDecl,
  type Same, type SystemName, type SystemProviderDecl,
} from '@harness/core';
import type { Logger } from '@ayepi/log';
import type { EventBus } from '../bus.ts';
import type { Catalog } from '../catalog/index.ts';
import { chunkFromWire, decisionInputToWire, usageFromWire, wireRequest } from '@harness/sdk/server';
import type { ProviderSource } from '../execution/providers.ts';
import type { LinkService, SystemConnection } from '../link/index.ts';
import type { SystemLifecycle } from '../link/lifecycle.ts';

// core's decision wire shapes are aeye's: a change on either side fails to compile here
true satisfies Same<WireDecisionQuestion, DecisionQuestion>;
true satisfies Same<WireDecisionAnswer, DecisionAnswer>;
// an embed input as it crosses the link is one aeye takes as it is (an image as an http(s) or data URL), once compacted
true satisfies (Compact<Exclude<WireEmbedInput, string>> extends Exclude<EmbeddingInput, string> ? true : false);

/** Every aeye model capability; a declared capability aeye doesn't know is left out. */
const CAPABILITIES = {
  chat: true, tools: true, vision: true, files: true, videoInput: true, json: true, structured: true, streaming: true, reasoning: true, image: true,
  audio: true, hearing: true, embedding: true, imageEmbedding: true, crossModalEmbedding: true, rerank: true, decision: true, zdr: true, toolsStrict: true,
} as const satisfies Record<ModelCapability, true>;

function isCapability(name: string): name is ModelCapability {
  return Object.hasOwn(CAPABILITIES, name);
}

/** An aeye embed input as it crosses the link: text as it is, an image as an http(s) or data URL (its bytes read here). */
export async function wireEmbedInput(input: EmbeddingInput): Promise<WireEmbedInput> {
  if (!isEmbeddingImage(input)) return input;
  return { image: await embeddingImageURL(input), ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }) };
}

/** The aeye provider key of a system's provider: `<system>/<provider>`. */
export function remoteProviderKey(system: SystemName, provider: string): string {
  return qualify(system, provider);
}

/**
 * A declared model as aeye model info, with the limits the provider serves it with now when it said (`live`). A model
 * that reads a prompt cache gets a cached-input price (its declared one, else its input price), which is how the hub
 * tells caching models apart (`cacheSupportOf`). Prices and abilities are always the declared (reviewed) ones.
 */
export function remoteModelInfo(key: string, model: ProviderModelDecl, live?: LiveProviderModel): ModelInfo {
  const { pricing } = model;
  const maxOutput = live?.maxOutput ?? model.maxOutput;
  const maxQuestions = live?.maxQuestions ?? model.maxQuestions;
  return {
    id: model.id,
    provider: key,
    name: model.name ?? model.id,
    capabilities: new Set(model.capabilities.filter(isCapability)),
    tier: 'efficient',
    contextWindow: live?.contextWindow ?? model.contextWindow,
    ...(maxOutput === undefined ? {} : { maxOutputTokens: maxOutput }),
    ...(maxQuestions === undefined ? {} : { maxQuestions }),
    pricing: {
      text: {
        input: pricing.input,
        output: pricing.output,
        ...(model.caching ? { cached: pricing.cached ?? pricing.input } : {}),
        ...(pricing.cacheWrite === undefined ? {} : { cacheWrite: pricing.cacheWrite }),
      },
    },
  };
}

/** The model id aeye hands a provider in a call's metadata (a model id, or the selected model's info). */
export function modelIdOf(metadata: unknown): string | undefined {
  if (typeof metadata !== 'object' || metadata === null || !('model' in metadata)) return undefined;
  const model: unknown = metadata.model;
  if (typeof model === 'string') return model;
  if (typeof model === 'object' && model !== null && 'id' in model && typeof model.id === 'string') return model.id;
  return undefined;
}

/** The model a non-chat call is for: the one aeye selected, else the request's own. */
function callModel(metadata: unknown, requested: string | { readonly id: string } | undefined): string | undefined {
  return modelIdOf(metadata) ?? (typeof requested === 'string' ? requested : requested?.id);
}

/** A provider call the system refused or failed. */
export class RemoteProviderError extends Error {
  override readonly name = 'RemoteProviderError';
  readonly kind: string;

  constructor(message: string, kind: string) {
    super(message);
    this.kind = kind;
  }
}

/** The link a remote provider calls: the system's connection while it is connected. */
export type RemoteLink = () => SystemConnection | undefined;

/**
 * How long the hub waits for a provider's live model list (`providerModels`). The hub AI is rebuilt only once
 * every provider has listed, so a system that never answers must not hold it: past this, the declared models are offered.
 */
export const LIST_MODELS_TIMEOUT = 5_000;

/** A system's provider as an aeye provider on the hub AI. */
export class RemoteProvider implements Provider<SystemProviderDecl> {
  readonly name: string;
  readonly config: SystemProviderDecl;
  readonly #system: SystemName;
  readonly #link: RemoteLink;

  readonly #listTimeout: number;

  constructor(system: SystemName, decl: SystemProviderDecl, link: RemoteLink, listTimeout: number = LIST_MODELS_TIMEOUT) {
    this.#system = system;
    this.#listTimeout = listTimeout;
    this.name = remoteProviderKey(system, decl.name);
    this.config = decl;
    this.#link = link;
  }

  /**
   * The declared models the provider serves now (`providerModels`), with the limits it serves them with: never a model
   * outside the declared set. Every declared model when the provider can't list, or the system can't be asked.
   */
  async listModels(): Promise<ModelInfo[]> {
    const declared = (live?: ReadonlyMap<string, LiveProviderModel>): ModelInfo[] => this.config.models
      .filter((model) => live === undefined || live.has(model.id))
      .map((model) => remoteModelInfo(this.name, model, live?.get(model.id)));
    const connection = this.#link();
    if (connection === undefined) return declared();
    try {
      const served = await connection.peer.call('providerModels', { provider: this.config.name }, this.#options(connection, AbortSignal.timeout(this.#listTimeout)));
      return served.listed ? declared(new Map(served.models.map((model) => [model.id, model]))) : declared();
    } catch {
      // a system that can't answer (an older SDK, a provider whose listing failed or took too long) offers what it declared
      return declared();
    }
  }

  checkHealth(): Promise<boolean> {
    return Promise.resolve(this.#link() !== undefined);
  }

  createStreamer() {
    return <C, M>(request: Request, _context: C, metadata?: M, signal?: AbortSignal): AsyncGenerator<Chunk, Response> => this.#chat(request, metadata, signal);
  }

  createExecutor() {
    return async <C, M>(request: Request, _context: C, metadata?: M, signal?: AbortSignal): Promise<Response> => {
      const stream = this.#chat(request, metadata, signal);
      for (;;) {
        const next = await stream.next();
        if (next.done === true) return next.value;
      }
    };
  }

  async embed(request: EmbeddingRequest, ctx?: { metadata?: unknown; signal?: AbortSignal | undefined }): Promise<EmbeddingResponse> {
    const id = callModel(ctx?.metadata, request.model);
    if (id === undefined) throw new RemoteProviderError(`${this.name} needs a model to embed with`, 'model');
    const connection = this.#connection();
    const inputs = await Promise.all(embeddingInputs(request).map(wireEmbedInput));
    const result = await connection.peer.call('providerEmbed', { provider: this.config.name, model: id, inputs }, this.#options(connection, ctx?.signal));
    return {
      embeddings: result.vectors.map((embedding, index) => ({ embedding, index })),
      model: id,
      ...(result.tokens === undefined ? {} : { usage: { text: { input: result.tokens } } }),
    };
  }

  /** Typed answers from one of the provider's decision models, through the system. Images don't cross the link yet. */
  async decide(request: DecisionRequest, ctx?: { metadata?: unknown; signal?: AbortSignal | undefined }): Promise<DecisionResponse> {
    const id = callModel(ctx?.metadata, request.model);
    if (id === undefined) throw new RemoteProviderError(`${this.name} needs a model to decide with`, 'model');
    if (request.images !== undefined && request.images.length > 0) throw new RemoteProviderError(`${this.name}: decision images don't cross the system link yet`, 'model');
    const connection = this.#connection();
    const result = await connection.peer.call('providerDecide', {
      provider: this.config.name, model: id, input: decisionInputToWire(request.input), questions: request.questions,
    }, this.#options(connection, ctx?.signal));
    return { answers: result.answers, model: id, ...(result.tokens === undefined ? {} : { usage: { text: { input: result.tokens } } }) };
  }

  /** Stream one chat call through the system. */
  async *#chat(request: Request, metadata: unknown, signal: AbortSignal | undefined): AsyncGenerator<Chunk, Response> {
    const model = modelIdOf(metadata);
    if (model === undefined) throw new RemoteProviderError(`${this.name} needs a model to chat with`, 'model');
    const connection = this.#connection();
    const body: ProviderChat = { provider: this.config.name, model, request: wireRequest(request), stream: true };
    const chunks: Chunk[] = [];
    for await (const item of connection.peer.call('providerChat', body, this.#options(connection, signal))) {
      switch (item.type) {
        case 'chunk': {
          const chunk = chunkFromWire(item.chunk);
          chunks.push(chunk);
          yield chunk;
          break;
        }
        case 'done': {
          const last: Chunk = { usage: usageFromWire(item.usage) };
          chunks.push(last);
          yield last;
          break;
        }
        case 'error': throw new RemoteProviderError(`${this.name}: ${item.message}`, item.kind);
      }
    }
    return getResponseFromChunks(chunks, model);
  }

  #connection(): SystemConnection {
    const connection = this.#link();
    if (connection === undefined) throw new RemoteProviderError(`${this.#system} is not connected`, 'provider');
    return connection;
  }

  #options(connection: SystemConnection, signal: AbortSignal | undefined): { signal: AbortSignal } {
    return { signal: signal === undefined ? connection.signal : AbortSignal.any([signal, connection.signal]) };
  }
}

/** What the offered providers read. */
export interface SystemProviderDeps {
  readonly link: Pick<LinkService, 'connection' | 'connected'>;
  readonly catalog: Pick<Catalog, 'manifest'>;
  readonly bus: Pick<EventBus, 'subscribe'>;
  readonly log: Logger;
  /**
   * Build 7: whether a system's provider is offered now: not while its system is installed and not yet live, nor when
   * an admin switched it off (`offeredBy`). Absent, every declared provider of a connected system is.
   */
  readonly offered?: (system: SystemName, provider: string) => Promise<boolean>;
}

/**
 * Whether a system's provider is offered now, by the system's lifecycle: once the system is live, and not while an admin
 * has it switched off. The one rule the hub AI's providers and the index's embedders both follow.
 */
export function offeredBy(lifecycle: Pick<SystemLifecycle, 'stage' | 'off'>): NonNullable<SystemProviderDeps['offered']> {
  return async (system, provider) => await lifecycle.stage(system) === 'live' && !(await lifecycle.off('providers', { system })).has(qualify(system, provider));
}

/** A provider a connected system offers now: its system, its declaration and its aeye key. */
export interface OfferedProvider {
  readonly system: SystemName;
  readonly provider: SystemProviderDecl;
  readonly key: string;
}

/** The providers connected systems offer now, and when that may have changed. */
export class OfferedProviders {
  readonly #deps: SystemProviderDeps;

  constructor(deps: SystemProviderDeps) {
    this.#deps = deps;
  }

  /** A system's connection, while it is connected. */
  link(system: SystemName): SystemConnection | undefined {
    return this.#deps.link.connection(system);
  }

  /** Every declared provider of a connected system that is offered now. */
  async list(): Promise<OfferedProvider[]> {
    const out: OfferedProvider[] = [];
    const systems = new Set(this.#deps.link.connected().map((c) => c.system));
    for (const system of systems) {
      const manifest = await this.#deps.catalog.manifest(system);
      for (const provider of manifest?.providers ?? []) {
        if (this.#deps.offered !== undefined && !await this.#deps.offered(system, provider.name)) continue;
        out.push({ system, provider, key: remoteProviderKey(system, provider.name) });
      }
    }
    return out;
  }

  /**
   * Call `changed` whenever what is offered may have changed: a system connected or left, changed what it declares,
   * went live, or had a provider switched.
   */
  watch(changed: () => void): () => void {
    const { bus } = this.#deps;
    const stops = [bus.subscribe('system.status', changed), bus.subscribe('catalog.changed', changed), bus.subscribe('capabilities.changed', changed)];
    return () => { for (const stop of stops) stop(); };
  }
}

/** The providers connected systems offer, as aeye providers on the hub AI. */
export class SystemProviderSource implements ProviderSource {
  readonly #offered: OfferedProviders;
  readonly #log: Logger;
  /** The keys the last load gave, to tell when the set changed. */
  #loaded = '';

  constructor(deps: SystemProviderDeps) {
    this.#offered = new OfferedProviders(deps);
    this.#log = deps.log;
  }

  async load(): Promise<Providers> {
    const providers: Record<string, Provider> = {};
    for (const decl of await this.#offered.list()) {
      providers[decl.key] = new RemoteProvider(decl.system, decl.provider, () => this.#offered.link(decl.system));
    }
    this.#loaded = Object.keys(providers).sort().join(',');
    if (this.#loaded !== '') this.#log.info('providers.remote', { providers: Object.keys(providers) });
    return providers;
  }

  /**
   * Call `changed` when the set of remote providers differs from the last load: a system that brings providers
   * connected or left, or changed what it declares.
   */
  watch(changed: () => void): () => void {
    return this.#offered.watch(() => {
      void this.#offered.list().then((offered) => {
        const keys = offered.map((d) => d.key).sort().join(',');
        if (keys !== this.#loaded) changed();
      }, (error: unknown) => { this.#log.warn('providers.remote.check-failed', { error: error instanceof Error ? error.message : String(error) }); });
    });
  }
}

/** Several provider sources as one: their providers joined (a later source's key wins), each one's changes heard. */
export class JoinedProviderSource implements ProviderSource {
  readonly #sources: readonly ProviderSource[];

  constructor(sources: readonly ProviderSource[]) {
    this.#sources = sources;
  }

  async load(): Promise<Providers> {
    const all: Record<string, Provider> = {};
    for (const source of this.#sources) Object.assign(all, await source.load());
    return all;
  }

  watch(changed: () => void): () => void {
    const stops = this.#sources.map((source) => source.watch?.(changed));
    return () => { for (const stop of stops) stop?.(); };
  }
}
