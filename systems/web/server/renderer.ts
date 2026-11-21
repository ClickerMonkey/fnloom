/**
 * Rendering script-built pages: `PageTabs` is what `@aeye/resources`' url loader calls when a fetched html page looks
 * built by scripts (`looksScriptRendered`) or the mode says `always`. One headless browser is shared and launched on
 * the first render (and again if it crashes); each render gets its own private browser context and tab, so cookies
 * and storage never carry from one page to the next. At most `concurrency` pages render at once. Images, fonts and
 * media are never downloaded, and every request a page makes passes the address guard. Each tab's network also goes
 * through its own proxy (`tabProxy`), which connects only to the address the guard checked a host at: requests that
 * skip the page's interception (WebSocket handshakes, service workers) are held to the same rules, and a name that
 * resolves elsewhere after its check (DNS rebinding) can't move a connection. A page is taken once its network goes
 * quiet, or when the idle wait runs out, whichever is first.
 */
import { AllowlistProxy } from '@harness/sdk/server';
import type { PageRenderer, RenderRequest, RenderedHtml } from '@aeye/resources';
import { redactUrl } from '../shared/urls.ts';
import type { AddressCheck } from './guard.ts';
import { WebProblem, isAbort, messageOf } from './problem.ts';

/** Request types a rendered page never downloads. */
export const BLOCKED_REQUESTS: ReadonlySet<string> = new Set(['image', 'font', 'media', 'texttrack', 'eventsource', 'websocket', 'manifest', 'ping', 'cspviolationreport']);

/** What a tab is asked to load. */
export interface TabLoad {
  readonly url: string;
  /** Headers sent with every request the page makes (the User-Agent is set apart). */
  readonly headers: Readonly<Record<string, string>>;
  readonly userAgent: string;
  /** How long the document may take to load. */
  readonly timeout: number;
  /** How long to wait for the network to go quiet afterwards. */
  readonly idle: number;
  /** Whether a request the page makes may go out. */
  allow(url: string, type: string): Promise<boolean>;
}

/** A page after it was loaded and its scripts ran. */
export interface LoadedTab {
  readonly html: string;
  readonly url: string;
}

/** Where a tab's network goes: its own proxy, which connects only to checked addresses. */
export interface TabNetwork {
  /** The proxy's URL (`http://127.0.0.1:<port>`). */
  readonly proxy: string;
}

/** One tab in its own browser context. */
export interface BrowserTab {
  load(request: TabLoad): Promise<LoadedTab>;
  /** Close the tab and its context. Safe to call twice. */
  close(): Promise<void>;
}

/** A running headless browser. */
export interface HeadlessBrowser {
  /** False once the browser has crashed or been closed. */
  readonly connected: boolean;
  /** A tab in a new private context whose every connection goes through `network`'s proxy. */
  open(network: TabNetwork): Promise<BrowserTab>;
  close(): Promise<void>;
}

/** Starts a headless browser. */
export type LaunchBrowser = () => Promise<HeadlessBrowser>;

/** How pages are rendered. */
export interface RendererOptions {
  readonly launch: LaunchBrowser;
  /** Pages rendered at once. */
  readonly concurrency: number;
  readonly timeout: number;
  readonly idle: number;
  readonly userAgent: string;
}

/** Runs work with at most `limit` at once, in the order asked. */
export class Slots {
  readonly #limit: number;
  readonly #waiting: Array<() => void> = [];
  #busy = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  /** How many are running now. */
  get busy(): number { return this.#busy; }
  /** How many are waiting for a slot. */
  get waiting(): number { return this.#waiting.length; }

  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.#acquire(signal);
    try {
      return await work();
    } finally {
      this.#release();
    }
  }

  #acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.#busy < this.#limit) {
      this.#busy += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const go = () => {
        signal?.removeEventListener('abort', give);
        this.#busy += 1;
        resolve();
      };
      const give = () => {
        const at = this.#waiting.indexOf(go);
        if (at >= 0) { this.#waiting.splice(at, 1); }
        reject(signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
      };
      this.#waiting.push(go);
      signal?.addEventListener('abort', give, { once: true });
    });
  }

  #release(): void {
    this.#busy -= 1;
    this.#waiting.shift()?.();
  }
}

/** A guard over a page's requests: blocked types never go out, and each host is checked once per page. */
export function requestFilter(guard: AddressCheck, signal?: AbortSignal): (url: string, type: string) => Promise<boolean> {
  const hosts = new Map<string, Promise<boolean>>();
  return (url, type) => {
    if (BLOCKED_REQUESTS.has(type)) { return Promise.resolve(false); }
    if (url.startsWith('data:') || url.startsWith('blob:') || url === 'about:blank') { return Promise.resolve(true); }
    if (!URL.canParse(url)) { return Promise.resolve(false); }
    const parsed = new URL(url);
    const key = `${parsed.protocol}//${parsed.host}`;
    const known = hosts.get(key);
    if (known !== undefined) { return known; }
    const verdict = guard.check(parsed, signal).then(() => true, () => false);
    hosts.set(key, verdict);
    return verdict;
  };
}

/**
 * The proxy a tab's network goes through: any host, connected at the one address `guard` checked it at (private ones
 * refused unless the guard allows them), so nothing the page does reaches an address the guard didn't pass.
 */
export function tabProxy(guard: AddressCheck, signal?: AbortSignal): AllowlistProxy {
  return new AllowlistProxy({ allow: ['*'], onRefused: () => undefined, route: (target) => guard.address(target.host, signal) });
}

/** Hands out page renderers that share one browser, each checking its pages' requests with its own address guard. */
export interface Renderers {
  /** A renderer (`@aeye/resources`' `PageRenderer`) whose pages' requests pass `guard`. */
  renderer(guard: AddressCheck): PageRenderer;
  /** Close the shared browser, if one was launched. */
  close(): Promise<void>;
}

/** The renderer's id in a fetched source's metadata (`renderedBy`). */
export const RENDERER_ID = 'puppeteer';

/** Pages rendered in tabs of one shared headless browser. */
export class PageTabs implements Renderers {
  readonly #options: RendererOptions;
  readonly #slots: Slots;
  #browser: Promise<HeadlessBrowser> | undefined;

  constructor(options: RendererOptions) {
    this.#options = options;
    this.#slots = new Slots(options.concurrency);
  }

  /** Pages rendering now and waiting. */
  get load(): { busy: number; waiting: number } {
    return { busy: this.#slots.busy, waiting: this.#slots.waiting };
  }

  renderer(guard: AddressCheck): PageRenderer {
    return { id: RENDERER_ID, render: (request) => this.#slots.run(() => this.#render(request, guard), request.signal) };
  }

  async close(): Promise<void> {
    const browser = this.#browser;
    this.#browser = undefined;
    if (browser !== undefined) { await (await browser.catch(() => undefined))?.close(); }
  }

  async #render(request: RenderRequest, guard: AddressCheck): Promise<RenderedHtml> {
    const browser = await this.#shared();
    const proxy = tabProxy(guard, request.signal);
    let tab: BrowserTab;
    try {
      tab = await browser.open({ proxy: await proxy.start() });
    } catch (error) {
      await proxy.close();
      throw error;
    }
    const closeTab = () => { void tab.close(); };
    request.signal?.addEventListener('abort', closeTab, { once: true });
    try {
      const { 'user-agent': agent, ...headers } = Object.fromEntries(Object.entries(request.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
      const loaded = await tab.load({
        url: request.url,
        headers,
        userAgent: agent ?? this.#options.userAgent,
        timeout: this.#options.timeout,
        idle: this.#options.idle,
        allow: requestFilter(guard, request.signal),
      });
      return { html: loaded.html, url: loaded.url };
    } catch (error) {
      if (request.signal?.aborted === true || isAbort(error) || error instanceof WebProblem) { throw error; }
      throw new WebProblem('render-failed', `The browser couldn't render ${redactUrl(request.url)}: ${messageOf(error)}`, { cause: error });
    } finally {
      request.signal?.removeEventListener('abort', closeTab);
      await tab.close();
      await proxy.close();
    }
  }

  /** The shared browser, launched on first use and again after it disconnected. */
  async #shared(): Promise<HeadlessBrowser> {
    const pending = this.#browser;
    if (pending !== undefined) {
      const browser = await pending.catch(() => undefined);
      if (browser?.connected === true) { return browser; }
      // another render already started a new one while this waited
      if (this.#browser !== pending) { return this.#shared(); }
    }
    const launching = this.#options.launch().catch((error: unknown) => {
      throw new WebProblem('render-failed', `The headless browser didn't start: ${messageOf(error)}`, { cause: error });
    });
    this.#browser = launching;
    try {
      return await launching;
    } catch (error) {
      if (this.#browser === launching) { this.#browser = undefined; }
      throw error;
    }
  }
}
