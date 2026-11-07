/**
 * Embedders come from systems: every `embedders` entry of a manifest becomes an `Embedder` while its system is
 * usable (connected and configured), and calls it over the link (`embed`), a batch at a time. The index uses the
 * pair named in `modelEnv` (`document` for what is stored, `query` for what is searched), once both are there and
 * share their dimensions.
 */
import type { Logger } from '@ayepi/log';
import { splitName, type EmbedderDecl, type QualifiedName } from '@harness/core';
import type { EventBus } from '../bus.ts';
import type { Catalog } from '../catalog/index.ts';
import { messageOf } from '../catalog/scope.ts';
import type { LinkService } from '../link/index.ts';
import type { Embedder, Embedders } from './index.ts';

/** An embedder a connected system serves. */
export class LinkEmbedder implements Embedder {
  readonly name: QualifiedName;
  readonly dimensions: number;
  readonly maxInput: number;
  readonly #links: LinkService;
  readonly #batch: number;

  constructor(options: { name: QualifiedName; decl: EmbedderDecl; links: LinkService; batch: number }) {
    this.name = options.name;
    this.dimensions = options.decl.dimensions;
    this.maxInput = options.decl.maxInput;
    this.#links = options.links;
    this.#batch = options.batch;
  }

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    const { system, local } = splitName(this.name);
    const connection = this.#links.connected().find((c) => c.system === system);
    if (connection === undefined) { throw new Error(`${this.name}: ${system} is not connected`); }
    const out: number[][] = [];
    for (let at = 0; at < texts.length; at += this.#batch) {
      const chunk = texts.slice(at, at + this.#batch).map((text) => text.slice(0, this.maxInput));
      const { vectors } = await connection.peer.call('embed', { embedder: local, texts: chunk }, signal === undefined ? {} : { signal });
      if (vectors.length !== chunk.length) { throw new Error(`${this.name} returned ${vectors.length} vectors for ${chunk.length} texts`); }
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
  readonly catalog: Catalog;
  readonly links: LinkService;
  readonly bus: EventBus;
  readonly log: Logger;
  /** The embedder that embeds what is stored (`modelEnv.HARNESS_EMBEDDER_DOCUMENT`). */
  readonly document: QualifiedName;
  /** The embedder that embeds what is searched for (`modelEnv.HARNESS_EMBEDDER_QUERY`). */
  readonly query: QualifiedName;
  /** Texts per `embed` call (`modelEnv.HARNESS_EMBED_BATCH`). */
  readonly batch: number;
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
    const { catalog, links, batch, log } = this.#options;
    const usable = new Map<QualifiedName, LinkEmbedder>();
    for (const entry of await catalog.entries('embedders')) {
      if ((await catalog.availability(entry.name)) !== true) { continue; }
      const known = this.#embedders.get(entry.name);
      const same = known !== undefined && known.dimensions === entry.decl.dimensions && known.maxInput === entry.decl.maxInput;
      usable.set(entry.name, same ? known : new LinkEmbedder({ name: entry.name, decl: entry.decl, links, batch }));
    }
    const changed = usable.size !== this.#embedders.size || [...usable].some(([name, embedder]) => this.#embedders.get(name) !== embedder);
    if (!changed) { return; }
    this.#embedders.clear();
    for (const [name, embedder] of usable) { this.#embedders.set(name, embedder); }
    log.info('index.embedders', { embedders: [...usable.keys()], active: this.active() !== undefined });
    for (const listener of [...this.#listeners]) { listener(); }
  }
}
