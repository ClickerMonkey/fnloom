import { createDefaultResourceRegistry } from '@aeye/resources/default';
import { describe, expect, it } from 'vitest';
import type { FetchSettings } from './index.ts';
import { PageLoader, mimeFor, titleFor } from './loader.ts';
import { WebProblem } from './problem.ts';
import { PageTabs } from './renderer.ts';
import { PUBLIC_DNS, html, scriptedFetch, tableLookup, type Answer, type TabScript } from './testing.ts';
import { fakeLauncher } from './testing.ts';

const registry = createDefaultResourceRegistry();
const settings: FetchSettings = { render: 'auto', allowPrivate: false, maxBytes: 1_000_000, timeout: 2_000 };

const APP = '<!doctype html><html><head><title>Loading…</title><script src="/app.js"></script></head><body><div id="root"></div></body></html>';
const PLAIN = `<!doctype html><html><head><title>A plain page</title></head><body><main><h1>Plain</h1><p>${'Words people can read. '.repeat(30)}</p></main></body></html>`;
const RENDERED = `<html><head><title>The app</title></head><body><div id="root"><h1>Built by scripts</h1><p>${'Rendered words. '.repeat(20)}</p></div></body></html>`;

/** A loader over a scripted fetch and a fake browser whose tabs run `script`. */
function rig(table: Readonly<Record<string, Answer>>, script: TabScript = () => Promise.resolve({ html: RENDERED, url: 'https://app.example.com/' })) {
  const fetchFn = scriptedFetch(table);
  const launch = fakeLauncher(script);
  const renderers = new PageTabs({ launch, concurrency: 2, timeout: 1_000, idle: 0, userAgent: 'test-agent' });
  const loader = new PageLoader({ registry, fetch: fetchFn, lookup: tableLookup(PUBLIC_DNS), renderers, redirects: 5, userAgent: 'test-agent' });
  return { loader, fetchFn, launch, renderers };
}

async function problemOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'none';
  } catch (error) {
    return error instanceof WebProblem ? error.code : `threw ${String(error)}`;
  }
}

describe('PageLoader', () => {
  it('keeps a plain page as fetched, with its title, type and media type', async () => {
    const { loader, fetchFn, launch } = rig({ 'https://example.com/': html(PLAIN) });
    const page = await loader.fetch('example.com', settings);
    expect(page).toMatchObject({ mime: 'text/html', type: 'html', requestedUrl: 'https://example.com/', finalUrl: 'https://example.com/', status: 200, rendered: false, title: 'A plain page' });
    expect(new TextDecoder().decode(page.bytes)).toBe(PLAIN);
    expect(launch.browsers).toHaveLength(0);
    expect(new Headers(fetchFn.seen[0]?.init.headers).get('user-agent')).toBe('test-agent');
  });

  it('renders an empty app root in the browser under auto, and takes the rendered title', async () => {
    const { loader, launch } = rig({ 'https://app.example.com/': html(APP) });
    const page = await loader.fetch('https://app.example.com/', settings);
    expect(page.rendered).toBe(true);
    expect(page.title).toBe('The app');
    expect(new TextDecoder().decode(page.bytes)).toContain('Built by scripts');
    expect(launch.browsers[0]?.loads[0]).toMatchObject({ url: 'https://app.example.com/', userAgent: 'test-agent' });
    expect(launch.browsers[0]?.openTabs).toBe(0);
  });

  it('follows the mode: never keeps the app root, always renders a plain page', async () => {
    const never = rig({ 'https://app.example.com/': html(APP) });
    const kept = await never.loader.fetch('https://app.example.com/', { ...settings, render: 'never' });
    expect(kept.rendered).toBe(false);
    expect(never.launch.browsers).toHaveLength(0);
    const always = rig({ 'https://example.com/': html(PLAIN) }, () => Promise.resolve({ html: PLAIN.replace('Plain', 'After scripts'), url: 'https://example.com/' }));
    const rendered = await always.loader.fetch('https://example.com/', { ...settings, render: 'always' });
    expect(rendered.rendered).toBe(true);
    expect(new TextDecoder().decode(rendered.bytes)).toContain('After scripts');
  });

  it('keeps the fetched html when rendering fails under auto, and fails under always', async () => {
    const broken: TabScript = () => Promise.reject(new Error('Chrome crashed'));
    const auto = rig({ 'https://app.example.com/': html(APP) }, broken);
    const kept = await auto.loader.fetch('https://app.example.com/', settings);
    expect(kept.rendered).toBe(false);
    expect(kept.renderError).toContain('Chrome crashed');
    expect(new TextDecoder().decode(kept.bytes)).toBe(APP);
    const always = rig({ 'https://app.example.com/': html(APP) }, broken);
    expect(await problemOf(always.loader.fetch('https://app.example.com/', { ...settings, render: 'always' }))).toBe('render-failed');
  });

  it('refuses 127.0.0.1 and localhost without fetching, unless private addresses are allowed', async () => {
    const { loader, fetchFn } = rig({ 'http://127.0.0.1:4300/': html(PLAIN), 'http://localhost/': html(PLAIN) });
    expect(await problemOf(loader.fetch('http://127.0.0.1:4300/', settings))).toBe('private-address');
    expect(await problemOf(loader.fetch('http://localhost/', settings))).toBe('private-address');
    expect(fetchFn.seen).toHaveLength(0);
    const allowed = await loader.fetch('http://127.0.0.1:4300/', { ...settings, allowPrivate: true });
    expect(allowed.title).toBe('A plain page');
  });

  it('refuses what is not a web URL', async () => {
    const { loader } = rig({});
    expect(await problemOf(loader.fetch('not a url', settings))).toBe('bad-url');
    expect(await problemOf(loader.fetch('ftp://example.com/file', settings))).toBe('bad-url');
  });

  it('detects a pdf served as bytes by its content, and names it from its URL', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n');
    const { loader } = rig({ 'https://example.com/files/Report%202026.pdf?token=secret': new Response(pdf, { headers: { 'content-type': 'application/octet-stream' } }) });
    const page = await loader.fetch('https://example.com/files/Report%202026.pdf?token=secret', settings);
    expect(page).toMatchObject({ type: 'pdf', mime: 'application/pdf', title: 'example.com · Report 2026.pdf' });
    expect(Buffer.from(page.bytes).equals(Buffer.from(pdf))).toBe(true);
  });

  it('transcodes text from its charset to utf-8', async () => {
    const latin1 = new Uint8Array([...new TextEncoder().encode('caf'), 0xe9]);
    const { loader } = rig({ 'https://example.com/menu.txt': new Response(latin1, { headers: { 'content-type': 'text/plain; charset=iso-8859-1' } }) });
    const page = await loader.fetch('https://example.com/menu.txt', settings);
    expect(new TextDecoder().decode(page.bytes)).toBe('café');
  });

  it('gives up after the timeout', async () => {
    const never: Answer = (init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(init.signal?.reason instanceof Error ? init.signal.reason : new Error('aborted')); });
    });
    const { loader } = rig({ 'https://example.com/slow': never });
    expect(await problemOf(loader.fetch('https://example.com/slow', { ...settings, timeout: 30 }))).toBe('timeout');
  });

  it('passes a cancel through as an abort', async () => {
    const never: Answer = (init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(new DOMException('cancelled', 'AbortError')); });
    });
    const { loader } = rig({ 'https://example.com/slow': never });
    const controller = new AbortController();
    const fetching = loader.fetch('https://example.com/slow', settings, controller.signal);
    controller.abort();
    await expect(fetching).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('mimeFor and titleFor', () => {
  it('prefers a specific media type, then the type\'s, then the generic one', () => {
    expect(mimeFor('html', 'text/html')).toBe('text/html');
    expect(mimeFor('markdown', 'text/plain')).toBe('text/markdown');
    expect(mimeFor('pdf', undefined)).toBe('application/pdf');
    expect(mimeFor(undefined, 'application/octet-stream')).toBe('application/octet-stream');
    expect(mimeFor(undefined, undefined)).toBe('application/octet-stream');
    expect(mimeFor('typescript', undefined)).toBe('application/octet-stream');
  });

  it('takes an html page\'s title, or labels it by its URL', () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    expect(titleFor('html', bytes('<title>  Two\n words </title>'), 'https://example.com/')).toBe('Two words');
    expect(titleFor('html', bytes('<p>no title</p>'), 'https://example.com/a/b')).toBe('example.com · b');
    expect(titleFor('json', bytes('{}'), 'https://example.com/data.json?api_key=k')).toBe('example.com · data.json');
  });
});
