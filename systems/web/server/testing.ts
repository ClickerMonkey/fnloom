/**
 * Test seams for the web server: a scripted `fetch` (answers by URL, records every request), DNS from a table, a fake
 * headless browser, and fakes of the search provider and the page source, so the implementation runs with no
 * network. Used by the `*.test.ts` files only.
 */
import type { FetchFn } from '@aeye/resources';
import type { SearchResultsValue } from '../shared/index.ts';
import type { HostLookup } from './guard.ts';
import type { FetchedPage, FetchSettings, PageSource, SearchArgs, SearchProvider } from './index.ts';
import type { BrowserTab, HeadlessBrowser, LaunchBrowser, LoadedTab, TabLoad } from './renderer.ts';

/** One request the scripted fetch saw. */
export interface SeenRequest {
  readonly url: string;
  readonly init: RequestInit;
}

/** An answer to a request: a response (used once), a maker of responses (for URLs asked more than once), or an error to throw. */
export type Answer = Response | Error | ((init: RequestInit) => Response | Promise<Response>);

/** A `fetch` that answers from a table of URLs (unknown URLs get a 404), recording each request. */
export function scriptedFetch(table: Readonly<Record<string, Answer>>): FetchFn & { readonly seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const fetchFn = async (input: string, init: RequestInit): Promise<Response> => {
    seen.push({ url: input, init });
    const answer = table[input];
    if (answer === undefined) { return new Response('not here', { status: 404, statusText: 'Not Found' }); }
    if (answer instanceof Error) { throw answer; }
    if (answer instanceof Response) {
      if (answer.bodyUsed) { throw new Error(`${input} was asked for twice; answer it with a function`); }
      return answer;
    }
    return answer(init);
  };
  return Object.assign(fetchFn, { seen });
}

/** An html response. */
export function html(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, ...init, headers: { 'content-type': 'text/html; charset=utf-8', ...headersObject(init.headers) } });
}

/** A redirect to `location`. */
export function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

function headersObject(headers: HeadersInit | undefined): Record<string, string> {
  return headers === undefined ? {} : Object.fromEntries(new Headers(headers).entries());
}

/** DNS from a table; a name not in it doesn't resolve. */
export function tableLookup(table: Readonly<Record<string, readonly string[]>>): HostLookup & { readonly asked: string[] } {
  const asked: string[] = [];
  const lookup: HostLookup = (hostname) => {
    asked.push(hostname);
    const found = table[hostname];
    return found === undefined ? Promise.reject(new Error(`ENOTFOUND ${hostname}`)) : Promise.resolve(found);
  };
  return Object.assign(lookup, { asked });
}

/** Public addresses for the hosts the tests use. */
export const PUBLIC_DNS = { 'example.com': ['93.184.215.14'], 'www.example.com': ['93.184.215.14'], 'app.example.com': ['93.184.215.15'], 'cdn.example.com': ['93.184.215.16'] } as const;

/** What a fake tab does with a load: the html (and URL) it ends with, or an error. */
export type TabScript = (request: TabLoad) => Promise<LoadedTab>;

/** A fake headless browser: each tab runs `script`; it records loads, open tabs and launches. */
export class FakeBrowser implements HeadlessBrowser {
  readonly loads: TabLoad[] = [];
  openTabs = 0;
  closedTabs = 0;
  connected = true;
  closed = false;
  readonly #script: TabScript;

  constructor(script: TabScript) {
    this.#script = script;
  }

  open(): Promise<BrowserTab> {
    this.openTabs += 1;
    let done = false;
    const tab: BrowserTab = {
      load: (request) => { this.loads.push(request); return this.#script(request); },
      close: () => {
        if (!done) { done = true; this.openTabs -= 1; this.closedTabs += 1; }
        return Promise.resolve();
      },
    };
    return Promise.resolve(tab);
  }

  close(): Promise<void> {
    this.closed = true;
    this.connected = false;
    return Promise.resolve();
  }
}

/** A launcher of fake browsers, counting launches; each launch makes a new one with the same script. */
export function fakeLauncher(script: TabScript): LaunchBrowser & { readonly browsers: FakeBrowser[] } {
  const browsers: FakeBrowser[] = [];
  const launch: LaunchBrowser = () => {
    const browser = new FakeBrowser(script);
    browsers.push(browser);
    return Promise.resolve(browser);
  };
  return Object.assign(launch, { browsers });
}

/** A search provider that answers with `results` and records what it was asked. */
export class FakeSearch implements SearchProvider {
  readonly asked: Array<{ args: SearchArgs; key: string | undefined }> = [];
  results: SearchResultsValue | Error;

  constructor(results: SearchResultsValue | Error) {
    this.results = results;
  }

  search(args: SearchArgs, options: { key: string | undefined }): Promise<SearchResultsValue> {
    this.asked.push({ args, key: options.key });
    return this.results instanceof Error ? Promise.reject(this.results) : Promise.resolve(this.results);
  }
}

/** A page source that answers with `page` (or throws) and records what it was asked. */
export class FakePages implements PageSource {
  readonly asked: Array<{ url: string; settings: FetchSettings }> = [];
  page: FetchedPage | Error;

  constructor(page: FetchedPage | Error) {
    this.page = page;
  }

  fetch(url: string, settings: FetchSettings): Promise<FetchedPage> {
    this.asked.push({ url, settings });
    return this.page instanceof Error ? Promise.reject(this.page) : Promise.resolve(this.page);
  }
}

/** A fetched html page. */
export function fetchedPage(overrides: Partial<FetchedPage> = {}): FetchedPage {
  return {
    bytes: new TextEncoder().encode('<html><head><title>Example</title></head><body><p>Hello</p></body></html>'),
    mime: 'text/html',
    type: 'html',
    requestedUrl: 'https://example.com/',
    finalUrl: 'https://example.com/',
    status: 200,
    rendered: false,
    renderError: undefined,
    title: 'Example',
    ...overrides,
  };
}
