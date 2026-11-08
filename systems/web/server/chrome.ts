/**
 * The real headless browser: puppeteer's Chrome behind `HeadlessBrowser`. Each tab is a page in its own incognito
 * browser context, with request interception on so `TabLoad.allow` decides every request the page makes.
 */
import puppeteer, { type Browser, type BrowserContext, type HTTPRequest, type Page } from 'puppeteer';
import type { BrowserTab, HeadlessBrowser, LaunchBrowser, LoadedTab, TabLoad } from './renderer.ts';

/** How many requests may still be in flight for the network to count as quiet. */
const IDLE_CONNECTIONS = 2;
/** How long the network must stay that quiet. */
const IDLE_TIME = 500;

/** True for puppeteer's timeout errors, which a quiet-network wait may end with. */
function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

/** A tab in its own browser context. */
class ChromeTab implements BrowserTab {
  readonly #context: BrowserContext;
  readonly #page: Page;
  #closed = false;

  constructor(context: BrowserContext, page: Page) {
    this.#context = context;
    this.#page = page;
  }

  async load(request: TabLoad): Promise<LoadedTab> {
    const page = this.#page;
    await page.setUserAgent({ userAgent: request.userAgent });
    if (Object.keys(request.headers).length > 0) { await page.setExtraHTTPHeaders({ ...request.headers }); }
    await page.setRequestInterception(true);
    page.on('request', (intercepted: HTTPRequest) => {
      void request.allow(intercepted.url(), intercepted.resourceType()).then(
        (allowed) => {
          if (intercepted.isInterceptResolutionHandled()) { return undefined; }
          return allowed ? intercepted.continue() : intercepted.abort('blockedbyclient');
        },
      ).catch(() => undefined);
    });
    await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: request.timeout });
    if (request.idle > 0) {
      try {
        await page.waitForNetworkIdle({ idleTime: IDLE_TIME, concurrency: IDLE_CONNECTIONS, timeout: request.idle });
      } catch (error) {
        // a page that never goes quiet (polling, analytics) is taken as it is when the wait runs out
        if (!isTimeoutError(error)) { throw error; }
      }
    }
    return { html: await page.content(), url: page.url() };
  }

  async close(): Promise<void> {
    if (this.#closed) { return; }
    this.#closed = true;
    await this.#context.close().catch(() => undefined);
  }
}

/** Puppeteer's browser as a `HeadlessBrowser`. */
class ChromeBrowser implements HeadlessBrowser {
  readonly #browser: Browser;

  constructor(browser: Browser) {
    this.#browser = browser;
  }

  get connected(): boolean { return this.#browser.connected; }

  async open(): Promise<BrowserTab> {
    const context = await this.#browser.createBrowserContext();
    try {
      return new ChromeTab(context, await context.newPage());
    } catch (error) {
      await context.close().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.#browser.close().catch(() => undefined);
  }
}

/** Launches puppeteer's headless Chrome (or the one at `executablePath`). */
export function launchChrome(options: { executablePath?: string | undefined } = {}): LaunchBrowser {
  return async () => new ChromeBrowser(await puppeteer.launch({
    headless: true,
    ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
    args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check', '--mute-audio', '--disable-extensions'],
  }));
}
