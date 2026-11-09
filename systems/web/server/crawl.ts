/**
 * Crawling a site: a breadth-first walk from a start page, a few links deep, that keeps every page it reads as a hub
 * resource under one folder (`crawls/<host>-<yyyymmdd-hhmm>`). Each page is fetched here first (robots.txt checked,
 * links read from its html), held in `FetchedPages` and imported through the hub, which fetches it back through
 * `web/fetch_raw` and finds it waiting, so no page crosses the network twice.
 */
import { descendants, parseHtml } from '@aeye/resources';
import type { ResourceUri } from '@harness/core';
import { CallFailed, type Infer } from '@harness/sdk';
import type { CrawledPage, CrawlSkipReason, SkippedPageValue } from '../shared/index.ts';
import { domainOf, redactUrl } from '../shared/urls.ts';
import type { FetchedPage, FetchSettings, PageSource } from './index.ts';
import { WebProblem, isAbort } from './problem.ts';
import { RobotsRules, escapeRegExp } from './robots.ts';

/** Pages fetched by a crawl, waiting for the hub to fetch them back; each is handed out once, within its time. */
export class FetchedPages {
  readonly #pages = new Map<string, { page: FetchedPage; until: number }>();
  readonly #ttl: number;
  readonly #now: () => number;

  constructor(ttl: number, now: () => number) {
    this.#ttl = ttl;
    this.#now = now;
  }

  /** Hold a page under the URL it was asked by and the one it ended at. */
  put(page: FetchedPage): void {
    this.#sweep();
    const until = this.#now() + this.#ttl;
    for (const url of new Set([page.requestedUrl, page.finalUrl])) { this.#pages.set(url, { page, until }); }
  }

  /** The page held for a URL, removed so a later fetch of it goes to the network. */
  take(url: string): FetchedPage | undefined {
    this.#sweep();
    const held = this.#pages.get(url);
    if (held === undefined) { return undefined; }
    for (const key of new Set([held.page.requestedUrl, held.page.finalUrl])) { this.#pages.delete(key); }
    return held.page;
  }

  /** How many URLs are held. */
  get size(): number {
    return this.#pages.size;
  }

  #sweep(): void {
    const now = this.#now();
    for (const [url, held] of this.#pages) { if (held.until <= now) { this.#pages.delete(url); } }
  }
}

/** What one crawl does. */
export interface CrawlPlan {
  readonly start: URL;
  /** Link levels to follow: 0 is the start page only. */
  readonly depth: number;
  readonly sameSite: boolean;
  readonly maxPages: number;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly fetch: FetchSettings;
  /** The folder the pages are kept under. */
  readonly folder: string;
}

/** A page the crawl kept (the result's `CrawledPage`, its uri typed). */
export type CrawlKept = Omit<Infer<typeof CrawledPage>, 'uri'> & { readonly uri: ResourceUri };

/** A page the crawl left out (the result's `SkippedPage`). */
export type CrawlSkip = SkippedPageValue;

/** What a crawl found. */
export interface CrawlReport {
  readonly pages: readonly CrawlKept[];
  readonly skipped: readonly CrawlSkip[];
}

/** Keeps a fetched page as a hub resource; throws to leave it out (a `CallFailed`, say). */
export type PageImporter = (url: string, folder: string) => Promise<{ uri: ResourceUri; title: string }>;

/** What a crawler is built from. */
export interface CrawlerDeps {
  readonly pages: PageSource;
  readonly held: FetchedPages;
  readonly importPage: PageImporter;
  /** The robots.txt agent token. */
  readonly agent: string;
  /** The most links one crawl looks at. */
  readonly maxLinks: number;
  /** Called after each page with the share of `maxPages` done. */
  readonly progress: (fraction: number, message: string) => void;
  readonly signal: AbortSignal;
}

/** Files a crawl doesn't treat as pages, by extension. */
const NOT_PAGES = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico', 'bmp', 'css', 'js', 'mjs', 'map', 'json', 'xml', 'rss', 'atom',
  'zip', 'gz', 'tgz', 'tar', 'rar', '7z', 'exe', 'dmg', 'msi', 'mp3', 'mp4', 'm4a', 'wav', 'ogg', 'webm', 'mov', 'avi', 'woff', 'woff2', 'ttf', 'otf', 'eot']);

/** The folder a crawl of `start` at `at` keeps its pages under: `crawls/<host>-<yyyymmdd-hhmm>` (UTC). */
export function crawlFolder(start: URL, at: number): string {
  const time = new Date(at).toISOString();
  const stamp = `${time.slice(0, 4)}${time.slice(5, 7)}${time.slice(8, 10)}-${time.slice(11, 13)}${time.slice(14, 16)}`;
  return `crawls/${start.host.toLowerCase().replace(/[^a-z0-9.-]/g, '-')}-${stamp}`;
}

/**
 * The resource folder the pages are under: the part of their URIs up to the crawl's folder, else the longest folder
 * they share. Empty when no page was kept.
 */
export function crawlRoot(uris: readonly string[], folder: string): string {
  const first = uris[0];
  if (first === undefined) { return ''; }
  const at = first.indexOf(`/${folder}/`);
  if (at >= 0) { return first.slice(0, at + folder.length + 1); }
  let shared = first.slice(0, first.lastIndexOf('/'));
  for (const uri of uris) {
    while (shared !== '' && !uri.startsWith(`${shared}/`)) { shared = shared.slice(0, Math.max(0, shared.lastIndexOf('/'))); }
  }
  return shared;
}

/**
 * A glob over a link: one with `://` matches the whole URL, one with a `/` the path (and query), one without the
 * path's last segment. `**` matches anything, `*` anything but `/`, `?` one character but `/`.
 */
export function globMatches(glob: string, url: URL): boolean {
  const subject = glob.includes('://') ? url.href : glob.includes('/') ? `${url.pathname}${url.search}` : (url.pathname.split('/').at(-1) ?? '');
  const pattern = glob.split(/(\*\*|\*|\?)/).map((part) => (part === '**' ? '.*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : escapeRegExp(part))).join('');
  return new RegExp(`^${pattern}$`).test(subject);
}

/** The links of an html page, absolute, without fragments, http(s) only; `rel="nofollow"` links are left out. */
export function linksOf(html: string, base: string): URL[] {
  const root = parseHtml(html);
  const baseHref = [...descendants(root)].find((element) => element.name === 'base' && element.attributes['href'] !== undefined)?.attributes['href'];
  const resolveFrom = baseHref !== undefined && URL.canParse(baseHref, base) ? new URL(baseHref, base).href : base;
  const links: URL[] = [];
  for (const element of descendants(root)) {
    const href = element.attributes['href'];
    if (element.name !== 'a' || href === undefined || href.trim() === '') { continue; }
    if ((element.attributes['rel'] ?? '').toLowerCase().split(/\s+/).includes('nofollow')) { continue; }
    if (!URL.canParse(href.trim(), resolveFrom)) { continue; }
    const url = new URL(href.trim(), resolveFrom);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') { continue; }
    url.hash = '';
    links.push(url);
  }
  return links;
}

/** A crawl's walk. One instance per crawl. */
export class Crawler {
  readonly #deps: CrawlerDeps;
  readonly #robots = new Map<string, Promise<RobotsRules>>();

  constructor(deps: CrawlerDeps) {
    this.#deps = deps;
  }

  /** Walk the site as the plan says. Throws only when the run is cancelled; a page that fails is left out. */
  async run(plan: CrawlPlan): Promise<CrawlReport> {
    const kept: CrawlKept[] = [];
    const skipped: CrawlSkip[] = [];
    const keptUrls = new Set<string>();
    const seen = new Set<string>([plan.start.href]);
    const queue: Array<{ url: URL; depth: number }> = [{ url: plan.start, depth: 0 }];
    const site = domainOf(plan.start);
    let looked = 1;

    while (queue.length > 0 && kept.length < plan.maxPages) {
      const next = queue.shift();
      if (next === undefined) { break; }
      const { url, depth } = next;
      if (!(await this.#rules(url, plan.fetch)).allows(url)) { skipped.push({ url: redactUrl(url), reason: 'robots' }); continue; }
      const page = await this.#fetch(url, plan.fetch);
      if ('problem' in page) { skipped.push({ url: redactUrl(url), reason: 'failed', detail: page.problem }); continue; }
      // a redirect to a page already kept is the same page
      if (keptUrls.has(page.finalUrl)) { continue; }
      const imported = await this.#import(page, plan.folder);
      if ('problem' in imported) { skipped.push({ url: redactUrl(url), reason: 'failed', detail: imported.problem }); continue; }
      keptUrls.add(page.finalUrl).add(page.requestedUrl);
      kept.push({ url: redactUrl(page.finalUrl), uri: imported.uri, title: imported.title, depth });
      this.#deps.progress(kept.length / plan.maxPages, `Kept ${kept.length} of up to ${plan.maxPages}: ${imported.title}`);
      if (depth >= plan.depth || page.type !== 'html') { continue; }
      for (const link of linksOf(new TextDecoder().decode(page.bytes), page.finalUrl)) {
        if (seen.has(link.href)) { continue; }
        if (looked >= this.#deps.maxLinks) { break; }
        seen.add(link.href);
        looked += 1;
        const reason = this.#leaveOut(link, plan, site);
        if (reason === undefined) { queue.push({ url: link, depth: depth + 1 }); } else { skipped.push({ url: redactUrl(link), reason }); }
      }
    }
    for (const left of queue) { skipped.push({ url: redactUrl(left.url), reason: 'limit' }); }
    return { pages: kept, skipped };
  }

  #leaveOut(link: URL, plan: CrawlPlan, site: string): CrawlSkipReason | undefined {
    if (plan.sameSite && domainOf(link) !== site) { return 'other-site'; }
    const extension = /\.([a-z0-9]+)$/i.exec(link.pathname)?.[1]?.toLowerCase();
    if (extension !== undefined && NOT_PAGES.has(extension)) { return 'not-a-page'; }
    if (plan.exclude.some((glob) => globMatches(glob, link))) { return 'excluded'; }
    if (plan.include.length > 0 && !plan.include.some((glob) => globMatches(glob, link))) { return 'not-included'; }
    return undefined;
  }

  async #fetch(url: URL, settings: FetchSettings): Promise<FetchedPage | { problem: string }> {
    try {
      const page = await this.#deps.pages.fetch(url.href, settings, this.#deps.signal);
      this.#deps.held.put(page);
      return page;
    } catch (error) {
      if (error instanceof WebProblem && !this.#deps.signal.aborted) { return { problem: error.message }; }
      throw error;
    }
  }

  async #import(page: FetchedPage, folder: string): Promise<{ uri: ResourceUri; title: string } | { problem: string }> {
    try {
      return await this.#deps.importPage(page.requestedUrl, folder);
    } catch (error) {
      if (this.#deps.signal.aborted || isAbort(error) || !(error instanceof Error) || (error instanceof CallFailed && error.error.class === 'cancelled')) { throw error; }
      return { problem: error.message };
    } finally {
      // the hub has fetched it back by now, or never will
      this.#deps.held.take(page.requestedUrl);
    }
  }

  /** The site's robots.txt rules, read once per origin; one that can't be read allows everything. */
  #rules(url: URL, settings: FetchSettings): Promise<RobotsRules> {
    const known = this.#robots.get(url.origin);
    if (known !== undefined) { return known; }
    const reading = this.#deps.pages.fetch(`${url.origin}/robots.txt`, { ...settings, render: 'never' }, this.#deps.signal).then(
      (page) => (page.mime.startsWith('text/') ? RobotsRules.parse(new TextDecoder().decode(page.bytes), this.#deps.agent) : RobotsRules.ALLOW_ALL),
      (error: unknown) => {
        if (this.#deps.signal.aborted || !(error instanceof WebProblem)) { throw error; }
        return RobotsRules.ALLOW_ALL;
      },
    );
    this.#robots.set(url.origin, reading);
    return reading;
  }
}

