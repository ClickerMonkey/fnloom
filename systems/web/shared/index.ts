/**
 * The web system's contract (`shared/`): Tavily search, and web pages read into hub resources. `web/read` imports a
 * page through the hub (`hub/resource_import`), which fetches it back through `web/fetch_raw` (this system: type
 * detection, redirects, a byte cap, and script-built pages rendered in a headless browser), keeps the raw content and
 * converts it to markdown; `web/read` then reads that clean form (`hub/resource_read`). Other systems import this to
 * call its fns with typed refs; its server implements it and its client draws it.
 */
import type { RenderMode as LibraryRenderMode } from '@aeye/resources';
import { RawPage as CoreRawPage, type FnEffects } from '@harness/core';
import { type Infer, type ValueOf, agents, context, fn, g, ginAs, hub, linear, mention, system, type } from '@harness/sdk';

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
  /** Every URL the crawl requested, robots.txt and redirects included (credentials redacted), shown on the run. */
  fetched: g.list(g.text()),
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
  /** The part of the page that matched, cleaned and cut short: a cut one ends with how much was cut. */
  snippet: g.text(),
  /** How well it matched, 0 to 1. */
  score: g.num({ min: 0 }),
  /** When it was published, as the source states it (news mostly). */
  published: g.optional(g.text()),
});

/** What a search provider finds: Tavily's short answer when asked, and the results, best first. */
export const SearchFound = g.obj({
  answer: g.optional(g.text()),
  results: g.list(SearchHit),
});

/** What `web/search` gives: what was found, and the hub resource the results are kept as. */
export const SearchResults = g.obj({
  answer: g.optional(g.text()),
  results: g.list(SearchHit),
  uri: g.field(g.text(), { docs: 'The hub resource the results are kept as: read it again with hub/resource_read, or search it later.' }),
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
  /** When `truncated`: what part is here, how much was left out and how to read the rest. */
  partial: g.optional(g.text()),
  /** When the page read empty, or was read in another form than its primary one: what that means. */
  note: g.optional(g.text()),
  /** Whether the page was run in the headless browser before it was read. */
  rendered: g.bool(),
  /** Every URL requested for it, redirects included (credentials redacted), shown on the run. */
  fetched: g.list(g.text()),
});

/** What `web/fetch_raw` gives the hub: core's `RawPage`, the shape the hub reads the result with. */
export const RawPage = ginAs(CoreRawPage);

/** The pages mention's target: a URL the person typed (not read yet), or a page the hub keeps (its resource and title). */
export const PageTarget = g.or([
  g.obj({ url: g.field(g.text({ minLength: 1 }), { docs: 'A URL the person typed, not read yet.' }) }),
  g.obj({
    uri: g.field(g.text({ minLength: 1 }), { docs: 'The hub resource a kept page is (`hub://resources/web/…`).' }),
    title: g.field(g.optional(g.text()), { docs: "The kept page's title." }),
  }),
]);

/**
 * What search, read and crawl do to data: they read, and keep what they read as hub resources (`hub/resource_import`).
 * Keeping it is a read side effect (Phil, 2026-11-22): it changes nothing the person owns, so they stay reads for
 * read-only searches and chats, and the resource creation is still listed in their facts.
 */
const KEEPS_WHAT_IT_READS: FnEffects = { mode: 'read', keeps: ['resources'] };

const url = () => g.field(g.text({ minLength: 1 }), { docs: 'An http or https URL. A bare address like `example.com/docs` is read as https.' });

/** The web system's contract. */
export const web = system('web', {
  description: 'Search the web and read web pages, which are kept as hub resources.',
  about: [
    'The public web: finding pages and reading them. web/search finds pages for a query and gives titles, URLs and short snippets (a snippet is a fragment, not enough evidence for a detail such as a time, a price or a date); web/read reads one page as clean text; web/crawl reads a whole site section.',
    'Every page it reads is kept as a hub resource, so it can be read again (hub/resource_read) without fetching it twice. It defines no fn kinds.',
    'Reach for it for anything current or outside what you know (news, opening hours, timetables, prices, reviews): search first, read the best one or two pages, and answer from what they say, with their URLs.',
    'Not for a web API that needs a sign-in or returns data (that is the api system), and not for files on the person\'s machine (fs). Load its guide (web/guide) before the first search.',
  ].join(' '),
  // its API groups: the hub indexes its fns by them (`web/api`, `web/api.<group>`)
  groups: [
    { name: 'search', title: 'Search', description: 'Search the web; the results are kept as a hub resource.' },
    { name: 'pages', title: 'Pages', description: 'Read one page, crawl a site, or fetch a page raw; every page is kept as a hub resource.' },
  ],
  // pages it reads are uploaded and kept as hub resources
  // any host: it searches (Tavily) and reads whatever page it is given; the supervisor enforces this once it is installed
  grants: { hub: ['resources', 'fns'], calls: ['hub/resource_import', 'hub/resource_read'], network: ['*'] },
})
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
        group: 'search',
        description: 'Search the web for pages. Gives titles, URLs and short snippets, best first, and a short answer when there is one.',
        instructions: [
          'Use it to find pages about anything current or outside what you know. It finds pages; it does not read them. A snippet or the short answer is a fragment of a page, often old or out of context: before you state a detail that matters (a time, a date, a price, an address, a route, an event\'s schedule), read the page it came from with web/read and check it there. Prefer the official source (the venue, the operator, the government site) over aggregators.',
          'Write the query as a search engine wants it (a few key words, names in full), not a question to a person. Use `topic: "news"` with `days` for recent events, `include` to keep to sites you trust, and `depth: "advanced"` only when basic results miss (it costs twice as much).',
          'The results are kept as a hub resource (`uri`). Cite the URLs you used, and say which details you could not confirm on a page.',
        ].join(' '),
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
        deps: { importResource: hub.fns.resource_import },
        examples: [
          {
            args: { query: 'Lisbon tram 28 timetable', limit: 5 },
            result: { results: [{ title: 'Tram 28 - Carris', url: 'https://www.carris.pt/en/tram-28', snippet: 'Tram 28 runs every 10 to 15 minutes from 7am…', score: 0.91 }], uri: 'hub://resources/searches/lisbon-tram-28-timetable' },
          },
          { args: { query: 'EU AI Act enforcement', topic: 'news', days: 7 }, note: 'This week\'s news.' },
          { args: { query: 'vue 3 defineModel', include: ['vuejs.org'] }, note: 'Only the official docs.' },
        ],
        effects: KEEPS_WHAT_IT_READS,
        status: {
          active: { one: 'Searching the web for {args.query}…', many: 'Running {n} web searches…' },
          retry: { one: 'Searching the web for {args.query} again…', many: 'Retrying {n} web searches…' },
          done: { one: 'Searched the web for {args.query}', many: 'Ran {n} web searches' },
          failed: { one: 'Searching the web for {args.query} failed', many: '{n} web searches failed' },
        },
        tags: ['read', 'web'],
      }),
      read: fn({
        group: 'pages',
        description: 'Read one web page by its URL as clean markdown (its main text, no menus or ads). Gives the title, the text, the final URL and whether it was cut; the page is kept as a hub resource, so it can be read again, searched and made into context.',
        instructions: [
          'Use it on a URL from web/search, from the person or from another page, to check what the page really says before you answer from it. When a page can\'t be read (an error, an empty page), say so and try the next result, or `render: "always"`; don\'t present a snippet as if you had read the page.',
          'It does not search: to find pages, use web/search first. The page is cleaned to its main text (no menus or ads) and kept as a hub resource (`uri`), so read more of it later with hub/resource_read and an `offset` instead of reading the URL again.',
          'Give `maxChars` for long pages. When `truncated`, `partial` says how much was left out and how to read the rest: read on before you state anything the page may say past the part you read. Pages built by scripts are run in a headless browser first (`render: "auto"`); use `always` when a page reads empty. Cite `finalUrl`.',
        ].join(' '),
        args: g.obj({
          url: url(),
          render: g.field(g.optional(RenderMode), { docs: 'Run the page in the headless browser first: `auto` (default), `always` or `never`.' }),
          maxChars: g.optional(g.num({ min: 1, max: READ_CHARS_MAX, whole: true })),
        }),
        returns: ReadResult,
        deps: { importResource: hub.fns.resource_import, readResource: hub.fns.resource_read },
        examples: [
          { args: { url: 'https://vuejs.org/guide/components/v-model.html', maxChars: 8000 } },
          { args: { url: 'example.com/pricing', render: 'always' }, note: 'A bare address is read as https; a script-built page is rendered first.' },
        ],
        effects: KEEPS_WHAT_IT_READS,
        status: {
          active: { one: 'Reading {args.url}…', many: 'Reading {n} web pages…' },
          retry: { one: 'Reading {args.url} again…', many: 'Retrying {n} web pages…' },
          done: { one: 'Read {output.title}', many: 'Read {n} web pages' },
          failed: { one: 'Reading {args.url} failed', many: '{n} web pages could not be read' },
        },
        tags: ['read', 'web'],
      }),
      crawl: fn({
        group: 'pages',
        description: 'Crawl a site from a start page: follow its links a few levels deep and keep every page as a hub resource under one folder, so the pages can be searched and made into context. Gives the folder (`root`), how many pages it kept and those it skipped.',
        instructions: 'Use it when a question needs a whole site or section (a manual, a docs site, a blog), not one page; for one page use web/read. Keep `maxPages` small and narrow with `include` (`/docs/**`); `depth` 1 is the start page and the pages it links to. Then search the pages under `root` with hub/search_resources, or read them with hub/resource_read. The site\'s robots.txt is respected, and only links (not images or scripts) are followed.',
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
        examples: [
          { args: { url: 'https://docs.example.com/', depth: 2, maxPages: 30, include: ['/guide/**'] }, note: 'One section of a docs site.' },
          { args: { url: 'https://blog.example.com/2026/', depth: 1, maxPages: 10 } },
        ],
        effects: KEEPS_WHAT_IT_READS,
        status: {
          active: { one: 'Crawling {args.url}…', many: 'Crawling {n} sites…' },
          retry: { one: 'Crawling {args.url} again…', many: 'Retrying {n} crawls…' },
          done: { one: 'Crawled {output.count} pages from {args.url}', many: 'Crawled {n} sites' },
          failed: { one: 'Crawling {args.url} failed', many: '{n} crawls failed' },
        },
        tags: ['read', 'web'],
      }),
      fetch_raw: fn({
        group: 'pages',
        description: 'Fetch a URL\'s raw content for the hub: its bytes by ref, type, final URL and status. Script-built pages are rendered first. Not for finding or reading pages.',
        instructions: 'The hub calls it while importing a URL as a resource. To find pages use web/search; to read one use web/read. Private and loopback addresses are refused unless the config allows them.',
        examples: [{ args: { url: 'https://example.com/report.pdf' } }],
        effects: { mode: 'read' },
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
      pages: mention({ title: 'Web pages', description: 'A URL you type, or a web page the hub keeps.', target: PageTarget, of: types.Page }),
    },
    context: {
      guide: context({
        description: 'How to look things up on the web: search, read the best pages, check details on the page, cite them.',
        content: [
          'Steps for a question about something current or outside what you know:',
          '1. web/search with a few key words, as a search engine wants them (`Lisbon tram 28 timetable`, not "what time does the tram run?"). For recent news add `topic: "news"` and `days`.',
          '2. Pick the one or two best results: the official source first (the operator, the venue, the maker), then well-known references.',
          '3. web/read each of those pages. A search snippet is a fragment: it may be old or about something else. Before you state a time, date, price, address, route or schedule, find it on the page you read.',
          '4. Answer from what the pages say, with the URL of each one you used. Say plainly what you could not confirm, and what depends on the day (opening hours, traffic, prices change). Give a number (a chance, a price, a count, a time) only when a page you read gives it; never turn words such as "likely" into a number of your own.',
          'Stop once the pages you read answer the question: don\'t search again with nearly the same words, and don\'t read more pages for a fact you already have.',
          '',
          'When a page can\'t be read (an error, an empty page), say so and try the next result, or web/read again with `render: "always"` for a page built by scripts.',
          'A page you read is kept as a hub resource: read more of it with hub/resource_read and its uri instead of reading the URL again.',
          'For a whole site or section, web/crawl keeps its pages under one folder; search them with hub/search_resources rather than reading each one.',
          'The web system reads public pages. A service that needs an account or a key, or gives data rather than pages, is the api system\'s.',
        ].join('\n'),
        fns: [fns.search, fns.read, fns.crawl],
        tags: ['web'],
      }),
      // what every chat agent is told about the web, in its system prompt (plan injected-context, section 5)
      basics: context({
        title: 'The web',
        description: 'Searching the web and reading pages: they are reads; a snippet is limited evidence; check details on the page.',
        summary: 'web/search finds pages and web/read reads one (both are reads). Check a detail on the page, not the snippet, and give its URL.',
        content: [
          'web/search finds pages and gives titles, URLs and short snippets; web/read reads one page as text; web/crawl reads a site section. All three are reads: they keep the pages they fetch as resources, which doesn\'t count as a change, so a search for reads finds them and they work in a chat that allows only reads.',
          'A snippet is a fragment of a page, often old or out of context: before you state a time, date, price, address or schedule, read the page it came from and find it there. Prefer the official source. Answer with the URL of each page you used, and say what you couldn\'t confirm.',
          'For a question tied to a place or a time ("near me", "next month"): take the place from what is kept about the person (a memory in front of you, else a search of their memories), else ask; take the dates from `<local_time>`; search, then read the best one or two pages.',
          'Load web/guide before your first search.',
        ].join('\n'),
        fns: [fns.search, fns.read],
        tags: ['web'],
        inject: { into: [agents.startingWith(hub.fns.chat)] },
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
/** What a search provider finds. */
export type SearchFoundValue = Infer<typeof SearchFound>;
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
