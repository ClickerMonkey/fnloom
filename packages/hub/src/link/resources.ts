/**
 * Resource routing. Systems that serve resources offer roots (folders at absolute URIs); a URI belongs to the
 * connected system whose root holds it, the longest root winning. Reads, lists and sections go to that system over
 * its link. Large text comes back as a content ref, fetched in chunks of the link's largest chunk.
 * Roots are asked for on connect, when its contract arrives and after it applies a config. Changes a system
 * reports are kept only for URIs under its own roots and announced on the bus as `resources.changed`.
 */
import { reject as refuse } from '@ayepi/core';
import type { Logger } from '@ayepi/log';
import {
  splitName, type ContentRef, type Page, type QualifiedName, type ReadWant, type ResourceChange, type ResourceLink, type ResourceRead, type ResourceRoot, type ResourceStat,
  type ResourceUri, type Section, type SystemName,
} from '@harness/core';
import type { EventBus } from '../bus.ts';
import type { Catalog } from '../catalog/index.ts';
import { messageOf } from '../catalog/scope.ts';
import type { LinkService, ResourceRouter, SystemConnection } from './index.ts';

/** What the router needs. */
export interface ResourceRouterOptions {
  readonly links: LinkService;
  readonly catalog: Catalog;
  readonly bus: EventBus;
  readonly log: Logger;
  /** The largest chunk to ask for when fetching content. */
  readonly maxChunk: number;
}

/** Whether `uri` is `root` or under it. */
export function underRoot(uri: string, root: string): boolean {
  return uri === root || uri.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/** Routes resource calls to the systems that serve them. */
export class PeerResourceRouter implements ResourceRouter {
  readonly #options: ResourceRouterOptions;
  readonly #roots = new Map<SystemName, ResourceRoot[]>();
  /** The roots each connected system was asked to watch. */
  readonly #watched = new Map<SystemName, Set<string>>();
  /** Each system's latest refresh, so an older answer that arrives late doesn't replace a newer one. */
  readonly #asked = new Map<SystemName, number>();

  constructor(options: ResourceRouterOptions) {
    this.#options = options;
    options.links.onChange((change) => {
      if (change.connected) { void this.refresh(change.system); return; }
      this.#roots.delete(change.system);
      this.#watched.delete(change.system);
    });
    // a system that connected before it was configured serves its roots once its config arrives
    options.bus.subscribe('system.status', ({ system, status }) => { if (status === 'connected') { void this.refresh(system); } });
    // the roots follow the config, so they are asked for again once the system has applied a new one
    options.bus.subscribe('system.configured', ({ system }) => { void this.refresh(system); });
  }

  roots(): ReadonlyArray<{ system: SystemName; root: ResourceRoot }> {
    return [...this.#roots].flatMap(([system, roots]) => roots.map((root) => ({ system, root })));
  }

  route(uri: ResourceUri): { system: SystemName; root: ResourceRoot } | undefined {
    let best: { system: SystemName; root: ResourceRoot } | undefined;
    for (const entry of this.roots()) {
      if (underRoot(uri, entry.root.uri) && (best === undefined || entry.root.uri.length > best.root.uri.length)) { best = entry; }
    }
    return best;
  }

  async refresh(system: SystemName): Promise<void> {
    const { links, catalog, log } = this.#options;
    const connection = links.connection(system);
    const manifest = await catalog.manifest(system);
    // before its first manifest nothing is known; importing the manifest refreshes again when it serves resources
    if (connection === undefined || manifest?.resources !== true) { this.#roots.delete(system); return; }
    const asked = (this.#asked.get(system) ?? 0) + 1;
    this.#asked.set(system, asked);
    try {
      const roots = await connection.peer.call('roots');
      if (this.#asked.get(system) !== asked) { return; }
      this.#roots.set(system, roots);
      const watched = this.#watched.get(system) ?? new Set<string>();
      this.#watched.set(system, watched);
      const fresh = roots.filter((root) => root.watch && !watched.has(root.uri)).map((root) => root.uri);
      for (const uri of fresh) { watched.add(uri); }
      if (fresh.length > 0) { await connection.peer.call('watch', { uris: fresh, on: true }); }
      log.info('resources.roots', { system, roots: roots.length });
      this.#options.bus.publish('resources.roots', { system, roots });
    } catch (error) {
      if (this.#asked.get(system) !== asked) { return; }
      this.#roots.delete(system);
      log.warn('resources.roots.failed', { system, error: messageOf(error) });
    }
  }

  async read(uri: ResourceUri, want: readonly ReadWant[], signal?: AbortSignal): Promise<ResourceRead> {
    return this.#serving(uri).peer.call('read', { uri, want: [...want] }, signal === undefined ? {} : { signal });
  }

  async text(uri: ResourceUri, signal?: AbortSignal): Promise<{ stat: ResourceStat; text: string; links: ResourceLink[] }> {
    const connection = this.#serving(uri);
    const read = await connection.peer.call('read', { uri, want: ['text', 'links'] }, signal === undefined ? {} : { signal });
    const links = read.links ?? [];
    if (read.text === undefined) { return { stat: read.stat, text: '', links }; }
    if ('inline' in read.text) { return { stat: read.stat, text: read.text.inline, links }; }
    return { stat: read.stat, text: await this.#content(connection, read.text.ref, signal), links };
  }

  async stat(uri: ResourceUri): Promise<ResourceStat | undefined> {
    return (await this.#serving(uri).peer.call('stat', { uri })).stat;
  }

  async list(uri: ResourceUri, cursor?: string): Promise<Page<ResourceStat>> {
    return this.#serving(uri).peer.call('list', { uri, ...(cursor === undefined ? {} : { cursor }) });
  }

  async sections(sectioner: QualifiedName, uri: ResourceUri, version: string): Promise<Section[]> {
    const { system, local } = splitName(sectioner);
    const connection = this.#options.links.connected().find((c) => c.system === system);
    if (connection === undefined) { throw refuse(503, 'SECTIONER_AWAY', `${system} is not connected, so ${sectioner} can't cut ${uri}`); }
    return connection.peer.call('sections', { sectioner: local, uri, version });
  }

  changed(system: SystemName, changes: readonly ResourceChange[]): void {
    const own = changes.filter((change) => this.route(change.uri)?.system === system);
    if (own.length < changes.length) { this.#options.log.warn('resources.changed.foreign', { system, ignored: changes.length - own.length }); }
    if (own.length > 0) { this.#options.bus.publish('resources.changed', { system, changes: own }); }
  }

  /** The connection of the system serving a URI, or a 404. */
  #serving(uri: ResourceUri): SystemConnection {
    const route = this.route(uri);
    const connection = route === undefined ? undefined : this.#options.links.connection(route.system);
    if (connection === undefined) { throw refuse(404, 'NO_RESOURCE', `no connected system serves ${uri}`); }
    return connection;
  }

  /** Fetch content by ref from a system, chunk by chunk (each chunk is base64). */
  async #content(connection: SystemConnection, ref: ContentRef, signal?: AbortSignal): Promise<string> {
    const parts: Buffer[] = [];
    let offset = 0;
    while (offset < ref.size) {
      const length = Math.min(this.#options.maxChunk, ref.size - offset);
      const { chunk } = await connection.peer.call('content', { ref, offset, length }, signal === undefined ? {} : { signal });
      const bytes = Buffer.from(chunk, 'base64');
      if (bytes.length === 0) { break; }
      parts.push(bytes);
      offset += bytes.length;
    }
    return Buffer.concat(parts).toString('utf8');
  }
}
