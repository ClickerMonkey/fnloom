import { SectionKey, type Json, type ResourceHit, type ResourceStat, type ResourceUri } from '@harness/core';
import type { Resources } from '@harness/sdk';
import { describe, expect, it } from 'vitest';
import { PageMentions, WEB_PAGES_ROOT, pageValue, pagesOf, type PageMentionCtx } from './mentions.ts';

const VUE: ResourceUri = 'hub://resources/web/vuejs.org/guide/introduction';
const REPORT: ResourceUri = 'hub://resources/web/example.com/report';

function hit(uri: ResourceUri, title: string, section?: string): ResourceHit {
  return { uri, title, preview: `${title}: the text that matched`, score: 1, ...(section === undefined ? {} : { section: SectionKey.parse(section) }) };
}

/** A mention ctx whose resources answer from a list, recording each search, and whose log keeps warnings. */
function ctxOf(hits: ResourceHit[] | Error, stats: Readonly<Record<string, ResourceStat>> = {}): PageMentionCtx & { searches: Array<{ query: string; roots?: ResourceUri[]; limit?: number }>; warnings: Array<Record<string, Json> | undefined> } {
  const searches: Array<{ query: string; roots?: ResourceUri[]; limit?: number }> = [];
  const warnings: Array<Record<string, Json> | undefined> = [];
  const resources: Resources = {
    stat: (uri) => Promise.resolve(stats[uri]),
    text: () => Promise.reject(new Error('not read here')),
    bytes: () => Promise.reject(new Error('not read here')),
    links: () => Promise.resolve([]),
    sections: () => Promise.resolve([]),
    search: (query, options) => {
      searches.push({ query, ...options });
      return hits instanceof Error ? Promise.reject(hits) : Promise.resolve(hits);
    },
  };
  const log: PageMentionCtx['log'] = { debug: () => undefined, info: () => undefined, warn: (_key, fields) => { warnings.push(fields); }, error: () => undefined };
  return { resources, log, searches, warnings };
}

describe('pagesOf', () => {
  it('keeps one hit per kept page, best first, up to the limit, and nothing outside the web pages', () => {
    const hits = [hit(VUE, 'Vue', 'intro'), hit(VUE, 'Vue', 'setup'), hit('hub://resources/uploads/a.md', 'Upload'), hit(REPORT, 'Report')];
    expect(pagesOf(hits, 5).map((h) => h.uri)).toEqual([VUE, REPORT]);
    expect(pagesOf(hits, 1).map((h) => h.uri)).toEqual([VUE]);
  });
});

describe('PageMentions', () => {
  const mentions = new PageMentions(5);

  it('offers the URL being typed first, then kept pages the hub finds for the person, under the web root', async () => {
    const ctx = ctxOf([hit(REPORT, 'Quarterly report')]);
    const options = await mentions.search('example.com/new?token=secret', ctx);
    expect(options[0]).toMatchObject({ label: 'example.com · new', icon: 'globe', target: { url: 'https://example.com/new?token=secret' } });
    expect(options[0]?.hint).toBe('Read https://example.com/new?token=redacted');
    expect(JSON.stringify(options.map((o) => [o.label, o.hint]))).not.toContain('secret');
    expect(options[1]).toMatchObject({ label: 'Quarterly report', target: { uri: REPORT, title: 'Quarterly report' } });
    expect(ctx.searches).toEqual([{ query: 'example.com/new?token=secret', roots: [WEB_PAGES_ROOT], limit: 5 }]);
  });

  it('searches nothing for empty text', async () => {
    const ctx = ctxOf([hit(REPORT, 'Quarterly report')]);
    expect(await mentions.search('  ', ctx)).toEqual([]);
    expect(ctx.searches).toEqual([]);
  });

  it('still offers the typed URL when the hub refuses the search, and logs why', async () => {
    const ctx = ctxOf(new Error('The mention request is stale.'));
    expect((await mentions.search('vuejs.org', ctx)).map((o) => o.label)).toEqual(['vuejs.org']);
    expect(ctx.warnings).toEqual([{ message: 'The mention request is stale.' }]);
  });

  it('draws a kept page\'s card from the hub, and none once it is gone', async () => {
    const stat: ResourceStat = { uri: VUE, name: 'Introduction | Vue.js', type: 'page', version: 'v1', modifiedAt: Date.UTC(2026, 10, 3) };
    const ctx = ctxOf([], { [VUE]: stat });
    expect(await mentions.hover({ uri: VUE, title: 'Introduction | Vue.js' }, ctx)).toEqual({
      title: 'Introduction | Vue.js', subtitle: 'A web page the hub keeps', fields: [{ label: 'Read', value: '2026-11-03' }], open: { resource: VUE, title: 'Introduction | Vue.js' },
    });
    expect(await mentions.hover({ uri: REPORT }, ctx)).toBeUndefined();
    expect(await mentions.hover({ uri: 'file:///etc/passwd' }, ctx)).toBeUndefined();
    const escaping = { uri: 'hub://resources/web/../uploads/secret.md', name: 'secret', type: 'file', version: 'v1' } satisfies ResourceStat;
    expect(await mentions.hover({ uri: escaping.uri }, ctxOf([], { [escaping.uri]: escaping }))).toBeUndefined();
    expect(await mentions.llm({ uri: escaping.uri })).toContain("isn't a web page the hub keeps");
  });

  it('draws a typed URL\'s card without fetching it, redacting credentials', async () => {
    const unread = await mentions.hover({ url: 'https://new.example/page?api_key=k' }, ctxOf([]));
    expect(unread).toMatchObject({ title: 'new.example · page', subtitle: 'https://new.example/page?api_key=redacted', open: { url: 'https://new.example/page?api_key=k' } });
    expect(unread?.body).toContain('web/read');
    expect(await mentions.hover({ url: 'not a url' }, ctxOf([]))).toBeUndefined();
  });

  it('tells the LLM how to read a page', async () => {
    expect(await mentions.llm({ url: 'example.com/x' })).toBe('Web page https://example.com/x. Read it with web/read {"url":"https://example.com/x"}.');
    expect(await mentions.llm({ uri: VUE, title: 'Introduction | Vue.js' })).toBe(`Web page "Introduction | Vue.js" (the hub resource ${VUE}). Read it with hub/resource_read {"uri":"${VUE}"}.`);
    expect(await mentions.llm({ uri: 'file:///etc/passwd' })).toBe('"file:///etc/passwd" isn\'t a web page the hub keeps.');
    expect(await mentions.llm({ url: 'nope' })).toBe('"nope" isn\'t a web address.');
  });

  it('makes Page values with a title from the URL when there is none', () => {
    expect(pageValue('https://www.example.com/a/b', undefined)).toEqual({ url: 'https://www.example.com/a/b', title: 'example.com · b', domain: 'example.com' });
  });
});
