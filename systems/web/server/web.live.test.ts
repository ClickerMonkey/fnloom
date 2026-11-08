// Live: Tavily search with TAVILY_API_KEY (skipped, with the reason, when it isn't set), and the real page loader:
// a public page over the network, and a script-built page from a local server rendered in puppeteer's Chrome. Run
// with `npm run test:live`.
import { createServer, type Server } from 'node:http';
import { createDefaultResourceRegistry } from '@aeye/resources/default';
import { systemLookup } from '@harness/sdk/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchChrome } from './chrome.ts';
import { webEnv } from './env.ts';
import type { FetchSettings } from './index.ts';
import { PageLoader } from './loader.ts';
import { PageTabs } from './renderer.ts';
import { TavilySearch } from './tavily.ts';

const settings = webEnv.parse();
const key = settings.TAVILY_API_KEY;
/** The web-system lane's port for the local page server. */
const PORT = 4451;
/** How long the live search may take: Tavily often answers in over ten seconds. */
const SEARCH_WAIT = 45_000;

describe.skipIf(key === undefined)('Tavily search (TAVILY_API_KEY)', () => {
  it('finds pages for a query, best first, with a short answer', async () => {
    const search = new TavilySearch({ url: settings.WEB_TAVILY_URL, fetch: (input, init) => fetch(input, init), timeout: 30_000, limit: 3, snippetChars: 300 });
    const results = await search.search({ query: 'Vue.js composition API documentation', limit: 3 }, { key });
    expect(results.results.length).toBeGreaterThan(0);
    expect(results.results.length).toBeLessThanOrEqual(3);
    for (const hit of results.results) {
      expect(URL.canParse(hit.url)).toBe(true);
      expect(hit.snippet.length).toBeLessThanOrEqual(301);
    }
    const scores = results.results.map((hit) => hit.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  }, SEARCH_WAIT);
});

describe('the page loader with a real browser', () => {
  const APP = `<!doctype html><html><head><title>Loading…</title></head><body><div id="root"></div>
<script>setTimeout(() => {
  document.title = 'Rendered by scripts';
  document.getElementById('root').innerHTML = '<h1>Built in the browser</h1><p>' + 'Words the server never sent. '.repeat(20) + '</p>';
}, 50);</script></body></html>`;
  let server: Server;
  const renderers = new PageTabs({ launch: launchChrome({ executablePath: settings.WEB_CHROME }), concurrency: 1, timeout: 30_000, idle: 2_000, userAgent: settings.WEB_USER_AGENT });
  const loader = new PageLoader({ registry: createDefaultResourceRegistry(), fetch: (input, init) => fetch(input, init), lookup: systemLookup, renderers, redirects: 5, userAgent: settings.WEB_USER_AGENT });
  const fetching: FetchSettings = { render: 'auto', allowPrivate: false, maxBytes: 5_000_000, timeout: 30_000 };

  beforeAll(async () => {
    server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(APP); });
    await new Promise<void>((resolve) => { server.listen(PORT, '0.0.0.0', resolve); });
  });
  afterAll(async () => {
    await renderers.close();
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  });

  it('keeps a plain public page as fetched', async () => {
    const page = await loader.fetch('https://en.wikipedia.org/wiki/Hypertext_Transfer_Protocol', fetching);
    expect(page).toMatchObject({ type: 'html', mime: 'text/html', status: 200, rendered: false });
    expect(page.title).toMatch(/HTTP|Hypertext Transfer Protocol/);
  });

  it('renders a script-built page in Chrome, and refuses it as private unless allowed', async () => {
    const url = `http://127.0.0.1:${PORT}/`;
    await expect(loader.fetch(url, fetching)).rejects.toMatchObject({ code: 'private-address' });
    const page = await loader.fetch(url, { ...fetching, allowPrivate: true });
    expect(page.rendered).toBe(true);
    expect(page.title).toBe('Rendered by scripts');
    expect(new TextDecoder().decode(page.bytes)).toContain('Built in the browser');
  });
});
