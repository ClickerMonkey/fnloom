/**
 * Model providers systems bring (manifest `providers`). Each declared provider of a connected system becomes a
 * `RemoteProvider`, an aeye `Provider` registered on the hub AI as `<system>/<provider>`: its models are the declared
 * ones (priced from their `pricing`, abilities from their `capabilities`), and a chat or embedding call to one goes
 * over the system's link (`providerChat`, streamed, and `providerEmbed`). The hub AI's hooks record and price those
 * calls like any other. `SystemProviderSource` lists them for the connected systems and says when that set changes,
 * so the hub AI is rebuilt with them as systems come and go.
 */
import type { EmbeddingRequest, EmbeddingResponse, ModelCapability, ModelInfo, Provider, Providers } from '@aeye/ai';
import { getResponseFromChunks, type Chunk, type Request, type Response } from '@aeye/core';
import { qualify, type ProviderChat, type ProviderModelDecl, type SystemName, type SystemProviderDecl } from '@harness/core';
import type { Logger } from '@ayepi/log';
import type { EventBus } from '../bus.ts';
import type { Catalog } from '../catalog/index.ts';
import { chunkFromWire, usageFromWire, wireRequest } from '@harness/sdk/server';
import type { ProviderSource } from '../execution/providers.ts';
import type { LinkService, SystemConnection } from '../link/index.ts';

/** Every aeye model capability; a declared capability aeye doesn't know is left out. */
const CAPABILITIES = {
  chat: true, tools: true, vision: true, files: true, videoInput: true, json: true, structured: true, streaming: true, reasoning: true, image: true,
  audio: true, hearing: true, embedding: true, rerank: true, decision: true, zdr: true, toolsStrict: true,
} as const satisfies Record<ModelCapability, true>;

function isCapability(name: string): name is ModelCapability {
  return Object.hasOwn(CAPABILITIES, name);
}

/** The aeye provider key of a system's provider: `<system>/<provider>`. */
export function remoteProviderKey(system: SystemName, provider: string): string {
  return qualify(system, provider);
}

/**
 * A declared model as aeye model info. A model that reads a prompt cache gets a cached-input price (its declared one,
 * else its input price), which is how the hub tells caching models apart (`cacheSupportOf`).
 */
export function remoteModelInfo(key: string, model: ProviderModelDecl): ModelInfo {
  const { pricing } = model;
  return {
    id: model.id,
    provider: key,
    name: model.name ?? model.id,
    capabilities: new Set(model.capabilities.filter(isCapability)),
    tier: 'efficient',
    contextWindow: model.contextWindow,
    ...(model.maxOutput === undefined ? {} : { maxOutputTokens: model.maxOutput }),
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

/** A system's provider as an aeye provider on the hub AI. */
export class RemoteProvider implements Provider<SystemProviderDecl> {
  readonly name: string;
  readonly config: SystemProviderDecl;
  readonly #system: SystemName;
  readonly #link: RemoteLink;

  constructor(system: SystemName, decl: SystemProviderDecl, link: RemoteLink) {
    this.#system = system;
    this.name = remoteProviderKey(system, decl.name);
    this.config = decl;
    this.#link = link;
  }

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve(this.config.models.map((model) => remoteModelInfo(this.name, model)));
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
    const model = modelIdOf(ctx?.metadata) ?? request.model;
    const id = typeof model === 'string' ? model : model?.id;
    if (id === undefined) throw new RemoteProviderError(`${this.name} needs a model to embed with`, 'model');
    const connection = this.#connection();
    const result = await connection.peer.call('providerEmbed', { provider: this.config.name, model: id, texts: request.texts }, this.#options(connection, ctx?.signal));
    return {
      embeddings: result.vectors.map((embedding, index) => ({ embedding, index })),
      model: id,
      ...(result.tokens === undefined ? {} : { usage: { text: { input: result.tokens } } }),
    };
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

/** What the system provider source reads. */
export interface SystemProviderDeps {
  readonly link: Pick<LinkService, 'connection' | 'connected'>;
  readonly catalog: Pick<Catalog, 'manifest'>;
  readonly bus: Pick<EventBus, 'subscribe'>;
  readonly log: Logger;
}

/** The providers of every connected system that declares some. */
export class SystemProviderSource implements ProviderSource {
  readonly #deps: SystemProviderDeps;
  /** The keys the last load gave, to tell when the set changed. */
  #loaded = '';

  constructor(deps: SystemProviderDeps) {
    this.#deps = deps;
  }

  async load(): Promise<Providers> {
    const providers: Record<string, Provider> = {};
    for (const decl of await this.#declared()) {
      providers[decl.key] = new RemoteProvider(decl.system, decl.provider, () => this.#deps.link.connection(decl.system));
    }
    this.#loaded = Object.keys(providers).sort().join(',');
    if (this.#loaded !== '') this.#deps.log.info('providers.remote', { providers: Object.keys(providers) });
    return providers;
  }

  /**
   * Call `changed` when the set of remote providers differs from the last load: a system that brings providers
   * connected or left, or changed what it declares.
   */
  watch(changed: () => void): () => void {
    const check = (): void => {
      void this.#declared().then((declared) => {
        const keys = declared.map((d) => d.key).sort().join(',');
        if (keys !== this.#loaded) changed();
      }, (error: unknown) => { this.#deps.log.warn('providers.remote.check-failed', { error: error instanceof Error ? error.message : String(error) }); });
    };
    const stops = [this.#deps.bus.subscribe('system.status', check), this.#deps.bus.subscribe('catalog.changed', check)];
    return () => { for (const stop of stops) stop(); };
  }

  async #declared(): Promise<Array<{ system: SystemName; provider: SystemProviderDecl; key: string }>> {
    const out: Array<{ system: SystemName; provider: SystemProviderDecl; key: string }> = [];
    const systems = new Set(this.#deps.link.connected().map((c) => c.system));
    for (const system of systems) {
      const manifest = await this.#deps.catalog.manifest(system);
      for (const provider of manifest?.providers ?? []) out.push({ system, provider, key: remoteProviderKey(system, provider.name) });
    }
    return out;
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
