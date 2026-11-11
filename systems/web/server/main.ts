/**
 * The web system's process: Tavily search, the page loader over the real `fetch` and DNS, the shared headless Chrome
 * for script-built pages, built renderers in the state folder, all served to the hub. Chromium runs here, never in
 * the hub. `npm run dev` starts it when `TAVILY_API_KEY` is set.
 */
import { join } from 'node:path';
import { createDefaultResourceRegistry } from '@aeye/resources/default';
import { loggedHost, rendererFolder, serve, systemLookup } from '@harness/sdk/server';
import { web } from '../shared/index.ts';
import { launchChrome } from './chrome.ts';
import { webEnv } from './env.ts';
import { createWebImpl } from './impl.ts';
import { PageLoader } from './loader.ts';
import { PageTabs } from './renderer.ts';
import { TavilySearch } from './tavily.ts';
import { RunUploads } from './uploads.ts';

const settings = webEnv.parse();
const { host, log } = loggedHost(web.name);

const renderers = new PageTabs({
  launch: launchChrome({ executablePath: settings.WEB_CHROME }),
  concurrency: settings.WEB_RENDER_CONCURRENCY,
  timeout: settings.WEB_RENDER_TIMEOUT,
  idle: settings.WEB_RENDER_IDLE,
  userAgent: settings.WEB_USER_AGENT,
});
const uploads = new RunUploads(settings.HARNESS_SYSTEM_STATE);

const server = createWebImpl({
  settings,
  search: new TavilySearch({
    url: settings.WEB_TAVILY_URL,
    fetch: (input, init) => fetch(input, init),
    timeout: settings.WEB_SEARCH_TIMEOUT,
    limit: settings.WEB_SEARCH_LIMIT,
    snippetChars: settings.WEB_SNIPPET_CHARS,
  }),
  pages: new PageLoader({
    registry: createDefaultResourceRegistry(),
    fetch: (input, init) => fetch(input, init),
    lookup: systemLookup,
    renderers,
    redirects: settings.WEB_REDIRECTS,
    userAgent: settings.WEB_USER_AGENT,
  }),
  uploads,
  renderers,
  now: () => Date.now(),
});

const built = performance.now();
const clientFolder = await rendererFolder({ main: import.meta.url, outDir: join(settings.HARNESS_SYSTEM_STATE, 'client') });
log.info('web.client.built', { folder: clientFolder, took: Math.round(performance.now() - built) });

log.info('web.serving', { hub: settings.HARNESS_HUB, search: settings.TAVILY_API_KEY !== undefined, render: settings.WEB_RENDER });
const running = await serve(web, server.impl, {
  hub: settings.HARNESS_HUB,
  state: settings.HARNESS_SYSTEM_STATE,
  client: clientFolder,
  files: uploads.factory,
  ...(settings.HARNESS_PAIRING_TOKEN === undefined ? {} : { pairingToken: settings.HARNESS_PAIRING_TOKEN }),
}, host);
running.onStatus((status) => { log.info('web.status', { status }); });

const stop = () => {
  renderers.close().finally(() => running.stop()).finally(() => { process.exit(0); }).catch(() => undefined);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
