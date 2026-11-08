import { ActorId, RunId, SessionId, TurnId, type RunSettled } from '@harness/core';
import { describe, expect, it } from 'vitest';
import type { HostLookup } from '@harness/sdk/server';
import { FETCH_RAW, guardedFetch, LibraryFetcher, WebSystemFetcher, type FetchRuns } from './fetch.ts';
import { RegistryConverters } from './converters.ts';
import { ALICE, bytes, HUB_ACTOR, MapFetcher, memoryContent } from './testing.ts';

const who = { actor: ALICE };
const settings = { HARNESS_FETCH_TIMEOUT: 5_000, HARNESS_FETCH_REDIRECTS: 8, HARNESS_FETCH_PRIVATE: false, HARNESS_IMPORT_MAX: 1_000_000 } as const;
const converters = new RegistryConverters({ maxRows: 10 });

/** Host names to addresses, for the guard. */
const hosts: Record<string, string[]> = { 'site.dev': ['93.184.216.34'], 'inside.lan': ['192.168.1.5'], 'six.dev': ['2606:2800:220:1::1'] };
const lookup: HostLookup = (host) => { const found = hosts[host]; return found === undefined ? Promise.reject(new Error(`ENOTFOUND ${host}`)) : Promise.resolve(found); };

/** A fetch answering from a table of URL → response maker, recording what was asked. */
function fakeFetch(answers: Record<string, () => Response>) {
  const asked: string[] = [];
  const fetch = (input: string): Promise<Response> => {
    asked.push(input);
    const answer = answers[input];
    return answer === undefined ? Promise.resolve(new Response('nope', { status: 404 })) : Promise.resolve(answer());
  };
  return { fetch, asked };
}

describe('the hub\'s guarded fetch', () => {
  const rules = { lookup, allowPrivate: false };

  it('refuses private hosts, local names, multicast and redirects that lead to one, and other schemes', async () => {
    const { fetch, asked } = fakeFetch({
      'https://site.dev/a': () => new Response(null, { status: 302, headers: { location: 'http://inside.lan/secret' } }),
      'https://site.dev/b': () => new Response(null, { status: 301, headers: { location: '/c' } }),
      'https://site.dev/c': () => new Response('ok'),
    });
    const guarded = guardedFetch(fetch, rules, 8);
    for (const url of ['http://127.0.0.1:4300/api', 'http://inside.lan/', 'https://site.dev/a', 'http://localhost:4300/', 'http://224.0.0.1/', 'http://[::ffff:7f00:1]/']) {
      await expect(guarded(url, {}), url).rejects.toMatchObject({ status: 403 });
    }
    expect(asked).not.toContain('http://inside.lan/secret');
    await expect(guarded('file:///etc/passwd', {})).rejects.toMatchObject({ status: 422 });
    await expect(guarded('https://nowhere.dev/', {})).rejects.toMatchObject({ status: 502 });
    expect(await (await guarded('https://site.dev/b', {})).text()).toBe('ok');
  });

  it('stops after the redirect limit', async () => {
    const { fetch } = fakeFetch({ 'https://site.dev/loop': () => new Response(null, { status: 302, headers: { location: '/loop' } }) });
    await expect(guardedFetch(fetch, rules, 2)('https://site.dev/loop', {})).rejects.toMatchObject({ status: 508 });
  });
});

describe('the hub fetching URLs itself', () => {
  it('fetches a page with its type, through the guard', async () => {
    const { fetch, asked } = fakeFetch({ 'https://site.dev/docs': () => new Response('<html><body><h1>Docs</h1></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }) });
    const fetcher = new LibraryFetcher({ converters, settings, fetch, lookup });
    const page = await fetcher.fetch('https://site.dev/docs', 'auto', who);
    expect(page).toMatchObject({ mime: 'text/html', finalUrl: 'https://site.dev/docs', rendered: false });
    expect(new TextDecoder().decode(page.bytes)).toContain('<h1>Docs</h1>');
    expect(asked).toEqual(['https://site.dev/docs']);
    await expect(fetcher.fetch('http://inside.lan/', 'auto', who)).rejects.toMatchObject({ status: 403 });
  });

  it('reaches private addresses only when an admin allows them', async () => {
    const { fetch } = fakeFetch({ 'http://inside.lan/': () => new Response('inside', { headers: { 'content-type': 'text/plain' } }) });
    const fetcher = new LibraryFetcher({ converters, settings: { ...settings, HARNESS_FETCH_PRIVATE: true }, fetch, lookup });
    expect(new TextDecoder().decode((await fetcher.fetch('http://inside.lan/', 'auto', who)).bytes)).toBe('inside');
  });
});

describe('fetching through the web system', () => {
  const parent = { id: RunId.parse('run_parent'), turn: TurnId.parse('trn_1'), actor: ALICE, priority: 'interactive', session: SessionId.parse('ses_1') } as const;

  function rig(options: { connected: boolean; settled: RunSettled }) {
    const content = memoryContent();
    const fallback = new MapFetcher();
    fallback.pages.set('https://site.dev/x', { bytes: bytes('fallback'), mime: 'text/plain', finalUrl: 'https://site.dev/x', rendered: false });
    const started: unknown[] = [];
    const runs: FetchRuns = {
      get: (id) => Promise.resolve(id === parent.id ? parent : undefined),
      start: (input) => { started.push(input); return Promise.resolve({ run: RunId.parse('run_child'), settled: Promise.resolve(options.settled) }); },
    };
    const fetcher = new WebSystemFetcher({ webConnected: () => options.connected, runs: () => runs, content, hubActor: HUB_ACTOR, fallback });
    return { content, fallback, started, fetcher };
  }

  it('fetches as a child run of the run that imports, and reads the bytes it kept', async () => {
    const content = memoryContent();
    const ref = await content.put(bytes('<p>rendered</p>'), 'text/html');
    const r = rig({ connected: true, settled: { status: 'done', result: { content: ref, mime: 'text/html', finalUrl: 'https://site.dev/y', status: 200, rendered: true, title: 'Y' } } });
    const kept = await r.content.put(bytes('<p>rendered</p>'), 'text/html');
    const page = await r.fetcher.fetch('https://site.dev/x', 'always', { actor: ALICE, run: parent.id });
    expect(page).toMatchObject({ mime: 'text/html', finalUrl: 'https://site.dev/y', rendered: true, title: 'Y' });
    expect(new TextDecoder().decode(page.bytes)).toBe('<p>rendered</p>');
    expect(kept).toEqual(ref);
    expect(r.started).toEqual([expect.objectContaining({ fn: FETCH_RAW, args: { url: 'https://site.dev/x', render: 'always' }, parent: parent.id, turn: 'trn_1', caller: HUB_ACTOR, actor: ActorId.parse('act_alice') })]);
  });

  it('fetches itself when there is no run or the web system is away, and says why a fetch failed', async () => {
    const away = rig({ connected: false, settled: { status: 'cancelled' } });
    expect(new TextDecoder().decode((await away.fetcher.fetch('https://site.dev/x', 'auto', { actor: ALICE, run: parent.id })).bytes)).toBe('fallback');
    const noRun = rig({ connected: true, settled: { status: 'cancelled' } });
    expect(new TextDecoder().decode((await noRun.fetcher.fetch('https://site.dev/x', 'auto', who)).bytes)).toBe('fallback');
    const failed = rig({ connected: true, settled: { status: 'failed', error: { class: 'fatal', message: 'timed out' } } });
    const failing = failed.fetcher.fetch('https://site.dev/x', 'auto', { actor: ALICE, run: parent.id });
    await expect(failing).rejects.toMatchObject({ status: 502 });
    await expect(failing).rejects.toThrow('timed out');
  });
});
