/**
 * The web system's tunables, an `@ayepi/env` slice. The config the admin sets in the hub (`web.defs.config`) wins over
 * these for the fields it has. Durations are milliseconds.
 */
import { env } from '@ayepi/env';
import { systemFields, systemState } from '@harness/sdk/server';
import { z } from 'zod';
import { READ_CHARS_MAX, RENDER_MODES, SEARCH_LIMIT_MAX } from '../shared/index.ts';

export const webEnv = env({
  ...systemFields(),
  /** The Tavily API key, used when the system's config names none. */
  TAVILY_API_KEY: z.string().min(1).optional(),
  /** Tavily's API. */
  WEB_TAVILY_URL: z.string().default('https://api.tavily.com'),
  /** What one Tavily credit costs, in USD; a basic search uses one, an advanced one two. Reported to the run's budget. */
  WEB_TAVILY_CREDIT: z.number().min(0).default(0.008),
  /** How long one search may take. */
  WEB_SEARCH_TIMEOUT: z.number().int().min(1_000).default(30_000),
  /** Results per search when the caller asks for no number. */
  WEB_SEARCH_LIMIT: z.number().int().min(1).max(SEARCH_LIMIT_MAX).default(5),
  /** The longest snippet a search result keeps, in characters. */
  WEB_SNIPPET_CHARS: z.number().int().min(80).default(600),
  /** When fetched html runs in the headless browser first, unless the config or the call says. */
  WEB_RENDER: z.enum(RENDER_MODES).default('auto'),
  /** Fetch private, loopback and link-local addresses, unless the config says. */
  WEB_ALLOW_PRIVATE: z.boolean().default(false),
  /** The most bytes downloaded per page, unless the config says. */
  WEB_MAX_BYTES: z.number().int().min(1_024).default(20 * 1024 * 1024),
  /** How long one page fetch may take (headers and body), unless the config says. */
  WEB_TIMEOUT: z.number().int().min(1_000).default(30_000),
  /** The most redirects one fetch follows. */
  WEB_REDIRECTS: z.number().int().min(0).max(30).default(10),
  /** The User-Agent pages are fetched with. */
  WEB_USER_AGENT: z.string().default('Mozilla/5.0 (compatible; harness-web/1.0; +https://github.com/ClickerMonkey/harness)'),
  /** Characters `web/read` returns when the caller asks for no number. */
  WEB_READ_CHARS: z.number().int().min(1).max(READ_CHARS_MAX).default(12_000),
  /** Pages rendered at once; more wait their turn. */
  WEB_RENDER_CONCURRENCY: z.number().int().min(1).max(16).default(2),
  /** How long the browser may take to load a page's document. */
  WEB_RENDER_TIMEOUT: z.number().int().min(1_000).default(20_000),
  /** How long to wait for the page's network to go quiet after it loaded; the page is taken as it is then. */
  WEB_RENDER_IDLE: z.number().int().min(0).default(5_000),
  /** The Chrome to render with; puppeteer's own when absent. */
  WEB_CHROME: z.string().min(1).optional(),
  /** The most options one `@` search for pages shows. */
  WEB_MENTION_LIMIT: z.number().int().min(1).default(10),
  /** Recently read pages the `@` mention offers. */
  WEB_RECENT_PAGES: z.number().int().min(0).default(50),
}).add(systemState('web'));

/** The web system's settings, resolved. */
export type WebSettings = ReturnType<typeof webEnv.parse>;
