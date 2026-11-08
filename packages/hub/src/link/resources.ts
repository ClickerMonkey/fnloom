/**
 * Resource routing. Instances that serve resources offer roots (folders at absolute URIs); a URI belongs to the
 * connected instance whose root holds it, the longest root winning (in a fleet each instance's URIs carry its name as
 * their authority, `file://laptop/…`, so its roots are its own). Reads, lists and sections go to that instance over
 * its link. Large text comes back as a content ref, fetched in chunks of the link's largest chunk.
 * Roots are asked for on connect, when its contract arrives and after it applies a config. Changes an instance
 * reports are kept only for URIs under its own roots and announced on the bus as `resources.changed`.
 */
import { reject as refuse } from '@ayepi/core';
import type { Logger } from '@ayepi/log';
import {
  SystemName, instanceLabel, splitName, type ContentRef, type InstanceName, type InstanceRef, type Page, type QualifiedName, type ReadWant, type ResourceChange, type ResourceLink, type ResourceRead, type ResourceStat,
  type ResourceUri, type Section,
} from '@harness/core';
import type { EventBus } from '../bus.ts';
import type { Catalog } from '../catalog/index.ts';
import { messageOf } from '../catalog/scope.ts';
import type { LinkService, ResourceRouter, RoutedRoot, SystemConnection } from './index.ts';

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
  /** Each connected instance's roots, by `system@instance`. */
  readonly #roots = new Map<string, RoutedRoot[]>();
  /** The roots each connected instance was asked to watch. */
  readonly #watched = new Map<string, Set<string>>();
  /** Each instance's latest refresh, so an older answer that arrives late doesn't replace a newer one. */
  readonly #asked = new Map<string, number>();

  constructor(options: ResourceRouterOptions) {
    this.#options = options;
    options.links.onChange((change) => {
      if (change.connected) { void this.refresh(change.system, change.instance); return; }
      this.#roots.delete(instanceLabel(change));
      this.#watched.delete(instanceLabel(change));
    });
    // a system that connected before it was configured serves its roots once its config arrives
    options.bus.subscribe('system.status', ({ system, status }) => { if (status === 'connected') { void this.refresh(system); } });
    // the roots follow the config, so they are asked for again once the system has applied a new one
    options.bus.subscribe('system.configured', ({ system }) => { void this.refresh(system); });
  }

  roots(): readonly RoutedRoot[] {
    return [...this.#roots.values()].flat();
  }

  route(uri: ResourceUri): RoutedRoot | undefined {
    let best: RoutedRoot | undefined;
    for (const entry of this.roots()) {
      if (underRoot(uri, entry.root.uri) && (best === undefined || entry.root.uri.length > best.root.uri.length)) { best = entry; }
    }
    return best;
  }

  async refresh(system: SystemName, instance?: InstanceName): Promise<void> {
    const { links } = this.#options;
    const connections = instance === undefined ? links.connections(system) : [links.connection(system, instance)];
    if (instance !== undefined && connections[0] === undefined) { this.#roots.delete(instanceLabel({ system, instance })); }
    await Promise.all(connections.map((connection) => (connection === undefined ? Promise.resolve() : this.#refreshOne(connection))));
  }

  /** Ask one instance for its roots and watch the new ones. */
  async #refreshOne(connection: SystemConnection): Promise<void> {
    const { catalog, log } = this.#options;
    const ref: InstanceRef = { system: connection.system, instance: connection.instance };
    const key = instanceLabel(ref);
    const manifest = await catalog.manifest(ref.system);
    // before its first manifest nothing is known; importing the manifest refreshes again when it serves resources
    if (manifest?.resources !== true) { this.#roots.delete(key); return; }
    const asked = (this.#asked.get(key) ?? 0) + 1;
    this.#asked.set(key, asked);
    try {
      const roots = await connection.peer.call('roots');
      if (this.#asked.get(key) !== asked) { return; }
      this.#roots.set(key, roots.map((root) => ({ ...ref, root })));
      const watched = this.#watched.get(key) ?? new Set<string>();
      this.#watched.set(key, watched);
      const fresh = roots.filter((root) => root.watch && !watched.has(root.uri)).map((root) => root.uri);
      for (const uri of fresh) { watched.add(uri); }
      if (fresh.length > 0) { await connection.peer.call('watch', { uris: fresh, on: true }); }
      log.info('resources.roots', { system: ref.system, instance: ref.instance, roots: roots.length });
      this.#options.bus.publish('resources.roots', { system: ref.system, roots });
    } catch (error) {
      if (this.#asked.get(key) !== asked) { return; }
      this.#roots.delete(key);
      log.warn('resources.roots.failed', { system: ref.system, instance: ref.instance, error: messageOf(error) });
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
    const { local } = splitName(sectioner);
    const system = SystemName.parse(splitName(sectioner).system);
    const route = this.route(uri);
    const connection = this.#options.links.connection(system, route?.system === system ? route.instance : undefined);
    if (connection === undefined) { throw refuse(503, 'SECTIONER_AWAY', `${system} is not connected, so ${sectioner} can't cut ${uri}`); }
    return connection.peer.call('sections', { sectioner: local, uri, version });
  }

  changed(link: InstanceRef, changes: readonly ResourceChange[]): void {
    const own = changes.filter((change) => {
      const route = this.route(change.uri);
      return route?.system === link.system && route.instance === link.instance;
    });
    if (own.length < changes.length) { this.#options.log.warn('resources.changed.foreign', { system: link.system, instance: link.instance, ignored: changes.length - own.length }); }
    if (own.length > 0) { this.#options.bus.publish('resources.changed', { system: link.system, changes: own }); }
  }

  /** The connection of the instance serving a URI, or a 404. */
  #serving(uri: ResourceUri): SystemConnection {
    const route = this.route(uri);
    const connection = route === undefined ? undefined : this.#options.links.connection(route.system, route.instance);
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
