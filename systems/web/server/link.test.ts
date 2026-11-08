/**
 * The web system end to end over the SDK's real link runtime: `serve` connects to an in-memory hub (`FakeHub`), sends
 * the manifest, gets its config, and every call below crosses the link as JSON and is checked against the contract on
 * both sides. The page loader is the real one over a scripted `fetch` and a fake browser; search is a fake.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultResourceRegistry } from '@aeye/resources/default';
import { Json, ResourceReadResult, ResourceRecord, mintId, type OutcomeWire, type RunSettled } from '@harness/core';
import { serve, type RunningSystem } from '@harness/sdk/server';
import { FakeHub, TEST_USER } from '@harness/sdk/server/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { web } from '../shared/index.ts';
import { webEnv } from './env.ts';
import { createWebImpl, fetchSettings, searchCredits, type WebServer } from './impl.ts';
import { PageLoader } from './loader.ts';
import { WebProblem } from './problem.ts';
import { PageTabs } from './renderer.ts';
import { FakeSearch, PUBLIC_DNS, fakeLauncher, html, scriptedFetch, tableLookup } from './testing.ts';
import { RunUploads } from './uploads.ts';

const settings = { ...webEnv.parse(), TAVILY_API_KEY: 'tvly-env', WEB_TAVILY_CREDIT: 0.01 };

const APP = '<html><head><title>Loading</title><script src="/app.js"></script></head><body><div id="app"></div></body></html>';
const ARTICLE = `<html><head><title>An article</title></head><body><main><h1>An article</h1><p>${'Readable text. '.repeat(40)}</p></main></body></html>`;

function done(outcome: OutcomeWire): Json {
  if (outcome.status !== 'done') { throw new Error(`expected done, got ${JSON.stringify(outcome)}`); }
  return outcome.result;
}

/** A hub resource record for an imported web page, as the hub's `importResource` answers. */
function pageRecord(url: string, finalUrl: string, rendered: boolean): Json {
  return Json.parse(ResourceRecord.parse({
    uri: 'hub://resources/web/article',
    system: 'hub',
    stat: { uri: 'hub://resources/web/article', name: 'An article', type: 'page', mime: 'text/html', format: 'html', version: 'v1' },
    links: [],
    source: { from: 'web', url, finalUrl, fetchedAt: 1, rendered },
    primary: 'markdown',
    seenAt: 1,
  }));
}

describe('web over the link', () => {
  let state: string;
  let hub: FakeHub;
  let search: FakeSearch;
  let server: WebServer;
  let launch: ReturnType<typeof fakeLauncher>;
  let fetchFn: ReturnType<typeof scriptedFetch>;
  let running: RunningSystem<'web'> | undefined;

  beforeEach(async () => {
    state = await mkdtemp(join(tmpdir(), 'harness-web-'));
    search = new FakeSearch({ answer: 'Cats sleep a lot.', results: [{ title: 'Cats', url: 'https://example.com/cats', snippet: 'About cats', score: 0.9 }] });
    fetchFn = scriptedFetch({
      'https://example.com/': html(ARTICLE),
      'https://app.example.com/': () => html(APP),
      'http://127.0.0.1:4300/': html(ARTICLE),
    });
    launch = fakeLauncher((request) => Promise.resolve({ html: '<html><head><title>The app</title></head><body><h1>Rendered</h1></body></html>', url: request.url }));
    const renderers = new PageTabs({ launch, concurrency: 1, timeout: 1_000, idle: 0, userAgent: 'test' });
    const uploads = new RunUploads(state);
    let clock = 1_000;
    server = createWebImpl({
      settings,
      search,
      pages: new PageLoader({ registry: createDefaultResourceRegistry(), fetch: fetchFn, lookup: tableLookup(PUBLIC_DNS), renderers, redirects: 5, userAgent: 'test' }),
      uploads,
      renderers,
      now: () => { clock += 10; return clock; },
    });
    hub = new FakeHub({ config: {} });
    running = await serve(web, server.impl, { hub: 'ws://hub.test/link', state, version: '0.0.0', files: uploads.factory }, hub.host());
    await running.ready();
  });
  afterEach(async () => {
    await running?.stop();
    running = undefined;
    await rm(state, { recursive: true, force: true });
  });

  it('sends a manifest with its fns, the Page type, the mention and the guide', () => {
    const manifest = hub.manifests[0];
    expect(manifest?.name).toBe('web');
    const fns = new Map(manifest?.fns.map((f) => [f.name, f]));
    expect(fns.get('search')?.tags).toContain('read');
    expect(fns.get('read')?.tags).toContain('read');
    expect(fns.get('fetch_raw')).toMatchObject({ visibility: 'none', display: 'hidden' });
    const text = JSON.stringify(manifest);
    for (const name of ['Page', 'pages', 'guide', 'hub/resource_import', 'hub/resource_read']) { expect(text).toContain(`"${name}"`); }
  });

  it('searches with the config\'s key over the system\'s, and reports the credits to the budget', async () => {
    const basic = await hub.run('web/search', { query: 'cats' });
    expect(basic).toMatchObject({ cost: 0.01 });
    expect(done(basic)).toEqual({ answer: 'Cats sleep a lot.', results: [{ title: 'Cats', url: 'https://example.com/cats', snippet: 'About cats', score: 0.9 }] });
    expect(search.asked.at(-1)?.key).toBe('tvly-env');
    await hub.configure({ tavilyKey: 'tvly-config' });
    expect(await hub.run('web/search', { query: 'dogs', depth: 'advanced' })).toMatchObject({ status: 'done', cost: 0.02 });
    expect(search.asked.at(-1)).toMatchObject({ key: 'tvly-config', args: { query: 'dogs', depth: 'advanced' } });
  });

  it('fails a search as the problem says, and charges nothing for it', async () => {
    search.results = new WebProblem('no-search-key', 'No key');
    const failed = await hub.run('web/search', { query: 'cats' });
    expect(failed).toMatchObject({ status: 'failed', error: { class: 'fatal', code: 'no-search-key' } });
    expect(failed).not.toHaveProperty('cost');
  });

  it('fetches a plain page raw for the hub: bytes uploaded by ref, its title, not rendered', async () => {
    const result = done(await hub.run('web/fetch_raw', { url: 'https://example.com/' }));
    expect(result).toMatchObject({ mime: 'text/html', finalUrl: 'https://example.com/', status: 200, rendered: false, title: 'An article' });
    const ref = typeof result === 'object' && result !== null && !Array.isArray(result) ? result['content'] : undefined;
    const hash = typeof ref === 'object' && ref !== null && !Array.isArray(ref) ? ref['hash'] : undefined;
    expect(typeof hash === 'string' ? new TextDecoder().decode(hub.content.get(hash)) : undefined).toBe(ARTICLE);
    expect(server.recent.get('https://example.com/')?.title).toBe('An article');
  });

  it('renders an empty app root before handing it over, under auto', async () => {
    expect(done(await hub.run('web/fetch_raw', { url: 'https://app.example.com/' }))).toMatchObject({ rendered: true, title: 'The app' });
    expect(launch.browsers).toHaveLength(1);
    expect(done(await hub.run('web/fetch_raw', { url: 'https://app.example.com/', render: 'never' }))).toMatchObject({ rendered: false, title: 'Loading' });
  });

  it('refuses 127.0.0.1 as the caller\'s problem, unless the config allows private addresses', async () => {
    expect(await hub.run('web/fetch_raw', { url: 'http://127.0.0.1:4300/' })).toMatchObject({ status: 'failed', error: { class: 'caller', code: 'private-address' } });
    expect(fetchFn.seen.some((r) => r.url.startsWith('http://127.0.0.1'))).toBe(false);
    await hub.configure({ allowPrivate: true });
    expect(done(await hub.run('web/fetch_raw', { url: 'http://127.0.0.1:4300/' }))).toMatchObject({ title: 'An article' });
  });

  it('reads a page through the hub: imports it, reads its primary form, and remembers it for mentions', async () => {
    const calls: Array<{ fn: string; args: Json }> = [];
    hub.onCall = (call): Promise<RunSettled> => {
      calls.push({ fn: call.fn, args: call.args });
      if (call.fn === 'hub/resource_import') { return Promise.resolve({ status: 'done', result: pageRecord('https://example.com/', 'https://example.com/', true) }); }
      const read = Json.parse(ResourceReadResult.parse({ uri: 'hub://resources/web/article', form: 'markdown', text: '# An article\n\nReadable text.', offset: 0, total: 600, truncated: true, forms: ['markdown'], offers: [] }));
      return Promise.resolve({ status: 'done', result: read });
    };
    const result = done(await hub.run('web/read', { url: 'example.com', render: 'always', maxChars: 40 }));
    expect(result).toEqual({ uri: 'hub://resources/web/article', title: 'An article', finalUrl: 'https://example.com/', text: '# An article\n\nReadable text.', truncated: true, rendered: true });
    expect(calls).toEqual([
      { fn: 'hub/resource_import', args: { input: { url: 'https://example.com/', render: 'always' } } },
      { fn: 'hub/resource_read', args: { uri: 'hub://resources/web/article', maxChars: 40 } },
    ]);
    expect(server.recent.get('https://example.com/')?.uri).toBe('hub://resources/web/article');

    const time = { now: 0, timeZone: 'UTC', local: '1970-01-01T00:00:00Z' };
    const asker = { session: mintId('session'), actor: TEST_USER.id, user: TEST_USER, time };
    const options = await hub.peer().call('mentions', { ...asker, provider: 'pages', query: 'article' });
    expect(options[0]).toMatchObject({ label: 'An article', target: { url: 'https://example.com/' } });
  });

  it('reads with the system\'s default length, and fails as the hub\'s call failed', async () => {
    hub.onCall = (call): Promise<RunSettled> => (call.fn === 'hub/resource_import'
      ? Promise.resolve({ status: 'failed', error: { class: 'caller', message: 'example.com answered 404 Not Found.', code: 'http-status' } })
      : Promise.resolve({ status: 'cancelled' }));
    expect(await hub.run('web/read', { url: 'https://example.com/missing' })).toMatchObject({ status: 'failed', error: { class: 'caller', code: 'http-status', message: 'example.com answered 404 Not Found.' } });
    hub.onCall = (call): Promise<RunSettled> => (call.fn === 'hub/resource_import'
      ? Promise.resolve({ status: 'done', result: pageRecord('https://example.com/', 'https://example.com/', false) })
      : Promise.resolve({ status: 'cancelled' }));
    expect((await hub.run('web/read', { url: 'https://example.com/' })).status).toBe('cancelled');
    expect(hub.calls.at(-1)?.args).toEqual({ uri: 'hub://resources/web/article', maxChars: settings.WEB_READ_CHARS });
  });

  it('refuses something that is not a URL as invalid input, without asking the hub or the network', async () => {
    for (const fn of ['web/read', 'web/fetch_raw'] as const) {
      expect(await hub.run(fn, { url: 'not a url' })).toMatchObject({ status: 'invalid-input', invalid: { problems: [{ path: 'url' }] } });
      expect(await hub.run(fn, { url: 'ftp://example.com/file' })).toMatchObject({ status: 'invalid-input' });
    }
    expect(hub.calls).toHaveLength(0);
    expect(fetchFn.seen).toHaveLength(0);
  });
});

describe('impl helpers', () => {
  it('takes fetch settings from the call, then the config, then the environment', () => {
    expect(fetchSettings({}, settings, undefined)).toEqual({ render: settings.WEB_RENDER, allowPrivate: false, maxBytes: settings.WEB_MAX_BYTES, timeout: settings.WEB_TIMEOUT });
    expect(fetchSettings({ render: 'never', allowPrivate: true, maxBytes: 2_048, timeout: 5_000 }, settings, 'always')).toEqual({ render: 'always', allowPrivate: true, maxBytes: 2_048, timeout: 5_000 });
  });

  it('counts Tavily credits by depth', () => {
    expect(searchCredits(undefined)).toBe(1);
    expect(searchCredits('basic')).toBe(1);
    expect(searchCredits('advanced')).toBe(2);
  });
});
