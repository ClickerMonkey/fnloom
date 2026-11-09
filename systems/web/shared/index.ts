/**
 * The web system's contract (`shared/`): Tavily search, and web pages read into hub resources. `web/read` imports a
 * page through the hub (`hub/resource_import`), which fetches it back through `web/fetch_raw` (this system: type
 * detection, redirects, a byte cap, and script-built pages rendered in a headless browser), keeps the raw content and
 * converts it to markdown; `web/read` then reads that clean form (`hub/resource_read`). Other systems import this to
 * call its fns with typed refs; its server implements it and its client draws it.
 */
import type { RenderMode as LibraryRenderMode } from '@aeye/resources';
import { RawPage as CoreRawPage } from '@harness/core';
import { type Infer, type ValueOf, context, fn, g, ginAs, hub, linear, mention, system, type } from '@harness/sdk';

const renderModes = ['auto', 'always', 'never'] as const satisfies readonly LibraryRenderMode[];
/**
 * When a fetched html page is run in the headless browser first: only when it looks script-built (`auto`), always, or
 * never. These are `@aeye/resources`' modes exactly: a mode added there fails to compile here until it is listed.
 */
export const RENDER_MODES: [LibraryRenderMode] extends [(typeof renderModes)[number]] ? typeof renderModes : never = renderModes;
export const RenderMode = g.enum(RENDER_MODES);

/** Which Tavily search depth: `basic` is fast and cheap, `advanced` digs further for better snippets. */
export const SEARCH_DEPTHS = ['basic', 'advanced'] as const;
/** What a search looks through: the general web, or recent news. */
export const SEARCH_TOPICS = ['general', 'news'] as const;

/** Most results one search returns. */
export const SEARCH_LIMIT_MAX = 20;
/** Most characters one read returns (the hub's read limit). */
export const READ_CHARS_MAX = 200_000;

/** Most link levels one crawl follows from its start page. */
export const CRAWL_DEPTH_MAX = 3;
/** Pages one crawl reads when the caller asks for no number. */
export const CRAWL_PAGES_DEFAULT = 25;

/** Why a crawl left a page out. */
export const CRAWL_SKIP_REASONS = ['robots', 'excluded', 'not-included', 'other-site', 'not-a-page', 'failed', 'limit'] as const;

/** A page a crawl kept, as a hub resource. */
export const CrawledPage = g.obj({ url: g.text(), uri: g.text(), title: g.text(), depth: g.num({ min: 0, whole: true }) });

/** A page a crawl left out, and why. */
export const SkippedPage = g.obj({
  url: g.text(),
  reason: g.enum(CRAWL_SKIP_REASONS),
  /** What went wrong, for `failed`. */
  detail: g.optional(g.text()),
});

/** What `web/crawl` gives: the root every page is kept under, the pages, and what was left out. */
export const CrawlResult = g.obj({
  /** The resource folder this crawl's pages are under: browse, search or make context from it. */
  root: g.text(),
  /** How many pages were kept. */
  count: g.num({ min: 0, whole: true }),
  pages: g.list(CrawledPage),
  /** Pages left out, up to the system's list limit; `moreSkipped` counts the rest. */
  skipped: g.list(SkippedPage),
  moreSkipped: g.num({ min: 0, whole: true }),
});

/** A web page: where it is and what it is called. */
export const Page = type({
  description: 'A web page: its URL, its title and the site it is on.',
  shape: g.obj({
    url: g.text({ minLength: 1 }),
    title: g.text(),
    domain: g.text(),
  }),
  display: { label: 'Web page', plural: 'Web pages', icon: 'globe', color: '#3b82f6', title: 'title', subtitle: 'domain' },
});

/** One search result. */
export const SearchHit = g.obj({
  title: g.text(),
  url: g.text(),
  /** The part of the page that matched, cleaned and cut short. */
  snippet: g.text(),
  /** How well it matched, 0 to 1. */
  score: g.num({ min: 0 }),
  /** When it was published, as the source states it (news mostly). */
  published: g.optional(g.text()),
});

/** What a search gives: Tavily's short answer when asked, and the results, best first. */
export const SearchResults = g.obj({
  answer: g.optional(g.text()),
  results: g.list(SearchHit),
});

/** What `web/read` gives: the page as a hub resource, and its clean text. */
export const ReadResult = g.obj({
  /** The hub resource the page was kept as. */
  uri: g.text(),
  title: g.text(),
  /** Where the page ended up after redirects. */
  finalUrl: g.text(),
  /** The page's markdown (or the text of its primary form), up to the asked length. */
  text: g.text(),
  truncated: g.bool(),
  /** Whether the page was run in the headless browser before it was read. */
  rendered: g.bool(),
});

/** What `web/fetch_raw` gives the hub: core's `RawPage`, the shape the hub reads the result with. */
export const RawPage = ginAs(CoreRawPage);

/** The pages mention's target: a URL. */
export const PageTarget = g.obj({ url: g.text({ minLength: 1 }) });

const url = () => g.field(g.text({ minLength: 1 }), { docs: 'An http or https URL. A bare address like `example.com/docs` is read as https.' });

/** The web system's contract. */
export const web = system('web', { description: 'Search the web and read web pages, which are kept as hub resources.' })
  .with({
    // every field is optional: an absent one takes the system's own setting (its environment)
    config: g.obj({
      tavilyKey: g.field(g.optional(g.text({ minLength: 1 })), { docs: 'The Tavily API key. Leave empty to use the system\'s `TAVILY_API_KEY`.' }),
      render: g.field(g.optional(RenderMode), { docs: 'When pages run in the headless browser first: `auto` (pages that look script-built), `always` or `never`.' }),
      allowPrivate: g.field(g.optional(g.bool()), { docs: 'Allow private, loopback and link-local addresses (your own network). Off by default.' }),
      maxBytes: g.field(g.optional(g.num({ min: 1_024, whole: true })), { docs: 'The most bytes downloaded per page.' }),
      timeout: g.field(g.optional(g.duration()), { docs: 'How long one page fetch may take.' }),
    }),
    types: { Page },
    fns: {
      search: fn({
        description: 'Search the web. Gives titles, URLs and short snippets, best first, and a short answer when there is one.',
        instructions: 'Search first, then read the one or two best pages with web/read before answering from them. Cite the URLs you used.',
        args: g.obj({
          query: g.text({ minLength: 1 }),
          limit: g.optional(g.num({ min: 1, max: SEARCH_LIMIT_MAX, whole: true })),
          depth: g.optional(g.enum(SEARCH_DEPTHS)),
          topic: g.optional(g.enum(SEARCH_TOPICS)),
          days: g.field(g.optional(g.num({ min: 1, whole: true })), { docs: 'Only results from the last this many days (news).' }),
          include: g.field(g.optional(g.list(g.text())), { docs: 'Only these domains (`example.com`).' }),
          exclude: g.field(g.optional(g.list(g.text())), { docs: 'Never these domains.' }),
        }),
        returns: SearchResults,
        status: {
          active: { one: 'Searching the web for {args.query}…', many: 'Running {n} web searches…' },
          retry: { one: 'Searching the web for {args.query} again…', many: 'Retrying {n} web searches…' },
          done: { one: 'Searched the web for {args.query}', many: 'Ran {n} web searches' },
          failed: { one: 'Searching the web for {args.query} failed', many: '{n} web searches failed' },
        },
        tags: ['read', 'web'],
      }),
      read: fn({
        description: 'Read a web page as clean markdown. The page is kept as a hub resource, so it can be read again, searched and made into context.',
        instructions: 'Give `maxChars` for long pages; read more of a kept page with hub/resource_read and its `uri` and an `offset`.',
        args: g.obj({
          url: url(),
          render: g.field(g.optional(RenderMode), { docs: 'Run the page in the headless browser first: `auto` (default), `always` or `never`.' }),
          maxChars: g.optional(g.num({ min: 1, max: READ_CHARS_MAX, whole: true })),
        }),
        returns: ReadResult,
        deps: { importResource: hub.fns.resource_import, readResource: hub.fns.resource_read },
        status: {
          active: { one: 'Reading {args.url}…', many: 'Reading {n} web pages…' },
          retry: { one: 'Reading {args.url} again…', many: 'Retrying {n} web pages…' },
          done: { one: 'Read {output.title}', many: 'Read {n} web pages' },
          failed: { one: 'Reading {args.url} failed', many: '{n} web pages could not be read' },
        },
        tags: ['read', 'web'],
      }),
      crawl: fn({
        description: 'Crawl a site from a start page: follow its links a few levels deep and keep every page as a hub resource under one folder, so the pages can be searched and made into context.',
        instructions: 'Use it when a question needs a whole site or section (docs, a blog), not one page. Keep `maxPages` small and narrow with `include` (`/docs/**`). Then search the pages under `root`, or read them with hub/resource_read. The site\'s robots.txt is respected.',
        args: g.obj({
          url: url(),
          depth: g.field(g.optional(g.num({ min: 0, max: CRAWL_DEPTH_MAX, whole: true })), { docs: 'How many links away from the start page to go: 0 is the start page only. Default 1.' }),
          sameSite: g.field(g.optional(g.bool()), { docs: 'Only follow links on the start page\'s site (default true).' }),
          maxPages: g.field(g.optional(g.num({ min: 1, whole: true })), { docs: `The most pages to keep (default ${CRAWL_PAGES_DEFAULT}; the system caps it).` }),
          include: g.field(g.optional(g.list(g.text({ minLength: 1 }))), { docs: 'Only follow links whose path matches one of these globs (`/docs/**`, `*.html`); a glob with `://` matches the whole URL.' }),
          exclude: g.field(g.optional(g.list(g.text({ minLength: 1 }))), { docs: 'Never follow links matching one of these globs.' }),
          render: g.field(g.optional(RenderMode), { docs: 'Run pages in the headless browser first: `auto` (default), `always` or `never`.' }),
        }),
        returns: CrawlResult,
        progress: linear,
        deps: { importResource: hub.fns.resource_import },
        status: {
          active: { one: 'Crawling {args.url}…', many: 'Crawling {n} sites…' },
          retry: { one: 'Crawling {args.url} again…', many: 'Retrying {n} crawls…' },
          done: { one: 'Crawled {output.count} pages from {args.url}', many: 'Crawled {n} sites' },
          failed: { one: 'Crawling {args.url} failed', many: '{n} crawls failed' },
        },
        tags: ['read', 'web'],
      }),
      fetch_raw: fn({
        description: 'Fetch a URL\'s raw content for the hub: its bytes by ref, type, final URL and status. Script-built pages are rendered first.',
        args: g.obj({ url: url(), render: g.optional(RenderMode) }),
        returns: RawPage,
        // the hub calls it while importing a URL; people and the LLM use web/read
        visibility: 'none',
        display: 'hidden',
        tags: ['read', 'web'],
      }),
    },
  })
  .with(({ fns, types }) => ({
    mentions: {
      pages: mention({ title: 'Web pages', description: 'A URL you type, or a page read recently.', target: PageTarget, of: types.Page }),
    },
    context: {
      guide: context({
        description: 'How to use the web: search, read the best pages, cite them.',
        content: [
          'Use web/search to find pages, then web/read the one or two that answer best; snippets alone are often out of context.',
          'Answer from what the pages say, and cite each URL you used.',
          'A page you read is kept as a hub resource: read more of it with hub/resource_read and its uri instead of reading the URL again.',
          'For a whole site or section, web/crawl keeps its pages under one folder; search them rather than reading each one.',
        ].join(' '),
        fns: [fns.search, fns.read, fns.crawl],
        tags: ['web'],
      }),
    },
  }));

/** The web contract's type. */
export type WebContract = typeof web;

/** The web system's config. */
export type WebConfigValue = Infer<WebContract['defs']['config']>;
/** A render mode. */
export type RenderModeValue = Infer<typeof RenderMode>;
/** One search result. */
export type SearchHitValue = Infer<typeof SearchHit>;
/** What a search gives. */
export type SearchResultsValue = Infer<typeof SearchResults>;
/** What `web/read` gives. */
export type ReadResultValue = Infer<typeof ReadResult>;
/** What `web/crawl` gives. */
export type CrawlResultValue = Infer<typeof CrawlResult>;
/** A page a crawl left out. */
export type SkippedPageValue = Infer<typeof SkippedPage>;
/** Why a crawl left a page out. */
export type CrawlSkipReason = (typeof CRAWL_SKIP_REASONS)[number];
/** What `web/fetch_raw` gives. */
export type RawPageValue = Infer<typeof RawPage>;
/** A web page. */
export type PageValue = ValueOf<typeof Page>;
/** The pages mention's target. */
export type PageTargetValue = Infer<typeof PageTarget>;
