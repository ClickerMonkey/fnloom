/**
 * Fetching a URL for `ResourceLibrary.import`. When the web system is connected and the import is part of a run, the
 * web system fetches it (`web/fetch_raw`: type detection, redirects, a byte cap and script-built pages rendered in
 * its headless browser) as a child run, so its cost and time show under the run that asked. Otherwise the hub
 * fetches it itself with `@aeye/resources`' `fetchResource` (no rendering).
 *
 * The hub's own fetch checks addresses with the SDK's rules (`addressVerdict`, the same the web system uses): it never
 * reaches private, loopback, link-local or reserved addresses or local names unless `HARNESS_FETCH_PRIVATE` says so,
 * redirects included (each hop's host is resolved and checked), so asking the LLM to fetch
 * `http://127.0.0.1:4300/…` can't reach the hub's own data.
 */
import { reject } from '@ayepi/core';
import { fetchResource, type FetchFn } from '@aeye/resources';
import { qualify, RawPage, SystemName, type ActorId, type RenderMode, type Run, type RunId, type RunSettled } from '@harness/core';
import { addressVerdict, followRedirects, systemLookup, type AddressRules, type HostLookup } from '@harness/sdk/server';
import type { ContentStore } from '../api/index.ts';
import type { RunService } from '../execution/index.ts';
import type { ResourcesEnv } from './env.ts';
import type { Asking, Converters } from './index.ts';

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

/** Refuse a URL that isn't http(s), or whose host is (or resolves to) a private address, under the SDK's address rules. */
async function checkPublic(url: URL, rules: AddressRules, signal?: AbortSignal): Promise<void> {
  const verdict = await addressVerdict(url, rules, signal);
  if (verdict.ok) { return; }
  switch (verdict.refusal) {
    case 'not-http': throw reject(422, 'NOT_HTTP', `only http and https URLs can be imported, not ${url.protocol}`);
    case 'private': throw reject(403, 'PRIVATE_ADDRESS', `${url.host} is a private or local address; the hub only imports public URLs (an admin can allow private ones)`);
    case 'unresolved': throw reject(502, 'UNRESOLVED_HOST', `could not look up ${url.hostname}`);
  }
}

/** A `fetch` that follows at most `redirects` redirects itself, checking every hop's host first. */
export function guardedFetch(inner: FetchFn, rules: AddressRules, redirects: number): FetchFn {
  return async (input, init) => (await followRedirects(input, init, {
    fetch: inner,
    check: (url, signal) => checkPublic(url, rules, signal),
    redirects,
    problems: {
      noLocation: (at) => reject(502, 'BAD_REDIRECT', `${at.host} redirected without a usable location`),
      tooMany: (_start, limit) => reject(508, 'TOO_MANY_REDIRECTS', `more than ${limit} redirects`),
    },
  })).response;
}

/** What the hub's own fetcher needs. */
export interface LibraryFetcherOptions {
  readonly converters: Pick<Converters, 'typeOf'>;
  readonly settings: Pick<ResourcesEnv, 'HARNESS_FETCH_TIMEOUT' | 'HARNESS_FETCH_PRIVATE' | 'HARNESS_FETCH_REDIRECTS' | 'HARNESS_IMPORT_MAX'>;
  /** The network fetch (default the global one). */
  readonly fetch?: FetchFn;
  /** The resolver hosts are checked with (default the machine's). */
  readonly lookup?: HostLookup;
}

/** The hub fetching URLs itself with `@aeye/resources`. */
export class LibraryFetcher implements UrlFetcher {
  readonly #o: LibraryFetcherOptions;
  readonly #fetch: FetchFn;

  constructor(options: LibraryFetcherOptions) {
    this.#o = options;
    const rules: AddressRules = { lookup: options.lookup ?? systemLookup, allowPrivate: options.settings.HARNESS_FETCH_PRIVATE };
    this.#fetch = guardedFetch(options.fetch ?? fetch, rules, options.settings.HARNESS_FETCH_REDIRECTS);
  }

  async fetch(url: string, _render: RenderMode, _who: Asking, signal?: AbortSignal): Promise<FetchedUrl> {
    const { settings, converters } = this.#o;
    const page = await fetchResource(url, { inferType: (location, mime) => converters.typeOf(location, mime) }, {
      fetch: this.#fetch, timeoutMs: settings.HARNESS_FETCH_TIMEOUT, maxBytes: settings.HARNESS_IMPORT_MAX, render: 'never', ...(signal === undefined ? {} : { signal }),
    });
    return { bytes: page.source.input, mime: page.source.mimeType, finalUrl: page.url, rendered: false };
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
