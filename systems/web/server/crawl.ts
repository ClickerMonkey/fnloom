/**
 * Crawling a site: `@aeye/resources`' `buildResourceGraph` walks it breadth first from a start page, a few links deep,
 * over the web system's guarded fetch (each request checked against the site's robots.txt first), and every page it
 * reads is kept as a hub resource under one folder (`crawls/<host>-<yyyymmdd-hhmm>`). Each graph node carries the raw
 * bytes and what the fetch found (final URL, status, rendered); the page is held in `FetchedPages` and imported through
 * the hub, which fetches it back through `web/fetch_raw` and finds it waiting, so no page crosses the network twice.
 */
import { buildResourceGraph, type ResourceGraph, type ResourceGraphEdge, type ResourceGraphNode, type ResourceLink } from '@aeye/resources';
import { z } from 'zod';
import type { ResourceUri } from '@harness/core';
import { CallFailed, type Infer } from '@harness/sdk';
import type { CrawledPage, CrawlSkipReason, SkippedPageValue } from '../shared/index.ts';
import { domainOf, redactUrl } from '../shared/urls.ts';
import type { FetchedPage, FetchSettings, PageSource } from './index.ts';
import { titleFor } from './loader.ts';
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
  /** How many pages load at once. */
  readonly concurrency: number;
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

/** The tag and `rel` words `@aeye/resources` records on each html link. */
const LinkFacts = z.object({ tag: z.string(), rel: z.array(z.string()).optional() });

/** The tag and `rel` words of a link the graph found (`@aeye/resources` puts them in its metadata). */
function linkFacts(link: ResourceLink): z.infer<typeof LinkFacts> | undefined {
  const facts = LinkFacts.safeParse(link.metadata);
  return facts.success ? facts.data : undefined;
}

/** A link as an absolute http(s) URL without its fragment, against the page it is on; `undefined` for any other link. */
function webUrlOf(link: ResourceLink, from: string): URL | undefined {
  const value = link.value.trim();
  if (value === '' || !URL.canParse(value, from)) { return undefined; }
  const url = new URL(value, from);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') { return undefined; }
  url.hash = '';
  return url;
}

/** A URL without its fragment (a link's `#part` names a place in the page, not another page). */
function withoutFragment(url: string): string {
  if (!URL.canParse(url)) { return url; }
  const parsed = new URL(url);
  parsed.hash = '';
  return parsed.href;
}

/** The words a robots refusal carries, so an edge's error says it was robots. */
const ROBOTS_REFUSAL = 'is disallowed by the site\'s robots.txt';

/** Records a page the crawl left out, once per URL. */
type Skip = (url: URL | string, reason: CrawlSkipReason, detail?: string) => void;

/** A crawl's walk. One instance per crawl. */
export class Crawler {
  readonly #deps: CrawlerDeps;
  readonly #robots = new Map<string, Promise<RobotsRules>>();

  constructor(deps: CrawlerDeps) {
    this.#deps = deps;
  }

  /** Walk the site as the plan says. Throws only when the run is cancelled; a page that fails is left out. */
  async run(plan: CrawlPlan): Promise<CrawlReport> {
    const site = domainOf(plan.start);
    const skipped = new Map<string, CrawlSkip>();
    const seen = new Set<string>([plan.start.href]);
    const skip: Skip = (url, reason, detail) => {
      const key = typeof url === 'string' ? url : url.href;
      if (!skipped.has(key)) { skipped.set(key, { url: redactUrl(url), reason, ...(detail === undefined ? {} : { detail }) }); }
    };
    // every page the graph reads is held for the hub and imported at once, while the walk goes on
    const imports: Array<Promise<{ depth: number; kept: CrawlKept } | undefined>> = [];
    const keptUrls = new Set<string>();
    let kept = 0;
    const { registry, options } = this.#deps.pages.crawling(plan.fetch, this.#deps.signal, (url) => this.#check(url, plan.fetch));

    let graph: ResourceGraph;
    try {
      graph = await buildResourceGraph(registry, plan.start.href, {
        ...options,
        maxDepth: plan.depth,
        maxResources: plan.maxPages,
        concurrency: this.#deps.concurrency,
        followChildren: false,
        // the site rule is by registrable domain (subdomains count), so it is checked here, not by origin in the graph
        followExternal: true,
        sameOrigin: false,
        keepBytes: true,
        shouldFollow: (link, from) => {
          // only an html page's anchors are pages to follow, and never a nofollow one
          const facts = linkFacts(link);
          if (from.type !== 'html' || facts?.tag !== 'a' || facts.rel?.includes('nofollow') === true) { return false; }
          const url = webUrlOf(link, from.location);
          if (url === undefined || seen.has(url.href) || seen.size >= this.#deps.maxLinks) { return false; }
          seen.add(url.href);
          const reason = this.#leaveOut(url, plan, site);
          if (reason !== undefined) { skip(url, reason); }
          return reason === undefined;
        },
        onNode: (node) => {
          const page = this.#pageOf(node);
          if (page === undefined || keptUrls.has(page.finalUrl)) { return; }
          keptUrls.add(page.finalUrl).add(page.requestedUrl);
          this.#deps.held.put(page);
          imports.push(this.#import(page, plan.folder, node.depth).then((answer) => {
            if ('problem' in answer) { skip(page.requestedUrl, 'failed', answer.problem); return undefined; }
            kept += 1;
            this.#deps.progress(kept / plan.maxPages, `Kept ${kept} of up to ${plan.maxPages}: ${answer.kept.title}`);
            return { depth: node.depth, kept: answer.kept };
          }));
        },
      });
    } catch (error) {
      // the start page itself failed, so the crawl keeps nothing
      if (this.#deps.signal.aborted || !(error instanceof Error) || isAbort(error)) { throw error; }
      await Promise.allSettled(imports);
      const robots = error.message.includes(ROBOTS_REFUSAL);
      skip(plan.start, robots ? 'robots' : 'failed', robots ? undefined : error.message);
      return { pages: [], skipped: [...skipped.values()] };
    }
    const settled = await Promise.all(imports);
    for (const node of graph.nodes.values()) {
      for (const edge of node.edges) { this.#edgeSkip(edge, node, skip); }
    }
    // in the order the walk reached them: by depth, then as the graph met them
    const pages = settled.flatMap((entry) => (entry === undefined ? [] : [entry])).sort((a, b) => a.depth - b.depth).map((entry) => entry.kept);
    return { pages, skipped: [...skipped.values()] };
  }

  /** Why a link the graph didn't load was left out, for the limit and failures (links the crawl chose not to follow are said already). */
  #edgeSkip(edge: ResourceGraphEdge, from: ResourceGraphNode, skip: Skip): void {
    if (edge.loaded) { return; }
    const url = webUrlOf(edge.link, from.location);
    if (url === undefined) { return; }
    if (edge.reason === 'max-resources') { skip(url, 'limit'); return; }
    if (edge.reason === 'error') {
      const robots = edge.error?.includes(ROBOTS_REFUSAL) === true;
      skip(url, robots ? 'robots' : 'failed', robots ? undefined : edge.error);
    }
  }

  #leaveOut(link: URL, plan: CrawlPlan, site: string): CrawlSkipReason | undefined {
    if (plan.sameSite && domainOf(link) !== site) { return 'other-site'; }
    const extension = /\.([a-z0-9]+)$/i.exec(link.pathname)?.[1]?.toLowerCase();
    if (extension !== undefined && NOT_PAGES.has(extension)) { return 'not-a-page'; }
    if (plan.exclude.some((glob) => globMatches(glob, link))) { return 'excluded'; }
    if (plan.include.length > 0 && !plan.include.some((glob) => globMatches(glob, link))) { return 'not-included'; }
    return undefined;
  }

  /** A graph node as a fetched page, from the bytes and fetch facts it carries; `undefined` for a node that wasn't fetched. */
  #pageOf(node: ResourceGraphNode): FetchedPage | undefined {
    const fetched = node.fetch;
    const bytes = node.bytes;
    if (fetched === undefined || bytes === undefined) { return undefined; }
    return {
      bytes,
      mime: node.resource.mimeType ?? 'application/octet-stream',
      type: node.type,
      requestedUrl: withoutFragment(fetched.requestedUrl),
      finalUrl: withoutFragment(fetched.url),
      status: fetched.status,
      rendered: fetched.rendered,
      renderError: fetched.renderError,
      title: titleFor(node.type, bytes, fetched.url),
    };
  }

  async #import(page: FetchedPage, folder: string, depth: number): Promise<{ kept: CrawlKept } | { problem: string }> {
    try {
      const imported = await this.#deps.importPage(page.requestedUrl, folder);
      return { kept: { url: redactUrl(page.finalUrl), uri: imported.uri, title: imported.title, depth } };
    } catch (error) {
      if (this.#deps.signal.aborted || isAbort(error) || !(error instanceof Error) || (error instanceof CallFailed && error.error.class === 'cancelled')) { throw error; }
      return { problem: error.message };
    } finally {
      // the hub has fetched it back by now, or never will
      this.#deps.held.take(page.requestedUrl);
    }
  }

  /** Refuse a request robots.txt disallows (robots.txt itself is always allowed). */
  async #check(url: URL, settings: FetchSettings): Promise<void> {
    if (url.pathname === '/robots.txt') { return; }
    if (!(await this.#rules(url, settings)).allows(url)) { throw new WebProblem('robots', `${redactUrl(url)} ${ROBOTS_REFUSAL}.`); }
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
