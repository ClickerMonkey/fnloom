import { describe, expect, it } from 'vitest';
import { PageMentions, RecentPages, pageValue, type RecentPage } from './mentions.ts';

const page = (url: string, more: Partial<RecentPage> = {}): RecentPage => ({ url, finalUrl: url, title: `Title of ${url}`, uri: undefined, rendered: false, at: 0, ...more });

describe('RecentPages', () => {
  it('keeps the newest pages first, at most the limit, and keeps a known resource uri', () => {
    const recent = new RecentPages(2);
    recent.add(page('https://a.example/', { uri: 'hub://resources/a' }));
    recent.add(page('https://b.example/'));
    recent.add(page('https://a.example/'));
    recent.add(page('https://c.example/'));
    expect(recent.all().map((p) => p.url)).toEqual(['https://c.example/', 'https://a.example/']);
    expect(recent.get('https://a.example/')?.uri).toBe('hub://resources/a');
  });

  it('finds a page by the URL it ended up at, and keeps nothing with a limit of 0', () => {
    const recent = new RecentPages(5);
    recent.add(page('https://short.example/x', { finalUrl: 'https://long.example/article' }));
    expect(recent.get('https://long.example/article')?.url).toBe('https://short.example/x');
    const none = new RecentPages(0);
    none.add(page('https://a.example/'));
    expect(none.all()).toEqual([]);
  });
});

describe('PageMentions', () => {
  const recent = new RecentPages(10);
  recent.add(page('https://vuejs.org/guide/introduction', { title: 'Introduction | Vue.js', uri: 'hub://resources/vue-intro', rendered: true }));
  recent.add(page('https://example.com/report', { title: 'Quarterly report' }));
  const mentions = new PageMentions(recent, 5);

  it('offers the URL being typed first, then recent pages that match', async () => {
    const options = await mentions.search('example.com/new?token=secret');
    expect(options[0]).toMatchObject({ label: 'example.com · new', icon: 'globe', target: { url: 'https://example.com/new?token=secret' } });
    expect(options[0]?.hint).toBe('Read https://example.com/new?token=redacted');
    expect(JSON.stringify(options.map((o) => [o.label, o.hint]))).not.toContain('secret');
    expect((await mentions.search('vue')).map((o) => o.label)).toEqual(['Introduction | Vue.js']);
    expect((await mentions.search('')).map((o) => o.label)).toEqual(['Quarterly report', 'Introduction | Vue.js']);
  });

  it('names a typed URL it has read by its title, without offering it twice', async () => {
    const options = await mentions.search('https://example.com/report');
    expect(options.map((o) => o.label)).toEqual(['Quarterly report']);
    expect(options[0]?.hint).toBe('example.com');
  });

  it('draws a hover card from what it knows, opening the kept resource', async () => {
    const card = await mentions.hover({ url: 'https://vuejs.org/guide/introduction' });
    expect(card).toMatchObject({
      title: 'Introduction | Vue.js',
      subtitle: 'https://vuejs.org/guide/introduction',
      fields: [{ label: 'Site', value: 'vuejs.org' }, { label: 'Read', value: 'Rendered in the browser' }],
      open: { resource: 'hub://resources/vue-intro' },
      value: { url: 'https://vuejs.org/guide/introduction', title: 'Introduction | Vue.js', domain: 'vuejs.org' },
    });
    const unread = await mentions.hover({ url: 'https://new.example/page?api_key=k' });
    expect(unread).toMatchObject({ title: 'new.example · page', subtitle: 'https://new.example/page?api_key=redacted', open: { url: 'https://new.example/page?api_key=k' } });
    expect(unread?.body).toContain('web/read');
    expect(await mentions.hover({ url: 'not a url' })).toBeUndefined();
  });

  it('tells the LLM how to read a page', async () => {
    expect(await mentions.llm({ url: 'example.com/x' })).toBe('Web page https://example.com/x. Read it with web/read {"url":"https://example.com/x"}.');
    expect(await mentions.llm({ url: 'https://vuejs.org/guide/introduction' })).toContain('hub/resource_read {"uri":"hub://resources/vue-intro"}');
    expect(await mentions.llm({ url: 'nope' })).toBe('"nope" isn\'t a web address.');
  });

  it('makes Page values with a title from the URL when there is none', () => {
    expect(pageValue('https://www.example.com/a/b', undefined)).toEqual({ url: 'https://www.example.com/a/b', title: 'example.com · b', domain: 'example.com' });
  });
});
