/**
 * Fetching a URL for the hub: `@aeye/resources`' `fetchResource` (type detection by content, header, extension and
 * text; charsets; the byte cap; the timeout) over the guarded fetch (every redirect hop checked, failures classed),
 * with script-built html rendered by the shared headless browser first under `auto`, and the page's title worked out.
 * The bytes go to the hub as they are (text as utf-8); the hub converts them.
 */
import { fetchResource, htmlToCleanMarkdown, type FetchFn, type TypeInference } from '@aeye/resources';
import type { RenderModeValue } from '../shared/index.ts';
import { labelOf, parseWebUrl, redactUrl } from '../shared/urls.ts';
import type { HostLookup } from '@harness/sdk/server';
import { AddressGuard } from './guard.ts';
import { guardedFetch } from './http.ts';
import type { FetchedPage, FetchSettings, PageSource } from './index.ts';
import { WebProblem, isAbort, isTimeout, messageOf } from './problem.ts';
import type { Renderers } from './renderer.ts';

/** A title for fetched content: an html page's own (`<title>`, `og:title`, the first `<h1>`), else a label from its URL. */
export function titleFor(type: string | undefined, bytes: Uint8Array, url: string): string {
  if (type === 'html') {
    const title = htmlToCleanMarkdown(new TextDecoder().decode(bytes), { baseUrl: url, links: false, images: false }).title?.replace(/\s+/g, ' ').trim();
    if (title !== undefined && title !== '') { return title; }
  }
  return labelOf(url);
}

/** What the loader is built from. */
export interface LoaderDeps {
  /** What detects types (the default `@aeye/resources` registry). */
  readonly registry: TypeInference;
  readonly fetch: FetchFn;
  readonly lookup: HostLookup;
  readonly renderers: Renderers;
  /** The most redirects one fetch follows. */
  readonly redirects: number;
  readonly userAgent: string;
}

/** `PageSource` over `fetchResource`. */
export class PageLoader implements PageSource {
  readonly #deps: LoaderDeps;

  constructor(deps: LoaderDeps) {
    this.#deps = deps;
  }

  async fetch(input: string, settings: FetchSettings, signal?: AbortSignal): Promise<FetchedPage> {
    const url = parseWebUrl(input);
    if (url === undefined) { throw new WebProblem('bad-url', `"${input}" isn't an http or https URL.`); }
    const guard = new AddressGuard(this.#deps.lookup, settings.allowPrivate);
    const render: RenderModeValue = settings.render;
    try {
      const page = await fetchResource(url.href, this.#deps.registry, {
        fetch: guardedFetch({ fetch: this.#deps.fetch, guard, redirects: this.#deps.redirects, maxBytes: settings.maxBytes }),
        headers: { 'user-agent': this.#deps.userAgent },
        maxBytes: settings.maxBytes,
        timeoutMs: settings.timeout,
        render,
        ...(render === 'never' ? {} : { renderer: this.#deps.renderers.renderer(guard) }),
        ...(signal === undefined ? {} : { signal }),
      });
      const bytes = page.source.input;
      return {
        bytes,
        mime: page.source.mimeType,
        type: page.source.type,
        requestedUrl: url.href,
        finalUrl: page.url,
        status: page.status,
        rendered: page.renderedBy !== undefined,
        renderError: page.renderError,
        title: titleFor(page.source.type, bytes, page.url),
      };
    } catch (error) {
      if (error instanceof WebProblem || signal?.aborted === true || isAbort(error)) { throw error; }
      if (isTimeout(error)) { throw new WebProblem('timeout', `${redactUrl(url)} took longer than ${settings.timeout} ms.`, { cause: error }); }
      throw new WebProblem('network', `Couldn't fetch ${redactUrl(url)}: ${messageOf(error)}`, { cause: error });
    }
  }
}
