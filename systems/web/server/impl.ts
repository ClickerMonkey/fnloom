/**
 * The web system's implementation: every fn, mention and lifecycle event the contract declares, wired to the
 * server's parts. `createWebImpl` takes every seam (the search provider, the page source, the uploads, the renderers
 * and the clock), so tests run it with fakes and no network.
 */
import { ResourceReadResult, ResourceRecord, type InputProblem, type ResourceImportArgs, type ResourceReadArgs } from '@harness/core';
import { CallFailed, type FnCtx, type FnTypes, type Outcome, type SystemImpl } from '@harness/sdk';
import type { RenderModeValue, WebContract } from '../shared/index.ts';
import { parseWebUrl, redactUrl } from '../shared/urls.ts';
import type { WebSettings } from './env.ts';
import type { ContentUploads, FetchSettings, PageSource, SearchArgs, SearchProvider, WebConfig } from './index.ts';
import { PageMentions, RecentPages } from './mentions.ts';
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
  readonly recent: RecentPages;
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

/**
 * Run fn code, turning a `WebProblem` into a failure of its class with its code, a failed hub call into the same
 * failure, and an abort of the run's own signal into a cancel.
 */
async function attempt<T extends FnTypes>(ctx: Pick<FnCtx<T, WebConfig>, 'fail' | 'cancelled' | 'signal'>, work: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof WebProblem) { return ctx.fail(error.errorClass, error.message, { code: error.code }); }
    if (error instanceof CallFailed) {
      if (error.error.class === 'cancelled') { return ctx.cancelled(); }
      return ctx.fail(error.error.class, error.error.message, error.error.code === undefined ? {} : { code: error.error.code });
    }
    if (ctx.signal.aborted) { return ctx.cancelled(); }
    throw error;
  }
}

/** Build the web implementation. */
export function createWebImpl(deps: WebDeps): WebServer {
  const s = deps.settings;
  const recent = new RecentPages(s.WEB_RECENT_PAGES);
  const mentions = new PageMentions(recent, s.WEB_MENTION_LIMIT);

  const impl: SystemImpl<WebContract['defs']> = {
    fns: {
      search: {
        run: (args, ctx) => attempt(ctx, async () => {
          const results = await deps.search.search(args, { key: ctx.config.tavilyKey ?? s.TAVILY_API_KEY, signal: ctx.signal });
          const credits = searchCredits(args.depth);
          ctx.budget.spend(credits * s.WEB_TAVILY_CREDIT, `Tavily search (${credits} ${credits === 1 ? 'credit' : 'credits'})`);
          ctx.log.info('web.search.done', { results: results.results.length, depth: args.depth ?? 'basic', topic: args.topic ?? 'general', answer: results.answer !== undefined });
          return ctx.done(results);
        }),
      },
      fetch_raw: {
        run: (args, ctx) => attempt(ctx, async () => {
          if (parseWebUrl(args.url) === undefined) { return ctx.invalid([urlProblem(args.url)]); }
          const started = deps.now();
          const page = await deps.pages.fetch(args.url, fetchSettings(ctx.config, s, args.render), ctx.signal);
          const content = await deps.uploads.upload(ctx.signal, page.bytes, page.mime);
          recent.add({ url: page.requestedUrl, finalUrl: page.finalUrl, title: page.title, uri: undefined, rendered: page.rendered, at: deps.now() });
          ctx.log.info('web.fetch.done', {
            url: redactUrl(page.finalUrl), status: page.status, mime: page.mime, bytes: page.bytes.byteLength, rendered: page.rendered,
            took: deps.now() - started, ...(page.renderError === undefined ? {} : { renderError: page.renderError }),
          });
          return ctx.done({ content, mime: page.mime, finalUrl: page.finalUrl, status: page.status, rendered: page.rendered, title: page.title });
        }),
      },
      read: {
        run: (args, ctx) => attempt(ctx, async () => {
          const url = parseWebUrl(args.url);
          if (url === undefined) { return ctx.invalid([urlProblem(args.url)]); }
          // the hub fns' args and results are the web endpoints' bodies and responses, so core's schemas check both; an
          // import's body is a union, which tool args carry as `input`
          const importing: ResourceImportArgs = { url: url.href, ...(args.render === undefined ? {} : { render: args.render }) };
          const record = ResourceRecord.parse(await ctx.fns.importResource({ input: importing }));
          const reading: ResourceReadArgs = { uri: record.uri, maxChars: args.maxChars ?? s.WEB_READ_CHARS };
          const read = ResourceReadResult.parse(await ctx.fns.readResource(reading));
          const source = record.source?.from === 'web' ? record.source : undefined;
          const finalUrl = source?.finalUrl ?? source?.url ?? url.href;
          const rendered = source?.rendered ?? false;
          recent.add({ url: url.href, finalUrl, title: record.stat.name, uri: record.uri, rendered, at: deps.now() });
          ctx.log.info('web.read.done', { url: redactUrl(finalUrl), uri: record.uri, chars: read.text.length, truncated: read.truncated, rendered });
          return ctx.done({ uri: record.uri, title: record.stat.name, finalUrl, text: read.text, truncated: read.truncated, rendered });
        }),
      },
    },
    mentions: {
      pages: {
        search: (query) => mentions.search(query),
        hover: (target) => mentions.hover(target),
        llm: (target) => mentions.llm(target),
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
  return { impl, recent };
}
