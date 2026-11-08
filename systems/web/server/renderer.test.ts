import { describe, expect, it } from 'vitest';
import { AddressGuard } from './guard.ts';
import { WebProblem } from './problem.ts';
import { BLOCKED_REQUESTS, PageTabs, RENDERER_ID, Slots, requestFilter } from './renderer.ts';
import { PUBLIC_DNS, fakeLauncher, tableLookup, type TabScript } from './testing.ts';

const guard = new AddressGuard(tableLookup(PUBLIC_DNS), false);
const options = { concurrency: 2, timeout: 1_000, idle: 250, userAgent: 'agent/1' };

/** A promise and the functions that settle it. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Slots', () => {
  it('runs at most the limit at once, the rest in the order asked', async () => {
    const slots = new Slots(2);
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const order: number[] = [];
    const runs = gates.map((gate, i) => slots.run(async () => { order.push(i); await gate.promise; return i; }));
    await flush();
    expect(order).toEqual([0, 1]);
    expect([slots.busy, slots.waiting]).toEqual([2, 1]);
    gates[0]?.resolve();
    await flush();
    expect(order).toEqual([0, 1, 2]);
    gates[1]?.resolve();
    gates[2]?.resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2]);
    expect([slots.busy, slots.waiting]).toEqual([0, 0]);
  });

  it('gives up a wait when its signal aborts, and refuses an aborted signal at once', async () => {
    const slots = new Slots(1);
    const gate = deferred<void>();
    const first = slots.run(() => gate.promise);
    const controller = new AbortController();
    const second = slots.run(() => Promise.resolve('never'), controller.signal);
    controller.abort();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(slots.waiting).toBe(0);
    await expect(slots.run(() => Promise.resolve(1), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    gate.resolve();
    await first;
  });

  it('frees the slot when the work fails', async () => {
    const slots = new Slots(1);
    await expect(slots.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await slots.run(() => Promise.resolve('next'))).toBe('next');
  });
});

describe('requestFilter', () => {
  it('blocks images, fonts and media, allows inline data, and checks each host once', async () => {
    const lookup = tableLookup({ ...PUBLIC_DNS, 'inside.example': ['10.0.0.1'] });
    const allow = requestFilter(new AddressGuard(lookup, false));
    for (const type of ['image', 'font', 'media']) { expect(BLOCKED_REQUESTS.has(type)).toBe(true); }
    expect(await allow('https://cdn.example.com/a.png', 'image')).toBe(false);
    expect(await allow('https://cdn.example.com/a.js', 'script')).toBe(true);
    expect(await allow('https://cdn.example.com/b.js', 'script')).toBe(true);
    expect(await allow('data:text/javascript,1', 'script')).toBe(true);
    expect(await allow('https://inside.example/api', 'xhr')).toBe(false);
    expect(await allow('http://127.0.0.1:4300/api', 'fetch')).toBe(false);
    expect(await allow('::not a url', 'fetch')).toBe(false);
    expect(lookup.asked.filter((host) => host === 'cdn.example.com')).toHaveLength(1);
  });
});

describe('PageTabs', () => {
  const page: TabScript = (request) => Promise.resolve({ html: `<p>${request.url}</p>`, url: request.url });

  it('launches one shared browser on first use and renders each page in its own tab', async () => {
    const launch = fakeLauncher(page);
    const tabs = new PageTabs({ launch, ...options });
    const renderer = tabs.renderer(guard);
    expect(renderer.id).toBe(RENDERER_ID);
    expect(launch.browsers).toHaveLength(0);
    const [a, b] = await Promise.all([
      renderer.render({ url: 'https://example.com/a', html: '' }),
      renderer.render({ url: 'https://example.com/b', html: '', headers: { 'User-Agent': 'theirs/2', Accept: 'text/html' } }),
    ]);
    expect(a).toEqual({ html: '<p>https://example.com/a</p>', url: 'https://example.com/a' });
    expect(b.url).toBe('https://example.com/b');
    expect(launch.browsers).toHaveLength(1);
    const browser = launch.browsers[0];
    expect(browser?.closedTabs).toBe(2);
    expect(browser?.loads.map((load) => [load.userAgent, load.headers, load.timeout, load.idle])).toEqual([
      ['agent/1', {}, 1_000, 250],
      ['theirs/2', { accept: 'text/html' }, 1_000, 250],
    ]);
    await tabs.close();
    expect(browser?.closed).toBe(true);
  });

  it('starts a new browser after the old one disconnected', async () => {
    const launch = fakeLauncher(page);
    const renderer = new PageTabs({ launch, ...options }).renderer(guard);
    await renderer.render({ url: 'https://example.com/', html: '' });
    const first = launch.browsers[0];
    if (first !== undefined) { first.connected = false; }
    await renderer.render({ url: 'https://example.com/', html: '' });
    expect(launch.browsers).toHaveLength(2);
  });

  it('turns a failed load into render-failed and still closes the tab', async () => {
    const launch = fakeLauncher(() => Promise.reject(new Error('net::ERR_NAME_NOT_RESOLVED')));
    const renderer = new PageTabs({ launch, ...options }).renderer(guard);
    const failure = await renderer.render({ url: 'https://example.com/', html: '' }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WebProblem);
    expect(failure).toMatchObject({ code: 'render-failed' });
    expect(launch.browsers[0]?.openTabs).toBe(0);
  });

  it('says so when the browser will not start, and tries again next time', async () => {
    let tries = 0;
    const launch = fakeLauncher(page);
    const tabs = new PageTabs({ launch: () => { tries += 1; return tries === 1 ? Promise.reject(new Error('no chrome')) : launch(); }, ...options });
    const renderer = tabs.renderer(guard);
    await expect(renderer.render({ url: 'https://example.com/', html: '' })).rejects.toMatchObject({ code: 'render-failed' });
    expect((await renderer.render({ url: 'https://example.com/', html: '' })).url).toBe('https://example.com/');
  });

  it('closes the tab when the render is cancelled', async () => {
    const gate = deferred<{ html: string; url: string }>();
    const launch = fakeLauncher(() => gate.promise);
    const renderer = new PageTabs({ launch, ...options }).renderer(guard);
    const controller = new AbortController();
    const rendering = renderer.render({ url: 'https://example.com/', html: '', signal: controller.signal });
    await flush();
    controller.abort();
    gate.reject(new Error('Target closed'));
    await expect(rendering).rejects.toThrow('Target closed');
    expect(launch.browsers[0]?.openTabs).toBe(0);
  });

  it('checks the page\'s requests with the guard it was made with', async () => {
    let verdict: boolean | undefined;
    const launch = fakeLauncher(async (request) => {
      verdict = await request.allow('http://192.168.1.1/router', 'xhr');
      return { html: '', url: request.url };
    });
    await new PageTabs({ launch, ...options }).renderer(guard).render({ url: 'https://example.com/', html: '' });
    expect(verdict).toBe(false);
    await new PageTabs({ launch, ...options }).renderer(new AddressGuard(tableLookup({}), true)).render({ url: 'https://example.com/', html: '' });
    expect(verdict).toBe(true);
  });

  it('closes nothing when no browser was launched', async () => {
    await expect(new PageTabs({ launch: fakeLauncher(page), ...options }).close()).resolves.toBeUndefined();
  });
});
