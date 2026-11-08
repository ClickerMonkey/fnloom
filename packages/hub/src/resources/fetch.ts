/**
 * Fetching a URL for `ResourceLibrary.import`. When the web system is connected and the import is part of a run, the
 * web system fetches it (`web/fetch_raw`: type detection, redirects, a byte cap and script-built pages rendered in
 * its headless browser) as a child run, so its cost and time show under the run that asked. Otherwise the hub
 * fetches it itself with `@aeye/resources`' `fetchResource` (no rendering).
 *
 * The hub's own fetch never reaches private, loopback or link-local addresses unless `HARNESS_FETCH_PRIVATE` says
 * so, redirects included (each hop's host is resolved and checked), so asking the LLM to fetch
 * `http://127.0.0.1:4300/…` can't reach the hub's own data.
 */
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { reject } from '@ayepi/core';
import { fetchResource, type FetchFn } from '@aeye/resources';
import { qualify, RawPage, SystemName, type ActorId, type Run, type RunId, type RunSettled } from '@harness/core';
import type { ContentStore } from '../api/index.ts';
import type { RunService } from '../execution/index.ts';
import type { ResourcesEnv } from './env.ts';
import type { Asking, Converters } from './index.ts';

/** When a fetched html page is run in a headless browser first. */
export type RenderMode = 'auto' | 'always' | 'never';

/** A fetched URL: its bytes and what the fetch found out. */
export interface FetchedUrl {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly finalUrl: string;
  readonly rendered: boolean;
  readonly title?: string;
}

/** Fetches URLs for imports. */
export interface UrlFetcher {
  fetch(url: string, render: RenderMode, who: Asking, signal?: AbortSignal): Promise<FetchedUrl>;
}

/** The most redirects the hub's own fetch follows. */
const MAX_REDIRECTS = 8;

/** Address ranges the hub's own fetch refuses: private, loopback, link-local, carrier-grade NAT and unspecified. */
const PRIVATE = (() => {
  const list = new BlockList();
  for (const [net, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const) {
    list.addSubnet(net, prefix, 'ipv4');
  }
  for (const [net, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10]] as const) { list.addSubnet(net, prefix, 'ipv6'); }
  return list;
})();

/** Whether an IP address is private, loopback, link-local or unspecified (IPv4-mapped IPv6 addresses by their IPv4). */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  const ip = mapped ?? address;
  const family = isIP(ip);
  if (family === 0) { return true; }
  return PRIVATE.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

/** Resolves a host name to its addresses (a seam for tests). */
export type ResolveHost = (host: string) => Promise<readonly string[]>;

/** The system's resolver. */
export const resolveHost: ResolveHost = async (host) => (await lookup(host, { all: true })).map((entry) => entry.address);

/** Refuse a URL that isn't http(s), or whose host is (or resolves to) a private address. */
export async function checkPublic(url: URL, resolve: ResolveHost): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') { throw reject(422, 'NOT_HTTP', `only http and https URLs can be imported, not ${url.protocol}`); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) === 0 ? await resolve(host) : [host];
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw reject(403, 'PRIVATE_ADDRESS', `${url.host} is a private or local address; the hub only imports public URLs (an admin can allow private ones)`);
  }
}

/** A `fetch` that follows redirects itself, checking every hop's host first. */
export function guardedFetch(inner: FetchFn, resolve: ResolveHost): FetchFn {
  return async (input, init) => {
    let url = new URL(input);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await checkPublic(url, resolve);
      const response = await inner(url.href, { ...init, redirect: 'manual' });
      const location = response.headers.get('location');
      if (response.status < 300 || response.status >= 400 || location === null) { return response; }
      await response.body?.cancel().catch(() => undefined);
      url = new URL(location, url);
    }
    throw reject(508, 'TOO_MANY_REDIRECTS', `more than ${MAX_REDIRECTS} redirects`);
  };
}

/** What the hub's own fetcher needs. */
export interface LibraryFetcherOptions {
  readonly converters: Pick<Converters, 'typeOf'>;
  readonly settings: Pick<ResourcesEnv, 'HARNESS_FETCH_TIMEOUT' | 'HARNESS_FETCH_PRIVATE' | 'HARNESS_IMPORT_MAX'>;
  /** The network fetch (default the global one). */
  readonly fetch?: FetchFn;
  readonly resolve?: ResolveHost;
}

/** The hub fetching URLs itself with `@aeye/resources`. */
export class LibraryFetcher implements UrlFetcher {
  readonly #o: LibraryFetcherOptions;
  readonly #fetch: FetchFn;

  constructor(options: LibraryFetcherOptions) {
    this.#o = options;
    const inner = options.fetch ?? fetch;
    this.#fetch = options.settings.HARNESS_FETCH_PRIVATE ? inner : guardedFetch(inner, options.resolve ?? resolveHost);
  }

  async fetch(url: string, _render: RenderMode, _who: Asking, signal?: AbortSignal): Promise<FetchedUrl> {
    const { settings, converters } = this.#o;
    const page = await fetchResource(url, { inferType: (location, mime) => converters.typeOf(location, mime) }, {
      fetch: this.#fetch, timeoutMs: settings.HARNESS_FETCH_TIMEOUT, maxBytes: settings.HARNESS_IMPORT_MAX, render: 'never', ...(signal === undefined ? {} : { signal }),
    });
    const mime = page.source.mimeType ?? page.declared?.mimeType ?? 'application/octet-stream';
    return { bytes: page.source.input, mime: page.source.type === 'html' && !mime.startsWith('text/html') ? 'text/html' : mime, finalUrl: page.url, rendered: false };
  }
}

/** The web system, and the fn it fetches with. */
export const WEB = SystemName.parse('web');
export const FETCH_RAW = qualify(WEB, 'fetch_raw');

/** The runs a fetch through the web system goes under: what it reads of the parent, and how it starts the child. */
export interface FetchRuns {
  get(run: RunId): Promise<Pick<Run, 'id' | 'turn' | 'actor' | 'priority' | 'session'> | undefined>;
  start: RunService['start'];
}

/** What fetching through the web system needs. */
export interface WebSystemFetcherOptions {
  /** Whether the web system is connected now. */
  readonly webConnected: () => boolean;
  readonly runs: () => FetchRuns;
  readonly content: ContentStore;
  /** The hub's own actor, the caller of the child run. */
  readonly hubActor: ActorId;
  /** Where to fetch when the web system can't (not connected, or no run to put the fetch under). */
  readonly fallback: UrlFetcher;
}

/** The web system fetching URLs (as a child run of the run that imports), else the fallback. */
export class WebSystemFetcher implements UrlFetcher {
  readonly #o: WebSystemFetcherOptions;

  constructor(options: WebSystemFetcherOptions) {
    this.#o = options;
  }

  async fetch(url: string, render: RenderMode, who: Asking, signal?: AbortSignal): Promise<FetchedUrl> {
    const parent = who.run === undefined ? undefined : await this.#o.runs().get(who.run);
    if (parent === undefined || !this.#o.webConnected()) {
      return this.#o.fallback.fetch(url, render, who, signal);
    }
    const { settled } = await this.#o.runs().start({
      fn: FETCH_RAW, args: { url, render }, turn: parent.turn, parent: parent.id, key: `${FETCH_RAW}:${url}`, actor: parent.actor, caller: this.#o.hubActor,
      priority: parent.priority, background: false, handlers: [], ...(parent.session === undefined ? {} : { session: parent.session }),
    });
    const outcome: RunSettled = await settled;
    switch (outcome.status) {
      case 'done': break;
      case 'failed': throw reject(502, 'FETCH_FAILED', `the web system could not fetch ${url}: ${outcome.error.message}`);
      case 'cancelled': case 'background': throw reject(502, 'FETCH_FAILED', `fetching ${url} did not finish (${outcome.status})`);
    }
    const page = RawPage.parse(outcome.result);
    return {
      bytes: await this.#o.content.read(page.content, 0, page.content.size), mime: page.mime, finalUrl: page.finalUrl, rendered: page.rendered,
      ...(page.title === undefined ? {} : { title: page.title }),
    };
  }
}
