/**
 * Embedders come from systems: every `embedders` entry of a manifest becomes an `Embedder` while its system is
 * usable (connected and configured), and calls it over the link (`embed`), a batch at a time. The index uses the
 * pair named in `modelEnv` (`document` for what is stored, `query` for what is searched), once both are there and
 * share their dimensions. Each `embed` call is a `ModelCall` of the hub's own work (modality `embed`, provider the
 * embedder system, model its embedder, purpose `index` for documents or `search` for queries), like every model call.
 */
import type { Logger } from '@ayepi/log';
import { splitName, type EmbedderDecl, type QualifiedName } from '@harness/core';
import type { EventBus } from '../bus.ts';
import type { Catalog } from '../catalog/index.ts';
import { messageOf } from '../catalog/scope.ts';
import type { LinkService } from '../link/index.ts';
import type { ModelCallLog } from '../metrics/index.ts';
import type { Embedder, Embedders } from './index.ts';

/** Bytes a vector number takes on the wire, as JSON text, roughly (for a call's received size). */
const VECTOR_NUMBER_BYTES = 10;

/** An embedder a connected system serves. */
export class LinkEmbedder implements Embedder {
  readonly name: QualifiedName;
  readonly dimensions: number;
  readonly maxInput: number;
  readonly #links: LinkService;
  readonly #batch: number;
  readonly #calls: () => Pick<ModelCallLog, 'begin'> | undefined;
  readonly #purpose: string;
  readonly #clock: () => number;

  constructor(options: {
    name: QualifiedName; decl: EmbedderDecl; links: LinkService; batch: number;
    /** Where each call is recorded (none in tests that don't care). */
    calls: () => Pick<ModelCallLog, 'begin'> | undefined;
    /** What the index embeds with it: `index` (documents) or `search` (queries). */
    purpose: string;
    clock: () => number;
  }) {
    this.name = options.name;
    this.dimensions = options.decl.dimensions;
    this.maxInput = options.decl.maxInput;
    this.#links = options.links;
    this.#batch = options.batch;
    this.#calls = options.calls;
    this.#purpose = options.purpose;
    this.#clock = options.clock;
  }

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    const { system, local } = splitName(this.name);
    const connection = this.#links.connected().find((c) => c.system === system);
    if (connection === undefined) { throw new Error(`${this.name}: ${system} is not connected`); }
    const call = await this.#calls()?.begin({ modality: 'embed', provider: system, model: local, purpose: this.#purpose }, this.#clock());
    const out: number[][] = [];
    let characters = 0;
    try {
      for (let at = 0; at < texts.length; at += this.#batch) {
        const chunk = texts.slice(at, at + this.#batch).map((text) => text.slice(0, this.maxInput));
        characters += chunk.reduce((sum, text) => sum + text.length, 0);
        const { vectors } = await connection.peer.call('embed', { embedder: local, texts: chunk }, signal === undefined ? {} : { signal });
        call?.firstByte();
        if (vectors.length !== chunk.length) { throw new Error(`${this.name} returned ${vectors.length} vectors for ${chunk.length} texts`); }
        for (const vector of vectors) {
          if (vector.length !== this.dimensions) { throw new Error(`${this.name} returned a vector of ${vector.length} numbers, not ${this.dimensions}`); }
          out.push(vector);
        }
      }
    } catch (error) {
      await call?.failed(messageOf(error), signal?.aborted === true);
      throw error;
    }
    await call?.done({
      units: { modality: 'embed', texts: texts.length, characters, dimensions: this.dimensions }, cost: 0, sent: characters, received: out.length * this.dimensions * VECTOR_NUMBER_BYTES,
    });
    return out;
  }
}

/** What the embedders follow. */
export interface SystemEmbeddersOptions {
  readonly catalog: Catalog;
  readonly links: LinkService;
  readonly bus: EventBus;
  readonly log: Logger;
  readonly clock: () => number;
  /** The embedder that embeds what is stored (`modelEnv.HARNESS_EMBEDDER_DOCUMENT`). */
  readonly document: QualifiedName;
  /** The embedder that embeds what is searched for (`modelEnv.HARNESS_EMBEDDER_QUERY`). */
  readonly query: QualifiedName;
  /** Texts per `embed` call (`modelEnv.HARNESS_EMBED_BATCH`). */
  readonly batch: number;
  /** Where each embed call is recorded, looked up when it is made (absent: not recorded). */
  readonly calls?: () => Pick<ModelCallLog, 'begin'>;
}

/** The embedders of usable systems, kept current as systems come and go. */
export class SystemEmbedders implements Embedders {
  readonly #options: SystemEmbeddersOptions;
  readonly #embedders = new Map<QualifiedName, LinkEmbedder>();
  readonly #listeners = new Set<() => void>();
  #refreshing: Promise<void> = Promise.resolve();

  constructor(options: SystemEmbeddersOptions) {
    this.#options = options;
    options.links.onChange(() => { void this.refresh(); });
    options.bus.subscribe('system.status', () => { void this.refresh(); });
    options.bus.subscribe('catalog.changed', () => { void this.refresh(); });
    // going live (build 7) changes what is offered without changing a fn: an embedder system has none
    options.bus.subscribe('capabilities.changed', () => { void this.refresh(); });
  }

  get(name: QualifiedName): Embedder | undefined {
    return this.#embedders.get(name);
  }

  active(): { document: Embedder; query: Embedder } | undefined {
    const document = this.#embedders.get(this.#options.document);
    const query = this.#embedders.get(this.#options.query);
    return document === undefined || query === undefined || document.dimensions !== query.dimensions ? undefined : { document, query };
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  /** Recompute which embedders are usable; listeners hear about any change. Resolves once done. */
  refresh(): Promise<void> {
    this.#refreshing = this.#refreshing.then(() => this.#refresh()).catch((error: unknown) => {
      this.#options.log.error('index.embedders.refresh.failed', { error: messageOf(error) });
    });
    return this.#refreshing;
  }

  async #refresh(): Promise<void> {
    const { catalog, links, batch, log, clock, document, query } = this.#options;
    const calls = (): Pick<ModelCallLog, 'begin'> | undefined => this.#options.calls?.();
    const usable = new Map<QualifiedName, LinkEmbedder>();
    for (const entry of await catalog.entries('embedders')) {
      if ((await catalog.availability(entry.name)) !== true) { continue; }
      const known = this.#embedders.get(entry.name);
      const same = known !== undefined && known.dimensions === entry.decl.dimensions && known.maxInput === entry.decl.maxInput;
      const purpose = entry.name === document ? 'index' : entry.name === query ? 'search' : 'embed';
      usable.set(entry.name, same ? known : new LinkEmbedder({ name: entry.name, decl: entry.decl, links, batch, calls, purpose, clock }));
    }
    const changed = usable.size !== this.#embedders.size || [...usable].some(([name, embedder]) => this.#embedders.get(name) !== embedder);
    if (!changed) { return; }
    const wasActive = this.active() !== undefined;
    this.#embedders.clear();
    for (const [name, embedder] of usable) { this.#embedders.set(name, embedder); }
    const active = this.active() !== undefined;
    log.info('index.embedders', { embedders: [...usable.keys()], active });
    for (const listener of [...this.#listeners]) { listener(); }
    // whether text is searched by meaning too is a capability people see (search boxes say it), so they hear of it
    if (active !== wasActive) { this.#options.bus.publish('capabilities.changed', {}); }
  }
}
