/**
 * The hub's own resources (`ResourceLibrary`), under `hub://resources/`: uploads (`uploads/<day>/<name>`), web pages
 * (`web/<host>/<path>`, so fetching a URL again updates the same resource), and fn outputs (`runs/<run>/<name>`).
 * Their raw content lives only in the hub's content store; each import is announced as a resource change, so the
 * index sections it (in its primary form) like any system's resource. Names never show a URL's credentials.
 *
 * Browsing covers every resource the hub knows that the asker may see, hub and system ones, filtered and grouped by
 * `browse.ts`: visibility is applied before the counts and the page, so neither tells of a resource the asker can't see.
 */
import { reject } from '@ayepi/core';
import type { Logger } from '@ayepi/log';
import {
  HUB_RESOURCE_ROOT, ResourceStat, type ActorId, type ContentRef, type QualifiedName, type ResourceImportArgs, type ResourcePage, type ResourceQuery,
  type ResourceRecord, type ResourceSource, type ResourceUri, type RunId,
} from '@harness/core';
import type { ContentStore } from '../api/index.ts';
import type { EventBus } from '../bus.ts';
import { HUB_SYSTEM } from '../catalog/availability.ts';
import { allRows, rows } from '../store/rows.ts';
import type { Indexer } from '../index/index.ts';
import { sectionIndexKey } from '../index/indexer.ts';
import { sha256Hex } from '../link/keys.ts';
import type { HubStore } from '../store/index.ts';
import { FacetCounter, inGroup, matches } from './browse.ts';
import type { ResourcesEnv } from './env.ts';
import type { UrlFetcher } from './fetch.ts';
import type { Asking, Converters, FormService, ResourceLibrary } from './index.ts';
import { dayOf, hubUri, isHubUri, resourceLinkKey, safePath, safeSegment, withoutCredentials } from './rules.ts';

/** How many resources a browse page holds when the browser doesn't say. */
const PAGE_SIZE = 50;

/** What the library needs. */
export interface HubResourceLibraryOptions {
  readonly store: HubStore;
  readonly content: ContentStore;
  readonly forms: () => FormService;
  readonly fetcher: UrlFetcher;
  readonly converters: Pick<Converters, 'typeOf'>;
  readonly indexer: () => Pick<Indexer, 'remove'>;
  readonly bus: EventBus;
  readonly log: Logger;
  readonly clock: () => number;
  readonly settings: Pick<ResourcesEnv, 'HARNESS_IMPORT_MAX'>;
  /** The hub's own actor: who keeps a fn's output. */
  readonly hubActor: ActorId;
}

/** A short hash suffix that tells apart two different contents given one name. */
function suffixed(name: string, hash: string): string {
  const dot = name.lastIndexOf('.');
  const tag = hash.slice(0, 8);
  return dot > 0 ? `${name.slice(0, dot)}-${tag}${name.slice(dot)}` : `${name}-${tag}`;
}

/** Where and how a hub resource is kept. */
interface Place {
  readonly path: string;
  /** Its URI's last segment. */
  readonly segment: string;
  /** Its name as people see it. */
  readonly name: string;
  readonly content: ContentRef;
  readonly source: ResourceSource;
  readonly type: ResourceStat['type'];
  /** Replace what is kept there (a page fetched again) rather than keep both. */
  readonly replace?: boolean;
}

/**
 * A web page's place under `web/` (or under `web/<folder>/`, so a crawl keeps its pages under one root): its host and
 * path folders, and the page's own segment (with its query told apart).
 */
export function webPlace(url: URL, folder?: string): { path: string; segment: string } {
  const parts = url.pathname.split('/').filter((part) => part !== '').map((part) => safeSegment(decodeURIComponent(part)));
  const last = parts.pop() ?? 'index';
  const query = url.search === '' ? '' : `~${sha256Hex(url.search).slice(0, 8)}`;
  const under = folder === undefined ? '' : safePath(folder);
  return { path: ['web', ...(under === '' ? [] : [under]), url.host, ...parts].join('/'), segment: `${last}${query}` };
}

/** The hub's resources over its store and content store. */
export class HubResourceLibrary implements ResourceLibrary {
  readonly #o: HubResourceLibraryOptions;

  constructor(options: HubResourceLibraryOptions) {
    this.#o = options;
  }

  async import(args: ResourceImportArgs, who: Asking): Promise<ResourceRecord> {
    if ('url' in args) { return this.#importUrl(args, who); }
    if (!(await this.#o.content.has(args.content))) { throw reject(404, 'CONTENT_NOT_FOUND', `no content ${args.content.hash}; upload it first`); }
    this.#checkSize(args.content.size);
    const path = args.path ?? `uploads/${dayOf(this.#o.clock())}`;
    return this.#keepAt({ path, segment: args.name, name: args.name, content: args.content, source: { from: 'upload', by: who.actor }, type: 'file' }, who);
  }

  async keep(input: { content: ContentRef; name: string; run: RunId; fn: QualifiedName }): Promise<ResourceRecord> {
    this.#checkSize(input.content.size);
    const place = { path: `runs/${input.run}`, segment: input.name, name: input.name, content: input.content, type: 'file' } as const;
    return this.#keepAt({ ...place, source: { from: 'run', run: input.run, fn: input.fn } }, { actor: this.#o.hubActor, run: input.run });
  }

  async keepMade(input: { content: ContentRef; path: string; name: string; source: ResourceSource }, who: Asking): Promise<ResourceRecord> {
    this.#checkSize(input.content.size);
    return this.#keepAt({ path: input.path, segment: input.name, name: input.name, content: input.content, source: input.source, type: 'file', replace: true }, who);
  }

  async rename(uri: ResourceUri, name: string, _who: Asking): Promise<ResourceRecord> {
    const record = await this.#own(uri);
    const renamed: ResourceRecord = { ...record, stat: { ...record.stat, name: name.trim() } };
    await this.#o.store.table('resources').put(renamed);
    this.#changed(renamed, 'changed');
    this.#o.log.info('resources.renamed', { uri, name: renamed.stat.name });
    return renamed;
  }

  async remove(uri: ResourceUri, _who: Asking): Promise<{ deleted: boolean; referencedBy: number }> {
    const { store, indexer, log } = this.#o;
    const record = await this.#own(uri);
    const referencedBy = await this.#references(uri);
    if (referencedBy > 0) { return { deleted: false, referencedBy }; }
    const sections = record.indexedVersion === undefined ? [] : await allRows(store.table('sections'), { where: { uri, version: record.indexedVersion } });
    await store.tx(async (tx) => {
      for (const section of sections) { await tx.table('sections').remove(section); }
      await tx.table('resources').remove(uri);
    });
    await indexer().remove('section', sections.map((section) => sectionIndexKey(uri, section.key)));
    this.#o.bus.publish('resources.changed', { system: HUB_SYSTEM, changes: [{ uri, change: 'removed' }] });
    log.info('resources.deleted', { uri, sections: sections.length });
    return { deleted: true, referencedBy: 0 };
  }

  async browse(query: ResourceQuery, _who: Asking, visible: (uri: string) => boolean): Promise<ResourcePage> {
    const now = this.#o.clock();
    const counter = new FacetCounter(query.group ?? 'type', { under: query.under, now });
    const start = query.cursor === undefined ? 0 : Math.max(0, Number.parseInt(query.cursor, 10) || 0);
    const limit = query.limit ?? PAGE_SIZE;
    const items: ResourceRecord[] = [];
    let shown = 0;
    // newest first, read page by page in the store's order (ties by URI); only the counts and this page are kept
    const read = rows(this.#o.store.table('resources'), { where: query.system === undefined ? undefined : { system: query.system }, order: [['seenAt', 'desc']] });
    for await (const record of read) {
      if (!matches(record, query) || !visible(record.uri)) { continue; }
      counter.add(record);
      if (!inGroup(record, query, now)) { continue; }
      if (shown >= start && shown < start + limit) { items.push(record); }
      shown += 1;
    }
    return { items, facets: counter.facets(), ...(start + limit < shown ? { cursor: String(start + limit) } : {}) };
  }

  /** Import a URL: fetched (through the web system when it can), kept under `web/<host>/…` (or `web/<folder>/<host>/…`). */
  async #importUrl(args: Extract<ResourceImportArgs, { url: string }>, who: Asking): Promise<ResourceRecord> {
    const { url, name } = args;
    const fetched = await this.#o.fetcher.fetch(url, args.render ?? 'auto', who);
    this.#checkSize(fetched.bytes.length);
    const ref = await this.#o.content.put(fetched.bytes, fetched.mime);
    const asked = withoutCredentials(url);
    const final = withoutCredentials(fetched.finalUrl);
    const { path, segment } = webPlace(final, args.folder);
    const shown = name ?? fetched.title ?? (final.pathname === '/' ? final.host : decodeURIComponent(final.pathname.split('/').filter((p) => p !== '').at(-1) ?? final.host));
    const source: ResourceSource = {
      from: 'web', url: asked.href, fetchedAt: this.#o.clock(), rendered: fetched.rendered, ...(final.href === asked.href ? {} : { finalUrl: final.href }),
    };
    return this.#keepAt({ path, segment, name: shown, content: ref, source, type: 'page', replace: true }, who);
  }

  /**
   * Keep content as a hub resource at `path/segment`. Content already kept there stays one resource; other content
   * under a taken name gets a hash suffix, unless `replace` (a web page fetched again is a new version of itself).
   */
  async #keepAt(place: Place, who: Asking): Promise<ResourceRecord> {
    const { store, clock, converters, log } = this.#o;
    const { path, segment, name, content, source, type } = place;
    let uri = hubUri(path, segment);
    const taken = await store.table('resources').get(uri);
    if (taken?.raw !== undefined && taken.raw.hash !== content.hash && place.replace !== true) { uri = hubUri(path, suffixed(segment, content.hash)); }
    const existing = await store.table('resources').get(uri);
    const now = clock();
    const format = converters.typeOf(segment, content.mime);
    const stat = ResourceStat.parse({
      uri, name: name.trim() === '' ? segment : name.trim(), type, mime: content.mime, size: content.size, modifiedAt: now, version: content.hash,
      ...(format === undefined ? {} : { format }),
    });
    const same = existing?.raw?.hash === content.hash;
    const record: ResourceRecord = {
      ...(same ? existing : {}), uri, system: HUB_SYSTEM, stat, links: same ? existing.links : [], source, raw: content, seenAt: now,
      ...(same ? {} : { forms: [] }),
    };
    await store.table('resources').put(record);
    log.info('resources.kept', { uri, source: source.from, hash: content.hash, size: content.size, again: same });
    // cheap forms are made now, so the record's badges are right when it is returned
    const { record: withForms } = await this.#o.forms().forms(uri, who);
    this.#changed(withForms, existing === undefined ? 'added' : 'changed');
    return withForms;
  }

  /** A hub resource's record, or 404 (and 403 for a system's resource, which only its system can change). */
  async #own(uri: ResourceUri): Promise<ResourceRecord> {
    if (!isHubUri(uri)) { throw reject(403, 'NOT_A_HUB_RESOURCE', `${uri} belongs to its system; only resources under ${HUB_RESOURCE_ROOT} can be renamed or deleted here`); }
    const record = await this.#o.store.table('resources').get(uri);
    if (record === undefined) { throw reject(404, 'NO_RESOURCE', `there is no hub resource ${uri}`); }
    return record;
  }

  /** How many context items and links still point at a resource. */
  async #references(uri: ResourceUri): Promise<number> {
    const { store } = this.#o;
    const made = (await allRows(store.table('context'), { where: { system: HUB_SYSTEM } })).filter((item) => item.origin?.type === 'resource' && item.origin.uri === uri).length;
    const linked = await store.table('contextLinks').count({ toKey: resourceLinkKey(uri) });
    return made + linked;
  }

  /** Refuse content over the import cap. */
  #checkSize(size: number): void {
    const max = this.#o.settings.HARNESS_IMPORT_MAX;
    if (size > max) { throw reject(413, 'TOO_LARGE', `the hub keeps resources of up to ${max} bytes; this is ${size}`); }
  }

  /** Announce a hub resource's change, so the index sections it and browsers refresh. */
  #changed(record: ResourceRecord, change: 'added' | 'changed'): void {
    this.#o.bus.publish('resources.changed', { system: HUB_SYSTEM, changes: [{ uri: record.uri, change, version: record.stat.version }] });
  }
}
