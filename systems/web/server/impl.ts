/**
 * The web system's implementation: every fn, mention and lifecycle event the contract declares, wired to the
 * server's parts. `createWebImpl` takes every seam (the search provider, the page source, the uploads, the renderers
 * and the clock), so tests run it with fakes and no network.
 */
import { ResourceReadResult, ResourceRecord, type InputProblem, type ResourceImportArgs, type ResourceReadArgs } from '@harness/core';
import { CallFailed, type FnCtx, type FnTypes, type Outcome, type SystemImpl } from '@harness/sdk';
import { CRAWL_PAGES_DEFAULT, type PageTargetValue, type RenderModeValue, type WebContract } from '../shared/index.ts';
import { parseWebUrl, redactUrl } from '../shared/urls.ts';
import { searchPage } from './searches.ts';
import { Crawler, FetchedPages, crawlFolder, crawlRoot } from './crawl.ts';
import type { WebSettings } from './env.ts';
import type { ContentUploads, FetchSettings, PageSource, SearchArgs, SearchProvider, WebConfig } from './index.ts';
import { PageMentions } from './mentions.ts';
import { WebProblem } from './problem.ts';
import type { Renderers } from './renderer.ts';

/** Everything the implementation is built from. */
export interface WebDeps {
  readonly settings: WebSettings;
  readonly search: SearchProvider;
  readonly pages: PageSource;
  readonly uploads: ContentUploads;
  readonly renderers: Renderers;
  readonly now: () => number;
}

/** The implementation and the parts tests and `main` reach into. */
export interface WebServer {
  readonly impl: SystemImpl<WebContract['defs']>;
  /** Pages crawls fetched, waiting for the hub to fetch them back. */
  readonly held: FetchedPages;
}

/** Tavily credits a search uses: one for a basic search, two for an advanced one. */
export function searchCredits(depth: SearchArgs['depth']): number {
  return depth === 'advanced' ? 2 : 1;
}

/** The `invalid-input` problem for a URL arg that isn't a web address: the caller (often the LLM) fixes it and retries. */
export function urlProblem(url: string): InputProblem {
  return { path: 'url', message: `"${url}" isn't an http or https URL; give one like https://example.com/page.` };
}

/** How a fetch behaves: the call's render mode, then the config's values, then the system's settings. */
export function fetchSettings(config: WebConfig, settings: WebSettings, render: RenderModeValue | undefined): FetchSettings {
  return {
    render: render ?? config.render ?? settings.WEB_RENDER,
    allowPrivate: config.allowPrivate ?? settings.WEB_ALLOW_PRIVATE,
    maxBytes: config.maxBytes ?? settings.WEB_MAX_BYTES,
    timeout: config.timeout ?? settings.WEB_TIMEOUT,
  };
}

/** What a failed page read adds to its error: nothing from the page is confirmed, and what to do instead. */
export const READ_FAILED_NOTE = 'The page was not read, so nothing it says is confirmed (a search snippet of it is not either): try the next result, or render: "always" for a page built by scripts.';

/** What a page that read empty says. */
export const READ_EMPTY_NOTE = 'The page read empty, so nothing it says is confirmed: it may be built by scripts (read it again with render: "always") or have no text; try the next result.';

/**
 * Run fn code, turning a `WebProblem` into a failure of its class with its code, a failed hub call into the same
 * failure, and an abort of the run's own signal into a cancel. `after` is added to a failure's message (what a
 * failed read means and what to do instead).
 */
async function attempt<T extends FnTypes>(ctx: Pick<FnCtx<T, WebConfig>, 'fail' | 'cancelled' | 'signal'>, work: () => Promise<Outcome<T>>, after?: string): Promise<Outcome<T>> {
  const said = (message: string): string => (after === undefined ? message : `${message} ${after}`);
  try {
    return await work();
  } catch (error) {
    if (error instanceof WebProblem) { return ctx.fail(error.errorClass, said(error.message), { code: error.code }); }
    if (error instanceof CallFailed) {
      if (error.error.class === 'cancelled') { return ctx.cancelled(); }
      return ctx.fail(error.error.class, said(error.error.message), error.error.code === undefined ? {} : { code: error.error.code });
    }
    if (ctx.signal.aborted) { return ctx.cancelled(); }
    throw error;
  }
}

/** Build the web implementation. */
export function createWebImpl(deps: WebDeps): WebServer {
  const s = deps.settings;
  const mentions = new PageMentions(s.WEB_MENTION_LIMIT);
  const held = new FetchedPages(s.WEB_CRAWL_CACHE_TTL, deps.now);

  const impl: SystemImpl<WebContract['defs']> = {
    fns: {
      search: {
        run: (args, ctx) => attempt(ctx, async () => {
          const results = await deps.search.search(args, { key: ctx.config.tavilyKey ?? s.TAVILY_API_KEY, signal: ctx.signal });
          const credits = searchCredits(args.depth);
          ctx.budget.spend(credits * s.WEB_TAVILY_CREDIT, `Tavily search (${credits} ${credits === 1 ? 'credit' : 'credits'})`);
          // the results are kept as a hub resource, so they can be read again, searched and made into context
          const page = searchPage(args.query, results, new Date(deps.now()).toISOString());
          const content = await deps.uploads.upload(ctx.signal, new TextEncoder().encode(page.markdown), 'text/markdown');
          const importing: ResourceImportArgs = { content, name: page.name };
          const record = ResourceRecord.parse(await ctx.fns.importResource(importing));
          ctx.log.info('web.search.done', { results: results.results.length, depth: args.depth ?? 'basic', topic: args.topic ?? 'general', answer: results.answer !== undefined, uri: record.uri });
          return ctx.done({ ...results, uri: record.uri });
        }),
      },
      fetch_raw: {
        run: (args, ctx) => attempt(ctx, async () => {
          if (parseWebUrl(args.url) === undefined) { return ctx.invalid([urlProblem(args.url)]); }
          const started = deps.now();
          const page = held.take(parseWebUrl(args.url)?.href ?? args.url) ?? await deps.pages.fetch(args.url, fetchSettings(ctx.config, s, args.render), ctx.signal);
          const content = await deps.uploads.upload(ctx.signal, page.bytes, page.mime);
          ctx.log.info('web.fetch.done', {
            url: redactUrl(page.finalUrl), status: page.status, mime: page.mime, bytes: page.bytes.byteLength, rendered: page.rendered,
            took: deps.now() - started, ...(page.renderError === undefined ? {} : { renderError: page.renderError }),
          });
          return ctx.done({ content, mime: page.mime, finalUrl: page.finalUrl, status: page.status, rendered: page.rendered, title: page.title });
        }),
      },
      crawl: {
        run: (args, ctx) => attempt(ctx, async () => {
          const start = parseWebUrl(args.url);
          if (start === undefined) { return ctx.invalid([urlProblem(args.url)]); }
          start.hash = '';
          const folder = crawlFolder(start, deps.now());
          const maxPages = Math.min(args.maxPages ?? CRAWL_PAGES_DEFAULT, s.WEB_CRAWL_MAX_PAGES);
          const crawler = new Crawler({
            pages: deps.pages,
            held,
            importPage: async (url, into) => {
              const importing: ResourceImportArgs = { url, folder: into, ...(args.render === undefined ? {} : { render: args.render }) };
              const record = ResourceRecord.parse(await ctx.fns.importResource(importing));
              return { uri: record.uri, title: record.stat.name };
            },
            agent: s.WEB_ROBOTS_AGENT,
            maxLinks: s.WEB_CRAWL_MAX_LINKS,
            concurrency: s.WEB_CRAWL_CONCURRENCY,
            progress: (fraction, message) => { ctx.progress.set(Math.min(1, fraction), message); },
            signal: ctx.signal,
          });
          const report = await crawler.run({
            start, folder, maxPages,
            depth: args.depth ?? 1,
            sameSite: args.sameSite ?? true,
            include: args.include ?? [],
            exclude: args.exclude ?? [],
            fetch: fetchSettings(ctx.config, s, args.render),
          });
          const root = crawlRoot(report.pages.map((page) => page.uri), folder);
          const shown = report.skipped.slice(0, s.WEB_CRAWL_SKIPPED_SHOWN);
          ctx.log.info('web.crawl.done', { url: redactUrl(start), root, pages: report.pages.length, skipped: report.skipped.length });
          return ctx.done({ root, count: report.pages.length, pages: [...report.pages], skipped: shown, moreSkipped: report.skipped.length - shown.length, fetched: [...report.fetched] });
        }),
      },
      read: {
        run: (args, ctx) => attempt(ctx, async () => {
          const url = parseWebUrl(args.url);
          if (url === undefined) { return ctx.invalid([urlProblem(args.url)]); }
          // fetched here, so the run says every URL that went out (redirects too), and held for the hub's import to take
          // back through fetch_raw, as a crawl's pages are
          const page = await deps.pages.fetch(url.href, fetchSettings(ctx.config, s, args.render), ctx.signal);
          held.put(page);
          // the hub fns' args and results are the web endpoints' bodies and responses, so core's schemas check both; an
          // import's body is a union, which tool args carry as `input`
          const importing: ResourceImportArgs = { url: page.requestedUrl, ...(args.render === undefined ? {} : { render: args.render }) };
          const record = ResourceRecord.parse(await ctx.fns.importResource(importing));
          const reading: ResourceReadArgs = { uri: record.uri, maxChars: args.maxChars ?? s.WEB_READ_CHARS };
          const read = ResourceReadResult.parse(await ctx.fns.readResource(reading));
          const source = record.source?.from === 'web' ? record.source : undefined;
          const finalUrl = source?.finalUrl ?? source?.url ?? url.href;
          const rendered = source?.rendered ?? false;
          ctx.log.info('web.read.done', { url: redactUrl(finalUrl), uri: record.uri, chars: read.text.length, truncated: read.truncated, rendered });
          const note = read.total === 0 ? READ_EMPTY_NOTE : read.note;
          return ctx.done({
            uri: record.uri, title: record.stat.name, finalUrl, text: read.text, truncated: read.truncated, ...(read.partial === undefined ? {} : { partial: read.partial }),
            ...(note === undefined ? {} : { note }), rendered, fetched: [...page.fetched],
          });
        }, READ_FAILED_NOTE),
      },
    },
    mentions: {
      pages: {
        search: (query, ctx) => mentions.search(query, ctx),
        hover: (target: PageTargetValue, ctx) => mentions.hover(target, ctx),
        llm: (target: PageTargetValue) => mentions.llm(target),
      },
    },
    lifecycle: {
      started: (ctx) => {
        ctx.log.info('web.started', { search: (ctx.config.tavilyKey ?? s.TAVILY_API_KEY) !== undefined, render: ctx.config.render ?? s.WEB_RENDER });
        return Promise.resolve();
      },
      configured: (ctx) => {
        ctx.log.info('web.configured', { search: (ctx.config.tavilyKey ?? s.TAVILY_API_KEY) !== undefined, render: ctx.config.render ?? s.WEB_RENDER });
        return Promise.resolve();
      },
      stopping: async (ctx) => {
        ctx.log.info('web.stopping', { reason: ctx.reason });
        await deps.renderers.close();
      },
    },
  };
  return { impl, held };
}
