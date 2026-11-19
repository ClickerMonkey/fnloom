/**
 * Embedders come from the model providers systems bring: every declared model with the `embedding` capability (text) or
 * `imageEmbedding` (images), and its `dimensions`, of a provider a connected system offers now (`OfferedProviders`:
 * live, not switched off) is an `Embedder`, named by its system and model id (`embedder/document`). It embeds through
 * the hub's AI (the LLM gateway), pinned to its model on its provider, a batch at a time, so pricing and the live model
 * listing are the hub AI's, in one place. The index uses the pair named in `modelEnv` (`document` for what is stored,
 * `query` for what is searched), once both are there and share their dimensions. Each embed is a `ModelCall` of the
 * hub's own work (modality `embed`, provider the system's provider, model its model id, purpose `index` for documents
 * or `search` for queries), like every other embed.
 *
 * Images go in the image space the admin's setting gives (`hubOptions['imageEmbedding']`, read through `imageSetting`
 * and turned into a space by core's `resolveImageSpace`): the text space when the document embedder shares it, else a
 * second space with its own embedder, or none (a text-only setup is as before). An image crosses the link as an
 * http(s) or data URL (`EmbedImage`).
 */
import type { EmbeddingInput } from '@aeye/ai';
import type { Logger } from '@ayepi/log';
import {
  EMBEDDING_CAPABILITIES, IMAGE_EMBEDDING_DEFAULT, isEmbedImage, qualify, resolveImageSpace, type EmbedderAbilities, type EmbedInput, type ImageEmbedderOption,
  type ImageEmbedding, type ImageSpaceCandidate, type ImageSpaceState, type ProviderModelDecl, type QualifiedName, type SystemName,
} from '@harness/core';
import type { EventBus } from '../bus.ts';
import { messageOf } from '../catalog/scope.ts';
import type { LlmGateway } from '../execution/index.ts';
import type { OfferedProvider, OfferedProviders } from '../models/remote.ts';
import type { EmbedLane } from './batch.ts';
import type { Embedder, Embedders, ImageSpace } from './index.ts';

/** The hub's AI as the embedders use it: its LLM gateway's embed. */
export type HubEmbeds = Pick<LlmGateway, 'embed'>;

/** The embedder name of a system's embedding model: its system and model id. */
export function embedderName(system: SystemName, model: string): QualifiedName {
  return qualify(system, model);
}

/** A declared model the index can embed with: an embedding model that says its dimensions. */
type EmbeddingModel = ProviderModelDecl & { readonly dimensions: number };

/** The embedding models (of text or images) of a provider. */
function embeddingModels(provider: OfferedProvider): EmbeddingModel[] {
  return provider.provider.models.filter((model): model is EmbeddingModel => EMBEDDING_CAPABILITIES.some((c) => model.capabilities.includes(c)) && model.dimensions !== undefined);
}

/** What a declared embedding model embeds, from its capabilities. */
export function abilitiesOf(model: Pick<ProviderModelDecl, 'capabilities'>): EmbedderAbilities {
  const has = (capability: string): boolean => model.capabilities.includes(capability);
  return { text: has('embedding'), images: has('imageEmbedding'), crossModal: has('crossModalEmbedding') };
}

/** What an embedder embeds: its own say, else text only. */
export function abilities(embedder: Pick<Embedder, 'abilities'>): EmbedderAbilities {
  return embedder.abilities ?? { text: true, images: false, crossModal: false };
}

/** An embedder as the image space rule reads it. */
function candidate(embedder: Embedder | undefined): ImageSpaceCandidate | undefined {
  return embedder === undefined ? undefined : { name: embedder.name, ...abilities(embedder) };
}

/** An embedding model of a system's provider, called through the hub's AI (priced, recorded and listed there). */
export class ProviderEmbedder implements Embedder {
  readonly name: QualifiedName;
  /** The model's name for people (its declared name, else its id). */
  readonly title: string;
  readonly dimensions: number;
  readonly maxInput: number;
  readonly abilities: EmbedderAbilities;
  readonly #provider: OfferedProvider;
  readonly #model: EmbeddingModel;
  readonly #batch: number;
  readonly #ai: () => HubEmbeds | undefined;
  readonly #purpose: string;

  constructor(options: {
    provider: OfferedProvider; model: EmbeddingModel; batch: number;
    /** The hub's AI, looked up when used: every call goes through it, so it is priced and recorded as a `ModelCall`. */
    ai: () => HubEmbeds | undefined;
    /** What the index embeds with it: `index` (documents) or `search` (queries). */
    purpose: string;
  }) {
    this.name = embedderName(options.provider.system, options.model.id);
    this.title = options.model.name ?? options.model.id;
    this.dimensions = options.model.dimensions;
    this.maxInput = options.model.maxInput ?? Number.MAX_SAFE_INTEGER;
    this.abilities = abilitiesOf(options.model);
    this.#provider = options.provider;
    this.#model = options.model;
    this.#batch = options.batch;
    this.#ai = options.ai;
    this.#purpose = options.purpose;
  }

  /** Whether this embedder stands for the same model, served the same way, as another declaration would. */
  same(provider: OfferedProvider, model: EmbeddingModel): boolean {
    return this.#provider.key === provider.key && this.#model.id === model.id && this.dimensions === model.dimensions
      && this.#model.name === model.name && this.#model.maxInput === model.maxInput && this.#model.pricing.input === model.pricing.input
      && this.#model.capabilities.join() === model.capabilities.join();
  }

  /**
   * Embed texts (cut to `maxInput`) and images (http(s) or data URLs), a batch per call through the hub's AI, pinned to
   * this model on its provider: each call is a `ModelCall` of the hub's own work (purpose `index` or `search`), at the
   * lane's priority (a search waits as interactive, indexing as background).
   */
  async embed(inputs: readonly EmbedInput[], lane: EmbedLane = 'background'): Promise<number[][]> {
    const ai = this.#ai();
    if (ai === undefined) { throw new Error(`${this.name}: the hub's AI is not ready`); }
    const metadata = { model: this.#model.id, provider: this.#provider.key };
    const out: number[][] = [];
    for (let at = 0; at < inputs.length; at += this.#batch) {
      const chunk = inputs.slice(at, at + this.#batch).map((input): EmbeddingInput => {
        if (!isEmbedImage(input)) { return input.slice(0, this.maxInput); }
        return input.mimeType === undefined ? { image: input.image } : { image: input.image, mimeType: input.mimeType };
      });
      const { value: vectors } = await ai.embed({ inputs: chunk, metadata }, { purpose: this.#purpose }, new AbortController().signal, lane);
      if (vectors.length !== chunk.length) { throw new Error(`${this.name} returned ${vectors.length} vectors for ${chunk.length} inputs`); }
      for (const vector of vectors) {
        if (vector.length !== this.dimensions) { throw new Error(`${this.name} returned a vector of ${vector.length} numbers, not ${this.dimensions}`); }
        out.push(vector);
      }
    }
    return out;
  }
}

/** What the embedders follow. */
export interface SystemEmbeddersOptions {
  /** The providers connected systems offer now. */
  readonly offered: Pick<OfferedProviders, 'list' | 'watch'>;
  readonly bus: Pick<EventBus, 'publish'>;
  readonly log: Logger;
  /** The embedder that embeds what is stored (`modelEnv.HARNESS_EMBEDDER_DOCUMENT`). */
  readonly document: QualifiedName;
  /** The embedder that embeds what is searched for (`modelEnv.HARNESS_EMBEDDER_QUERY`). */
  readonly query: QualifiedName;
  /** Inputs per embed call (`modelEnv.HARNESS_EMBED_BATCH`). */
  readonly batch: number;
  /** The hub's AI, looked up when an embed is made (the execution module's LLM gateway; undefined until it is built). */
  readonly ai: () => HubEmbeds | undefined;
  /** Whether connections came or went (the link's `onChange`), so the embedders are worked out again. */
  readonly connections: { onChange(listener: () => void): () => void };
  /** The admin's image embedding setting, read at each refresh (absent: the default, same as text). */
  readonly imageSetting?: () => Promise<ImageEmbedding>;
}

/** The embedding models of offered providers, kept current as systems come and go, and the image space in use. */
export class SystemEmbedders implements Embedders {
  readonly #options: SystemEmbeddersOptions;
  readonly #embedders = new Map<QualifiedName, ProviderEmbedder>();
  readonly #listeners = new Set<() => void>();
  #refreshing: Promise<void> = Promise.resolve();
  /** The image space the setting gives now, or why there is none. */
  #imageState: ImageSpaceState = { space: 'none', reason: 'The embedders are not worked out yet.' };

  constructor(options: SystemEmbeddersOptions) {
    this.#options = options;
    options.connections.onChange(() => { void this.refresh(); });
    // going live (build 7) changes what is offered without changing a fn: an embedder system has none
    options.offered.watch(() => { void this.refresh(); });
  }

  get(name: QualifiedName): Embedder | undefined {
    return this.#embedders.get(name);
  }

  active(): { document: Embedder; query: Embedder } | undefined {
    const document = this.#embedders.get(this.#options.document);
    const query = this.#embedders.get(this.#options.query);
    return document === undefined || query === undefined || document.dimensions !== query.dimensions ? undefined : { document, query };
  }

  images(): ImageSpace | undefined {
    const state = this.#imageState;
    if (state.space === 'none') { return undefined; }
    const embedder = this.#embedders.get(state.embedder);
    if (embedder === undefined) { return undefined; }
    return state.space === 'shared' ? { embedder, shared: true, crossModal: true } : { embedder, shared: false, crossModal: state.crossModal };
  }

  /** The image space in use, or why there is none (the admin page). */
  imageState(): ImageSpaceState {
    return this.#imageState;
  }

  /** The embedders connected now that embed images (the admin's choices). */
  imageOptions(): ImageEmbedderOption[] {
    return [...this.#embedders.values()].filter((embedder) => embedder.abilities.images)
      .map((embedder) => ({ embedder: embedder.name, name: embedder.title, dimensions: embedder.dimensions, ...embedder.abilities }));
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  /** Recompute which embedders are usable and the image space; listeners hear about any change. Resolves once done. */
  refresh(): Promise<void> {
    this.#refreshing = this.#refreshing.then(() => this.#refresh()).catch((error: unknown) => {
      this.#options.log.error('index.embedders.refresh.failed', { error: messageOf(error) });
    });
    return this.#refreshing;
  }

  async #refresh(): Promise<void> {
    const { offered, batch, log, document, query, ai } = this.#options;
    const usable = new Map<QualifiedName, ProviderEmbedder>();
    for (const provider of await offered.list()) {
      for (const model of embeddingModels(provider)) {
        const name = embedderName(provider.system, model.id);
        if (usable.has(name)) {
          // two of a system's providers declare the same embedding model id: the first keeps the name
          log.warn('index.embedders.duplicate', { embedder: name, provider: provider.key });
          continue;
        }
        const known = this.#embedders.get(name);
        const purpose = name === document ? 'index' : name === query ? 'search' : 'embed';
        usable.set(name, known?.same(provider, model) === true ? known : new ProviderEmbedder({ provider, model, batch, ai, purpose }));
      }
    }
    const setting = await this.#options.imageSetting?.() ?? IMAGE_EMBEDDING_DEFAULT;
    const imageState = resolveImageSpace(setting, candidate(usable.get(document)), setting.use === 'model' ? candidate(usable.get(setting.embedder)) : undefined);
    const changed = usable.size !== this.#embedders.size || [...usable].some(([name, embedder]) => this.#embedders.get(name) !== embedder)
      || JSON.stringify(imageState) !== JSON.stringify(this.#imageState);
    if (!changed) { return; }
    const wasActive = this.active() !== undefined;
    const hadImages = this.images() !== undefined;
    this.#embedders.clear();
    for (const [name, embedder] of usable) { this.#embedders.set(name, embedder); }
    this.#imageState = imageState;
    const active = this.active() !== undefined;
    const images = this.images() !== undefined;
    log.info('index.embedders', { embedders: [...usable.keys()], active, images: imageState.space === 'none' ? 'none' : `${imageState.space} ${imageState.embedder}` });
    for (const listener of [...this.#listeners]) { listener(); }
    // whether text (and pictures) are searched by meaning is a capability people see (search boxes say it), so they hear of it
    if (active !== wasActive || images !== hadImages) { this.#options.bus.publish('capabilities.changed', {}); }
  }
}
