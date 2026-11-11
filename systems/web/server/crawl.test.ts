/**
 * Crawls over a fake site: `@aeye/resources`' graph over the real page loader on a scripted `fetch`, robots.txt read once per origin, links
 * followed by depth, same-site, include and exclude, the page limit, and pages held for the hub's fetch back.
 */
import { createDefaultResourceRegistry } from '@aeye/resources/default';
import { mintId, type ResourceUri } from '@harness/core';
import { CallFailed } from '@harness/sdk';
import { describe, expect, it } from 'vitest';
import { Crawler, FetchedPages, crawlFolder, crawlRoot, globMatches, type CrawlPlan, type PageImporter } from './crawl.ts';
import { PageLoader } from './loader.ts';
import { RobotsRules } from './robots.ts';
import { PageTabs } from './renderer.ts';
import { PUBLIC_DNS, fakeLauncher, fetchedPage, html, scriptedFetch, tableLookup } from './testing.ts';

const page = (title: string, links: string[]) => () => html(`<html><head><title>${title}</title></head><body><main><h1>${title}</h1>${links.map((href) => `<a href="${href}">${href}</a>`).join(' ')}</main></body></html>`);

const SITE = {
  'https://example.com/robots.txt': () => new Response('User-agent: *\nDisallow: /private\nAllow: /private/open\n', { headers: { 'content-type': 'text/plain' } }),
  'https://example.com/': page('Home', ['/docs/a', '/docs/b#part', '/private/x', '/private/open', 'https://other.example.org/', '/logo.png', '/blog/1', 'mailto:me@example.com']),
  'https://example.com/docs/a': page('Doc A', ['/docs/deep', '/']),
  'https://example.com/docs/b': page('Doc B', []),
  'https://example.com/private/open': page('Open', []),
  'https://example.com/blog/1': page('Blog 1', []),
  'https://example.com/docs/deep': page('Deep', []),
};

function crawler(overrides: { importPage?: PageImporter; maxLinks?: number } = {}) {
  const fetchFn = scriptedFetch(SITE);
  const renderers = new PageTabs({ launch: fakeLauncher(() => Promise.reject(new Error('no browser'))), concurrency: 1, timeout: 1_000, idle: 0, userAgent: 'test' });
  const pages = new PageLoader({ registry: createDefaultResourceRegistry(), fetch: fetchFn, lookup: tableLookup(PUBLIC_DNS), renderers, redirects: 3, userAgent: 'test' });
  const held = new FetchedPages(60_000, () => 0);
  const imported: Array<{ url: string; folder: string; held: boolean }> = [];
  const progress: number[] = [];
  const run = new Crawler({
    pages,
    held,
    importPage: overrides.importPage ?? ((url, folder) => {
      imported.push({ url, folder, held: held.take(url) !== undefined });
      const uri: ResourceUri = `hub://resources/web/${folder}/${new URL(url).pathname.replace(/\W+/g, '-')}`;
      return Promise.resolve({ uri, title: url });
    }),
    agent: 'harness-web',
    maxLinks: overrides.maxLinks ?? 100,
    concurrency: 1,
    progress: (fraction) => { progress.push(fraction); },
    signal: new AbortController().signal,
  });
  return { run, fetchFn, imported, progress, held };
}

const plan = (overrides: Partial<CrawlPlan> = {}): CrawlPlan => ({
  start: new URL('https://example.com/'), depth: 1, sameSite: true, maxPages: 25, include: [], exclude: [],
  fetch: { render: 'never', allowPrivate: false, maxBytes: 1_000_000, timeout: 5_000 }, folder: 'crawls/example.com-20261108-1200', ...overrides,
});

describe('a crawl', () => {
  it('follows links one level deep on the site, respecting robots.txt, and keeps each page under the folder', async () => {
    const { run, fetchFn, imported, progress } = crawler();
    const report = await run.run(plan());
    expect(report.pages.map((p) => p.title)).toEqual(['https://example.com/', 'https://example.com/docs/a', 'https://example.com/docs/b', 'https://example.com/private/open', 'https://example.com/blog/1']);
    expect(report.pages.map((p) => p.depth)).toEqual([0, 1, 1, 1, 1]);
    expect(imported.every((i) => i.folder === 'crawls/example.com-20261108-1200' && i.held)).toBe(true);
    const reasons = Object.fromEntries(report.skipped.map((s) => [s.url, s.reason]));
    expect(reasons).toEqual({ 'https://example.com/private/x': 'robots', 'https://other.example.org/': 'other-site', 'https://example.com/logo.png': 'not-a-page' });
    expect(fetchFn.seen.filter((r) => r.url.endsWith('/robots.txt'))).toHaveLength(1);
    expect(fetchFn.seen.some((r) => r.url.includes('/docs/deep'))).toBe(false);
    expect(progress.at(-1)).toBeCloseTo(5 / 25);
  });

  it('goes deeper, narrows with include and exclude, and stops at the page limit', async () => {
    expect((await crawler().run.run(plan({ depth: 2, include: ['/docs/**'], exclude: ['/docs/b'] }))).pages.map((p) => p.depth)).toEqual([0, 1, 2]);
    const limited = await crawler().run.run(plan({ maxPages: 2 }));
    expect(limited.pages).toHaveLength(2);
    expect(limited.skipped.filter((s) => s.reason === 'limit').map((s) => s.url)).toEqual(['https://example.com/docs/b', 'https://example.com/private/x', 'https://example.com/private/open', 'https://example.com/blog/1']);
    expect((await crawler().run.run(plan({ depth: 0 }))).pages).toHaveLength(1);
  });

  it('leaves out a page that fails to fetch or import, and stops on a cancel', async () => {
    const failing = crawler({ importPage: (url) => (url.endsWith('/docs/a') ? Promise.reject(new CallFailed(mintId('run'), { class: 'caller', message: 'too big' })) : Promise.resolve({ uri: 'hub://resources/x', title: 'x' })) });
    const report = await failing.run.run(plan({ start: new URL('https://example.com/') }));
    expect(report.skipped).toContainEqual({ url: 'https://example.com/docs/a', reason: 'failed', detail: 'too big' });
    expect(failing.held.size).toBe(0);
    const missing = await crawler().run.run(plan({ start: new URL('https://example.com/nope') }));
    expect(missing.skipped[0]).toMatchObject({ reason: 'failed' });
    const cancelled = crawler({ importPage: () => Promise.reject(new CallFailed(undefined, { class: 'cancelled' })) });
    await expect(cancelled.run.run(plan())).rejects.toBeInstanceOf(CallFailed);
  });
});

describe('crawl helpers', () => {
  it('names the folder by host and UTC minute, and finds the root of its pages', () => {
    expect(crawlFolder(new URL('https://Example.com:8080/x'), Date.UTC(2026, 10, 8, 9, 5))).toBe('crawls/example.com-8080-20261108-0905');
    expect(crawlRoot(['hub://resources/web/crawls/a/x', 'hub://resources/web/crawls/a/y/z'], 'crawls/a')).toBe('hub://resources/web/crawls/a');
    expect(crawlRoot(['hub://resources/web/h/a/x', 'hub://resources/web/h/b'], 'crawls/a')).toBe('hub://resources/web/h');
    expect(crawlRoot([], 'crawls/a')).toBe('');
  });

  it('matches globs against the path, the last segment or the whole URL', () => {
    const url = new URL('https://example.com/docs/guide/intro.html?x=1');
    expect(globMatches('/docs/**', url)).toBe(true);
    expect(globMatches('/docs/*', url)).toBe(false);
    expect(globMatches('*.html', url)).toBe(true);
    expect(globMatches('https://example.com/**', url)).toBe(true);
    expect(globMatches('/blog/**', url)).toBe(false);
  });

  it('holds a fetched page once, until its time is up', () => {
    let now = 0;
    const held = new FetchedPages(1_000, () => now);
    held.put(fetchedPage({ requestedUrl: 'https://example.com/a', finalUrl: 'https://example.com/b' }));
    expect(held.take('https://example.com/b')?.requestedUrl).toBe('https://example.com/a');
    expect(held.take('https://example.com/a')).toBeUndefined();
    held.put(fetchedPage());
    now = 1_000;
    expect(held.take('https://example.com/')).toBeUndefined();
  });
});

describe('robots.txt', () => {
  const text = 'User-agent: harness-web\nUser-agent: other\nDisallow: /no\nAllow: /no/but$\n\nUser-agent: *\nDisallow: /\n# comment\nSitemap: /s.xml';
  it('uses the group naming the agent over *, longest match wins, $ anchors', () => {
    const rules = RobotsRules.parse(text, 'harness-web');
    expect(rules.allows(new URL('https://e.com/yes'))).toBe(true);
    expect(rules.allows(new URL('https://e.com/no/thing'))).toBe(false);
    expect(rules.allows(new URL('https://e.com/no/but'))).toBe(true);
    expect(rules.allows(new URL('https://e.com/no/butter'))).toBe(false);
    expect(RobotsRules.parse(text, 'someone').allows(new URL('https://e.com/yes'))).toBe(false);
    expect(RobotsRules.parse('User-agent: *\nDisallow: /*.pdf$\nDisallow:\n', 'x').allows(new URL('https://e.com/a/b.pdf'))).toBe(false);
    expect(RobotsRules.ALLOW_ALL.allows(new URL('https://e.com/'))).toBe(true);
  });
});
